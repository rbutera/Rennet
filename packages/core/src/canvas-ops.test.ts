import type {
  AnchorKind,
  CanvasAngle,
  Decomposition,
  Disposition,
  RspProvenance,
} from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  type AdmittedDocument,
  buildCanvas,
  type CanvasEvent,
  canvasId,
  dispatchUserCanvasCommand,
  foldCanvas,
  ORCHESTRATOR_CANVAS_OPS,
  USER_CANVAS_COMMANDS,
} from "./canvas";
import {
  CANVAS_OPS_TOOLS,
  CANVAS_OPS_VERSION,
  type CanvasOpsBackend,
  type CanvasOpsEffect,
  type CanvasOpsTool,
  canvasOpsTool,
  type DiffHit,
  type ElementDetail,
  type HunkDetail,
  type OpsEnvelope,
  type OpsFreshness,
  type ReviewIdentity,
  type RunLedgerEntry,
  type ThreadDetail,
  type ToolOutcome,
  type ViewState,
} from "./canvas-ops";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures: a small real decisions canvas built through buildCanvas, plus a
// mutable backend whose applyEffects folds L3 events so the L2-sovereignty trace
// (criterion 2) can be asserted against real canvas state, not a mock.
// ─────────────────────────────────────────────────────────────────────────────

const REVIEW_ID = "rev_1";
const PATCHSET_ID = "ps_1";

function makeDecomposition(): Decomposition {
  const chunk = (chunkId: string, hunkId: string, layer: number) => ({
    chunkId,
    kind: "substantive" as const,
    title: `chunk ${chunkId}`,
    layer,
    filePaths: [`src/${chunkId}.ts`],
    hunkIds: [hunkId],
    changedLoc: 3,
  });
  return {
    patchsetId: PATCHSET_ID,
    hunks: [],
    classifications: [],
    chunks: [chunk("c1", "h1", 0), chunk("c2", "h2", 1)],
    edges: [{ from: "c1", to: "c2", kind: "enables" }],
    readingOrder: ["c1", "c2"],
    residue: [],
  };
}

/** A decision.record with `count` decisions anchored to chunk `c1` and one to `c2`. */
function makeDecisionDoc(count: number): AdmittedDocument {
  const decisions = Array.from({ length: count }, (_, index) => ({
    decisionId: `d${index}`,
    anchor: index === count - 1 ? "rennet:chunk/c2" : "rennet:chunk/c1",
    title: `decision ${index}`,
  }));
  return { docId: "doc_dec", docType: "decision.record", body: { decisions } };
}

interface FixtureOptions {
  freshness?: OpsFreshness;
  decisionCount?: number;
  dispositions?: Disposition[];
  diffHits?: DiffHit[];
  overBudget?: boolean;
}

interface Fixture {
  backend: CanvasOpsBackend;
  applied: CanvasOpsEffect[];
  canvasEvents: CanvasEvent[];
  decisionsCanvasId: string;
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const decomposition = makeDecomposition();
  const admittedDocs = [makeDecisionDoc(options.decisionCount ?? 5)];
  const dispositions = options.dispositions ?? [];
  const canvasEvents: CanvasEvent[] = [];
  const applied: CanvasOpsEffect[] = [];
  const decisionsCanvasId = canvasId(REVIEW_ID, PATCHSET_ID, "decisions");

  const build = (angle: CanvasAngle) =>
    buildCanvas({
      reviewId: REVIEW_ID,
      patchsetId: PATCHSET_ID,
      angle,
      admittedDocs,
      decomposition,
      dispositions,
      canvasEvents,
    });

