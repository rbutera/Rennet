import type {
  AnalysisElement,
  Annotation,
  AnnotationKind,
  Canvas,
  CanvasAngle,
  Decomposition,
  Disposition,
  DispositionType,
  Proposal,
  ProposalKind,
  RoutePlanResult,
  RspProvenance,
  RspTier,
} from "@rennet/protocol";
import { v7 as uuidv7 } from "uuid";
import { type CanvasEvent, dispatchOrchestratorCanvasOp } from "./canvas";
import type { ContextAskQuery, RunContextAskResult } from "./context-ask";
import type { KnowledgeQuery, KnowledgeResult } from "./knowledge";
import type { NoveltyResult } from "./novelty-ledger";
import type {
  ProjectFileOverviewResult,
  ProjectFileResult,
  ProjectMapResult,
  ProjectMapScope,
  ProjectReferenceResult,
  ProjectSymbolDefinitionResult,
  ReferenceLookup,
  SnapshotGateFailure,
  SymbolLookup,
} from "./project-context";

// ─────────────────────────────────────────────────────────────────────────────
// canvasOps@2 — the orchestrator's entire world (issue #12)
//
// One versioned in-process MCP tool surface: the six interaction ops, the seven
// read-only retrieval ops, the read-only base-branch/change context ops
// (`context.map` / `context.file`, issue #14 — Orchestrator Context Access §2;
// `context.novelty`, issue #144 — the deterministic novelty ledger), and the
// model-free symbolic ops (`context.overview` / `context.symbol`,
// repo-map-symbolic-surface — the "IDE for the agent" over Rennet's own index).
// This module is the PURE contract — tool descriptors with pure handlers over
// an injected `CanvasOpsBackend` port. It carries NO harness dependency: the Claude slot
// reaches these descriptors as an in-process MCP server (the SDK wiring lives in
// `@rennet/adapters`); codex/omp reach the SAME descriptors as external MCP
// later. One contract, no `if (harness === X)`.
//
// The tool surface IS zoom for the orchestrator (Rai's product thesis, inward):
// `canvas.describe` at count → cohort → element depth, then `canvas.read` of one
// element's body, is roll-up-then-zoom, machine-facing.
//
// Two guarantees are STRUCTURAL, not prose:
//   - Actor partition: the surface contains no user-only or engine-only op, and
//     the write ops route through issue #10's `dispatchOrchestratorCanvasOp`,
//     whose effect union excludes L2. "The human still disposes" is a property of
//     the wiring — `canvas.propose` raises an L3 proposal; L2 arrives only when
//     the user adjudicates (a user command, off this surface).
//   - Honest reads: every reply carries a freshness verdict (R30 at the reply);
//     a stale verdict rides on the answer itself; list tools paginate with
//     totality (never-cap applied to the machine reader); "nothing found" is a
//     distinguished value, never an empty-looking success.
// ─────────────────────────────────────────────────────────────────────────────

/** The version string of this combined interaction + retrieval surface. */
export const CANVAS_OPS_VERSION = "canvasOps@2";

/** The freshness verdict every reply carries (R30 at the reply, not only boot). */
export type OpsFreshness = "current" | "updating" | "stale" | "failed";

/**
 * The uniform envelope every tool reply carries. `freshness` is REQUIRED —
 * staleness rides on the answer itself. `total`/`cursor` appear on list replies
 * (pagination with totality; a `null` cursor means completion, a silent cap is
 * forbidden). `truncated` is visible, DSL-doctrine truncation only.
 */
export interface OpsEnvelope<T = unknown> {
  data: T;
  evidence?: string[];
  freshness: OpsFreshness;
  total?: number;
  cursor?: string | null;
  truncated?: { droppedBytes: number };
}

/** A structured error — for a MALFORMED or unresolvable-address call only. */
export interface OpsError {
  code: "invalid-input" | "not-found" | "unknown-tool";
  message: string;
}

/**
 * A tool's outcome: an ok envelope with the (structurally L2-free) effects the
 * host must apply, or a structured error. "Nothing found" and "over budget" are
 * distinguished OK values, never errors — an error means the CALL was malformed
 * or addressed a specific thing that does not exist.
 */
export type ToolOutcome<T = unknown> =
  | { ok: true; envelope: OpsEnvelope<T>; effects: CanvasOpsEffect[] }
  | { ok: false; error: OpsError };

/**
 * The effects a canvasOps@2 handler may produce. There is deliberately NO L2
 * variant: `annotate`/`propose` are L3 (routed through issue #10's dispatch),
 * `focus` is presentational (nothing becomes read), `recompute` is a visible,
 * budget-gated request. A disposition write is a USER effect and does not exist
 * here.
 */
export type CanvasOpsEffect =
  | { kind: "annotate"; event: CanvasEvent }
  | { kind: "propose"; event: CanvasEvent }
  | { kind: "focus"; target: string }
  | { kind: "recompute"; scope: string; angle?: CanvasAngle; plan: RoutePlanResult };

// ── Backend port: the durable state the surface reads through ─────────────────

/** B1 review identity — the addressing scheme every call needs. */
export interface ReviewIdentity {
  /** The workspace this review belongs to (B1, Orchestrator Context Access §1.1). */
  workspace?: string;
  /** The primary repo under review (B1). Per-repo freshness is B2; this is the anchor. */
  repo?: string;
  reviewId: string;
  patchsetId: string;
  lineage?: string;
  mode?: "own-branch-handoff" | "someone-elses-pr";
}

/** What the user is looking at now (read-only deixis). */
export interface ViewState {
  openCanvasId?: string;
  angle?: CanvasAngle;
  expandedCohorts: string[];
  viewportAnchor?: string;
  selection?: string;
}

/** The full content of one addressed thing (`canvas.read` — the zoom-in). */
export interface ElementDetail {
  refKind: "element" | "disposition" | "annotation" | "cohort";
  ref: string;
  element?: AnalysisElement;
  body?: unknown;
  provenancePointer?: string;
  blastRadius?: boolean;
  disposition?: Disposition;
  annotation?: Annotation;
}

/** One message in a disposition's inline clarification thread. */
export interface ThreadMessage {
  author: "user" | "orchestrator" | "fleet";
  body: string;
  at?: number;
}

/** A disposition's clarification thread plus its current refined/published form. */
export interface ThreadDetail {
  dispositionId: string;
  messages: ThreadMessage[];
  refined?: string;
  published?: string;
}

/** Hunk content with lineage status and any dispositions anchored to it. */
export interface HunkDetail {
  ref: string;
  hunkId?: string;
  file?: string;
  content: string;
  lineage: "carried-approved" | "new" | "modified" | "ambiguous-failed-closed";
  dispositions: Disposition[];
}

/** A matching anchor from the occurrence manifest (anchors, not content). */
export interface DiffHit {
  anchor: string;
  kind: string;
  file?: string;
}

/** One run-ledger row: which fleet task ran, at what tier/model, and its yield. */
export interface RunLedgerEntry {
  runId: string;
  purpose: string;
  tier: RspTier;
  model: string;
  admitted: number;
  rejected: number;
  budgetSpent?: number;
  budgetRemaining?: number;
}

/**
 * The data-access port the host implements. The tool handlers shape, paginate,
 * and stamp freshness over what this returns; the port supplies durable state
 * and applies the (L3/presentational/recompute) effects the write ops emit. A
 * direct-address miss returns `undefined` (the handler decides error vs
 * nothing-found by whether the call addressed a specific thing or searched).
 */
