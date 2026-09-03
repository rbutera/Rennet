import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileProjectStore, RoundRecordStore, SessionStore } from "@rennet/adapters";
import { mintSession } from "@rennet/core";
import {
  ROUND_NO_REGEN,
  type RoundRecord,
  type SessionModel,
  type SidebarSession,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { SessionEntry } from "../session/session-entry";
import { projectHandlers } from "./project";
import { createDispatchRuntime, type DispatchDeps } from "./runtime";
import { sessionHandlers, sidebarSessionOf } from "./session";

// The sidebar's sessions and the project rename (C18), driven over the REAL durable stores
// the composition root wires. Positive controls: a rename and a pin SURVIVE a fresh store
// (the reload proof — nothing is held in memory), an emptied name restores the `org/repo`
// fallback (R67) and an emptied session title falls back to the claimed branch, and an
// archive is reversible.

function sessionsDir(): string {
  return mkdtempSync(join(tmpdir(), "rennet-sessions-"));
}

/** The dispatch surface over a session store rooted at `dir` — a fresh runtime each call,
 *  so "read it back through a new store" is a genuine reload, not a cached answer. */
function sessionDispatch(
  dir: string,
  t3?: { forgetSession: (ids: readonly string[]) => Promise<number> },
) {
  const store = new SessionStore(dir);
  const rounds = new RoundRecordStore(join(dir, "rounds"));
  const sidebarSessionFor = (session: SessionModel) =>
    sidebarSessionOf(session, rounds.read(session.id));
  let captured = 0;
  const entry = new SessionEntry(store);
  const rt = createDispatchRuntime({
    service: { reviewById: () => undefined },
    sessions: {
      list: () => store.list().map(sidebarSessionFor),
      // The composition root's own start, verbatim in SHAPE (create-server.ts) — so the
      // front door this test drives is the front door the app runs. The capture the real
      // root performs is stubbed to a fixed review id: this suite is about the claim and
      // the durability of the mint; background preparation has composition-root tests.
      start: async ({
        projectId,
        target,
        replacesSessionId,
      }: {
        projectId: string;
        commandId: string;
        replacesSessionId?: string;
        target?: { branch: string; prNumber?: number; repository?: string };
      }) => {
        // A DISTINCT review per start, as a real capture produces — a shared id would make
        // every mint look like a reattach to the first one.
        captured += 1;
        const reviewId = `rev-${captured}`;
        const entered =
          target === undefined
            ? { session: mintSession(projectId), reattached: false }
            : replacesSessionId === undefined
              ? entry.enter(projectId, target, undefined, reviewId)
              : entry.enterSuccessor(replacesSessionId, projectId, target);
        if (!entered.reattached) store.save(entered.session);
        const bound = store.attachReview(entered.session.id, reviewId) ?? entered.session;
        if (replacesSessionId !== undefined) store.archive(replacesSessionId);
        return { session: sidebarSessionFor(bound), reattached: entered.reattached };
      },
      rename: (id: string, title: string) => {
        const session = store.rename(id, title);
        return session && sidebarSessionFor(session);
      },
      setPinned: (id: string, pinned: boolean) => {
        const session = store.setPinned(id, pinned);
        return session && sidebarSessionFor(session);
      },
      setArchived: (id: string, archived: boolean) => {
        const session = archived ? store.archive(id) : store.restore(id);
        return session && sidebarSessionFor(session);
      },
    },
    ...(t3 === undefined ? {} : { t3Sidecar: t3 }),
  } as unknown as DispatchDeps);
  return { handlers: sessionHandlers(rt), rounds, store };
}

const seed = (id: string, branch?: string): SessionModel => ({
  id,
  projectId: "p1",
  threads: [],
  createdAt: 1,
  ...(branch === undefined ? {} : { claim: { branch } }),
});

const roundRecord = (
  id: string,
  outcome: "completed" | "failed",
  regeneration?: "pending" | "not-needed",
): RoundRecord => ({
  asksDispatched: [`ask-${id}`],
  dispatchId: `dispatch-${id}`,
  workerCommitRange: { from: `from-${id}`, to: `to-${id}` },
  boardGeneration: regeneration === undefined ? `generation-${id}` : ROUND_NO_REGEN,
  reportBoard: regeneration === undefined ? `report-${id}` : ROUND_NO_REGEN,
  outcome,
  ...(regeneration === undefined ? {} : { regeneration }),
});

type Rows = { sessions: { id: string; title: string; pinned?: boolean; archived?: boolean }[] };

describe("session.list + the sidebar's session writes (C18)", () => {
  it("lists the persisted sessions, titled by the claim it actually holds", async () => {
    const dir = sessionsDir();
    const { handlers, store } = sessionDispatch(dir);
    store.save(seed("s1", "feat/seam"));
    store.save(seed("s2"));
    const out = (await handlers["session.list"]({})) as Rows;
    expect(out.sessions.map((row) => row.title).sort()).toEqual(["New review", "feat/seam"]);
  });

  it("a rename and a pin SURVIVE a reload; an emptied title restores the branch", async () => {
    const dir = sessionsDir();
    const first = sessionDispatch(dir);
    first.store.save(seed("s1", "feat/seam"));
    await first.handlers["session.rename"]({ sessionId: "s1", title: "Auth refactor" });
    await first.handlers["session.setPinned"]({ sessionId: "s1", pinned: true });

    // A FRESH store over the same directory — the reload proof.
    const reloaded = sessionDispatch(dir);
    const rows = ((await reloaded.handlers["session.list"]({})) as Rows).sessions;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Auth refactor");
    expect(rows[0]?.pinned).toBe(true);

    // Emptying the title CLEARS it, so the row falls back to the claimed branch.
    await reloaded.handlers["session.rename"]({ sessionId: "s1", title: "   " });
    const after = ((await sessionDispatch(dir).handlers["session.list"]({})) as Rows).sessions;
    expect(after[0]?.title).toBe("feat/seam");
  });

  it("archive is reversible, and both halves survive a reload", async () => {
    const dir = sessionsDir();
    const first = sessionDispatch(dir);
    first.store.save(seed("s1", "feat/seam"));
    await first.handlers["session.archive"]({ sessionId: "s1", archived: true });
    expect(
      ((await sessionDispatch(dir).handlers["session.list"]({})) as Rows).sessions[0]?.archived,
    ).toBe(true);

    await sessionDispatch(dir).handlers["session.archive"]({ sessionId: "s1", archived: false });
    expect(
      ((await sessionDispatch(dir).handlers["session.list"]({})) as Rows).sessions[0]?.archived,
    ).toBeUndefined();
  });

  it("a write against an unknown session answers null — nothing was stored", async () => {
    const { handlers } = sessionDispatch(sessionsDir());
    expect(await handlers["session.rename"]({ sessionId: "nope", title: "x" })).toEqual({
      session: null,
    });
  });

  it("projects the latest durably completed round on list, start, and update rows", async () => {
    const dir = sessionsDir();
    const first = sessionDispatch(dir);
    first.store.save(seed("s1", "feat/seam"));
    first.rounds.record("s1", roundRecord("failed", "failed"));
    first.rounds.record("s1", roundRecord("completed", "completed"));
    first.rounds.record("s1", roundRecord("pending", "completed", "pending"));

    const listed = (await sessionDispatch(dir).handlers["session.list"]({})) as {
      sessions: SidebarSession[];
    };
    expect(listed.sessions[0]?.subtitle).toBe("Round 2 is back");

    const started = (await sessionDispatch(dir).handlers["session.mint"]({
      projectId: "p1",
      commandId: "11111111-1111-4111-8111-111111111111",
      branch: "feat/seam",
    })) as Minted;
    expect(started.reattached).toBe(true);
    expect(started.session?.subtitle).toBe("Round 2 is back");

    const renamed = (await sessionDispatch(dir).handlers["session.rename"]({
      sessionId: "s1",
      title: "Round-tripped",
    })) as { session: SidebarSession | null };
    expect(renamed.session?.subtitle).toBe("Round 2 is back");

    const pinned = (await sessionDispatch(dir).handlers["session.setPinned"]({
      sessionId: "s1",
      pinned: true,
    })) as { session: SidebarSession | null };
    expect(pinned.session?.subtitle).toBe("Round 2 is back");

    const archived = (await sessionDispatch(dir).handlers["session.archive"]({
      sessionId: "s1",
      archived: true,
    })) as { session: SidebarSession | null };
    expect(archived.session?.subtitle).toBe("Round 2 is back");
  });

  it("does not turn a failed or pending ledger row into a returned-round subtitle", () => {
    expect(
      sidebarSessionOf(seed("s1"), [
        roundRecord("failed", "failed"),
        roundRecord("pending", "completed", "pending"),
      ]).subtitle,
    ).toBeUndefined();
  });
});

describe("project.rename (C12 cluster 7, bound in C18)", () => {
  function projectDispatch(file: string) {
    const store = new FileProjectStore(file);
    const rt = createDispatchRuntime({
      service: { reviewById: () => undefined },
      allowedRoots: new Set<string>(),
      projects: {
        list: () => store.list(),
        remove: () => ({ projects: store.list() }),
        rename: (input: { projectId: string; name: string }) => ({
          project: store.rename(input.projectId, input.name) ?? null,
          projects: store.list(),
        }),
        add: () => ({ project: store.list()[0], projects: store.list() }),
      },
    } as unknown as DispatchDeps);
    return { handlers: projectHandlers(rt), store };
  }

  it("renames the stored project, and an emptied name restores the org/repo identity", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "rennet-projects-")), "projects.json");
    const first = projectDispatch(file);
    const stored = first.store.add({
      name: "rennet",
      path: "/code/acme/rennet",
      kind: "repo",
      repoCount: 1,
      branchCount: 1,
      primaryBranch: "main",
      openPath: "/code/acme/rennet",
      source: "local",
    });

    await first.handlers["project.rename"]({ projectId: stored.id, name: "Rennet · main" });
    // A FRESH store over the same file — the rename is on disk, not in memory.
    expect(projectDispatch(file).store.list()[0]?.name).toBe("Rennet · main");

    await projectDispatch(file).handlers["project.rename"]({ projectId: stored.id, name: "  " });
    expect(projectDispatch(file).store.list()[0]?.name).toBe("acme/rennet");
  });

  it("an unknown project answers null with the untouched list, never a throw", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "rennet-projects-")), "projects.json");
    const { handlers } = projectDispatch(file);
    expect(await handlers["project.rename"]({ projectId: "nope", name: "x" })).toEqual({
      project: null,
      projects: [],
    });
  });
});

