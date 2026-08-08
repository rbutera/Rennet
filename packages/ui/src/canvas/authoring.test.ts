import type { Disposition } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  addToBatch,
  authorDisposition,
  batchPayload,
  batchPayloadDigest,
  batchViewModel,
  type DispositionBatch,
  draftsFromAuthored,
  editDraftBody,
  editDraftType,
  orphanedDispositions,
  withdrawDraft,
} from "./authoring";
import { demoCanvases } from "./fixtures";

const canvases = demoCanvases();
// cohort:c2 == chunk c2 == two files; every finer altitude under it resolves to
// exactly these two paths, so the six-granularity assertions share one target.
const C2_PATHS = ["src/module-2/file-1.ts", "src/module-2/file-2.ts"];

describe("authorDisposition — a disposition at every granularity, traced to per-anchor L2", () => {
  it("resolves cohort granularity to the cohort's file paths, one traced act", () => {
    const { writes, trace } = authorDisposition(canvases.decisions, {
      granularity: "cohort",
      cohortKey: "cohort:c2",
      type: "approve",
      body: "cohort ok",
    });
    expect(writes.map((w) => w.path).sort()).toEqual(C2_PATHS);
    expect(writes.every((w) => w.type === "approve" && w.body === "cohort ok")).toBe(true);
    expect(trace.granularity).toBe("cohort");
    expect(trace.source).toBe("cohort:c2");
    expect(trace.writes).toEqual(writes);
  });

  it("resolves element granularity through the element's chunk", () => {
    const { writes, trace } = authorDisposition(canvases.decisions, {
      granularity: "element",
      elementKey: "dec-2-1",
      type: "comment",
      body: "",
    });
    expect(writes.map((w) => w.path).sort()).toEqual(C2_PATHS);
    expect(trace.granularity).toBe("element");
    expect(trace.source).toBe("dec-2-1");
  });

  it("resolves symbol granularity through its element, labelled symbol", () => {
    const { writes, trace } = authorDisposition(canvases.decisions, {
      granularity: "symbol",
      elementKey: "dec-2-1",
      type: "question",
      body: "why here?",
    });
    expect(writes.map((w) => w.path).sort()).toEqual(C2_PATHS);
    expect(trace.granularity).toBe("symbol");
  });

  it("resolves hunk granularity through the hunk's containing chunk", () => {
    const { writes, trace } = authorDisposition(canvases.decisions, {
      granularity: "hunk",
      hunkId: "c2-h1",
      type: "approve",
      body: "",
    });
    expect(writes.map((w) => w.path).sort()).toEqual(C2_PATHS);
    expect(trace.granularity).toBe("hunk");
    expect(trace.source).toBe("c2-h1");
  });

  it("resolves line granularity through the hunk's chunk, recording the span in the trace", () => {
    const { writes, trace } = authorDisposition(canvases.decisions, {
      granularity: "line",
      hunkId: "c2-h1",
      span: { startLine: 3, endLine: 5 },
      type: "request-change",
      body: "off-by-one",
    });
    expect(writes.map((w) => w.path).sort()).toEqual(C2_PATHS);
    expect(writes.every((w) => w.type === "request-change")).toBe(true);
    expect(trace.granularity).toBe("line");
    expect(trace.source).toContain("c2-h1");
    expect(trace.source).toContain("3");
  });

  it("resolves roll-up granularity to the whole changeset, one act", () => {
    const { writes, trace } = authorDisposition(canvases.decisions, {
      granularity: "rollup",
      type: "approve",
      body: "",
    });
    const distinct = new Set(
      canvases.decisions.layers.substrate.chunks.flatMap((c) => c.filePaths),
    );
    expect(new Set(writes.map((w) => w.path))).toEqual(distinct);
    expect(writes.length).toBe(distinct.size);
    expect(trace.granularity).toBe("rollup");
    // A group act is ONE user act fanning out — the trace binds the one act to N writes.
    expect(trace.writes).toEqual(writes);
  });
});