export interface CanvasOpsBackend {
  identity(): ReviewIdentity;
  /** R30 at the reply: the freshness verdict for the addressed canvas. */
  freshness(canvasId?: string): OpsFreshness;
  angles(): readonly CanvasAngle[];
  /** Resolve a canvas (default: the user's active canvas). `undefined` if none. */
  canvas(canvasId?: string): Canvas | undefined;
  view(): ViewState;
  element(ref: string): ElementDetail | undefined;
  thread(dispositionId: string): ThreadDetail | undefined;
  hunk(ref: string, contextLines?: number): HunkDetail | undefined;
  searchDiff(query: string): readonly DiffHit[];
  decomposition(): Decomposition;
  runLedger(filter?: string): readonly RunLedgerEntry[];
  provenance(docId: string): RspProvenance | undefined;
  /** The RoutePlan budget gate for a recompute (R10: refuses before any model runs). */
  planRecompute(scope: string, angle?: CanvasAngle): RoutePlanResult;
  /**
   * `context.map` (issue #14): the deterministic, MODEL-FREE structural map of the
   * base branch at the review's resolved base OID, optionally scoped. The backend
   * owns the per-request `ReviewIdentity.repo → repoKey → resolved base-OID`
   * resolution and passes it through the fail-closed reader gate, so this returns
   * either a served map or a TYPED gate failure (absent | stale | corrupt) — never
   * a stale/served-but-wrong map. No LLM anywhere in this path.
   */
  projectMap(scope?: ProjectMapScope): ProjectMapResult;
  /**
   * `context.file` (issue #14): what the deterministic snapshot knows about ONE
   * repo-relative file at the resolved base OID (structural entry + symbols). The
   * path is escape-checked by the reader; the same fail-closed gate applies, so a
   * stale/absent/corrupt snapshot is a typed refusal, never a served answer.
   */
  fileContext(path: string): ProjectFileResult;
  /**
   * `context.novelty` (issue #144): the deterministic, MODEL-FREE novelty ledger
   * for the review's CHANGE (each changed file/symbol classified novel/extends/
   * conforms with cited baseline evidence) against the snapshot at the patchset's
   * pinned base OID. The backend owns the per-review `{repoKey, patchset}`
   * resolution and passes it through the SAME fail-closed snapshot gate the context
   * reads use, so this returns either a served ledger or a TYPED gate failure
   * (absent | stale | corrupt) — never a ledger computed against a mismatched
   * baseline. No LLM anywhere in this path (the extends/conforms/novel LLM layer is
   * a deferred Stage-2 wave).
   */
  novelty(): NoveltyResult;
  /**
   * `context.overview` (repo-map-symbolic-surface, layer b): the LEANEST
   * context-saver — a file's top-level symbol overview (names, kinds, lines, NO
   * bodies) served straight from the deterministic snapshot's per-file symbol
   * shards. Model-free, on Rennet's OWN index (no LSP, no bundled engine). The
   * backend resolves the base OID and passes the same fail-closed gate the other
   * context reads use, so a stale/absent/corrupt snapshot is a typed refusal,
   * never a served-but-wrong overview.
   */
  fileOverview(path: string): ProjectFileOverviewResult;
  /**
   * `context.symbol` (repo-map-symbolic-surface, layer b): Rennet's OWN model-free
   * go-to-definition. Resolves an exported symbol NAME to its definition site(s)
   * across the snapshot's `structural-ts-v1` symbol index (path + line + owning
   * scope), pinned to the review's base OID. NO model and NO LSP — it scans the
   * deterministic exported-symbol index we already build. Honest scope: exported
   * top-level symbols only (a `reexport` site is labelled as such). The backend
   * resolves the base OID and passes the same fail-closed gate, so a
   * stale/absent/corrupt snapshot is a typed refusal, never a served-but-wrong site.
   */
  symbolDefinition(query: SymbolLookup): ProjectSymbolDefinitionResult;
  /**
   * `context.references` (repo-map-symbolic-surface, layer b — #200): Rennet's OWN
   * model-free find-references, the blast-radius third op completing `context.overview`
   * + `context.symbol`. Resolves an identifier NAME to its occurrence site(s) across
   * the snapshot's `structural-refs-v1` reference index (path + line + owning scope),
   * pinned to the review's base OID. NO model and NO LSP. Honest scope: NAME-based and
   * TEXTUAL (a mention in a comment/string counts; two distinct symbols sharing a name
   * are indistinct). The backend resolves the base OID and passes the same fail-closed
   * gate, so a stale/absent/corrupt snapshot is a typed refusal, never a served-but-wrong site.
   */
  references(query: ReferenceLookup): ProjectReferenceResult;
  /**
   * `context.knowledge` (repo-map-knowledge, layer c): the LLM-reconstructed
   * understanding of the base branch — what a module does, the conventions it
   * embodies, the reconstructed WHY — served VERBATIM with each statement's
   * evidence, confidence, and hypothesis label intact. The ONLY model-backed
   * layer, and it is OFF the review's critical path: it degrades to an empty view
   * (not-yet-enriched) honestly rather than blocking. The backend resolves the
   * base OID and passes the SAME fail-closed snapshot gate the other context reads
   * use (so a stale/absent/corrupt snapshot is a typed refusal); a statement whose
   * cited bytes the current snapshot changed is disclosed as invalidated-pending,
   * never silently dropped. Model turns happen on enrichment, NEVER on this read.
   */
  knowledge(query?: KnowledgeQuery): KnowledgeResult;
  /**
   * `context.ask` (issue #15): one synthesised answer to a question about the
   * project, composed from the existing pure reads plus ONE injected model turn.
   * Unlike every other retrieval accessor this is model-backed, so it is async —
   * it returns the validated answer document (`{answer, evidence, confidence,
   * unanswered?}` + a metered `cost`), a first-class `unanswered`-with-reason
   * success, or a `failed` ask (an evidence-free answer is never served as clean).
   * The answering machinery lives behind this port boundary and MAY be upgraded
   * without changing the tool contract. Budget is metered and reported, never
   * refused (Rule Zero).
   */
  ask(query: ContextAskQuery): Promise<RunContextAskResult>;
  /** Apply the effects a write op emitted. Never receives an L2 write. */
  applyEffects(effects: readonly CanvasOpsEffect[]): void;
}

/**
 * Freshness reconciliation (issue #14 decision #2): map the snapshot gate's
 * failure space (`absent | stale | corrupt`) onto the canvasOps@2 `OpsFreshness`
 * verdict every reply carries. `stale` is exactly the surface's `stale` (R30 at
 * the reply); `absent` and `corrupt` are both `failed` — the deterministic read
 * gate could not produce a snapshot, so the read failed. The surface's fourth
 * verdict `updating` is never produced here: it denotes a live rebuild in flight,
 * which the fail-closed READ gate does not signal (a snapshot is either fresh at
 * the requested OID, or it is one of these three refusals).
 */
function snapshotFreshness(failure: SnapshotGateFailure): OpsFreshness {
  return failure.reason === "stale" ? "stale" : "failed";
}

// ── Tool descriptor + neutral param spec ─────────────────────────────────────

/** A neutral (harness-agnostic) parameter type, compiled to Zod / JSON Schema by a transport. */
export type ToolParamType = "string" | "string[]" | "number" | "boolean" | "enum";

/** One tool parameter, described independently of any schema library. */
export interface ToolParam {
  name: string;
  type: ToolParamType;
  optional: boolean;
  description: string;
  enum?: readonly string[];
}

/** The tool's arguments as received from the transport (validated defensively). */
export type ToolArgs = Record<string, unknown>;

/** Whether a tool is an interaction op or a retrieval read. */
export type CanvasOpsToolKind = "interaction" | "retrieval";

