import type { PatchFile, Patchset, Review, RspProvenance } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import type { CanvasOpsEffect, RunLedgerEntry } from "./canvas-ops";
import { buildReviewCanvases, type ReviewPipelineResult } from "./pipeline";
import { reviewBackendCore } from "./review-backend";

// ─────────────────────────────────────────────────────────────────────────────
// The pure production-backend core over a REAL fixture review: a real patchset →
// real decomposition → real canvases through `buildReviewCanvases` (deterministic
// floor, no harness). Every assertion is against diff-derived data, never a mock.
// ─────────────────────────────────────────────────────────────────────────────

const repository = {
  id: "repo",
  root: "/repo",
  commonDir: "/repo/.git",
  baseRef: "main",
  baseOid: "base-oid",
  headOid: "head-oid",
};

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: 3, deletions: 1, binary: false, patch };
}

const ALPHA = `@@ -1,3 +1,6 @@
 export function alpha() {
-  return 1;
+  const value = compute(2);
+  logger.info(value);
+  return value;
 }
+
+export const beta = () => alpha() + 1;`;
const GAMMA = `@@ -1,2 +1,5 @@
 import { alpha } from "./alpha";
+
+export function gamma() {
+  return alpha() * 3;
+}`;

const PATCHSET: Patchset = {
  id: "ps-1",
  createdAt: "2026-08-10T00:00:00.000Z",
  repository,
  files: [file("src/alpha.ts", ALPHA), file("src/gamma.ts", GAMMA)],
  rawDiff: [ALPHA, GAMMA].join("\n"),
  byteLength: 0,
  truncated: false,
};

const REVIEW: Review = {
  id: "review-1",
  repositoryRoot: "/repo",
  patchsets: [PATCHSET],
  activePatchsetId: "ps-1",
  dispositions: [],
  status: "current",
};

async function fixture(): Promise<ReviewPipelineResult> {
  return buildReviewCanvases({ reviewId: REVIEW.id, patchset: PATCHSET, dispositions: [] });
}