describe("the raw-draft batch — the sovereign payload that will publish or hand off", () => {
  function seededBatch(): DispositionBatch {
    const authored = authorDisposition(canvases.decisions, {
      granularity: "cohort",
      cohortKey: "cohort:c2",
      type: "comment",
      body: "raw lazy note",
    });
    return addToBatch([], draftsFromAuthored(authored));
  }

  it("carries the raw body verbatim (lazy/vague is supported, no refinement)", () => {
    const batch = seededBatch();
    expect(batch.every((d) => d.raw === "raw lazy note")).toBe(true);
  });

  it("upserts by path (a later act on the same path replaces the earlier draft)", () => {
    const first = seededBatch();
    const second = addToBatch(
      first,
      draftsFromAuthored(
        authorDisposition(canvases.decisions, {
          granularity: "cohort",
          cohortKey: "cohort:c2",
          type: "approve",
          body: "changed my mind",
        }),
      ),
    );
    expect(second.filter((d) => d.path === "src/module-2/file-1.ts").length).toBe(1);
    expect(second.find((d) => d.path === "src/module-2/file-1.ts")?.type).toBe("approve");
    expect(second.find((d) => d.path === "src/module-2/file-1.ts")?.raw).toBe("changed my mind");
  });

  it("payload is the sorted raw→body transform, not the raw batch (byte-stable)", () => {
    // An intentionally UNSORTED batch carrying a `raw` field: the payload must
    // reorder by path AND rename raw→body. This can go red if `batchViewModel`
    // stops sorting or stops projecting `raw`→`body`. (The view==payload identity
    // is asserted against the RENDERED <BatchView> in authoring-surface.test.tsx.)
    const batch: DispositionBatch = [
      { path: "z/last.ts", type: "comment", raw: "note-z" },
      { path: "a/first.ts", type: "approve", raw: "note-a" },
    ];
    expect(batchPayload(batch)).toBe(
      JSON.stringify([
        { path: "a/first.ts", type: "approve", body: "note-a" },
        { path: "z/last.ts", type: "comment", body: "note-z" },
      ]),
    );
    // Proof the transform is load-bearing: the payload is NOT the raw serialisation.
    expect(batchPayload(batch)).not.toBe(JSON.stringify(batch));
  });

  it("edit-body and edit-type flow through to the payload", () => {
    let batch = seededBatch();
    batch = editDraftBody(batch, "src/module-2/file-1.ts", "sharpened");
    batch = editDraftType(batch, "src/module-2/file-1.ts", "request-change");
    const entry = batchViewModel(batch).find((w) => w.path === "src/module-2/file-1.ts");
    expect(entry?.body).toBe("sharpened");
    expect(entry?.type).toBe("request-change");
  });

  it("withdraw-before-publish leaves ZERO residue, and removes ONLY the withdrawn paths", () => {
    const sentinel = "SENTINEL-Z9Q";
    const survivor = "SURVIVOR-K3P";
    const authored = authorDisposition(canvases.decisions, {
      granularity: "element",
      elementKey: "dec-2-1",
      type: "comment",
      body: sentinel,
    });
    // The element's two files PLUS an unrelated survivor draft, so a clear-all
    // (over-broad) withdraw would drop the survivor too and go red here.
    let batch = addToBatch([], draftsFromAuthored(authored));
    batch = addToBatch(batch, [{ path: "src/other.ts", type: "approve", raw: survivor }]);
    expect(batchPayload(batch)).toContain(sentinel);
    let after: DispositionBatch = batch;
    for (const path of C2_PATHS) after = withdrawDraft(after, path);
    expect(batchPayload(after)).not.toContain(sentinel);
    expect(batchPayload(after)).toContain(survivor); // surgical, not a clear-all
    expect(after.map((draft) => draft.path)).toEqual(["src/other.ts"]);
  });

  it("payload digest is a pure function of batch content (order-independent)", () => {
    const batch = seededBatch();
    const reversed = [...batch].reverse();
    expect(batchPayloadDigest(reversed)).toBe(batchPayloadDigest(batch));
  });
});

describe("orphanedDispositions — a disposition that failed to carry surfaces, never vanishes", () => {
  const carried: Disposition = {
    anchor: { path: "src/keep.ts", contentDigest: "same" },
    type: "approve",
    body: "",
  };
  const dropped: Disposition = {
    anchor: { path: "src/changed.ts", contentDigest: "old" },
    type: "request-change",
    body: "needs work",
  };

  it("returns exactly the before-dispositions absent after activation", () => {
    const before = [carried, dropped];
    const after = [carried]; // the engine's byte-identical carry kept only `carried`
    const orphans = orphanedDispositions(before, after);
    expect(orphans).toEqual([dropped]);
  });

  it("treats a same-path but changed-digest disposition as orphaned (fail-closed)", () => {
    const before = [dropped];
    const after: Disposition[] = [
      { anchor: { path: "src/changed.ts", contentDigest: "new" }, type: "approve", body: "" },
    ];
    expect(orphanedDispositions(before, after)).toEqual([dropped]);
  });

  it("is empty when everything carried", () => {
    expect(orphanedDispositions([carried], [carried])).toEqual([]);
  });

  it("surfaces a dropped span even when a sibling span on the SAME file carried (issue #78 span-aware key)", () => {
    // Two span-grained dispositions on ONE file: identical `path` AND `contentDigest`
    // (the whole-file digest), differing only in their span/side. Pre-#78 the key was
    // [path, contentDigest], so both spans shared a key — the dropped span collided with
    // the carried one and vanished from the tray. The span-aware key distinguishes them.
    const carriedSpan: Disposition = {
      anchor: {
        path: "src/multi.ts",
        contentDigest: "file-digest",
        span: { startLine: 5, endLine: 10 },
        side: "additions",
        spanDigest: "span-a",
      },
      type: "approve",
      body: "top span ok",
    };
    const droppedSpan: Disposition = {
      anchor: {
        path: "src/multi.ts",
        contentDigest: "file-digest",
        span: { startLine: 20, endLine: 25 },
        side: "additions",
        spanDigest: "span-b",
      },
      type: "request-change",
      body: "bottom span needs work",
    };
    const before = [carriedSpan, droppedSpan];
    const after = [carriedSpan]; // only the top span carried onto the new patchset
    expect(orphanedDispositions(before, after)).toEqual([droppedSpan]);
  });
});