/**
 * A canvasOps@2 tool descriptor: a harness-agnostic contract with a PURE handler
 * over the backend port. `readOnly` maps to the transport's `readOnlyHint`;
 * `alwaysLoad` keeps the hot trio out of tool-search deferral (§2.5).
 */
export interface CanvasOpsTool {
  name: string;
  description: string;
  kind: CanvasOpsToolKind;
  readOnly: boolean;
  alwaysLoad: boolean;
  params: readonly ToolParam[];
  /**
   * The pure handler. Almost every tool is synchronous (a deterministic read);
   * `context.ask` is the one model-backed tool and returns a `Promise`, so the
   * type admits either — the transport (`toSdkHandler`) awaits the outcome
   * uniformly.
   */
  handle(args: ToolArgs, backend: CanvasOpsBackend): ToolOutcome | Promise<ToolOutcome>;
}

// ── Argument + pagination helpers ────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function optString(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireString(args: ToolArgs, key: string): string | undefined {
  return optString(args, key);
}

function stringList(args: ToolArgs, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

function enumArg<T extends string>(
  args: ToolArgs,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[key];
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function pageLimit(args: ToolArgs): number {
  const value = args.limit;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(value), MAX_PAGE_SIZE);
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Paginate with totality: `total` is the true length, `cursor` is the next
 * offset as a string, or `null` at completion. A silent cap is impossible — a
 * non-null cursor is the honest "more exists" signal.
 */
function paginate<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit: number,
): { page: T[]; total: number; cursor: string | null } {
  const offset = decodeCursor(cursor);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    page,
    total: items.length,
    cursor: nextOffset < items.length ? String(nextOffset) : null,
  };
}

function ok<T>(
  data: T,
  parts: { freshness: OpsFreshness; evidence?: string[]; total?: number; cursor?: string | null },
  effects: CanvasOpsEffect[] = [],
): ToolOutcome<T> {
  const envelope: OpsEnvelope<T> = { data, freshness: parts.freshness };
  if (parts.evidence) envelope.evidence = parts.evidence;
  if (parts.total !== undefined) envelope.total = parts.total;
  if (parts.cursor !== undefined) envelope.cursor = parts.cursor;
  return { ok: true, envelope, effects };
}

function fail(code: OpsError["code"], message: string): ToolOutcome {
  return { ok: false, error: { code, message } };
}

// ── Shaping helpers ──────────────────────────────────────────────────────────

interface CanvasCounts {
  angle: CanvasAngle;
  canvasId: string;
  elements: number;
  cohorts: number;
  residue: number;
  coverage: {
    paths: number;
    dispositioned: number;
    unread: number;
    approved: number;
    requestChanged: number;
  };
}

/** Count-level canvas state (B3): the shape of the review, contents excluded. */
function computeCounts(canvas: Canvas, residue: number): CanvasCounts {
  const substratePaths = new Set(canvas.layers.substrate.chunks.flatMap((c) => c.filePaths));
  const disps = canvas.layers.disposition.dispositions;
  const dispositioned = new Set(disps.map((d) => d.anchor.path));
  const byType = (type: DispositionType) => disps.filter((d) => d.type === type).length;
  return {
    angle: canvas.angle,
    canvasId: canvas.canvasId,
    elements: canvas.layers.analysis.elements.length,
    cohorts: canvas.layers.analysis.cohorts.length,
    residue,
    coverage: {
      paths: substratePaths.size,
      dispositioned: dispositioned.size,
      // "read" iff a substrate path carries a disposition (the type model's own
      // definition of read); unread = the substrate paths with no disposition.
      unread: Math.max(0, substratePaths.size - dispositioned.size),
      approved: byType("approve"),
      requestChanged: byType("request-change"),
    },
  };
}

function summarizeElement(element: AnalysisElement): {
  elementKey: string;
  docId: string;
  anchor: string;
  kind: string;
  title: string;
} {
  return {
    elementKey: element.elementKey,
    docId: element.docId,
    anchor: element.anchor,
    kind: element.kind,
    title: element.title,
  };
}

function summarizeCohort(cohort: Canvas["layers"]["analysis"]["cohorts"][number]): {
  cohortKey: string;
  title: string;
  elements: number;
} {
  return { cohortKey: cohort.cohortKey, title: cohort.title, elements: cohort.elementKeys.length };
}

// ── Interaction ops ──────────────────────────────────────────────────────────

const describeTool: CanvasOpsTool = {
  name: "canvas.describe",
  description:
    "Tell me what is on a canvas surface, at the altitude you choose. Use FIRST to orient: depth 'counts' is the shape of the review (element/cohort/disposition-coverage numbers), 'cohorts' is the cohort tree in logical order, 'elements' is the element summaries. Paginated with totality — follow the cursor; a page is never the whole.",
  kind: "interaction",
  readOnly: true,
  alwaysLoad: true,
  params: [
    {
      name: "canvasId",
      type: "string",
      optional: true,
      description: "The canvas to describe (default: the user's active canvas).",
    },
    {
      name: "depth",
      type: "enum",
      optional: true,
      enum: ["counts", "cohorts", "elements"],
      description: "Altitude: counts | cohorts | elements. Default counts.",
    },
    {
      name: "cursor",
      type: "string",
      optional: true,
      description: "Continuation cursor from a prior page (cohorts/elements).",
    },
    {
      name: "limit",
      type: "number",
      optional: true,
      description: "Max rows per page (cohorts/elements).",
    },
  ],
  handle(args, backend) {
    const canvasId = optString(args, "canvasId");
    const depth = enumArg(args, "depth", ["counts", "cohorts", "elements"] as const) ?? "counts";
    const canvas = backend.canvas(canvasId);
    if (!canvas) return fail("not-found", `no canvas for ${canvasId ?? "(active)"}`);
    const freshness = backend.freshness(canvasId);
    const evidence = [canvas.canvasId];
    if (depth === "counts") {
      const residue = backend.decomposition().residue.length;
      return ok(computeCounts(canvas, residue), { freshness, evidence });
    }
    const limit = pageLimit(args);
    const cursor = optString(args, "cursor");
    if (depth === "cohorts") {
      const rows = canvas.layers.analysis.cohorts.map(summarizeCohort);
      const paged = paginate(rows, cursor, limit);
      return ok(paged.page, { freshness, evidence, total: paged.total, cursor: paged.cursor });
    }
    const rows = canvas.layers.analysis.elements.map(summarizeElement);
    const paged = paginate(rows, cursor, limit);
    return ok(paged.page, { freshness, evidence, total: paged.total, cursor: paged.cursor });
  },
};

const viewTool: CanvasOpsTool = {
  name: "canvas.view",
  description:
    "Tell me what the user is looking at now: open canvas, active lens, expanded cohorts, viewport anchor, selection. Read-only deixis (this context is also pushed to you on each user request; the pull form is for mid-answer re-checks).",
  kind: "interaction",
  readOnly: true,
  alwaysLoad: true,
  params: [],
  handle(_args, backend) {
    return ok(backend.view(), { freshness: backend.freshness() });
  },
};

const focusTool: CanvasOpsTool = {
  name: "canvas.focus",
  description:
    "Look here: scroll/open the target for the user. Purely presentational — no state changes and NOTHING becomes read. Invite the user's attention; never spend it on their behalf.",
  kind: "interaction",
  readOnly: false,
  alwaysLoad: false,
  params: [
    {
      name: "target",
      type: "string",
      optional: false,
      description: "The element key or anchor to bring into view.",
    },
  ],
  handle(args, backend) {
    const target = requireString(args, "target");
    if (!target) return fail("invalid-input", "canvas.focus requires a target");
    return ok({ focused: target }, { freshness: backend.freshness() }, [{ kind: "focus", target }]);
  },
};

