import type {
  AnchorKind,
  CanvasAngle,
  Decomposition,
  Disposition,
  NoveltyLedger,
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
import type { KnowledgeQuery, KnowledgeResult } from "./knowledge";
import type { NoveltyResult } from "./novelty-ledger";
import type {
  ProjectFileOverviewResult,
  ProjectFileResult,
  ProjectMap,
  ProjectMapResult,
  ProjectMapScope,
  ProjectReferenceResult,
  ProjectSymbolDefinitionResult,
  ReferenceLookup,
  SymbolLookup,
} from "./project-context";

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
    blockingStates: [],
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
  /** Override the deterministic project-map gate result (default: a fresh served map). */
  projectMap?: ProjectMapResult;
  /** Capture the scope the last `context.map` call passed the backend. */
  onProjectMap?: (scope?: ProjectMapScope) => void;
  /** Override the deterministic file-context gate result (default: a fresh served context). */
  fileContext?: ProjectFileResult;
  /** Override the deterministic file-overview gate result (default: a fresh served overview). */
  fileOverview?: ProjectFileOverviewResult;
  /** Override the deterministic go-to-definition gate result (default: two served sites). */
  symbolDefinition?: ProjectSymbolDefinitionResult;
  /** Capture the lookup the last `context.symbol` call passed the backend. */
  onSymbolDefinition?: (query: SymbolLookup) => void;
  /** Override the deterministic find-references gate result (default: two served sites). */
  references?: ProjectReferenceResult;
  /** Capture the lookup the last `context.references` call passed the backend. */
  onReferences?: (query: ReferenceLookup) => void;
  /** Override the deterministic novelty-ledger gate result (default: a fresh served ledger). */
  novelty?: NoveltyResult;
  /** Fires when a `context.novelty` call reaches the backend (default served ledger). */
  onNovelty?: () => void;
  /** Override the knowledge gate result (default: a served view with one statement). */
  knowledge?: KnowledgeResult;
  /** Capture the query the last `context.knowledge` call passed the backend. */
  onKnowledge?: (query?: KnowledgeQuery) => void;
}

const FIXTURE_BASE_OID = "a".repeat(40);
const FIXTURE_FINGERPRINT = "fp-fixture";
const FIXTURE_PATCHSET_PIN = "ps-novelty-1";

/** A fresh, served project map (the deterministic reader's ok shape). */
function freshProjectMap(): ProjectMap {
  return {
    baseRef: "refs/heads/main",
    baseRefResolution: "explicit-setting",
    baseOid: FIXTURE_BASE_OID,
    fingerprint: FIXTURE_FINGERPRINT,
    files: [{ path: "packages/a/src/index.ts", blobOid: "b".repeat(40), size: 12, mode: "100644" }],
    scopes: [{ name: "@t/a", root: "packages/a", private: true, tags: [] }],
    edges: [],
    entryPoints: [],
    tests: [],
    ownership: [],
    conventions: [],
  };
}

