import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileProjectStore, SessionStore } from "@rennet/adapters";
import type { SessionModel } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
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
function sessionDispatch(dir: string) {
  const store = new SessionStore(dir);
  const rt = createDispatchRuntime({
    service: { reviewById: () => undefined },
    sessions: {
      list: () => store.list().map(sidebarSessionOf),
      rename: (id: string, title: string) => {
        const session = store.rename(id, title);
        return session && sidebarSessionOf(session);
      },
      setPinned: (id: string, pinned: boolean) => {
        const session = store.setPinned(id, pinned);
        return session && sidebarSessionOf(session);
      },
      setArchived: (id: string, archived: boolean) => {
        const session = archived ? store.archive(id) : store.restore(id);
        return session && sidebarSessionOf(session);
      },
    },
  } as unknown as DispatchDeps);
  return { handlers: sessionHandlers(rt), store };
}

const seed = (id: string, branch?: string): SessionModel => ({
  id,
  projectId: "p1",
  threads: [],
  createdAt: 1,
  ...(branch === undefined ? {} : { claim: { branch } }),
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
