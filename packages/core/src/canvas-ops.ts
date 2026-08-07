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
} from "@rennet/types";
import { v7 as uuidv7 } from "uuid";
import { type CanvasEvent, dispatchOrchestratorCanvasOp } from "./canvas";

// ─────────────────────────────────────────────────────────────────────────────
// canvasOps@2 — the orchestrator's entire world (issue #12)
//
// One versioned in-process MCP tool surface: the six interaction ops plus the
// seven read-only retrieval ops (Orchestrator Context Access §2). This module is
// the PURE contract — tool descriptors with pure handlers over an injected
// `CanvasOpsBackend` port. It carries NO harness dependency: the Claude slot
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
  /** Apply the effects a write op emitted. Never receives an L2 write. */
  applyEffects(effects: readonly CanvasOpsEffect[]): void;
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
  handle(args: ToolArgs, backend: CanvasOpsBackend): ToolOutcome;
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
      enum: ["spec", "sequence", "decisions", "claims", "noise"],
      description: "Restrict to one canvas angle.",
    },
  ],
  handle(args, backend) {
    const scope = requireString(args, "scope");
    if (!scope) return fail("invalid-input", "canvas.recompute requires a scope");
    const angle = enumArg(args, "angle", [
      "spec",
      "sequence",
      "decisions",
      "claims",
      "noise",
    ] as const);
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

// ── The surface ──────────────────────────────────────────────────────────────

/**
 * The full canvasOps@2 tool surface, in a stable order: the six interaction ops
 * then the seven retrieval reads. `context.*` is deliberately absent — it rides
 * the base-branch context issue. This list IS the structural actor partition:
 * no user-only op (disposition/adjudicate/expand/select/pin) and no engine-only
 * op (project/invalidate/carry/order) appears here, so "the human still
 * disposes" is a property of the surface's composition.
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