/** A fresh, served novelty ledger (the deterministic reader's ok shape) — one novel file. */
function freshNoveltyLedger(): NoveltyLedger {
  return {
    projectSnapshotId: "snapshot-fingerprint",
    snapshotFingerprint: FIXTURE_FINGERPRINT,
    baseOid: FIXTURE_BASE_OID,
    patchsetId: FIXTURE_PATCHSET_PIN,
    entries: [
      {
        unit: { kind: "file", path: "packages/a/src/added.ts", fileStatus: "added" },
        classification: "novel",
        evidence: {
          snapshotFingerprint: FIXTURE_FINGERPRINT,
          baseOid: FIXTURE_BASE_OID,
          shard: null,
          match: { kind: "file-absent", path: "packages/a/src/added.ts" },
          context: {
            scope: "@t/a",
            isKnownTest: false,
            isConvention: false,
            patchTruncated: false,
          },
        },
      },
    ],
  };
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
    projectMap: (scope?: ProjectMapScope): ProjectMapResult => {
      options.onProjectMap?.(scope);
      return options.projectMap ?? { ok: true, map: freshProjectMap() };
    },
    fileContext: (path: string): ProjectFileResult =>
      options.fileContext ?? {
        ok: true,
        context: {
          path,
          blobOid: "b".repeat(40),
          size: 12,
          mode: "100644",
          isSymlink: false,
          scope: "@t/a",
          hasSymbols: true,
          extractor: "test",
          symbols: [],
          tests: [],
        },
      },
    fileOverview: (path: string): ProjectFileOverviewResult =>
      options.fileOverview ?? {
        ok: true,
        overview: {
          path,
          blobOid: "b".repeat(40),
          extractor: "test",
          hasSymbols: true,
          symbols: [
            { name: "foo", kind: "function", line: 1 },
            { name: "Bar", kind: "class", line: 5 },
          ],
        },
      },
    symbolDefinition: (query: SymbolLookup): ProjectSymbolDefinitionResult => {
      options.onSymbolDefinition?.(query);
      return (
        options.symbolDefinition ?? {
          ok: true,
          definitions: {
            name: query.name,
            sites: [
              {
                path: "packages/a/src/index.ts",
                name: query.name,
                kind: "function",
                line: 2,
                scope: "@t/a",
              },
              {
                path: "packages/b/src/index.ts",
                name: query.name,
                kind: "const",
                line: 9,
                scope: "@t/b",
              },
            ],
          },
        }
      );
    },
    references: (query: ReferenceLookup): ProjectReferenceResult => {
      options.onReferences?.(query);
      return (
        options.references ?? {
          ok: true,
          references: {
            name: query.name,
            sites: [
              { path: "packages/a/src/index.ts", line: 2, scope: "@t/a" },
              { path: "packages/b/src/index.ts", line: 9, scope: "@t/b" },
            ],
          },
        }
      );
    },
    novelty: (): NoveltyResult => {
      options.onNovelty?.();
      return options.novelty ?? { ok: true, ledger: freshNoveltyLedger() };
    },
    knowledge: (query?: KnowledgeQuery): KnowledgeResult => {
      options.onKnowledge?.(query);
      return (
        options.knowledge ?? {
          ok: true,
          knowledge: {
            baseOid: "base-oid",
            snapshotFingerprint: "fp-1",
            generator: "knowledge-gen@1",
            statements: [
              {
                id: "k1",
                subject: "@t/a",
                aspect: "purpose",
                claim: "scope a is the deterministic source",
                evidence: [{ path: "packages/a/src/index.ts", blobOid: "blob-a" }],
                confidence: "high",
                status: "hypothesis",
                provenance: { generator: "knowledge-gen@1", model: null, apiKeySource: null },
                learnedAgainst: { baseOid: "base-oid", snapshotFingerprint: "fp-1" },
              },
            ],
            invalidatedPending: [],
          },
        }
      );
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
  it("is versioned canvasOps@2 with the interaction ops, retrieval reads, and context reads", () => {
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
      "context.map",
      "context.file",
      "context.novelty",
      "context.overview",
      "context.symbol",
      "context.references",
      "context.knowledge",
    ]);
    // The base-branch context reads (issue #14) + the deterministic novelty ledger
    // (issue #144) + the model-free symbolic trio (repo-map-symbolic-surface:
    // context.overview + context.symbol + context.references, #200) ride this
    // surface, and the ONE model-backed read (context.knowledge, repo-map-knowledge
    // layer c) joins them.
    expect(names).toContain("context.map");
    expect(names).toContain("context.file");
    expect(names).toContain("context.novelty");
    expect(names).toContain("context.overview");
    expect(names).toContain("context.symbol");
    expect(names).toContain("context.references");
    expect(names).toContain("context.knowledge");
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
      "context.map",
      "context.file",
      "context.novelty",
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
    const dag = structure.data as {
      chunks: unknown[];
      readingOrder: string[];
      blockingStates: unknown[];
    };
    expect(dag.readingOrder).toEqual(["c1", "c2"]);
    expect(dag.blockingStates).toEqual([]);

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

  // Issue #14: base-branch context reads (context.map / context.file) ─────────
  describe("context.map — deterministic base-branch map through the fail-closed gate", () => {
    it("serves a fresh map as `current`, with base OID + fingerprint as evidence", () => {
      const { backend } = makeFixture();
      const env = expectOk(run(canvasOpsTool("context.map"), {}, backend));
      const map = env.data as ProjectMap;
      expect(map.baseOid).toBe(FIXTURE_BASE_OID);
      expect(map.scopes.map((s) => s.name)).toEqual(["@t/a"]);
      expect(env.freshness).toBe("current");
      expect(env.evidence).toEqual([FIXTURE_BASE_OID, FIXTURE_FINGERPRINT]);
    });

    it("passes path/scope narrowing through to the backend port", () => {
      let seen: ProjectMapScope | undefined;
      const { backend } = makeFixture({ onProjectMap: (scope) => (seen = scope) });
      run(canvasOpsTool("context.map"), { path: "packages/a", scope: "@t/a" }, backend);
      expect(seen).toEqual({ path: "packages/a", scope: "@t/a" });
    });

    it("passes NO scope object when neither path nor scope is given", () => {
      let called = false;
      let seen: ProjectMapScope | undefined = { path: "x" };
      const { backend } = makeFixture({
        onProjectMap: (scope) => {
          called = true;
          seen = scope;
        },
      });
      run(canvasOpsTool("context.map"), {}, backend);
      expect(called).toBe(true);
      expect(seen).toBeUndefined();
    });

    it("rides a STALE snapshot back as freshness `stale` with an `unavailable` payload, not a served map (R30)", () => {
      const { backend } = makeFixture({
        projectMap: {
          ok: false,
          failure: { reason: "stale", storedBaseOid: "old", requestedBaseOid: "new" },
        },
      });
      const env = expectOk(run(canvasOpsTool("context.map"), {}, backend));
      expect(env.freshness).toBe("stale");
      const data = env.data as { unavailable: { reason: string } };
      expect(data.unavailable.reason).toBe("stale");
      // The distinguished refusal never masquerades as a served map.
      expect((env.data as { baseOid?: string }).baseOid).toBeUndefined();
    });

    it("maps an ABSENT snapshot to freshness `failed`", () => {
      const { backend } = makeFixture({ projectMap: { ok: false, failure: { reason: "absent" } } });
      const env = expectOk(run(canvasOpsTool("context.map"), {}, backend));
      expect(env.freshness).toBe("failed");
      expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("absent");
    });

    it("maps a CORRUPT snapshot to freshness `failed`", () => {
      const { backend } = makeFixture({
        projectMap: {
          ok: false,
          failure: { reason: "corrupt", missing: ["files"], mismatched: [] },
        },
      });
      const env = expectOk(run(canvasOpsTool("context.map"), {}, backend));
      expect(env.freshness).toBe("failed");
      expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("corrupt");
    });
  });

  describe("context.file — deterministic file context through the fail-closed gate", () => {
    it("serves a fresh file context as `current`, with the blob OID as evidence", () => {
      const { backend } = makeFixture();
      const env = expectOk(
        run(canvasOpsTool("context.file"), { path: "packages/a/src/index.ts" }, backend),
      );
      expect((env.data as { path: string }).path).toBe("packages/a/src/index.ts");
      expect(env.freshness).toBe("current");
      expect(env.evidence).toEqual(["b".repeat(40)]);
    });

    it("refuses a missing path arg as invalid-input", () => {
      const { backend } = makeFixture();
      const outcome = run(canvasOpsTool("context.file"), {}, backend);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("invalid-input");
    });

    it("maps the reader's invalid-path refusal to an invalid-input call error", () => {
      const { backend } = makeFixture({
        fileContext: { ok: false, reason: "invalid-path", path: "../escape.ts" },
      });
      const outcome = run(canvasOpsTool("context.file"), { path: "../escape.ts" }, backend);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("invalid-input");
    });

    it("maps a path absent from the tree to a not-found call error", () => {
      const { backend } = makeFixture({
        fileContext: { ok: false, reason: "not-found", path: "packages/a/ghost.ts" },
      });
      const outcome = run(canvasOpsTool("context.file"), { path: "packages/a/ghost.ts" }, backend);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("not-found");
    });

    it("surfaces a corrupt symbol shard as a `failed` read with a uniform `unavailable` payload", () => {
      const { backend } = makeFixture({
        fileContext: {
          ok: false,
          reason: "shard-unavailable",
          path: "packages/a/src/index.ts",
          digest: "deadbeef",
        },
      });
      const env = expectOk(
        run(canvasOpsTool("context.file"), { path: "packages/a/src/index.ts" }, backend),
      );
      expect(env.freshness).toBe("failed");
      const data = env.data as { unavailable: { reason: string; mismatched: string[] } };
      expect(data.unavailable.reason).toBe("corrupt");
      expect(data.unavailable.mismatched).toEqual(["deadbeef"]);
    });

    it("rides a whole-snapshot stale gate back as freshness `stale`", () => {
      const { backend } = makeFixture({
        fileContext: {
          ok: false,
          reason: "snapshot-unavailable",
          failure: { reason: "stale", storedBaseOid: "old", requestedBaseOid: "new" },
        },
      });
      const env = expectOk(
        run(canvasOpsTool("context.file"), { path: "packages/a/src/index.ts" }, backend),
      );
      expect(env.freshness).toBe("stale");
      expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("stale");
    });
  });

  // Issue #144: the deterministic novelty ledger (context.novelty) ─────────────
  describe("context.novelty — deterministic novelty ledger through the fail-closed gate", () => {
    it("serves a fresh ledger as `current`, with base OID + fingerprint + patchset id as evidence", () => {
      const { backend } = makeFixture();
      const env = expectOk(run(canvasOpsTool("context.novelty"), {}, backend));
      const ledger = env.data as NoveltyLedger;
      expect(ledger.baseOid).toBe(FIXTURE_BASE_OID);
      expect(ledger.snapshotFingerprint).toBe(FIXTURE_FINGERPRINT);
      expect(ledger.patchsetId).toBe(FIXTURE_PATCHSET_PIN);
      expect(ledger.entries[0]?.classification).toBe("novel");
      expect(env.freshness).toBe("current");
      expect(env.evidence).toEqual([FIXTURE_BASE_OID, FIXTURE_FINGERPRINT, FIXTURE_PATCHSET_PIN]);
    });

    it("takes no params and reaches the backend port once", () => {
      let calls = 0;
      const { backend } = makeFixture({ onNovelty: () => (calls += 1) });
      run(canvasOpsTool("context.novelty"), {}, backend);
      expect(calls).toBe(1);
    });

    it("rides a STALE snapshot back as freshness `stale` with an `unavailable` payload, not a served ledger (R30)", () => {
      const { backend } = makeFixture({
        novelty: {
          ok: false,
          failure: { reason: "stale", storedBaseOid: "old", requestedBaseOid: "new" },
        },
      });
      const env = expectOk(run(canvasOpsTool("context.novelty"), {}, backend));
      expect(env.freshness).toBe("stale");
      const data = env.data as { unavailable: { reason: string; storedBaseOid?: string } };
      expect(data.unavailable.reason).toBe("stale");
      expect(data.unavailable.storedBaseOid).toBe("old");
      // The distinguished refusal never masquerades as a served ledger.
      expect((env.data as { baseOid?: string }).baseOid).toBeUndefined();
      expect((env.data as { entries?: unknown }).entries).toBeUndefined();
    });

    it("maps an ABSENT snapshot to freshness `failed`", () => {
      const { backend } = makeFixture({
        novelty: { ok: false, failure: { reason: "absent" } },
      });
      const env = expectOk(run(canvasOpsTool("context.novelty"), {}, backend));
      expect(env.freshness).toBe("failed");
      expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("absent");
    });

    it("maps a CORRUPT snapshot to freshness `failed`", () => {
      const { backend } = makeFixture({
        novelty: {
          ok: false,
          failure: { reason: "corrupt", missing: ["symbols"], mismatched: [] },
        },
      });
      const env = expectOk(run(canvasOpsTool("context.novelty"), {}, backend));
      expect(env.freshness).toBe("failed");
      expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("corrupt");
    });
  });

  // repo-map-symbolic-surface: the model-free "IDE for the agent" (layer b) ─────
  describe("context.overview — a file's symbol overview from the snapshot (no LSP)", () => {
    it("serves a fresh overview as `current`, with the blob OID as evidence, symbols paginated", () => {
      const { backend } = makeFixture();
      const env = expectOk(
        run(canvasOpsTool("context.overview"), { path: "packages/a/src/index.ts" }, backend),
      );
      const data = env.data as {
        path: string;
        hasSymbols: boolean;
        symbols: { name: string }[];
      };
      expect(data.path).toBe("packages/a/src/index.ts");
      expect(data.hasSymbols).toBe(true);
      expect(data.symbols.map((s) => s.name)).toEqual(["foo", "Bar"]);
      expect(env.freshness).toBe("current");
      expect(env.evidence).toEqual(["b".repeat(40)]);
      // Totality: the true count rides back, and the whole page fit (cursor null).
      expect(env.total).toBe(2);
      expect(env.cursor).toBeNull();
    });

    it("paginates the symbol list with totality (a page is never the whole)", () => {
      const { backend } = makeFixture();
      const first = expectOk(
        run(
          canvasOpsTool("context.overview"),
          { path: "packages/a/src/index.ts", limit: 1 },
          backend,
        ),
      );
      expect((first.data as { symbols: unknown[] }).symbols).toHaveLength(1);
      expect(first.total).toBe(2);
      expect(first.cursor).toBe("1");
      const second = expectOk(
        run(
          canvasOpsTool("context.overview"),
          { path: "packages/a/src/index.ts", limit: 1, cursor: "1" },
          backend,
        ),
      );
      expect((second.data as { symbols: { name: string }[] }).symbols.map((s) => s.name)).toEqual([
        "Bar",
      ]);
      expect(second.cursor).toBeNull();
    });

    it("is an honest ok with hasSymbols:false for a file bearing no symbol shard", () => {
      const { backend } = makeFixture({
        fileOverview: {
          ok: true,
          overview: {
            path: "packages/a/package.json",
            blobOid: "j".repeat(40),
            extractor: null,
            hasSymbols: false,
            symbols: [],
          },
        },
      });
      const env = expectOk(
        run(canvasOpsTool("context.overview"), { path: "packages/a/package.json" }, backend),
      );
      const data = env.data as { hasSymbols: boolean; symbols: unknown[] };
      expect(data.hasSymbols).toBe(false);
      expect(data.symbols).toEqual([]);
      expect(env.freshness).toBe("current");
    });

    it("refuses a missing path arg as invalid-input", () => {
      const { backend } = makeFixture();
      const outcome = run(canvasOpsTool("context.overview"), {}, backend);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("invalid-input");
    });

    it("maps the reader's invalid-path refusal to an invalid-input call error", () => {
      const { backend } = makeFixture({
        fileOverview: { ok: false, reason: "invalid-path", path: "../escape.ts" },
      });
      const outcome = run(canvasOpsTool("context.overview"), { path: "../escape.ts" }, backend);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("invalid-input");
    });

    it("maps a path absent from the tree to a not-found call error", () => {
      const { backend } = makeFixture({
        fileOverview: { ok: false, reason: "not-found", path: "packages/a/ghost.ts" },
      });
      const outcome = run(
        canvasOpsTool("context.overview"),
        { path: "packages/a/ghost.ts" },
        backend,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("not-found");
    });

    it("surfaces a corrupt symbol shard as a `failed` read with a uniform `unavailable` payload", () => {
      const { backend } = makeFixture({
        fileOverview: {
          ok: false,
          reason: "shard-unavailable",
          path: "packages/a/src/index.ts",
          digest: "deadbeef",
        },
      });
      const env = expectOk(
        run(canvasOpsTool("context.overview"), { path: "packages/a/src/index.ts" }, backend),
      );
      expect(env.freshness).toBe("failed");
      const data = env.data as { unavailable: { reason: string; mismatched: string[] } };
      expect(data.unavailable.reason).toBe("corrupt");
      expect(data.unavailable.mismatched).toEqual(["deadbeef"]);
    });

    it("rides a whole-snapshot stale gate back as freshness `stale`, not a served overview", () => {
      const { backend } = makeFixture({
        fileOverview: {
          ok: false,
          reason: "snapshot-unavailable",
          failure: { reason: "stale", storedBaseOid: "old", requestedBaseOid: "new" },
        },
      });
      const env = expectOk(
        run(canvasOpsTool("context.overview"), { path: "packages/a/src/index.ts" }, backend),
      );
      expect(env.freshness).toBe("stale");
      expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("stale");
      expect((env.data as { symbols?: unknown }).symbols).toBeUndefined();
    });
  });

  describe("context.symbol — go-to-definition over the exported-symbol index (no LSP)", () => {
    it("serves definition sites as `current`, with each site's path:line as evidence", () => {
      const { backend } = makeFixture();
      const env = expectOk(run(canvasOpsTool("context.symbol"), { name: "makeA" }, backend));
      const data = env.data as { name: string; sites: { path: string; line: number }[] };
      expect(data.name).toBe("makeA");
      expect(data.sites.map((s) => `${s.path}:${s.line}`)).toEqual([
        "packages/a/src/index.ts:2",
        "packages/b/src/index.ts:9",
      ]);
      expect(env.freshness).toBe("current");
      expect(env.evidence).toEqual(["packages/a/src/index.ts:2", "packages/b/src/index.ts:9"]);
      expect(env.total).toBe(2);
      expect(env.cursor).toBeNull();
    });

    it("passes name/kind/scope through to the backend port", () => {
      let seen: SymbolLookup | undefined;
      const { backend } = makeFixture({ onSymbolDefinition: (q) => (seen = q) });
      run(canvasOpsTool("context.symbol"), { name: "Foo", kind: "class", scope: "@t/a" }, backend);
      expect(seen).toEqual({ name: "Foo", kind: "class", scope: "@t/a" });
    });

    it("ignores an unknown kind value (defensive enum parse) rather than erroring", () => {
      let seen: SymbolLookup | undefined;
      const { backend } = makeFixture({ onSymbolDefinition: (q) => (seen = q) });
      run(canvasOpsTool("context.symbol"), { name: "Foo", kind: "not-a-kind" }, backend);
      expect(seen).toEqual({ name: "Foo" });
    });

    it("paginates the sites with totality", () => {
      const { backend } = makeFixture();
      const first = expectOk(
        run(canvasOpsTool("context.symbol"), { name: "makeA", limit: 1 }, backend),
      );
      expect((first.data as { sites: unknown[] }).sites).toHaveLength(1);
      expect(first.total).toBe(2);
      expect(first.cursor).toBe("1");
    });

    it("returns an honest empty site set (total 0), never an error, when nothing matches", () => {
      const { backend } = makeFixture({
        symbolDefinition: { ok: true, definitions: { name: "ghost", sites: [] } },
      });
      const env = expectOk(run(canvasOpsTool("context.symbol"), { name: "ghost" }, backend));
      const data = env.data as { name: string; sites: unknown[] };
      expect(data.name).toBe("ghost");
      expect(data.sites).toEqual([]);
      expect(env.total).toBe(0);
      expect(env.freshness).toBe("current");
    });

    it("refuses a missing name arg as invalid-input", () => {
      const { backend } = makeFixture();
      const outcome = run(canvasOpsTool("context.symbol"), {}, backend);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("invalid-input");
    });

    it("surfaces a corrupt symbol shard as a `failed` read with an `unavailable` payload", () => {
      const { backend } = makeFixture({
        symbolDefinition: { ok: false, reason: "shard-unavailable", digest: "deadbeef" },
      });
      const env = expectOk(run(canvasOpsTool("context.symbol"), { name: "makeA" }, backend));
      expect(env.freshness).toBe("failed");
      const data = env.data as { unavailable: { reason: string; mismatched: string[] } };
      expect(data.unavailable.reason).toBe("corrupt");
      expect(data.unavailable.mismatched).toEqual(["deadbeef"]);
    });

    it("rides a whole-snapshot stale gate back as freshness `stale`, not served sites", () => {
      const { backend } = makeFixture({
        symbolDefinition: {
          ok: false,
          reason: "snapshot-unavailable",
          failure: { reason: "stale", storedBaseOid: "old", requestedBaseOid: "new" },
        },
      });
      const env = expectOk(run(canvasOpsTool("context.symbol"), { name: "makeA" }, backend));
      expect(env.freshness).toBe("stale");
      expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("stale");
      expect((env.data as { sites?: unknown }).sites).toBeUndefined();
    });
  });

  describe("context.references — find-references over the occurrence index (no LSP)", () => {
    it("serves occurrence sites with path:line evidence, all model-free", () => {
      const { backend } = makeFixture();
      const env = expectOk(run(canvasOpsTool("context.references"), { name: "makeA" }, backend));
      expect(env.freshness).toBe("current");
      const data = env.data as { name: string; sites: { path: string; line: number }[] };
      expect(data.name).toBe("makeA");
      expect(data.sites).toEqual([
        { path: "packages/a/src/index.ts", line: 2, scope: "@t/a" },
        { path: "packages/b/src/index.ts", line: 9, scope: "@t/b" },
      ]);
      expect(env.evidence).toEqual(["packages/a/src/index.ts:2", "packages/b/src/index.ts:9"]);
      expect(env.total).toBe(2);
    });

    it("passes name/scope/path through to the backend port", () => {
      let seen: ReferenceLookup | undefined;
      const { backend } = makeFixture({ onReferences: (q) => (seen = q) });
      run(
        canvasOpsTool("context.references"),
        { name: "foo", scope: "@t/a", path: "packages/a" },
        backend,
      );
      expect(seen).toEqual({ name: "foo", scope: "@t/a", path: "packages/a" });
    });

    it("paginates the sites with totality", () => {
      const { backend } = makeFixture();
      const first = expectOk(
        run(canvasOpsTool("context.references"), { name: "foo", limit: 1 }, backend),
      );
      expect((first.data as { sites: unknown[] }).sites).toHaveLength(1);
      expect(first.total).toBe(2);
      expect(first.cursor).toBe("1");
    });

    it("returns an honest empty site set (total 0), never an error, when nothing matches", () => {
      const { backend } = makeFixture({
        references: { ok: true, references: { name: "ghost", sites: [] } },
      });
      const env = expectOk(run(canvasOpsTool("context.references"), { name: "ghost" }, backend));
      const data = env.data as { name: string; sites: unknown[] };
      expect(data.name).toBe("ghost");
      expect(data.sites).toEqual([]);
      expect(env.total).toBe(0);
      expect(env.freshness).toBe("current");
    });

    it("refuses a missing name arg as invalid-input", () => {
      const { backend } = makeFixture();
      const outcome = run(canvasOpsTool("context.references"), {}, backend);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("invalid-input");
    });

    it("surfaces a corrupt reference shard as a `failed` read with an `unavailable` payload", () => {
      const { backend } = makeFixture({
        references: { ok: false, reason: "shard-unavailable", digest: "deadbeef" },
      });
      const env = expectOk(run(canvasOpsTool("context.references"), { name: "makeA" }, backend));
      expect(env.freshness).toBe("failed");
      const data = env.data as { unavailable: { reason: string; mismatched: string[] } };
      expect(data.unavailable.reason).toBe("corrupt");
      expect(data.unavailable.mismatched).toEqual(["deadbeef"]);
    });

    it("rides a whole-snapshot stale gate back as freshness `stale`, not served sites", () => {
      const { backend } = makeFixture({
        references: {
          ok: false,
          reason: "snapshot-unavailable",
          failure: { reason: "stale", storedBaseOid: "old", requestedBaseOid: "new" },
        },
      });
      const env = expectOk(run(canvasOpsTool("context.references"), { name: "makeA" }, backend));
      expect(env.freshness).toBe("stale");
      expect((env.data as { unavailable: { reason: string } }).unavailable.reason).toBe("stale");
      expect((env.data as { sites?: unknown }).sites).toBeUndefined();
    });
  });

  describe("context.knowledge — LLM-reconstructed knowledge, served verbatim, no model on read", () => {
    it("serves current statements verbatim with their hypothesis label + evidence intact", () => {
      const { backend } = makeFixture();
      const env = expectOk(run(canvasOpsTool("context.knowledge"), {}, backend));
      expect(env.freshness).toBe("current");
      const data = env.data as {
        statements: { id: string; status: string; claim: string; evidence: unknown[] }[];
      };
      expect(data.statements).toHaveLength(1);
      expect(data.statements[0]?.status).toBe("hypothesis");
      expect(data.statements[0]?.claim).toBe("scope a is the deterministic source");
      // Evidence cites path:blobOid so a reader can prove which bytes it was drawn from.
      expect(env.evidence).toEqual(["packages/a/src/index.ts:blob-a"]);
      expect(env.total).toBe(1);
    });

    it("passes the query (subject/aspect/path) through to the backend", () => {
      let seen: unknown;
      const { backend } = makeFixture({ onKnowledge: (q) => (seen = q) });
      run(
        canvasOpsTool("context.knowledge"),
        { subject: "@t/a", aspect: "purpose", path: "packages/a" },
        backend,
      );
      expect(seen).toEqual({ subject: "@t/a", aspect: "purpose", path: "packages/a" });
    });

    it("discloses invalidated-pending statements rather than dropping them silently", () => {
      const { backend } = makeFixture({
        knowledge: {
          ok: true,
          knowledge: {
            baseOid: "b",
            snapshotFingerprint: "fp2",
            generator: "knowledge-gen@1",
            statements: [],
            invalidatedPending: [
              {
                id: "stale-1",
                subject: "packages/a",
                aspect: "why",
                claim: "the old rationale",
                evidence: [{ path: "packages/a/src/old.ts", blobOid: "gone" }],
                confidence: "medium",
                status: "hypothesis",
                provenance: { generator: "knowledge-gen@1", model: null, apiKeySource: null },
                learnedAgainst: { baseOid: "a", snapshotFingerprint: "fp1" },
              },
            ],
          },
        },
      });
      const env = expectOk(run(canvasOpsTool("context.knowledge"), {}, backend));
      const data = env.data as { invalidatedPending: { id: string; subject: string }[] };
      expect(data.invalidatedPending).toEqual([{ id: "stale-1", subject: "packages/a" }]);
    });

    it("returns an honest empty view (not an error) when knowledge is not yet enriched", () => {
      const { backend } = makeFixture({
        knowledge: {
          ok: true,
          knowledge: {
            baseOid: "b",
            snapshotFingerprint: "fp",
            generator: null,
            statements: [],
            invalidatedPending: [],
          },
        },
      });
      const env = expectOk(run(canvasOpsTool("context.knowledge"), {}, backend));
      expect(env.freshness).toBe("current");
      expect((env.data as { statements: unknown[] }).statements).toEqual([]);
      expect((env.data as { generator: string | null }).generator).toBeNull();
    });

    it("rides a stale/absent snapshot gate back as a freshness verdict with an unavailable payload", () => {
      const { backend } = makeFixture({
        knowledge: { ok: false, failure: { reason: "absent" } },
      });
      const env = expectOk(run(canvasOpsTool("context.knowledge"), {}, backend));
      expect(env.freshness).toBe("failed");
      const data = env.data as { unavailable: { reason: string }; statements?: unknown };
      expect(data.unavailable.reason).toBe("absent");
      expect(data.statements).toBeUndefined();
    });
  });
});
