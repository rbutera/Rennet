import type { SessionThread } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { addThread, archive, attachReview, bindTarget, mintSession } from "./state";

const fixed = { id: () => "sess-1", now: () => 1000 };
const claim = { branch: "feat/x", prNumber: 12 } as const;
const codeAnchor = {
  type: "code",
  ref: { patchsetId: "ps-1", path: "a.ts", side: "head", startLine: 1, endLine: 4 },
} as const;

describe("session state machine (#466 res. 1–2, B09 cluster 1)", () => {
  it("mints a no-target session (no claim, no review, empty threads)", () => {
    const s = mintSession("proj-1", fixed);
    expect(s).toEqual({ id: "sess-1", projectId: "proj-1", threads: [], createdAt: 1000 });
    expect(s.claim).toBeUndefined();
    expect(s.reviewId).toBeUndefined();
  });

  it("mint → bind → attach → lock → archive", () => {
    const bound = bindTarget(mintSession("proj-1", fixed), claim);
    expect(bound.id).toBe("sess-1"); // upgrade in place preserves the id
    expect(bound.claim).toEqual(claim);

    const reviewed = attachReview(bound, "rev-9");
    expect(reviewed.reviewId).toBe("rev-9");

    // lock: a claimed session refuses a second target — new target = new session
    expect(() => bindTarget(reviewed, { branch: "feat/y" })).toThrow(/new session/);

    const archived = archive(reviewed, () => 2000);
    expect(archived.archivedAt).toBe(2000);
    // idempotent: re-archiving keeps the original stamp
    expect(archive(archived, () => 3000).archivedAt).toBe(2000);
  });

  it("attachReview is idempotent for the same review, refuses a different one", () => {
    const s = attachReview(mintSession("proj-1", fixed), "rev-9");
    expect(attachReview(s, "rev-9").reviewId).toBe("rev-9");
    expect(() => attachReview(s, "rev-other")).toThrow(/at most one review/);
  });

  it("adds an anchored-arm thread (ask requires an anchor) and a plain thread (no ask)", () => {
    let s = mintSession("proj-1", fixed);
    const anchored: SessionThread = {
      threadId: "th-1",
      anchor: codeAnchor,
      ask: { intent: "tighten", exitLane: "round", provenance: "el-3", lifecycle: "staged" },
    };
    s = addThread(s, anchored);
    s = addThread(s, { threadId: "th-2" });
    expect(s.threads).toHaveLength(2);

    // frozen union: an ask without an anchor does not parse (does not store)
    expect(() =>
      addThread(s, {
        threadId: "th-3",
        ask: { intent: "x", exitLane: "round", provenance: "p", lifecycle: "staged" },
      } as unknown as SessionThread),
    ).toThrow();
  });
});