const annotateTool: CanvasOpsTool = {
  name: "canvas.annotate",
  description:
    "Mark something for our conversation: a highlight, callout, or link on an element or anchor. Ephemeral by default (it vanishes at session end); the user alone may pin it. This never alters analysis, dispositions, cohorts, or ordering.",
  kind: "interaction",
  readOnly: false,
  alwaysLoad: false,
  params: [
    {
      name: "target",
      type: "string",
      optional: false,
      description: "The element key or anchor to mark.",
    },
    {
      name: "kind",
      type: "enum",
      optional: true,
      enum: ["highlight", "callout", "link"],
      description: "Mark kind. Default highlight.",
    },
    { name: "body", type: "string", optional: true, description: "Optional mark text." },
    {
      name: "canvasId",
      type: "string",
      optional: true,
      description: "The canvas the mark belongs to (default: active).",
    },
  ],
  handle(args, backend) {
    const target = requireString(args, "target");
    if (!target) return fail("invalid-input", "canvas.annotate requires a target");
    const kind = (enumArg(args, "kind", ["highlight", "callout", "link"] as const) ??
      "highlight") as AnnotationKind;
    const canvas = backend.canvas(optString(args, "canvasId"));
    const canvasId = optString(args, "canvasId") ?? canvas?.canvasId ?? "";
    const annotationId = uuidv7();
    // Route through issue #10's dispatch: its effect union structurally excludes
    // L2, so an annotate can only ever emit a CanvasAnnotated (L3).
    const effect = dispatchOrchestratorCanvasOp("canvas.annotate", {
      canvasId,
      target,
      kind,
      body: optString(args, "body") ?? "",
      annotationId,
    });
    const effects: CanvasOpsEffect[] = effect.kind === "annotate" ? [effect] : [];
    return ok(
      { annotationId, target, kind, pinned: false },
      { freshness: backend.freshness(canvasId) },
      effects,
    );
  },
};

const proposeTool: CanvasOpsTool = {
  name: "canvas.propose",
  description:
    "Suggest — you decide. Raise a disposition/regroup/split proposal on L3 next to its target(s) with an accept/edit/dismiss affordance. BULK is allowed: one proposal may cover many anchors (e.g. approve all verified-noise groups). Accepting is a USER act and only then becomes a disposition — you never write one yourself.",
  kind: "interaction",
  readOnly: false,
  alwaysLoad: false,
  params: [
    {
      name: "kind",
      type: "enum",
      optional: false,
      enum: ["disposition", "regroup", "split"],
      description: "Proposal kind.",
    },
    {
      name: "targets",
      type: "string[]",
      optional: false,
      description: "One or more element keys / anchors the proposal covers (bulk allowed).",
    },
    {
      name: "payload",
      type: "string",
      optional: false,
      description: "The proposed content (e.g. the disposition body).",
    },
    {
      name: "canvasId",
      type: "string",
      optional: true,
      description: "The canvas the proposal belongs to (default: active).",
    },
  ],
  handle(args, backend) {
    const kind = enumArg(args, "kind", ["disposition", "regroup", "split"] as const) as
      | ProposalKind
      | undefined;
    if (!kind) return fail("invalid-input", "canvas.propose requires a kind");
    const targets = stringList(args, "targets");
    const primaryTarget = targets[0];
    if (primaryTarget === undefined)
      return fail("invalid-input", "canvas.propose requires at least one target");
    const payload = requireString(args, "payload");
    if (payload === undefined) return fail("invalid-input", "canvas.propose requires a payload");
    const canvas = backend.canvas(optString(args, "canvasId"));
    const canvasId = optString(args, "canvasId") ?? canvas?.canvasId ?? "";
    const proposalId = uuidv7();
    // A bulk proposal carries every covered anchor in its (opaque) payload so one
    // proposal can span many anchors; `target` names the primary for rendering.
    const proposal: Proposal = {
      proposalId,
      kind,
      target: primaryTarget,
      payload: JSON.stringify({ targets, body: payload }),
      status: "pending",
    };
    const effect = dispatchOrchestratorCanvasOp("canvas.propose", { canvasId, proposal });
    const effects: CanvasOpsEffect[] = effect.kind === "propose" ? [effect] : [];
    return ok(
      { proposalId, kind, targets, status: "pending" },
      { freshness: backend.freshness(canvasId) },
      effects,
    );
  },
};

const recomputeTool: CanvasOpsTool = {
  name: "canvas.recompute",
  description:
    "Re-run the fleet on a slice. Explicit, budget-gated by the same RoutePlan machinery, and visible to the user. Over budget, it REFUSES before any model runs and returns the refusal — model-backed regeneration is never automatic.",
  kind: "interaction",
  readOnly: false,
  alwaysLoad: false,
  params: [
    {
      name: "scope",
      type: "string",
      optional: false,
      description: "The slice to re-run (an anchor / chunk / cohort).",
    },
    {
      name: "angle",
      type: "enum",
      optional: true,
      enum: ["spec", "sequence", "decisions", "noise"],
      description: "Restrict to one canvas angle.",
    },
  ],
  handle(args, backend) {
    const scope = requireString(args, "scope");
    if (!scope) return fail("invalid-input", "canvas.recompute requires a scope");
    const angle = enumArg(args, "angle", ["spec", "sequence", "decisions", "noise"] as const);
    const plan = backend.planRecompute(scope, angle);
    // Refused ⇒ a VISIBLE refusal in the envelope, and NO recompute effect (the
    // budget gate refused before any model would run — R10).
    const effects: CanvasOpsEffect[] = plan.refused
      ? []
      : [{ kind: "recompute", scope, angle, plan }];
    return ok(plan, { freshness: backend.freshness() }, effects);
  },
};

// ── Retrieval family (all read-only) ─────────────────────────────────────────

const readTool: CanvasOpsTool = {
  name: "canvas.read",
  description:
    "Zoom in: the full content of ONE thing — an L1 element's admitted body, an L2 disposition's raw+refined form, or an L3 annotation. `describe` tells you what is on the surface; `read` gets a specific thing into the conversation without dragging its siblings along.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    {
      name: "ref",
      type: "string",
      optional: false,
      description: "An element key, anchor, disposition id, annotation id, or cohort id.",
    },
  ],
  handle(args, backend) {
    const ref = requireString(args, "ref");
    if (!ref) return fail("invalid-input", "canvas.read requires a ref");
    const detail = backend.element(ref);
    if (!detail) return fail("not-found", `no element/disposition/annotation for ${ref}`);
    const evidence = [detail.provenancePointer ?? detail.element?.docId ?? ref].filter(
      (v): v is string => typeof v === "string",
    );
    return ok(detail, { freshness: backend.freshness(), evidence });
  },
};

const threadTool: CanvasOpsTool = {
  name: "canvas.thread",
  description:
    "Read a disposition's inline clarification thread (the comment-interpretation back-and-forth), oldest-first, plus its current refined/published form. A disposition with no thread is a distinguished nothing-found, not an error.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    {
      name: "dispositionId",
      type: "string",
      optional: false,
      description: "The disposition whose thread to read.",
    },
  ],
  handle(args, backend) {
    const dispositionId = requireString(args, "dispositionId");
    if (!dispositionId) return fail("invalid-input", "canvas.thread requires a dispositionId");
    const thread = backend.thread(dispositionId);
    if (!thread) {
      // Nothing-found is distinguished: a disposition legitimately may have no
      // thread. total 0, scope named — never an empty-looking success.
      return ok(
        { dispositionId, messages: [] as ThreadMessage[], scope: `thread:${dispositionId}` },
        { freshness: backend.freshness(), total: 0 },
      );
    }
    return ok(thread, { freshness: backend.freshness(), total: thread.messages.length });
  },
};