type Minted = { session: SidebarSession | null; reattached: boolean };

describe("session.mint — the New Chat front door (C21)", () => {
  it("mints a session AND claims the target in one act, surviving a reload", async () => {
    const dir = sessionsDir();
    const out = (await sessionDispatch(dir).handlers["session.mint"]({
      projectId: "p1",
      commandId: "11111111-1111-4111-8111-111111111111",
      branch: "feat/seam",
      prNumber: 42,
    })) as Minted;
    expect(out.reattached).toBe(false);
    expect(out.session?.claim).toEqual({ branch: "feat/seam", prNumber: 42 });
    // A PR claim reads as `your-pr`, and the row is titled by the branch it claimed.
    expect(out.session?.target).toBe("your-pr");
    expect(out.session?.title).toBe("feat/seam");
    // A FRESH store over the same dir — the mint is on disk, not in memory.
    const listed = (await sessionDispatch(dir).handlers["session.list"]({})) as {
      sessions: SidebarSession[];
    };
    expect(listed.sessions.map((row) => row.id)).toEqual([out.session?.id]);
  });

  it("a second click on a claimed target REATTACHES — one session per target, never two", async () => {
    const dir = sessionsDir();
    const first = (await sessionDispatch(dir).handlers["session.mint"]({
      projectId: "p1",
      commandId: "11111111-1111-4111-8111-111111111111",
      branch: "feat/seam",
      prNumber: 42,
    })) as Minted;
    // The PR row and the branch row are ONE claimed thing (#466 res. 11): entering by the
    // branch alone still lands on the session the PR click minted.
    const again = (await sessionDispatch(dir).handlers["session.mint"]({
      projectId: "p1",
      commandId: "11111111-1111-4111-8111-111111111111",
      branch: "feat/seam",
    })) as Minted;
    expect(again.reattached).toBe(true);
    expect(again.session?.id).toBe(first.session?.id);
    const listed = (await sessionDispatch(dir).handlers["session.list"]({})) as {
      sessions: SidebarSession[];
    };
    expect(listed.sessions).toHaveLength(1);
  });

  it("a claim is project-scoped, and a no-target mint claims nothing", async () => {
    const dir = sessionsDir();
    const here = (await sessionDispatch(dir).handlers["session.mint"]({
      projectId: "p1",
      commandId: "11111111-1111-4111-8111-111111111111",
      branch: "feat/seam",
    })) as Minted;
    // The same branch name in ANOTHER project is a different target — never a cross-attach.
    const elsewhere = (await sessionDispatch(dir).handlers["session.mint"]({
      projectId: "p2",
      commandId: "11111111-1111-4111-8111-111111111111",
      branch: "feat/seam",
    })) as Minted;
    expect(elsewhere.reattached).toBe(false);
    expect(elsewhere.session?.id).not.toBe(here.session?.id);
    // The "talk about the project" row: no branch ⇒ no claim, so it hides no row.
    const bare = (await sessionDispatch(dir).handlers["session.mint"]({
      projectId: "p1",
      commandId: "11111111-1111-4111-8111-111111111111",
    })) as Minted;
    expect(bare.session?.claim).toBeUndefined();
    expect(bare.session?.title).toBe("New review");
  });

  it("no session store wired answers an honest null — nothing was minted", async () => {
    const rt = createDispatchRuntime({
      service: { reviewById: () => undefined },
    } as unknown as DispatchDeps);
    expect(
      await sessionHandlers(rt)["session.mint"]({
        projectId: "p1",
        commandId: "11111111-1111-4111-8111-111111111111",
        branch: "feat/seam",
      }),
    ).toEqual({ session: null, reattached: false });
  });
});

