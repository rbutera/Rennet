import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindTarget, mintSession } from "@rennet/core";
import type { SessionThread } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./session-store";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rennet-sessions-"));
}

const fixed = { id: () => "sess-1", now: () => 1000 };
const codeAnchor = {
  type: "code",
  ref: { patchsetId: "ps-1", path: "a.ts", side: "head", startLine: 1, endLine: 4 },
} as const;

describe("SessionStore (#466 res. 1–2, B09 cluster 1)", () => {
  it("round-trips a session through disk", () => {
    const store = new SessionStore(tmpDir());
    const session = {
      ...bindTarget(mintSession("proj-1", fixed), { branch: "feat/x", prNumber: 3 }),
      repository: "acme/widget",
      forgeRepository: { forge: "github", owner: "acme", name: "widget" },
    };
    store.save(session);
    expect(store.load("sess-1")).toEqual(session);
  });

  it("loads and lists legacy repository JSON without inventing a forge", () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "legacy.json"),
      JSON.stringify({
        id: "legacy",
        projectId: "proj-1",
        repository: "acme/widget",
        claim: { branch: "main", prNumber: 7 },
        threads: [],
        createdAt: 900,
      }),
    );
    const store = new SessionStore(dir);

    expect(store.load("legacy")).toEqual({
      id: "legacy",
      projectId: "proj-1",
      repository: "acme/widget",
      claim: { branch: "main", prNumber: 7 },
      threads: [],
      createdAt: 900,
    });
    expect(store.list().map((session) => session.id)).toEqual(["legacy"]);
    expect(store.list()[0]?.forgeRepository).toBeUndefined();
  });

  it("pins a coding harness and clears a legacy Claude cursor when Codex is selected", () => {
    const store = new SessionStore(tmpDir());
    store.save({
      ...mintSession("proj-1", fixed),
      harnessCursor: {
        harnessSessionId: "legacy-claude-session",
        lastAssistantMessageAnchor: "message-1",
        turnCount: 2,
      },
    });

    const selected = store.setCodingHarness("sess-1", { id: "codex", version: "0.146.0" });

    expect(selected?.codingHarness).toEqual({ id: "codex", version: "0.146.0" });
    expect(selected?.harnessCursor).toBeUndefined();
    expect(store.load("sess-1")?.codingHarness).toEqual({ id: "codex", version: "0.146.0" });
  });

  it("keeps a same-provider cursor while refreshing the recorded harness version", () => {
    const store = new SessionStore(tmpDir());
    const harnessCursor = {
      harnessSessionId: "claude-session",
      lastAssistantMessageAnchor: "message-1",
      turnCount: 2,
    };
    store.save({
      ...mintSession("proj-1", fixed),
      codingHarness: { id: "claude-code", version: "2.1.219" },
      harnessCursor,
    });

    const selected = store.setCodingHarness("sess-1", {
      id: "claude-code",
      version: "2.1.220",
    });

    expect(selected?.codingHarness).toEqual({ id: "claude-code", version: "2.1.220" });
    expect(selected?.harnessCursor).toEqual(harnessCursor);
  });

  it("returns undefined for an absent or malformed file (fail-safe read)", () => {
    const dir = tmpDir();
    const store = new SessionStore(dir);
    expect(store.load("missing")).toBeUndefined();
    writeFileSync(join(dir, "junk.json"), "{ not json");
    expect(store.load("junk")).toBeUndefined();
    // a malformed file is skipped by list(), not thrown
    expect(store.list()).toEqual([]);
  });

  it("lists persisted sessions newest first", () => {
    const store = new SessionStore(tmpDir());
    store.save(mintSession("p", { id: () => "a", now: () => 100 }));
    store.save(mintSession("p", { id: () => "b", now: () => 300 }));
    store.save(mintSession("p", { id: () => "c", now: () => 200 }));
    expect(store.list().map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("archive is soft — the record survives on disk with archivedAt", () => {
    const store = new SessionStore(tmpDir(), { now: () => 5000 });
    store.save(mintSession("proj-1", fixed));
    const archived = store.archive("sess-1");
    expect(archived?.archivedAt).toBe(5000);
    const reloaded = store.load("sess-1");
    expect(reloaded?.archivedAt).toBe(5000); // still readable, just archived
  });

  it("adds a thread reference through the store (frozen union enforced)", () => {
    const store = new SessionStore(tmpDir());
    store.save(mintSession("proj-1", fixed));
    const updated = store.addThread("sess-1", { threadId: "th-1", anchor: codeAnchor });
    expect(updated?.threads).toHaveLength(1);
    expect(store.load("sess-1")?.threads[0]?.threadId).toBe("th-1");
    // an ask without an anchor is refused by the pure layer, never stored
    expect(() =>
      store.addThread("sess-1", {
        threadId: "th-2",
        ask: { intent: "x", exitLane: "round", provenance: "p", lifecycle: "staged" },
      } as unknown as SessionThread),
    ).toThrow();
  });

  // ── The workspace binding (session-bound-workspace 5.1) ─────────────────────────────────
  it("records a bound workspace on a session written before the field existed, once", () => {
    const dir = tmpDir();
    // A record from before the binding wave: no `boundRoot`, and no `contextRoot` either.
    writeFileSync(
      join(dir, "pre-wave.json"),
      JSON.stringify({
        id: "pre-wave",
        projectId: "proj-1",
        repositoryRoot: "/repos/alpha",
        claim: { branch: "feat/x" },
        threads: [],
        createdAt: 900,
      }),
    );
    const store = new SessionStore(dir);
    // It still PARSES: a stricter schema would drop the record, and `list()` dropping a
    // record is read by the context sweep as "that session is gone" — a live session's
    // files deleted under it.
    const loaded = store.load("pre-wave");
    expect(loaded?.id).toBe("pre-wave");
    expect(loaded?.boundRoot).toBeUndefined();

    // First use binds it lazily and records it...
    expect(store.setBoundRoot("pre-wave", "/repos/alpha")?.boundRoot).toBe("/repos/alpha");
    expect(new SessionStore(dir).load("pre-wave")?.boundRoot).toBe("/repos/alpha");
    // ...and the binding is decided ONCE: a later ask keeps the recorded root rather than
    // moving a live session's workspace under its own running turns.
    expect(store.setBoundRoot("pre-wave", "/repos/beta")?.boundRoot).toBe("/repos/alpha");
    expect(store.setBoundRoot("no-such-session", "/repos/alpha")).toBeUndefined();
  });
});
