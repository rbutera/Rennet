import { archive } from "@rennet/core";
import type { ForgeRepoIdentity, SessionModel } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { type EntryStore, SessionEntry, type Target } from "./session-entry";

// ── Fake store ─────────────────────────────────────────────────────────────────

/** An in-memory `EntryStore`. Records saves so a test can prove mint-vs-reattach by
 *  counting how many sessions were persisted. */
function fakeStore(seed: SessionModel[] = []): EntryStore & {
  readonly sessions: SessionModel[];
  readonly saves: SessionModel[];
} {
  const sessions = [...seed];
  const saves: SessionModel[] = [];
  return {
    sessions,
    saves,
    list: () => [...sessions],
    save: (s) => {
      saves.push(s);
      const at = sessions.findIndex((x) => x.id === s.id);
      if (at >= 0) sessions[at] = s;
      else sessions.push(s);
    },
  };
}

/** Deterministic mint deps so ids/clocks are assertable. */
function mintDeps(idSeq: string[]) {
  let i = 0;
  return { id: () => idSeq[i++] ?? `extra-${i}`, now: () => 1_000 };
}

const FEAT: Target = { branch: "feat/x", prNumber: 7 };
const GITHUB_WIDGET = {
  forge: "github",
  owner: "acme",
  name: "widget",
} satisfies ForgeRepoIdentity;
const GITLAB_WIDGET = {
  forge: "gitlab",
  owner: "acme",
  name: "widget",
} satisfies ForgeRepoIdentity;

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SessionEntry.enter — mint + claim in one act", () => {
  it("mints a session claiming the branch AND its PR, and persists it", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["s1"]));
    const { session, reattached } = entry.enter("proj", FEAT);
    expect(reattached).toBe(false);
    expect(session.id).toBe("s1");
    expect(session.claim).toEqual({ branch: "feat/x", prNumber: 7 });
    expect(store.sessions).toHaveLength(1);
  });

  it("omits prNumber when the target has no PR (branch-only claim)", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["s1"]));
    const { session } = entry.enter("proj", { branch: "feat/x" });
    expect(session.claim).toEqual({ branch: "feat/x" });
    expect(session.claim).not.toHaveProperty("prNumber");
  });
});

describe("SessionEntry.enter — re-entry reattaches (never a second session)", () => {
  it("reattaches to the same session on a second click for the same target", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["s1", "s2"]));
    const first = entry.enter("proj", FEAT);
    const second = entry.enter("proj", FEAT);
    expect(second.reattached).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    expect(store.sessions).toHaveLength(1); // no second mint
  });

  it("reattaches when the target matches by PR even if the branch string differs (one claimed thing)", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["s1", "s2"]));
    const first = entry.enter("proj", { branch: "feat/x", prNumber: 7 });
    const byPr = entry.enter("proj", { branch: "some-other-ref", prNumber: 7 });
    expect(byPr.reattached).toBe(true);
    expect(byPr.session.id).toBe(first.session.id);
    expect(store.sessions).toHaveLength(1);
  });

  it("mints a fresh session once the claiming session is archived (archive is the release)", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["s1", "s2"]));
    const first = entry.enter("proj", FEAT);
    store.save(archive(first.session, () => 2_000));
    const again = entry.enter("proj", FEAT);
    expect(again.reattached).toBe(false);
    expect(again.session.id).toBe("s2");
  });

  it("does not cross-attach the same branch/PR across projects — claims are project-scoped (F5)", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["a1", "b1"]));
    // Project A claims feat/x + PR #7.
    const inA = entry.enter("proj-a", FEAT);
    // The SAME branch and PR number in project B must NOT reattach to A's session.
    const inB = entry.enter("proj-b", FEAT);
    expect(inB.reattached).toBe(false);
    expect(inB.session.id).toBe("b1");
    expect(inB.session.id).not.toBe(inA.session.id);
    expect(inB.session.projectId).toBe("proj-b");
    // Re-entering project A still reattaches to A's session (scoping is not amnesia).
    expect(entry.enter("proj-a", FEAT).session.id).toBe(inA.session.id);
    expect(store.sessions).toHaveLength(2);
  });

  it("does not cross-attach identical repository coordinates across forges", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["github", "gitlab", "extra"]));
    const github = entry.enter("proj", {
      branch: "main",
      prNumber: 7,
      repository: "acme/widget",
      forgeRepository: GITHUB_WIDGET,
    });
    const gitlab = entry.enter("proj", {
      branch: "main",
      prNumber: 7,
      repository: "acme/widget",
      forgeRepository: GITLAB_WIDGET,
    });

    expect(gitlab.reattached).toBe(false);
    expect(gitlab.session.id).toBe("gitlab");
    expect(gitlab.session.id).not.toBe(github.session.id);
    expect(store.sessions).toHaveLength(2);
    expect(
      entry.enter("proj", {
        branch: "main",
        prNumber: 7,
        repository: "acme/widget",
        forgeRepository: GITHUB_WIDGET,
      }).session.id,
    ).toBe("github");
  });

  it("reattaches and provider-stamps a legacy session when owner/name agrees", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["legacy", "extra"]));
    const legacy = entry.enter("proj", {
      branch: "main",
      prNumber: 7,
      repository: "acme/widget",
    });
    const current = entry.enter("proj", {
      branch: "main",
      prNumber: 7,
      repository: "acme/widget",
      forgeRepository: GITHUB_WIDGET,
    });

    expect(current.reattached).toBe(true);
    expect(current.session.id).toBe(legacy.session.id);
    expect(current.session.forgeRepository).toEqual(GITHUB_WIDGET);
    expect(store.sessions).toHaveLength(1);
  });

  it("does not provider-stamp a contradictory one-sided legacy session", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["legacy", "github"]));
    const legacy = entry.enter("proj", {
      branch: "main",
      prNumber: 7,
      repository: "other/repo",
    });
    const current = entry.enter("proj", {
      branch: "main",
      prNumber: 7,
      forgeRepository: GITHUB_WIDGET,
    });

    expect(current.reattached).toBe(false);
    expect(current.session.id).toBe("github");
    expect(current.session.id).not.toBe(legacy.session.id);
    expect(current.session.forgeRepository).toEqual(GITHUB_WIDGET);
    expect(store.sessions).toHaveLength(2);
  });
});