const diffReadTool: CanvasOpsTool = {
  name: "diff.read",
  description:
    "Read hunk content with surrounding context, its lineage status (carried-approved | new | modified | ambiguous-failed-closed), and any dispositions anchored to it.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    {
      name: "ref",
      type: "string",
      optional: false,
      description: "An anchor, hunk id, or file path.",
    },
    {
      name: "contextLines",
      type: "number",
      optional: true,
      description: "Lines of surrounding context.",
    },
  ],
  handle(args, backend) {
    const ref = requireString(args, "ref");
    if (!ref) return fail("invalid-input", "diff.read requires a ref");
    const contextValue = args.contextLines;
    const contextLines =
      typeof contextValue === "number" && Number.isFinite(contextValue) ? contextValue : undefined;
    const hunk = backend.hunk(ref, contextLines);
    if (!hunk) return fail("not-found", `no hunk for ${ref}`);
    return ok(hunk, { freshness: backend.freshness(), evidence: [ref] });
  },
};

const diffSearchTool: CanvasOpsTool = {
  name: "diff.search",
  description:
    "Find matching anchors from the occurrence manifest by text | symbol | path-glob. Returns ANCHORS not content, so a broad search is cheap — zoom with diff.read. No matches is a distinguished nothing-found (total 0, scope named).",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    {
      name: "query",
      type: "string",
      optional: false,
      description: "Text, symbol, or path-glob to search for.",
    },
    {
      name: "cursor",
      type: "string",
      optional: true,
      description: "Continuation cursor from a prior page.",
    },
    { name: "limit", type: "number", optional: true, description: "Max hits per page." },
  ],
  handle(args, backend) {
    const query = requireString(args, "query");
    if (!query) return fail("invalid-input", "diff.search requires a query");
    const hits = backend.searchDiff(query);
    const paged = paginate(hits, optString(args, "cursor"), pageLimit(args));
    // Named scope even when empty: absence of results is distinguishable from a
    // failed search.
    return ok(
      { scope: `diff:${query}`, results: paged.page },
      {
        freshness: backend.freshness(),
        total: paged.total,
        cursor: paged.cursor,
      },
    );
  },
};

const diffStructureTool: CanvasOpsTool = {
  name: "diff.structure",
  description:
    "The decomposition DAG / topological reading order as data (the sequence canvas's L1). This is the ordering substrate — 'why is this cohort first?' is answerable with evidence, not vibes.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [],
  handle(_args, backend) {
    const decomposition = backend.decomposition();
    const data = {
      chunks: decomposition.chunks,
      edges: decomposition.edges,
      readingOrder: decomposition.readingOrder,
      residue: decomposition.residue,
      // Incomplete-ingestion blockers (R18): a truncated tail, a binary blob, or
      // a submodule pointer the floor could not ingest. A done or publish gate
      // can refuse a false-clear by checking this array directly.
      blockingStates: decomposition.blockingStates,
    };
    return ok(data, { freshness: backend.freshness(), total: decomposition.chunks.length });
  },
};

const runLedgerTool: CanvasOpsTool = {
  name: "run.ledger",
  description:
    "Which fleet tasks ran, their tiers, models, budgets, and admitted-vs-rejected counts. An honest capability statement: whether analysis is complete, degraded, or budget-starved.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    {
      name: "filter",
      type: "string",
      optional: true,
      description: "Optional filter (e.g. a purpose or run id).",
    },
    {
      name: "cursor",
      type: "string",
      optional: true,
      description: "Continuation cursor from a prior page.",
    },
    { name: "limit", type: "number", optional: true, description: "Max rows per page." },
  ],
  handle(args, backend) {
    const rows = backend.runLedger(optString(args, "filter"));
    const paged = paginate(rows, optString(args, "cursor"), pageLimit(args));
    return ok(paged.page, {
      freshness: backend.freshness(),
      total: paged.total,
      cursor: paged.cursor,
    });
  },
};

const runProvenanceTool: CanvasOpsTool = {
  name: "run.provenance",
  description:
    "The provenance block for one admitted document: harness, model, tier, route, input digest, capability snapshot, tokens, and cost.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    { name: "docId", type: "string", optional: false, description: "The admitted document id." },
  ],
  handle(args, backend) {
    const docId = requireString(args, "docId");
    if (!docId) return fail("invalid-input", "run.provenance requires a docId");
    const provenance = backend.provenance(docId);
    if (!provenance) return fail("not-found", `no provenance for ${docId}`);
    return ok(provenance, { freshness: backend.freshness(), evidence: [docId] });
  },
};

// ── Base-branch / change context reads (issues #14, #144) ─────────────────────
//
// `context.map` / `context.file` (issue #14) are the base-branch/workspace context
// as a first-class tool surface (Orchestrator Context Access §2.3); `context.novelty`
// (issue #144) is the deterministic novelty ledger for the CHANGE against that base.
// All three are DETERMINISTIC and MODEL-FREE: each wraps a fail-closed reader gate
// through the backend port, so a stale / absent / corrupt snapshot surfaces as an
// honest freshness verdict, never a served-but-wrong answer. The per-request base is
// resolved by the backend, off this pure surface: `context.map` / `context.file`
// resolve `ReviewIdentity.repo → repoKey → base OID`; `context.novelty` resolves the
// review's `{repoKey, patchset}` (the patchset pins its own base OID).

/** The uniform "the snapshot could not be served" payload — a distinguished value. */
function unavailable(
  failure: SnapshotGateFailure,
  extra?: Record<string, unknown>,
): { unavailable: SnapshotGateFailure } & Record<string, unknown> {
  return { unavailable: failure, ...extra };
}

const contextMapTool: CanvasOpsTool = {
  name: "context.map",
  description:
    "The deterministic structural MAP of the base branch at the review's pinned base OID: files, workspace scopes, dependency edges, entry points, tests, ownership, conventions. NO model in this path — it is the checkable shape of the project, not an interpretation, and it carries the base OID + fingerprint so you can prove which snapshot you read. Optionally narrow to a subtree (path) and/or a workspace scope. A stale/absent/corrupt snapshot rides back as a freshness verdict with an `unavailable` payload, never a served map.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    {
      name: "path",
      type: "string",
      optional: true,
      description: "Repo-relative POSIX subtree prefix to scope the map to.",
    },
    {
      name: "scope",
      type: "string",
      optional: true,
      description: "A workspace scope name to scope the map to.",
    },
  ],
  handle(args, backend) {
    const path = optString(args, "path");
    const scope = optString(args, "scope");
    const query: ProjectMapScope | undefined =
      path === undefined && scope === undefined
        ? undefined
        : {
            ...(path !== undefined ? { path } : {}),
            ...(scope !== undefined ? { scope } : {}),
          };
    const result = backend.projectMap(query);
    if (result.ok) {
      // The gate only serves a map that is FRESH at the requested OID, so a served
      // map is always `current`; its own base OID + fingerprint are the evidence.
      return ok(result.map, {
        freshness: "current",
        evidence: [result.map.baseOid, result.map.fingerprint],
      });
    }
    // A refusal is a real, honest reply — the verdict rides on the answer (R30).
    return ok(unavailable(result.failure, { scope: `context.map:${path ?? scope ?? "(all)"}` }), {
      freshness: snapshotFreshness(result.failure),
    });
  },
};