describe("session.mint — moved-head successor", () => {
  it("returns a fresh live claimant only after persisting it ahead of the archived source", async () => {
    const dir = sessionsDir();
    const firstRuntime = sessionDispatch(dir);
    const first = (await firstRuntime.handlers["session.mint"]({
      projectId: "p1",
      commandId: "0b2c1ea2-10fc-4394-88cc-b906584f9211",
      branch: "feat/seam",
      prNumber: 7,
      repository: "acme/widget",
    })) as { session: SidebarSession };

    const replacement = (await firstRuntime.handlers["session.mint"]({
      projectId: "p1",
      commandId: "7f875da6-fbef-4d57-a59d-c0f39094f11e",
      branch: "feat/seam",
      prNumber: 7,
      repository: "acme/widget",
      replacesSessionId: first.session.id,
    })) as { session: SidebarSession; reattached: boolean };

    expect(replacement.reattached).toBe(false);
    expect(replacement.session.id).not.toBe(first.session.id);
    const rows = (await sessionDispatch(dir).handlers["session.list"]({})) as {
      sessions: SidebarSession[];
    };
    expect(rows.sessions.find((session) => session.id === first.session.id)?.archived).toBe(true);
    const fresh = rows.sessions.find((session) => session.id === replacement.session.id);
    expect(fresh?.archived).toBeUndefined();
    expect(fresh).toMatchObject({
      claim: { branch: "feat/seam", prNumber: 7 },
      repository: "acme/widget",
    });
  });
});