describe("SessionEntry.enterSuccessor — replacement survives every interruption point", () => {
  it("persists the fresh claimant while the refused review's session remains live", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["old", "fresh"]));
    entry.enter("proj", { ...FEAT, repository: "acme/widget", forgeRepository: GITHUB_WIDGET });
    store.saves.length = 0;

    const successor = entry.enterSuccessor("old", "proj", {
      ...FEAT,
      repository: "acme/widget",
      forgeRepository: GITHUB_WIDGET,
    });

    expect(successor.reattached).toBe(false);
    expect(successor.session.id).toBe("fresh");
    expect(store.saves.map((session) => [session.id, session.archivedAt])).toEqual([
      ["fresh", undefined],
    ]);
    expect(store.sessions.find((session) => session.id === "old")?.archivedAt).toBeUndefined();
  });

  it("adopts a fresh claimant left by an interruption before releasing the old claim", () => {
    const target = { ...FEAT, repository: "acme/widget", forgeRepository: GITHUB_WIDGET };
    const store = fakeStore([
      {
        id: "old",
        projectId: "proj",
        claim: FEAT,
        repository: target.repository,
        forgeRepository: target.forgeRepository,
        threads: [],
        createdAt: 1,
      },
      {
        id: "fresh",
        projectId: "proj",
        claim: FEAT,
        repository: target.repository,
        forgeRepository: target.forgeRepository,
        threads: [],
        createdAt: 2,
      },
    ]);
    const entry = new SessionEntry(store, mintDeps(["unused"]));

    const successor = entry.enterSuccessor("old", "proj", target);

    expect(successor).toMatchObject({ reattached: true, session: { id: "fresh" } });
    expect(store.saves).toEqual([]);
    expect(store.sessions.find((session) => session.id === "old")?.archivedAt).toBeUndefined();
  });

  it("adopts the persisted successor when the response is lost after releasing the old claim", () => {
    const target = { ...FEAT, repository: "acme/widget", forgeRepository: GITHUB_WIDGET };
    const store = fakeStore([
      {
        id: "old",
        projectId: "proj",
        claim: FEAT,
        repository: target.repository,
        forgeRepository: target.forgeRepository,
        threads: [],
        createdAt: 1,
        archivedAt: 3,
      },
      {
        id: "fresh",
        projectId: "proj",
        claim: FEAT,
        repository: target.repository,
        forgeRepository: target.forgeRepository,
        threads: [],
        createdAt: 2,
      },
    ]);
    const entry = new SessionEntry(store, mintDeps(["unused"]));

    const successor = entry.enterSuccessor("old", "proj", target);

    expect(successor).toMatchObject({ reattached: true, session: { id: "fresh" } });
    expect(store.saves).toEqual([]);
  });
});

describe("SessionEntry.visibleTargets — claim-dedup on resolve", () => {
  it("hides every New-chat row resolving to a live claim (by branch or PR), keeps the rest", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["s1"]));
    entry.enter("proj", FEAT);
    const visible = entry.visibleTargets("proj", [
      { branch: "feat/x" }, // same branch — hidden
      { branch: "ref-y", prNumber: 7 }, // same PR — hidden
      { branch: "feat/z", prNumber: 9 }, // unclaimed — kept
    ]);
    expect(visible).toEqual([{ branch: "feat/z", prNumber: 9 }]);
  });

  it("a merged target keeps its claim (rows stay hidden); archive releases it (rows return)", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["s1"]));
    const { session } = entry.enter("proj", FEAT); // merge state is irrelevant — the claim holds
    expect(entry.visibleTargets("proj", [{ branch: "feat/x" }])).toEqual([]);
    store.save(archive(session, () => 2_000));
    expect(entry.visibleTargets("proj", [{ branch: "feat/x" }])).toEqual([{ branch: "feat/x" }]);
  });

  it("a claim in another project does not hide a same-named target here (project-scoped, F5)", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["a1"]));
    entry.enter("proj-a", FEAT); // project A claims feat/x + PR #7
    // In project B the same branch/PR is still an offerable New-chat row.
    expect(entry.visibleTargets("proj-b", [{ branch: "feat/x", prNumber: 7 }])).toEqual([
      { branch: "feat/x", prNumber: 7 },
    ]);
  });

  it("keeps the other forge visible when coordinates, branch, and PR number are identical", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["github"]));
    entry.enter("proj", {
      branch: "main",
      prNumber: 7,
      repository: "acme/widget",
      forgeRepository: GITHUB_WIDGET,
    });

    const gitlab = {
      branch: "main",
      prNumber: 7,
      repository: "acme/widget",
      forgeRepository: GITLAB_WIDGET,
    } satisfies Target;
    expect(
      entry.visibleTargets("proj", [
        {
          branch: "main",
          prNumber: 7,
          repository: "acme/widget",
          forgeRepository: GITHUB_WIDGET,
        },
        gitlab,
      ]),
    ).toEqual([gitlab]);
  });
});