const contextFileTool: CanvasOpsTool = {
  name: "context.file",
  description:
    "What the deterministic snapshot knows about ONE file at the review's pinned base OID: its git blob OID, size, mode, workspace scope, and declared symbols (recovered structurally, no model). The path is repo-relative and escape-checked — `../`, absolute, and unsafe paths are refused as invalid input. A path absent from the tree is a not-found. A stale/absent/corrupt snapshot rides back as a freshness verdict with an `unavailable` payload, never a served-but-wrong answer.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    {
      name: "path",
      type: "string",
      optional: false,
      description: "Repo-relative POSIX path of the file, escape-checked.",
    },
  ],
  handle(args, backend) {
    const path = requireString(args, "path");
    if (!path) return fail("invalid-input", "context.file requires a path");
    const result = backend.fileContext(path);
    if (result.ok) {
      return ok(result.context, {
        freshness: "current",
        evidence: [result.context.blobOid],
      });
    }
    switch (result.reason) {
      // A malformed address and a missing-but-well-formed address are call-level
      // errors (matching diff.read / run.provenance direct-address misses).
      case "invalid-path":
        return fail("invalid-input", `context.file refuses unsafe path: ${result.path}`);
      case "not-found":
        return fail("not-found", `no file ${result.path} at the base OID`);
      // A symbol shard the manifest references would not decode intact — a
      // corruption of the file's own symbols. Surface it uniformly with the
      // whole-snapshot corrupt case: a `failed` read with an `unavailable`
      // payload, never a silent "no symbols".
      case "shard-unavailable":
        return ok(
          unavailable(
            { reason: "corrupt", missing: [], mismatched: [result.digest] },
            { path: result.path },
          ),
          { freshness: "failed" },
        );
      case "snapshot-unavailable":
        return ok(unavailable(result.failure, { path }), {
          freshness: snapshotFreshness(result.failure),
        });
    }
  },
};

const contextNoveltyTool: CanvasOpsTool = {
  name: "context.novelty",
  description:
    "The deterministic NOVELTY LEDGER for this review's change against the base branch at the pinned base OID: every changed file and introduced symbol classified `novel` | `extends` | `conforms`, each verdict citing the concrete baseline entity (or its absence) it rests on. NO model in this path — it is the checkable structural relationship between the change and the baseline, not an interpretation, and it carries the base OID + snapshot fingerprint + patchset id so you can prove which (baseline, diff) pair produced it. A stale/absent/corrupt snapshot rides back as a freshness verdict with an `unavailable` payload, never a ledger computed against a mismatched baseline.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [],
  handle(_args, backend) {
    const result = backend.novelty();
    if (result.ok) {
      // The gate only serves a ledger built against a snapshot FRESH at the
      // patchset's base OID, so a served ledger is always `current`; its own base
      // OID + fingerprint + patchset id are the (baseline, diff) provenance.
      return ok(result.ledger, {
        freshness: "current",
        evidence: [
          result.ledger.baseOid,
          result.ledger.snapshotFingerprint,
          result.ledger.patchsetId,
        ],
      });
    }
    // A refusal is a real, honest reply — the verdict rides on the answer (R30).
    return ok(unavailable(result.failure, { scope: "context.novelty" }), {
      freshness: snapshotFreshness(result.failure),
    });
  },
};

// ── Symbolic navigation surface (repo-map-symbolic-surface, layer b) ──────────
//
// The model-free "IDE for the agent" (context-window economy is the design goal,
// not a side effect), built on Rennet's OWN deterministic index — no LSP, no
// bundled engine, no model. Per Rai (2026-08-10): recreate the useful bits
// ourselves rather than bundle a proprietary tool (codeindexer, rejected on
// licence) or ship a heavy runtime (Serena's Python+LSP stack).
//
//   • `context.overview` — a file's exported-symbol overview from its per-file
//     symbol shard. "What's in this file" without reading it.
//   • `context.symbol`  — go-to-definition: resolve an exported symbol NAME to its
//     definition site(s) across the same exported-symbol index.
//
//   • `context.references` — find-references (#200): resolve an identifier NAME to
//     every occurrence SITE across the tree, for blast radius. Completes the trio.
//
// `context.overview`/`context.symbol` are honest about the exported-symbol index's
// reach: EXPORTED top-level symbols only (the `structural-ts-v1` extractor's scope).
// `context.references` rides a SEPARATE per-file index (`structural-refs-v1`) that
// records identifier occurrences, so it reaches further — but is honest that its
// matching is NAME-BASED and TEXTUAL (regex, not a parse): two distinct symbols that
// share a name are indistinct, and a mention in a comment/string counts.

const contextOverviewTool: CanvasOpsTool = {
  name: "context.overview",
  description:
    "The leanest context-saver: ONE file's top-level symbol OVERVIEW at the review's pinned base OID — declared symbols (name, kind, 1-based line), signatures not bodies, recovered structurally from the snapshot's per-file symbol shards. NO model and NO LSP in this path. Use this to learn what a file contains WITHOUT reading the file into your window. Paginated with totality — follow the cursor; a page is never the whole. A stale/absent/corrupt snapshot rides back as a freshness verdict with an `unavailable` payload; a file with no extractable symbols is an honest ok with `hasSymbols: false`.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    {
      name: "path",
      type: "string",
      optional: false,
      description: "Repo-relative POSIX path of the file, escape-checked.",
    },
    {
      name: "limit",
      type: "number",
      optional: true,
      description: "Max symbols per page (default 50, max 200).",
    },
    {
      name: "cursor",
      type: "string",
      optional: true,
      description: "The next-page offset returned by a previous call, or omit for the first page.",
    },
  ],
  handle(args, backend) {
    const path = requireString(args, "path");
    if (!path) return fail("invalid-input", "context.overview requires a path");
    const result = backend.fileOverview(path);
    if (result.ok) {
      const { page, total, cursor } = paginate(
        result.overview.symbols,
        optString(args, "cursor"),
        pageLimit(args),
      );
      // The overview minus the paginated symbol slice; `symbols` carries just the
      // page, `total` + `cursor` carry the totality (never a silent cap).
      return ok(
        {
          path: result.overview.path,
          blobOid: result.overview.blobOid,
          extractor: result.overview.extractor,
          hasSymbols: result.overview.hasSymbols,
          symbols: page,
        },
        { freshness: "current", evidence: [result.overview.blobOid], total, cursor },
      );
    }
    switch (result.reason) {
      case "invalid-path":
        return fail("invalid-input", `context.overview refuses unsafe path: ${result.path}`);
      case "not-found":
        return fail("not-found", `no file ${result.path} at the base OID`);
      case "shard-unavailable":
        return ok(
          unavailable(
            { reason: "corrupt", missing: [], mismatched: [result.digest] },
            {
              path: result.path,
            },
          ),
          { freshness: "failed" },
        );
      case "snapshot-unavailable":
        return ok(unavailable(result.failure, { path }), {
          freshness: snapshotFreshness(result.failure),
        });
    }
  },
};

const SYMBOL_KINDS = [
  "function",
  "class",
  "const",
  "let",
  "var",
  "interface",
  "type",
  "enum",
  "default",
  "reexport",
] as const;

