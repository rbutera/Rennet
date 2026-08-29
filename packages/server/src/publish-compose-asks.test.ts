import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskLogStore } from "@rennet/adapters";
import {
  canonicalReviewPayload,
  deriveReviewEvent,
  type ReviewBodyNote,
  type ReviewCommentInput,
  resolveReviewEvent,
  reviewBodyNotesFromProjection,
  reviewCommentsFromProjection,
} from "@rennet/core";
import { describe, expect, it } from "vitest";

// B11 cluster 3 — the two-strata compose over the durable ask projection. These exercise the
// pure mapping (`reviewCommentsFromProjection`) directly over a real on-disk `AskLogStore`, so
// the durable→compose path (append → foldAsks → compose) is proven end-to-end without the full
// dispatch harness. The integration round-trip (compose → publish.review byte-exact) lives in
// `dispatch.test.ts` where the whole command surface is wired.

function freshStore(): { store: AskLogStore; dir: string; sid: string } {
  const dir = mkdtempSync(join(tmpdir(), "rennet-compose-asks-"));
  return { store: new AskLogStore(dir), dir, sid: "review-1" };
}

describe("reviewCommentsFromProjection (B11 cluster 3) — the two-strata compose over the projection", () => {
  it("composes staged line asks + bare line comments in deterministic (path, line) order", () => {
    const { store, sid } = freshStore();
    store.append(sid, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/b.ts:5", type: "request-change", body: "rename" },
    });
    store.append(sid, {
      kind: "stage",
      ask: { id: "a2", anchor: "src/a.ts:10", type: "comment", body: "nit" },
    });
    store.append(sid, { kind: "line-comment-set", path: "src/a.ts", line: 3, body: "typo" });

    // Sorted by path then line, regardless of the append/Record order above.
    expect(reviewCommentsFromProjection(store.readProjection(sid))).toEqual<ReviewCommentInput[]>([
      { path: "src/a.ts", line: 3, side: "RIGHT", type: "comment", body: "typo" },
      { path: "src/a.ts", line: 10, side: "RIGHT", type: "comment", body: "nit" },
      { path: "src/b.ts", line: 5, side: "RIGHT", type: "request-change", body: "rename" },
    ]);
  });

  it("collapses an ask and a bare line comment on one path:line to the ask (dual-claim)", () => {
    const { store, sid } = freshStore();
    store.append(sid, { kind: "line-comment-set", path: "src/a.ts", line: 7, body: "bare note" });
    store.append(sid, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/a.ts:7", type: "request-change", body: "the ask wins" },
    });
    // One comment on 7 — the ask claims the line (its intent type + body), not two posts.
    expect(reviewCommentsFromProjection(store.readProjection(sid))).toEqual<ReviewCommentInput[]>([
      { path: "src/a.ts", line: 7, side: "RIGHT", type: "request-change", body: "the ask wins" },
    ]);
  });

  it("excludes retired asks from comments, and routes a prose ask into the BODY stratum (finding 2)", () => {
    const { store, sid } = freshStore();
    store.append(sid, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/a.ts:1", type: "comment", body: "keep" },
    });
    store.append(sid, {
      kind: "stage",
      ask: { id: "a2", anchor: "src/a.ts:2", type: "comment", body: "gone" },
    });
    store.append(sid, { kind: "retire", id: "a2", reason: "dupe" });
    // A prose ask has no diff line — it must travel in the review BODY, never vanish (P0 finding 2).
    store.append(sid, {
      kind: "stage",
      ask: { id: "a3", anchor: "This reads well.", type: "request-change", body: "tighten this" },
    });
    const projection = store.readProjection(sid);
    // The code-anchored ask is a line comment; the retired one is gone; the prose ask is NOT here.
    expect(reviewCommentsFromProjection(projection)).toEqual<ReviewCommentInput[]>([
      { path: "src/a.ts", line: 1, side: "RIGHT", type: "comment", body: "keep" },
    ]);
    // The prose ask surfaces as a review-BODY note (exactly once) — the lost reviewer intent.
    expect(reviewBodyNotesFromProjection(projection)).toEqual<ReviewBodyNote[]>([
      {
        id: "a3",
        type: "request-change",
        body: "tighten this",
        anchor: "This reads well.",
      },
    ]);
  });

  it("PARTITIONS every staged ask: each appears EXACTLY ONCE across line comments + body notes (finding 2)", () => {
    const { store, sid } = freshStore();
    store.append(sid, {
      kind: "stage",
      ask: { id: "c1", anchor: "src/a.ts:5", type: "request-change", body: "code ask" },
    });
    store.append(sid, {
      kind: "stage",
      ask: { id: "p1", anchor: "A quoted board sentence.", type: "comment", body: "prose ask" },
    });
    store.append(sid, {
      kind: "stage",
      ask: { id: "po1", anchor: "src/onlypath.ts", type: "comment", body: "path-only ask" },
    });
    const projection = store.readProjection(sid);
    const comments = reviewCommentsFromProjection(projection);
    const bodyNotes = reviewBodyNotesFromProjection(projection);
    // Three staged asks → three outbound items, each in exactly one stratum, none dropped, none doubled.
    const bodies = [...comments.map((c) => c.body), ...bodyNotes.map((n) => n.body)].sort();
    expect(bodies).toEqual(["code ask", "path-only ask", "prose ask"]);
    // The code ask is a line comment; the prose + path-only asks (no diff line) are body notes.
    expect(comments.map((c) => c.body)).toEqual(["code ask"]);
    expect(bodyNotes.map((n) => n.body).sort()).toEqual(["path-only ask", "prose ask"]);
  });

  it("carries a DELETION-side (LEFT) ask to the LEFT side, not the hardcoded RIGHT (finding 7)", () => {
    const { store, sid } = freshStore();
    // A deletion-side ask (the reviewer commented on a removed line — the pre-image).
    store.append(sid, {
      kind: "stage",
      ask: {
        id: "d1",
        anchor: "src/a.ts:12",
        type: "request-change",
        body: "this deletion is wrong",
        side: "LEFT",
      },
    });
    // A default (additions-side) ask still posts RIGHT.
    store.append(sid, {
      kind: "stage",
      ask: { id: "r1", anchor: "src/a.ts:20", type: "comment", body: "post-image note" },
    });
    expect(reviewCommentsFromProjection(store.readProjection(sid))).toEqual<ReviewCommentInput[]>([
      {
        path: "src/a.ts",
        line: 12,
        side: "LEFT",
        type: "request-change",
        body: "this deletion is wrong",
      },
      { path: "src/a.ts", line: 20, side: "RIGHT", type: "comment", body: "post-image note" },
    ]);
  });

  it("uses canonical CodeRef provenance and keeps same-number LEFT and RIGHT positions distinct", () => {
    const { store, sid } = freshStore();
    store.append(sid, { kind: "line-comment-set", path: "src/a.ts", line: 12, body: "right note" });
    store.append(sid, {
      kind: "stage",
      ask: {
        id: "left",
        anchor: "legacy prose that must not decide placement",
        type: "request-change",
        body: "restore the removed branch",
        side: "RIGHT",
        codeRef: {
          patchsetId: "patchset-1",
          path: "src/a.ts",
          side: "base",
          startLine: 12,
          endLine: 14,
        },
      },
    });

    const projection = store.readProjection(sid);
    expect(reviewCommentsFromProjection(projection)).toEqual<ReviewCommentInput[]>([
      {
        path: "src/a.ts",
        line: 12,
        side: "LEFT",
        type: "request-change",
        body: "restore the removed branch",
      },
      { path: "src/a.ts", line: 12, side: "RIGHT", type: "comment", body: "right note" },
    ]);
    expect(reviewBodyNotesFromProjection(projection)).toEqual([]);
  });

  it("an empty ask set composes nothing to post", () => {
    const { store, sid } = freshStore();
    expect(reviewCommentsFromProjection(store.readProjection(sid))).toEqual([]);
  });

  it("the verdict override wins over the derived event; clearing it derives again", () => {
    const { store, sid } = freshStore();
    store.append(sid, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/a.ts:1", type: "request-change", body: "x" },
    });
    const derived = reviewCommentsFromProjection(store.readProjection(sid));
    expect(deriveReviewEvent(derived)).toBe("REQUEST_CHANGES");

    store.append(sid, { kind: "verdict-override-set", verdict: "COMMENT" });
    const overridden = store.readProjection(sid);
    expect(
      resolveReviewEvent(
        reviewCommentsFromProjection(overridden),
        overridden.verdictOverride ?? undefined,
      ),
    ).toBe("COMMENT");

    store.append(sid, { kind: "verdict-override-clear" });
    const cleared = store.readProjection(sid);
    expect(
      resolveReviewEvent(
        reviewCommentsFromProjection(cleared),
        cleared.verdictOverride ?? undefined,
      ),
    ).toBe("REQUEST_CHANGES");
  });

  it("a projection round-tripped through disk composes identically (durable→compose)", () => {
    const { store, dir, sid } = freshStore();
    store.append(sid, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/a.ts:4", type: "comment", body: "note" },
    });
    store.append(sid, { kind: "line-comment-set", path: "src/z.ts", line: 9, body: "z" });
    store.append(sid, { kind: "verdict-override-set", verdict: "APPROVE" });
    const beforePayload = canonicalReviewPayload(
      reviewCommentsFromProjection(store.readProjection(sid)),
    );

    // A fresh store over the SAME dir (a restarted host) folds the same log to the same projection.
    const restarted = new AskLogStore(dir);
    expect(
      canonicalReviewPayload(reviewCommentsFromProjection(restarted.readProjection(sid))),
    ).toBe(beforePayload);
    expect(restarted.readProjection(sid).verdictOverride).toBe("APPROVE");
  });
});
