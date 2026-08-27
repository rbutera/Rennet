import { archive } from "@rennet/core";
import type { SessionModel } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { type EntryStore, SessionEntry, type Target } from "./session-entry";

// ── Fake store ─────────────────────────────────────────────────────────────────

/** An in-memory `EntryStore`. Records saves so a test can prove mint-vs-reattach by
 *  counting how many sessions were persisted. */
function fakeStore(seed: SessionModel[] = []): EntryStore & { readonly sessions: SessionModel[] } {
  const sessions = [...seed];
  return {
    sessions,
    list: () => [...sessions],
    save: (s) => {
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
});

describe("SessionEntry.visibleTargets — claim-dedup on resolve", () => {
  it("hides every New-chat row resolving to a live claim (by branch or PR), keeps the rest", () => {
    const store = fakeStore();
    const entry = new SessionEntry(store, mintDeps(["s1"]));
    entry.enter("proj", FEAT);
    const visible = entry.visibleTargets([
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
    expect(entry.visibleTargets([{ branch: "feat/x" }])).toEqual([]);
    store.save(archive(session, () => 2_000));
    expect(entry.visibleTargets([{ branch: "feat/x" }])).toEqual([{ branch: "feat/x" }]);
  });
});