const contextSymbolTool: CanvasOpsTool = {
  name: "context.symbol",
  description:
    "Go-to-definition, model-free: resolve an EXPORTED symbol NAME to its definition site(s) across the base branch at the pinned base OID — each site's file path, 1-based line, declaration kind, and owning workspace scope, from Rennet's deterministic exported-symbol index (the same shards `context.overview` reads). NO model, NO LSP. Use this to find WHERE a symbol is defined instead of reading files to hunt for it. Honest scope: EXPORTED top-level symbols only (not locals, class members, or unexported declarations); a re-export site is returned with kind `reexport`, not chased to its origin. Every match is returned (a name exported from several files yields several sites), so an empty `sites` is a real 'no exported definition found', never a hidden error. Optionally narrow by `kind` and/or workspace `scope`. A stale/absent/corrupt snapshot rides back as a freshness verdict with an `unavailable` payload.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    {
      name: "name",
      type: "string",
      optional: false,
      description: "The exported symbol name to resolve (e.g. `buildCanvas`).",
    },
    {
      name: "kind",
      type: "enum",
      optional: true,
      enum: SYMBOL_KINDS,
      description: "Restrict to this declaration kind.",
    },
    {
      name: "scope",
      type: "string",
      optional: true,
      description: "Restrict to definitions inside this workspace scope name.",
    },
    {
      name: "limit",
      type: "number",
      optional: true,
      description: "Max definition sites per page (default 50, max 200).",
    },
    {
      name: "cursor",
      type: "string",
      optional: true,
      description: "The next-page offset returned by a previous call, or omit for the first page.",
    },
  ],
  handle(args, backend) {
    const name = requireString(args, "name");
    if (!name) return fail("invalid-input", "context.symbol requires a name");
    const kind = enumArg(args, "kind", SYMBOL_KINDS);
    const scope = optString(args, "scope");
    const query: SymbolLookup = {
      name,
      ...(kind !== undefined ? { kind } : {}),
      ...(scope !== undefined ? { scope } : {}),
    };
    const result = backend.symbolDefinition(query);
    if (result.ok) {
      const { page, total, cursor } = paginate(
        result.definitions.sites,
        optString(args, "cursor"),
        pageLimit(args),
      );
      // Evidence is the concrete site set (path:line per definition); an empty set
      // is an honest "no exported definition", carried by total:0, not a fake hit.
      return ok(
        { name: result.definitions.name, sites: page },
        {
          freshness: "current",
          evidence: page.map((site) => `${site.path}:${site.line}`),
          total,
          cursor,
        },
      );
    }
    switch (result.reason) {
      case "shard-unavailable":
        return ok(
          unavailable(
            { reason: "corrupt", missing: [], mismatched: [result.digest] },
            { scope: `context.symbol:${name}` },
          ),
          { freshness: "failed" },
        );
      case "snapshot-unavailable":
        return ok(unavailable(result.failure, { scope: `context.symbol:${name}` }), {
          freshness: snapshotFreshness(result.failure),
        });
    }
  },
};

const contextReferencesTool: CanvasOpsTool = {
  name: "context.references",
  description:
    "Find-references, model-free: resolve an identifier NAME to every occurrence SITE across the base branch at the pinned base OID — each site's file path, 1-based line, and owning workspace scope, from Rennet's deterministic identifier-occurrence index (the third symbolic op, alongside context.overview and context.symbol). NO model, NO LSP. Use this for BLAST RADIUS — 'where is X used?' — instead of grepping whole files. Honest scope: matching is NAME-BASED and TEXTUAL (the index is regex-built, not a parse), so two DISTINCT symbols that share a name are indistinguishable, a mention in a line comment or string literal is a real occurrence (block comments are skipped), and the declaration site is included — this is 'every place the token appears', not a semantic use-set. Every occurrence is returned, so an empty `sites` is a real 'no occurrence found', never a hidden error. Optionally narrow by workspace `scope` and/or a repo-relative `path` subtree. Paginated with totality — a cursor means more exists. A stale/absent/corrupt snapshot rides back as a freshness verdict with an `unavailable` payload.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    {
      name: "name",
      type: "string",
      optional: false,
      description: "The identifier name to find occurrences of (e.g. `buildCanvas`).",
    },
    {
      name: "scope",
      type: "string",
      optional: true,
      description: "Restrict to occurrences inside this workspace scope name.",
    },
    {
      name: "path",
      type: "string",
      optional: true,
      description: "Restrict to occurrences under this repo-relative POSIX subtree prefix.",
    },
    {
      name: "limit",
      type: "number",
      optional: true,
      description: "Max occurrence sites per page (default 50, max 200).",
    },
    {
      name: "cursor",
      type: "string",
      optional: true,
      description: "The next-page offset returned by a previous call, or omit for the first page.",
    },
  ],
  handle(args, backend) {
    const name = requireString(args, "name");
    if (!name) return fail("invalid-input", "context.references requires a name");
    const scope = optString(args, "scope");
    const path = optString(args, "path");
    const query: ReferenceLookup = {
      name,
      ...(scope !== undefined ? { scope } : {}),
      ...(path !== undefined ? { path } : {}),
    };
    const result = backend.references(query);
    if (result.ok) {
      const { page, total, cursor } = paginate(
        result.references.sites,
        optString(args, "cursor"),
        pageLimit(args),
      );
      // Evidence is the concrete occurrence set (path:line per site); an empty set is
      // an honest "no occurrence", carried by total:0, not a fake hit.
      return ok(
        { name: result.references.name, sites: page },
        {
          freshness: "current",
          evidence: page.map((site) => `${site.path}:${site.line}`),
          total,
          cursor,
        },
      );
    }
    switch (result.reason) {
      case "shard-unavailable":
        return ok(
          unavailable(
            { reason: "corrupt", missing: [], mismatched: [result.digest] },
            { scope: `context.references:${name}` },
          ),
          { freshness: "failed" },
        );
      case "snapshot-unavailable":
        return ok(unavailable(result.failure, { scope: `context.references:${name}` }), {
          freshness: snapshotFreshness(result.failure),
        });
    }
  },
};

// ── LLM knowledge surface (repo-map-knowledge, layer c) ──────────────────────
//
// The ONE model-backed Repo Map layer, exposed as a read-only retrieval tool. The
// model turns happen on ENRICHMENT (project-open + baseline-advance delta pass),
// never on this read — `context.knowledge` serves the already-reconstructed set
// verbatim. It is OFF the review's fail-closed critical path (a review requires
// the structural map + symbolic surface, both model-free; knowledge is best-effort
// and degrades to an empty view when not yet enriched). Every statement carries
// its evidence, confidence, and hypothesis label; a statement the current snapshot
// invalidated is DISCLOSED as invalidated-pending, never silently absent.

const KNOWLEDGE_ASPECTS = ["purpose", "convention", "why"] as const;