  const backend: CanvasOpsBackend = {
    identity: (): ReviewIdentity => ({ reviewId: REVIEW_ID, patchsetId: PATCHSET_ID }),
    freshness: (): OpsFreshness => options.freshness ?? "current",
    angles: () => ["decisions"],
    canvas: (id?: string) => {
      if (id !== undefined && id !== decisionsCanvasId) return undefined;
      return build("decisions");
    },
    view: (): ViewState => ({
      openCanvasId: decisionsCanvasId,
      angle: "decisions",
      expandedCohorts: ["cohort:c1"],
      selection: undefined,
    }),
    element: (ref: string): ElementDetail | undefined => {
      const canvas = build("decisions");
      const element = canvas.layers.analysis.elements.find((e) => e.elementKey === ref);
      if (!element) return undefined;
      return {
        refKind: "element",
        ref,
        element,
        body: { title: element.title },
        provenancePointer: element.docId,
        blastRadius: false,
      };
    },
    thread: (dispositionId: string): ThreadDetail | undefined =>
      dispositionId === "disp_known"
        ? { dispositionId, messages: [{ author: "user", body: "why?" }], refined: "clarified" }
        : undefined,
    hunk: (ref: string): HunkDetail | undefined =>
      ref === "rennet:hunk/h1"
        ? {
            ref,
            hunkId: "h1",
            file: "src/c1.ts",
            content: "+ line",
            lineage: "new",
            dispositions: [],
          }
        : undefined,
    searchDiff: (query: string): readonly DiffHit[] =>
      options.diffHits ??
      (query === "known"
        ? [{ anchor: "rennet:hunk/h1", kind: "hunk" as AnchorKind, file: "src/c1.ts" }]
        : []),
    decomposition: () => decomposition,
    runLedger: (): readonly RunLedgerEntry[] => [
      { runId: "run_1", purpose: "proposal", tier: "light", model: "m", admitted: 3, rejected: 0 },
    ],
    provenance: (docId: string): RspProvenance | undefined =>
      docId === "doc_dec"
        ? ({
            harness: "claude",
            harnessVersion: "1",
            adapterVersion: "1",
            model: "m",
            modelReportedBy: "harness",
            tier: "light",
            route: "agentic",
            runId: "run_1",
            inputDigest: "x",
            capability: {
              structuredOutput: {
                implementedByAdapter: true,
                advertisedByHarness: true,
                availableInSession: true,
              },
              perCallModelSelection: {
                implementedByAdapter: true,
                advertisedByHarness: true,
                availableInSession: true,
              },
            },
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 2 },
            reportedUsd: null,
            derivedUsd: null,
          } satisfies RspProvenance)
        : undefined,
    planRecompute: (scope: string, angle?: CanvasAngle) =>
      options.overBudget
        ? {
            refused: true,
            harnessInvocationCount: 9,
            maxHarnessInvocations: 5,
            reason: "over budget",
          }
        : {
            refused: false,
            invocations: [
              { purpose: "proposal", tier: "light", label: `${scope}:${angle ?? "all"}` },
            ],
            harnessInvocationCount: 1,
            maxHarnessInvocations: 5,
          },
    applyEffects: (effects) => {
      for (const effect of effects) {
        applied.push(effect);
        if (effect.kind === "annotate" || effect.kind === "propose")
          canvasEvents.push(effect.event);
      }
    },
  };

  return { backend, applied, canvasEvents, decisionsCanvasId };
}

function run(
  tool: CanvasOpsTool,
  args: Record<string, unknown>,
  backend: CanvasOpsBackend,
): ToolOutcome {
  return tool.handle(args, backend);
}