describe("reviewBackendCore — the pure production backend over a real review", () => {
  it("is a strict subset of CanvasOpsBackend (no store-backed Repo-Map accessors)", async () => {
    const core = reviewBackendCore({ review: REVIEW, pipeline: await fixture() });
    // The three store-backed reads are supplied by the composition root, not core.
    expect("projectMap" in core).toBe(false);
    expect("fileContext" in core).toBe(false);
    expect("novelty" in core).toBe(false);
    // Everything else IS present.
    for (const key of [
      "identity",
      "freshness",
      "angles",
      "canvas",
      "view",
      "element",
      "thread",
      "hunk",
      "searchDiff",
      "decomposition",
      "runLedger",
      "provenance",
      "planRecompute",
      "applyEffects",
    ]) {
      expect(typeof (core as Record<string, unknown>)[key]).toBe("function");
    }
  });

  it("identity + view + angles come from the live review and built canvases", async () => {
    const pipeline = await fixture();
    const core = reviewBackendCore({ review: REVIEW, pipeline });
    const id = core.identity();
    expect(id.reviewId).toBe("review-1");
    expect(id.patchsetId).toBe("ps-1");
    expect(id.repo).toBe("/repo");

    const angles = core.angles();
    expect(angles.length).toBeGreaterThan(0);
    // Every reported angle resolves to a real built canvas.
    for (const angle of angles) expect(pipeline.canvases[angle]).toBeDefined();

    const view = core.view();
    expect(view.openCanvasId).toBeDefined();
    expect(view.expandedCohorts).toEqual([]);
    // The active canvas resolves by its own id, and by default.
    expect(core.canvas()?.canvasId).toBe(view.openCanvasId);
    expect(core.canvas(view.openCanvasId)?.canvasId).toBe(view.openCanvasId);
    expect(core.canvas("no-such-canvas")).toBeUndefined();
  });

  it("decomposition + hunk + searchDiff serve the real captured diff", async () => {
    const pipeline = await fixture();
    const core = reviewBackendCore({ review: REVIEW, pipeline });

    const decomposition = core.decomposition();
    expect(decomposition).toBe(pipeline.decomposition);
    expect(decomposition.hunks.length).toBeGreaterThan(0);

    const firstHunk = decomposition.hunks[0];
    if (!firstHunk) throw new Error("expected at least one hunk");
    const detail = core.hunk(firstHunk.id);
    expect(detail?.hunkId).toBe(firstHunk.id);
    expect(detail?.file).toBe(firstHunk.filePath);
    expect(detail?.lineage).toBe("new");
    // Real captured bytes, not a fixture: the rendered content carries a hunk header.
    expect(detail?.content).toContain("@@");
    // Resolvable by the `rennet:hunk/<id>` anchor form too.
    expect(core.hunk(`rennet:hunk/${firstHunk.id}`)?.hunkId).toBe(firstHunk.id);

    // searchDiff finds a real changed path; a nonsense query is a clean empty.
    const hits = core.searchDiff("alpha");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.file?.includes("alpha"))).toBe(true);
    expect(core.searchDiff("zzz-no-such-symbol-zzz")).toEqual([]);
  });

  it("element reads a real analysis element with its provenance pointer", async () => {
    const pipeline = await fixture();
    const core = reviewBackendCore({ review: REVIEW, pipeline });
    // The sequence canvas carries the decomposition's elements from the floor.
    const element = pipeline.canvases.sequence?.layers.analysis.elements[0];
    if (!element) throw new Error("expected at least one analysis element");
    const detail = core.element(element.elementKey);
    expect(detail?.refKind).toBe("element");
    expect(detail?.element?.elementKey).toBe(element.elementKey);
    expect(detail?.provenancePointer).toBe(element.docId);
    // A ref that addresses nothing is undefined (the tool turns it into not-found).
    expect(core.element("no-such-ref")).toBeUndefined();
  });

  it("runLedger + provenance are distinguished-empty in v1, never a fabricated row", async () => {
    const pipeline = await fixture();
    const core = reviewBackendCore({ review: REVIEW, pipeline });
    // POSITIVE CONTROL: a fabricated ledger row would be caught — the honest v1
    // ledger is empty, and provenance for any doc is unrecorded.
    expect(core.runLedger()).toEqual([]);
    expect(core.runLedger("proposal")).toEqual([]);
    expect(core.provenance("doc_dec")).toBeUndefined();

    // The accessor READS state (it does not ignore it): recorded rows/provenance
    // are served, so the empty result above is a real absence, not a stub.
    const row: RunLedgerEntry = {
      runId: "run_1",
      purpose: "proposal",
      tier: "light",
      model: "m",
      admitted: 3,
      rejected: 0,
    };
    const provenance = { runId: "run_1" } as unknown as RspProvenance;
    const wired = reviewBackendCore({
      review: REVIEW,
      pipeline,
      runLedger: [row],
      provenanceByDoc: new Map([["doc_dec", provenance]]),
    });
    expect(wired.runLedger()).toEqual([row]);
    expect(wired.runLedger("nope")).toEqual([]);
    expect(wired.provenance("doc_dec")?.runId).toBe("run_1");
  });

  it("planRecompute is the real Brita budget gate over the live decomposition", async () => {
    const pipeline = await fixture();
    const core = reviewBackendCore({ review: REVIEW, pipeline });
    const plan = core.planRecompute("rennet:chunk/c1", "decisions");
    // A real plan (not a stub): the small fixture is within budget.
    expect(plan.refused).toBe(false);
    if (!plan.refused) expect(plan.invocations.length).toBeGreaterThan(0);
  });

  it("planRecompute normalizes a malformed ceiling before the Brita gate — no fake refusal (#269 follow-up)", async () => {
    // review-backend passed raw routePlanOptions to buildRoutePlan, so a malformed
    // maxHarnessInvocations (-1) refused pre-flight — the same raw-read-one-hop-over
    // shape as the pipeline bug (#269). Normalizing here sends it to the default, so a
    // within-budget decomposition is NOT refused. Red-proved by reverting the fix.
    const pipeline = await fixture();
    const core = reviewBackendCore({
      review: REVIEW,
      pipeline,
      routePlanOptions: { maxHarnessInvocations: -1 },
    });
    const plan = core.planRecompute("rennet:chunk/c1", "decisions");
    expect(plan.refused).toBe(false);
  });

  it("freshness defaults to current and honours an explicit stale override", async () => {
    const pipeline = await fixture();
    expect(reviewBackendCore({ review: REVIEW, pipeline }).freshness()).toBe("current");
    expect(reviewBackendCore({ review: REVIEW, pipeline, freshness: "stale" }).freshness()).toBe(
      "stale",
    );
  });

  it("thread is a distinguished nothing-found (no v1 clarification store)", async () => {
    const core = reviewBackendCore({ review: REVIEW, pipeline: await fixture() });
    expect(core.thread("any-disposition")).toBeUndefined();
  });

  it("applyEffects forwards the L2-free effect union to the injected sink", async () => {
    const sink = vi.fn();
    const core = reviewBackendCore({
      review: REVIEW,
      pipeline: await fixture(),
      applyEffects: sink,
    });
    const effects: CanvasOpsEffect[] = [{ kind: "focus", target: "rennet:chunk/c1" }];
    core.applyEffects(effects);
    expect(sink).toHaveBeenCalledWith(effects);
    // Structurally impossible to route an L2 disposition write: the effect union
    // has no such variant, so anything the sink receives is L3/presentational/recompute.
    expect(effects.every((e) => e.kind !== ("disposition" as unknown))).toBe(true);
  });
});