// ── Archiving prunes the sidecar's threads (t3-lens-threads 1.7) ─────────────

describe("session.archive deletes the session's T3 threads", () => {
  /** Records every `forgetSession` call, so a test can assert WHEN and WITH WHAT. */
  function forgetSpy() {
    const calls: string[][] = [];
    return {
      calls,
      forgetSession: async (ids: readonly string[]) => {
        calls.push([...ids]);
        return ids.length;
      },
    };
  }

  const archive = (
    handlers: ReturnType<typeof sessionDispatch>["handlers"],
    sessionId: string,
    archived: boolean,
  ) => handlers["session.archive"]({ sessionId, archived }, undefined as never);

  it("sweeps the session id AND the review id, because the two kinds bind under different ones", async () => {
    const spy = forgetSpy();
    const { handlers, store } = sessionDispatch(sessionsDir(), spy);
    store.save(seed("s1", "feat/x"));
    store.attachReview("s1", "rev-1");

    await archive(handlers, "s1", true);

    // Exactly one sweep, naming both ids: the session thread is bound under the REVIEW id
    // (what `chat.t3Session` and the handoff bind on), the seat threads under the session id.
    expect(spy.calls).toHaveLength(1);
    expect([...(spy.calls[0] ?? [])].sort()).toEqual(["rev-1", "s1"]);
    // The archive itself still happened — the cleanup is not instead of it.
    expect(store.list().find((row) => row.id === "s1")?.archivedAt).toBeDefined();
  });

  it("un-archiving deletes nothing, so the next use creates fresh threads", async () => {
    const spy = forgetSpy();
    const { handlers, store } = sessionDispatch(sessionsDir(), spy);
    store.save(seed("s1", "feat/x"));
    store.attachReview("s1", "rev-1");

    await archive(handlers, "s1", true);
    await archive(handlers, "s1", false);

    // The COUNT is the assertion: "was called" would be satisfied by the archive alone and
    // could not see an un-archive that swept too.
    expect(spy.calls).toHaveLength(1);
    expect(store.list().find((row) => row.id === "s1")?.archivedAt).toBeUndefined();
  });

  it("sweeps by the session id alone when no review is attached", async () => {
    const spy = forgetSpy();
    const { handlers, store } = sessionDispatch(sessionsDir(), spy);
    store.save(seed("s2"));

    await archive(handlers, "s2", true);
    expect(spy.calls).toEqual([["s2"]]);
  });

  it("archives fine on a daemon with no sidecar composed", async () => {
    const { handlers, store } = sessionDispatch(sessionsDir());
    store.save(seed("s3", "feat/y"));

    const out = await archive(handlers, "s3", true);
    expect((out as { session: SidebarSession }).session.archived).toBe(true);
  });

  it("sweeps nothing for a session id the store does not know", async () => {
    const spy = forgetSpy();
    const { handlers } = sessionDispatch(sessionsDir(), spy);

    await archive(handlers, "nope", true);
    // `setArchived` returned null: no session was archived, so there is nothing to prune.
    expect(spy.calls).toEqual([]);
  });
});