function expectOk<T>(outcome: ToolOutcome<T>): OpsEnvelope<T> {
  if (!outcome.ok) throw new Error(`expected ok, got error ${JSON.stringify(outcome.error)}`);
  return outcome.envelope;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("canvasOps@2 tool surface", () => {
  it("is versioned canvasOps@2 with the six interaction ops and seven retrieval ops", () => {
    expect(CANVAS_OPS_VERSION).toBe("canvasOps@2");
    const names = CANVAS_OPS_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "canvas.describe",
      "canvas.view",
      "canvas.focus",
      "canvas.annotate",
      "canvas.propose",
      "canvas.recompute",
      "canvas.read",
      "canvas.thread",
      "diff.read",
      "diff.search",
      "diff.structure",
      "run.ledger",
      "run.provenance",
    ]);
    // context.* rides the base-branch context issue — NOT on this surface.
    expect(names.some((n) => n.startsWith("context."))).toBe(false);
  });

  it("marks the hot trio always-loaded and read tools read-only", () => {
    const describe = canvasOpsTool("canvas.describe");
    const view = canvasOpsTool("canvas.view");
    expect(describe.alwaysLoad).toBe(true);
    expect(view.alwaysLoad).toBe(true);
    // Read-only: describe + view + the whole retrieval family.
    for (const name of [
      "canvas.describe",
      "canvas.view",
      "canvas.read",
      "canvas.thread",
      "diff.read",
      "diff.search",
      "diff.structure",
      "run.ledger",
      "run.provenance",
    ]) {
      expect(canvasOpsTool(name).readOnly).toBe(true);
    }
    // Not read-only: the presentational focus, the L3 writers, and the recompute request.
    for (const name of ["canvas.focus", "canvas.annotate", "canvas.propose", "canvas.recompute"]) {
      expect(canvasOpsTool(name).readOnly).toBe(false);
    }
  });

  // Acceptance criterion 1 ──────────────────────────────────────────────────
  it("round-trips describe(counts) → describe(cohorts) → read(one element)", () => {
    const { backend } = makeFixture({ decisionCount: 5 });
    const describe = canvasOpsTool("canvas.describe");

    const counts = expectOk(run(describe, { depth: "counts" }, backend));
    const countsData = counts.data as { elements: number; cohorts: number };
    expect(countsData.elements).toBe(5);
    expect(countsData.cohorts).toBe(2);
    expect(counts.freshness).toBe("current");

    const cohorts = expectOk(run(describe, { depth: "cohorts" }, backend));
    const cohortRows = cohorts.data as Array<{ cohortKey: string }>;
    expect(cohortRows.length).toBe(2);
    expect(cohorts.total).toBe(2);

    const elements = expectOk(run(describe, { depth: "elements" }, backend));
    const elementRows = elements.data as Array<{ elementKey: string; title: string }>;
    const firstKey = elementRows[0]?.elementKey ?? "";
    const read = canvasOpsTool("canvas.read");
    const element = expectOk(run(read, { ref: firstKey }, backend));
    const detail = element.data as ElementDetail;
    expect(detail.ref).toBe(firstKey);
    expect(detail.element?.elementKey).toBe(firstKey);
    expect(element.evidence).toContain("doc_dec");
  });

  // Acceptance criterion 3 ──────────────────────────────────────────────────
  it("paginates elements honestly with totality — the cursor walks to completion", () => {
    const { backend } = makeFixture({ decisionCount: 5 });
    const describe = canvasOpsTool("canvas.describe");

    const first = expectOk(run(describe, { depth: "elements", limit: 2 }, backend));
    const total = first.total ?? -1;
    const seen = (first.data as Array<{ elementKey: string }>).map((row) => row.elementKey);
    // A canvas bigger than one page: the first page must carry a non-null cursor.
    expect(first.cursor).toBeTruthy();
    let cursor = first.cursor ?? undefined;
    let pages = 1;
    while (cursor) {
      const env = expectOk(run(describe, { depth: "elements", limit: 2, cursor }, backend));
      const rows = env.data as Array<{ elementKey: string }>;
      for (const row of rows) seen.push(row.elementKey);
      pages += 1;
      // A silent cap is forbidden: while more remain, the cursor is non-null.
      if (rows.length > 0 && seen.length < total) expect(env.cursor).toBeTruthy();
      cursor = env.cursor ?? undefined;
      if (pages > 10) throw new Error("cursor failed to terminate");
    }
    expect(total).toBe(5);
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5); // each element exactly once
    expect(pages).toBe(3); // 2 + 2 + 1
  });

  // Acceptance criterion 4 ──────────────────────────────────────────────────
  it("rides a stale freshness verdict on the reply after a seeded patchset advance", () => {
    const { backend } = makeFixture({ freshness: "stale" });
    const describe = canvasOpsTool("canvas.describe");
    const read = canvasOpsTool("canvas.read");
    expect(expectOk(run(describe, { depth: "counts" }, backend)).freshness).toBe("stale");
    const canvas = backend.canvas();
    const key = canvas?.layers.analysis.elements[0]?.elementKey ?? "";
    expect(expectOk(run(read, { ref: key }, backend)).freshness).toBe("stale");
  });

  // Acceptance criterion 5 ──────────────────────────────────────────────────
  it("contains no user-only or engine-only op (structural)", () => {
    const names = new Set(CANVAS_OPS_TOOLS.map((t) => t.name));
    for (const userOp of USER_CANVAS_COMMANDS) {
      expect(names.has(userOp)).toBe(false);
    }
    const engineOps = ["project", "invalidate", "carry", "order"];
    for (const engineOp of engineOps) {
      expect(names.has(engineOp)).toBe(false);
      expect(names.has(`canvas.${engineOp}`)).toBe(false);
    }
    // The orchestrator interaction ops are exactly issue #10's vocabulary.
    for (const op of ORCHESTRATOR_CANVAS_OPS) {
      expect(names.has(op)).toBe(true);
    }
  });

  it("never produces an L2 disposition effect from any handler", () => {
    const { backend, applied } = makeFixture();
    // Exercise every write op with harmless args; none may push an L2 write.
    const outcomes = [
      run(canvasOpsTool("canvas.annotate"), { target: "rennet:chunk/c1", body: "mark" }, backend),
      run(
        canvasOpsTool("canvas.propose"),
        { kind: "disposition", targets: ["rennet:chunk/c1"], payload: "approve" },
        backend,
      ),
      run(canvasOpsTool("canvas.focus"), { target: "rennet:chunk/c1" }, backend),
      run(canvasOpsTool("canvas.recompute"), { scope: "rennet:chunk/c1" }, backend),
    ];
    // APPLY the effects each write op returned (the host's job) — this is what
    // populates `applied`. Without this the assertions below run over an empty
    // array and cannot go red.
    for (const outcome of outcomes) {
      if (!outcome.ok) throw new Error(`expected ok, got ${JSON.stringify(outcome.error)}`);
      backend.applyEffects(outcome.effects);
    }
    // Each of the four write ops emitted exactly its one legal effect — the
    // assertion goes red if any handler silently emits nothing, an extra effect,
    // or (the invariant) an L2 disposition write.
    expect(applied.map((e) => e.kind).sort()).toEqual([
      "annotate",
      "focus",
      "propose",
      "recompute",
    ]);
    // Structurally reinforced: no CanvasOpsEffect variant is a disposition write.
    expect(applied.map((e) => e.kind)).not.toContain("disposition");
  });

  // Acceptance criterion 2 ──────────────────────────────────────────────────
  it("raises a bulk proposal on L3; only user adjudication creates L2 (event trace)", () => {
    const { backend, applied, canvasEvents, decisionsCanvasId } = makeFixture();
    const propose = canvasOpsTool("canvas.propose");
    const outcome = run(
      propose,
      {
        kind: "disposition",
        targets: ["rennet:chunk/c1", "rennet:chunk/c2", "rennet:noisegroup/n1"],
        payload: "approve all three",
        canvasId: decisionsCanvasId,
      },
      backend,
    );
    const env = expectOk(outcome);
    // The proposal covers many anchors (bulk).
    const proposalData = env.data as { proposalId: string; targets: string[] };
    expect(proposalData.targets.length).toBe(3);

    // The effect is a ProposalRaised (L3), applied by the host.
    if (!outcome.ok) throw new Error("expected ok");
    backend.applyEffects(outcome.effects);
    expect(applied.some((e) => e.kind === "propose")).toBe(true);

    // Fold the canvas events: the proposal is a pending L3 proposal, and there is
    // NO L2 disposition anywhere in the fold.
    const state = foldCanvas(decisionsCanvasId, canvasEvents);
    expect(state.proposals.length).toBe(1);
    expect(state.proposals[0]?.status).toBe("pending");

    // L2 appears ONLY when the USER adjudicates (a user command, off this surface).
    const beforeAdjudication = state.proposals[0]?.status;
    expect(beforeAdjudication).not.toBe("accepted");
    const userEffect = dispatchUserCanvasCommand("canvas.adjudicateProposal", {
      outcome: "accepted",
      anchorPath: "src/c1.ts",
      type: "approve",
      body: "approve all three",
    });
    expect(userEffect.kind).toBe("disposition"); // the L2 write is a USER effect
  });

  // "Nothing found" distinguished from a failed call ─────────────────────────
  it("returns a distinguished nothing-found value, not an empty-looking success", () => {
    const { backend } = makeFixture();
    const search = canvasOpsTool("diff.search");
    const env = expectOk(run(search, { query: "no-such-symbol" }, backend));
    expect(env.total).toBe(0);
    const data = env.data as { scope: string; results: unknown[] };
    expect(data.results).toEqual([]);
    expect(data.scope).toContain("no-such-symbol"); // the searched scope is named

    // A malformed call is a structured error, distinguishable from nothing-found.
    const bad = run(search, {}, backend);
    expect(bad.ok).toBe(false);
  });

  // recompute budget gate ─────────────────────────────────────────────────────
  it("refuses recompute over budget with a visible refusal and no recompute effect", () => {
    const over = makeFixture({ overBudget: true });
    const outcome = run(
      canvasOpsTool("canvas.recompute"),
      { scope: "rennet:chunk/c1", angle: "decisions" },
      over.backend,
    );
    const env = expectOk(outcome);
    const plan = env.data as { refused: boolean; reason?: string };
    expect(plan.refused).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    over.backend.applyEffects(outcome.effects);
    expect(over.applied.some((e) => e.kind === "recompute")).toBe(false);

    const within = makeFixture({ overBudget: false });
    const ok = run(
      canvasOpsTool("canvas.recompute"),
      { scope: "rennet:chunk/c1", angle: "decisions" },
      within.backend,
    );
    if (!ok.ok) throw new Error("expected ok");
    within.backend.applyEffects(ok.effects);
    expect(within.applied.some((e) => e.kind === "recompute")).toBe(true);
  });

  // retrieval family sanity ──────────────────────────────────────────────────
  it("retrieval tools return the uniform envelope with freshness and evidence", () => {
    const { backend } = makeFixture();
    const structure = expectOk(run(canvasOpsTool("diff.structure"), {}, backend));
    const dag = structure.data as { chunks: unknown[]; readingOrder: string[] };
    expect(dag.readingOrder).toEqual(["c1", "c2"]);

    const ledger = expectOk(run(canvasOpsTool("run.ledger"), {}, backend));
    expect((ledger.data as unknown[]).length).toBe(1);
    expect(ledger.total).toBe(1);

    const prov = expectOk(run(canvasOpsTool("run.provenance"), { docId: "doc_dec" }, backend));
    expect((prov.data as RspProvenance).runId).toBe("run_1");

    const hunk = expectOk(run(canvasOpsTool("diff.read"), { ref: "rennet:hunk/h1" }, backend));
    expect((hunk.data as HunkDetail).hunkId).toBe("h1");

    const thread = expectOk(
      run(canvasOpsTool("canvas.thread"), { dispositionId: "disp_known" }, backend),
    );
    expect((thread.data as ThreadDetail).messages.length).toBe(1);

    const view = expectOk(run(canvasOpsTool("canvas.view"), {}, backend));
    expect((view.data as ViewState).angle).toBe("decisions");
  });
});