const contextKnowledgeTool: CanvasOpsTool = {
  name: "context.knowledge",
  description:
    "The LLM-reconstructed KNOWLEDGE of the base branch: what a module does, the conventions it embodies, and the reconstructed WHY — each statement anchored to the code it is drawn from, with a `confidence` and a `status` label (`hypothesis` for a model-derived inference, `confirmed` for an established fact). Served VERBATIM from the already-enriched set — this read runs NO model. Use it to learn a module's intent WITHOUT re-deriving it from the code. Optionally narrow by `subject` (a scope name or path), `aspect` (purpose | convention | why), or a `path` subtree. Honesty: a `hypothesis` is never presented as fact; a statement whose cited bytes the current snapshot changed rides in `invalidatedPending` (disclosed, awaiting re-adjudication), never dropped; an empty result is an honest 'not yet enriched', not an error. Paginated with totality — a cursor means more exists. A stale/absent/corrupt snapshot rides back as a freshness verdict with an `unavailable` payload.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    {
      name: "subject",
      type: "string",
      optional: true,
      description: "Restrict to statements about this subject (a workspace scope name or a path).",
    },
    {
      name: "aspect",
      type: "enum",
      optional: true,
      enum: KNOWLEDGE_ASPECTS,
      description: "Restrict to this aspect of understanding.",
    },
    {
      name: "path",
      type: "string",
      optional: true,
      description:
        "Restrict to statements citing evidence under this repo-relative subtree prefix.",
    },
    {
      name: "limit",
      type: "number",
      optional: true,
      description: "Max statements per page (default 50, max 200).",
    },
    {
      name: "cursor",
      type: "string",
      optional: true,
      description: "The next-page offset returned by a previous call, or omit for the first page.",
    },
  ],
  handle(args, backend) {
    const subject = optString(args, "subject");
    const aspect = enumArg(args, "aspect", KNOWLEDGE_ASPECTS);
    const path = optString(args, "path");
    const query: KnowledgeQuery | undefined =
      subject === undefined && aspect === undefined && path === undefined
        ? undefined
        : {
            ...(subject !== undefined ? { subject } : {}),
            ...(aspect !== undefined ? { aspect } : {}),
            ...(path !== undefined ? { path } : {}),
          };
    const result = backend.knowledge(query);
    if (result.ok) {
      const view = result.knowledge;
      const { page, total, cursor } = paginate(
        view.statements,
        optString(args, "cursor"),
        pageLimit(args),
      );
      // Evidence is the concrete anchor set of the served page (path:blobOid), so a
      // reader can prove which bytes each statement was drawn from. The disclosed
      // `invalidatedPending` ids ride alongside — never a silent omission.
      return ok(
        {
          baseOid: view.baseOid,
          fingerprint: view.snapshotFingerprint,
          generator: view.generator,
          statements: page,
          invalidatedPending: view.invalidatedPending.map((s) => ({
            id: s.id,
            subject: s.subject,
          })),
        },
        {
          freshness: "current",
          evidence: page.flatMap((s) => s.evidence.map((a) => `${a.path}:${a.blobOid}`)),
          total,
          cursor,
        },
      );
    }
    return ok(unavailable(result.failure, { scope: "context.knowledge" }), {
      freshness: snapshotFreshness(result.failure),
    });
  },
};

// ── The synthesis surface (context.ask, issue #15) ──────────────────────────
//
// The ONE model-backed TOOL (context.knowledge is model-backed but its READ runs
// no model; context.ask runs a model turn per call). It composes a validated
// answer from the existing pure reads plus one injected turn, behind the async
// `backend.ask` port. Evidence-or-nothing: an answer with claims and no resolvable
// evidence is a `failed` ask, never a clean answer (anti-hallucination, Rule Zero
// protects it as anti-lie-in-the-UI). `unanswered`-with-reason is a first-class
// SUCCESS. Budget is metered and reported in the `cost` block, never refused.

const contextAskTool: CanvasOpsTool = {
  name: "context.ask",
  description:
    "Ask ONE question about the project and get back a validated ANSWER DOCUMENT synthesised from the knowledge layer + the deterministic project map: `{answer, evidence, confidence, unanswered?}` plus a metered `cost`. Every claim carries EVIDENCE anchors (path[:line], resolved against the pinned snapshot); an answer that cannot cite evidence is reported as a FAILED ask, never a fluent guess. When the layer demonstrably cannot support an answer you get `unanswered` with a reason naming what was consulted — an HONEST non-answer is a real, successful result, not an error. `budgetHint` routes the model: 'quick' (light fetch seat) or 'thorough' (heavy seat); either way the budget is metered and reported in `cost`, NEVER refused. Use this for a QUESTION needing synthesis — for a raw structural fact prefer context.map/file/overview/symbol/references, and for verbatim learned statements prefer context.knowledge.",
  kind: "retrieval",
  readOnly: true,
  alwaysLoad: false,
  params: [
    {
      name: "question",
      type: "string",
      optional: false,
      description: "The question to answer from the project's knowledge layer + snapshot.",
    },
    {
      name: "scope",
      type: "string",
      optional: true,
      description: "Narrow the consulted context to a scope name or repo-relative subtree.",
    },
    {
      name: "budgetHint",
      type: "enum",
      optional: true,
      enum: ["quick", "thorough"],
      description: "Routing hint: 'quick' (light) or 'thorough' (heavy). Default quick.",
    },
  ],
  async handle(args, backend) {
    const question = requireString(args, "question");
    if (!question) return fail("invalid-input", "context.ask requires a question");
    const scope = optString(args, "scope");
    const budgetHint = enumArg(args, "budgetHint", ["quick", "thorough"] as const);
    const query: ContextAskQuery = {
      question,
      ...(scope !== undefined ? { scope } : {}),
      ...(budgetHint !== undefined ? { budgetHint } : {}),
    };
    const result = await backend.ask(query);
    if (result.status === "answered") {
      // Evidence is the concrete anchor set (path:blobOid), so a reader can prove
      // which bytes each claim was drawn from.
      return ok(result.answer, {
        freshness: "current",
        evidence: result.answer.evidence.map((a) => `${a.path}:${a.blobOid}`),
      });
    }
    if (result.status === "unanswered") {
      // An honest non-answer is a served OK, never an error (anti-hallucination).
      return ok(result.answer, { freshness: "current" });
    }
    // A failed ask rides back as an honest `failed` reply carrying the cost — it is
    // NOT rendered as a clean answer (evidence-or-nothing).
    return ok(
      { failed: { reason: result.failureReason }, cost: result.cost },
      { freshness: "failed" },
    );
  },
};

// ── The surface ──────────────────────────────────────────────────────────────

/**
 * The full canvasOps@2 tool surface, in a stable order: the six interaction ops,
 * the seven retrieval reads, the base-branch/change context reads (`context.map`
 * / `context.file`, issue #14, the context #12 left riding it; `context.novelty`,
 * issue #144 — the deterministic novelty ledger for the change), then the model-free
 * "IDE for the agent" symbolic ops (`context.overview` — a file's exported-symbol
 * overview; `context.symbol` — go-to-definition over the same exported-symbol index;
 * `context.references` — find-references over the identifier-occurrence index, for
 * blast radius, #200), all riding Rennet's OWN deterministic shards (no LSP, no
 * bundled engine). Last, the ONE model-backed read
 * (`context.knowledge`, repo-map-knowledge layer c) — the LLM-reconstructed WHY,
 * served verbatim off the enriched set, off the review's critical path. This list IS
 * the structural actor partition: no user-only op
 * (disposition/adjudicate/expand/select/pin) and no engine-only op
 * (project/invalidate/carry/order) appears here, so "the human still disposes" is
 * a property of the surface's composition. `context.*` are read-only and
 * model-free, so they add retrieval reach without touching L1/L2/L3 or ordering.
 */
export const CANVAS_OPS_TOOLS: readonly CanvasOpsTool[] = [
  describeTool,
  viewTool,
  focusTool,
  annotateTool,
  proposeTool,
  recomputeTool,
  readTool,
  threadTool,
  diffReadTool,
  diffSearchTool,
  diffStructureTool,
  runLedgerTool,
  runProvenanceTool,
  contextMapTool,
  contextFileTool,
  contextNoveltyTool,
  contextOverviewTool,
  contextSymbolTool,
  contextReferencesTool,
  contextKnowledgeTool,
  contextAskTool,
] as const;

const TOOLS_BY_NAME: ReadonlyMap<string, CanvasOpsTool> = new Map(
  CANVAS_OPS_TOOLS.map((tool) => [tool.name, tool]),
);

/** Look up a tool by name. Throws on an unknown name (a programming error). */
export function canvasOpsTool(name: string): CanvasOpsTool {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new Error(`unknown canvasOps tool: ${name}`);
  return tool;
}
