import { sha256Hex } from "@rennet/protocol";
import type { Canvas, CanvasAngle, DispositionType } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { compareCodeUnits } from "./canvas";
import {
  CANVAS_OPS_TOOLS,
  CANVAS_OPS_VERSION,
  type CanvasOpsTool,
  type OpsFreshness,
  type ReviewIdentity,
} from "./canvas-ops";

// ─────────────────────────────────────────────────────────────────────────────
// The lean orchestrator bootstrap (issue #13) — a MAP of the review, not a
// container of it (Rai, 2026-08-06, superseding both fat-dump and capped-primer).
//
// The primer is a deterministic, versioned document assembled as a pure function
// of already-derived review state (`PrimerInputs`) → bytes. "Same state → same
// bytes" is therefore a fixture assertion, no live backend needed. It carries six
// sections (Orchestrator Context Access §1.1): B1 identity, B2 freshness, B3
// count-level canvas state, B4 the versioned protocol card, B5 a tool index
// derived from the LIVE canvasOps@2 surface, B6 the run-ledger headline. The whole
// thing is ≤ 4 KB, and its SHA-256 digest lands in the session's provenance so
// "the orchestrator is primed" is a checkable property.
//
// The card is a fixed versioned constant (teaching that outlives any one build);
// the tool index is derived at boot from `CANVAS_OPS_TOOLS` so it is honest about
// what is actually attached and callable. The digest uses the node-free
// `sha256Hex` from `@rennet/protocol` (core's `payloadDigest` is `node:crypto`;
// the primer digest stays portable and is over a plain string).
// ─────────────────────────────────────────────────────────────────────────────

/** The format version of the assembled primer (bump on any assembly-shape change). */
export const PRIMER_VERSION = "primer@1";

/** The versioned protocol card identifier — the card is a base instruction. */
export const PROTOCOL_CARD_VERSION = "protocol-card@1";

/**
 * The hard byte ceiling for the assembled primer (Orchestrator Context Access
 * §1.1). Raised from 4096 to 4352 (4.25 KiB) when the symbolic ops `context.overview`
 * and `context.symbol` (repo-map-symbolic-surface) joined the surface, then to 4608
 * (4.5 KiB) when `context.references` (#200) completed the trio: advertising the
 * "navigate before dumping" ops in the boot primer is what makes an agent reach for
 * them. Still a hard boundary — an oversized state throws rather than assembling a
 * fat primer.
 */
export const PRIMER_MAX_BYTES = 4608;

/**
 * B2/B3 row caps (#65). The primer is a MAP, not a container: a large multi-repo
 * review must still fit the ≤ 4 KB ceiling, so B2 emits at most `PRIMER_MAX_FRESHNESS_ROWS`
 * per-repo lines and B3 at most `PRIMER_MAX_CANVAS_ROWS` per-canvas lines, then a
 * single rollup tail line carrying the count and aggregate of the remainder. The
 * rolled-up repos/canvases stay reachable via the tool surface. Caps chosen so the
 * existing full-review fixture (2 repos, 5 canvases) stays byte-identical (no tail)
 * and a 10-repo / 20-canvas review lands under the ceiling with headroom.
 *
 * The caps bound the NUMBER of rows, not the length of any one row — a pathological
 * multi-kilobyte identifier still trips the fail-closed ceiling throw (the backstop).
 */
export const PRIMER_MAX_FRESHNESS_ROWS = 6;
export const PRIMER_MAX_CANVAS_ROWS = 5;

/**
 * B4 — the protocol card. A versioned base instruction teaching the four-actor
 * contract, the two product principles, the never-do list, and the ask protocol.
 * It teaches the canvasOps@2 CONTRACT (constitution); the live menu of attached
 * tools is B5. Faithful to Orchestrator Context Access §4; terse because the
 * schemas carry the per-tool detail.
 */
export const PROTOCOL_CARD = `## How this session works
You orchestrate a Rennet review. You converse with the reviewer about the code
via the canvases. Four actors: the deterministic engine PLACES analysis; fleet
agents EMITTED it; YOU may describe, focus, annotate, propose, and ask; the USER
ALONE dispositions. You cannot mark anything read, edit analysis, or reorder
cohorts — your proposals become real only when the user accepts them.

Two principles govern everything you present: content is grouped and ordered
LOGICALLY so the review is understandable from first principles (never by
danger); and anything that can be rolled up is rolled up — the user approves at
any altitude and you help them zoom.

## You are deliberately under-informed, and you can always ask
Your context holds a MAP of the review, not the review. This is by design. The
state is one tool call away and always fresher than your memory of it:
 - what is on a surface / where are we    -> canvas.describe (zoom via depth)
 - what is the user looking at            -> canvas.view (also pushed to you)
 - the full content of one thing          -> canvas.read / canvas.thread
 - the code itself                        -> diff.read, diff.search, diff.structure
 - the base branch: map / files / learned -> context.map, context.file, context.knowledge
 - a QUESTION needing synthesis           -> context.ask
 - what analysis ran and what it cost     -> run.ledger, run.provenance

Never answer about the base branch or unexamined code from recall — retrieve or
ask first. Reads return {data, evidence, freshness, total/cursor}: cite the
evidence; if freshness is not "current", say so before relying on it; a cursor
means more exists — never present a page as the whole. context.ask returns
{answer, evidence, confidence, unanswered?}: an "unanswered" is a real result —
relay the gap honestly rather than filling it.`;

// ── Primer input shapes (already-derived state; no live backend) ──────────────

/** B2 — one repo's freshness verdict line (R30 at boot). */
export interface RepoFreshness {
  repoId: string;
  snapshotId: string;
  verdict: OpsFreshness;
}

/** B3 — count-level canvas state for one canvas (counts only, never contents). */
export interface CanvasStateSummary {
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

/** B5 — one tool-index row: a tool name and its when-to-use one-liner. */
export interface PrimerToolEntry {
  name: string;
  whenToUse: string;
}

/** B6 — the run-ledger headline (one honest capability line). */
export interface RunLedgerHeadline {
  fleetTasks: number;
  admitted: number;
  rejected: number;
  budgetSpent?: number;
  budgetRemaining?: number;
}

/** The full already-derived state the primer is assembled from. */
export interface PrimerInputs {
  identity: ReviewIdentity;
  freshness: readonly RepoFreshness[];
  canvasState: readonly CanvasStateSummary[];
  toolIndex: readonly PrimerToolEntry[];
  runLedger: RunLedgerHeadline;
}

/** The assembled, sectioned primer manifest. */
export interface PrimerManifest {
  version: string;
  cardVersion: string;
  surfaceVersion: string;
  text: string;
  digest: string;
  bytes: number;
  sections: {
    identity: ReviewIdentity;
    freshness: readonly RepoFreshness[];
    canvasState: readonly CanvasStateSummary[];
    card: string;
    cardVersion: string;
    toolIndex: readonly PrimerToolEntry[];
    runLedger: RunLedgerHeadline;
  };
}

// ── Tool index derivation (B5, from the live surface) ─────────────────────────

/**
 * Terse when-to-use one-liners keyed by tool name — honest, in-budget, and in
 * sync with the live surface. A tool without an entry here falls back to the
 * first sentence of its own description, so a newly-added tool is never silently
 * dropped from the index.
 */
//
// Terse by mandate: the B5 index rides the ≤4 KB primer ceiling, so as the surface
// grows these one-liners must stay lean (the schemas carry the per-tool detail).
const TOOL_WHEN_TO_USE: Readonly<Record<string, string>> = {
  "canvas.describe": "orient: counts | cohorts | elements",
  "canvas.view": "what the user is looking at now",
  "canvas.focus": "scroll/open a target (presentational)",
  "canvas.annotate": "mark something for the chat (ephemeral)",
  "canvas.propose": "suggest disposition/regroup/split — user decides",
  "canvas.recompute": "re-run the fleet on a slice (budget-gated)",
  "canvas.read": "zoom into ONE element/disposition/annotation",
  "canvas.thread": "a disposition's clarification back-and-forth",
  "diff.read": "hunk content + lineage + dispositions",
  "diff.search": "find anchors by text/symbol/path-glob (then zoom)",
  "diff.structure": "the decomposition DAG / reading order",
  "run.ledger": "fleet tasks: tiers, budgets, admitted/rejected",
  "run.provenance": "one admitted document's provenance block",
  "context.map": "base-branch map (no model)",
  "context.file": "one file's structural context",
  "context.novelty": "the change vs base: novel/extends/conforms",
  "context.overview": "a file's exported symbols (don't read the file)",
  "context.symbol": "go-to-definition: where an exported name is defined",
  "context.references": "find-references: where a name is used (blast radius)",
  "context.knowledge": "learned WHY of a module (labelled hypothesis/confirmed)",
  "context.ask": "ask a QUESTION; get answer+evidence or honest unanswered",
};

/** First sentence of a description (fallback one-liner), trimmed. */
function firstSentence(description: string): string {
  const stop = description.indexOf(". ");
  const head = stop === -1 ? description : description.slice(0, stop);
  return head.trim();
}

/**
 * B5 — derive the tool index from the LIVE canvasOps@2 surface, preserving the
 * registry's own stable order so the index is honest about what is attached.
 */
export function toolIndexFromSurface(
  tools: readonly CanvasOpsTool[] = CANVAS_OPS_TOOLS,
): PrimerToolEntry[] {
  return tools.map((tool) => ({
    name: tool.name,
    whenToUse: TOOL_WHEN_TO_USE[tool.name] ?? firstSentence(tool.description),
  }));
}

// ── B3 helper: derive count-level state from a Canvas ─────────────────────────

/**
 * Count-level canvas state (B3) from a `Canvas` — the same shape the canvasOps@2
 * `canvas.describe(counts)` reply carries, contents excluded. The host uses this
 * to build `PrimerInputs.canvasState`.
 */
export function summarizeCanvasCounts(canvas: Canvas, residue: number): CanvasStateSummary {
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
      unread: Math.max(0, substratePaths.size - dispositioned.size),
      approved: byType("approve"),
      requestChanged: byType("request-change"),
    },
  };
}

// ── Deterministic assembly ────────────────────────────────────────────────────

const ANGLE_ORDER: ReadonlyMap<CanvasAngle, number> = new Map(
  CANVAS_ANGLES.map((angle, index) => [angle, index]),
);

// Ordering is code-unit, never `localeCompare`: the primer digest is provenance
// and must be byte-identical across machines and ICU versions (the same
// determinism doctrine `canvas.ts` applies to canvas ordering).
function stableFreshness(rows: readonly RepoFreshness[]): RepoFreshness[] {
  return [...rows].sort((left, right) => compareCodeUnits(left.repoId, right.repoId));
}

function stableCanvasState(rows: readonly CanvasStateSummary[]): CanvasStateSummary[] {
  return [...rows].sort((left, right) => {
    const byAngle = (ANGLE_ORDER.get(left.angle) ?? 99) - (ANGLE_ORDER.get(right.angle) ?? 99);
    return byAngle !== 0 ? byAngle : compareCodeUnits(left.canvasId, right.canvasId);
  });
}

function identityLine(identity: ReviewIdentity): string {
  const parts: string[] = [];
  if (identity.workspace) parts.push(`workspace ${identity.workspace}`);
  if (identity.repo) parts.push(`repo ${identity.repo}`);
  parts.push(`review ${identity.reviewId}`, `patchset ${identity.patchsetId}`);
  if (identity.lineage) parts.push(identity.lineage);
  if (identity.mode) parts.push(`mode ${identity.mode}`);
  return parts.join("; ");
}

function freshnessLine(row: RepoFreshness): string {
  return `- ${row.repoId}: ${row.snapshotId} ${row.verdict}`;
}

function canvasStateLine(row: CanvasStateSummary): string {
  const c = row.coverage;
  return (
    `- ${row.angle} (${row.canvasId}): ${row.elements} elements, ${row.cohorts} cohorts, ` +
    `${row.residue} residue; coverage ${c.dispositioned}/${c.paths} dispositioned, ` +
    `${c.unread} unread, ${c.approved} approved, ${c.requestChanged} request-change`
  );
}

/**
 * B2 section body (#65): the first `PRIMER_MAX_FRESHNESS_ROWS` rows verbatim, then a
 * single rollup tail aggregating the remainder as fresh (`current`) / stale (the rest).
 * Rolled-up repos stay reachable via the tool surface.
 */
function freshnessSection(rows: readonly RepoFreshness[]): string[] {
  if (rows.length <= PRIMER_MAX_FRESHNESS_ROWS) return rows.map(freshnessLine);
  const shown = rows.slice(0, PRIMER_MAX_FRESHNESS_ROWS);
  const rest = rows.slice(PRIMER_MAX_FRESHNESS_ROWS);
  const fresh = rest.filter((r) => r.verdict === "current").length;
  const stale = rest.length - fresh;
  return [
    ...shown.map(freshnessLine),
    `- … +${rest.length} more repos — ${fresh} fresh / ${stale} stale`,
  ];
}

/**
 * B3 section body (#65): the first `PRIMER_MAX_CANVAS_ROWS` rows verbatim, then a single
 * rollup tail aggregating the remainder in the same count vocabulary (elements,
 * dispositioned/paths, unread) — the counts that answer "where are we / what have I not
 * looked at". Rolled-up canvases stay reachable via the tool surface.
 */
function canvasStateSection(rows: readonly CanvasStateSummary[]): string[] {
  if (rows.length <= PRIMER_MAX_CANVAS_ROWS) return rows.map(canvasStateLine);
  const shown = rows.slice(0, PRIMER_MAX_CANVAS_ROWS);
  const rest = rows.slice(PRIMER_MAX_CANVAS_ROWS);
  const sum = (pick: (r: CanvasStateSummary) => number) => rest.reduce((acc, r) => acc + pick(r), 0);
  const elements = sum((r) => r.elements);
  const dispositioned = sum((r) => r.coverage.dispositioned);
  const paths = sum((r) => r.coverage.paths);
  const unread = sum((r) => r.coverage.unread);
  return [
    ...shown.map(canvasStateLine),
    `- … +${rest.length} more canvases — ${elements} elements, ${dispositioned}/${paths} dispositioned, ${unread} unread`,
  ];
}

function toolIndexLine(entry: PrimerToolEntry): string {
  return `- ${entry.name} — ${entry.whenToUse}`;
}

function runLedgerLine(headline: RunLedgerHeadline): string {
  const budget =
    headline.budgetSpent !== undefined || headline.budgetRemaining !== undefined
      ? `; budget ${headline.budgetSpent ?? 0} spent / ${headline.budgetRemaining ?? 0} remaining`
      : "";
  return `${headline.fleetTasks} fleet tasks ran, ${headline.admitted} admitted, ${headline.rejected} rejected${budget}`;
}

/**
 * Assemble the primer deterministically. Same inputs → identical bytes and
 * digest, regardless of input order (freshness sorted by repoId, canvas state by
 * canvas-angle order; the tool index preserves the registry order). The card is
 * the versioned constant. The digest is a node-free SHA-256 over the text.
 */
export function assemblePrimer(inputs: PrimerInputs): PrimerManifest {
  const freshness = stableFreshness(inputs.freshness);
  const canvasState = stableCanvasState(inputs.canvasState);
  const toolIndex = inputs.toolIndex;

  const text = [
    `# Rennet orchestrator primer (${PRIMER_VERSION}, ${CANVAS_OPS_VERSION})`,
    "",
    "## B1 review",
    identityLine(inputs.identity),
    "",
    "## B2 freshness",
    ...freshnessSection(freshness),
    "",
    "## B3 canvas state (counts only)",
    ...canvasStateSection(canvasState),
    "",
    `## B4 protocol card (${PROTOCOL_CARD_VERSION})`,
    PROTOCOL_CARD,
    "",
    "## B5 tools",
    ...toolIndex.map(toolIndexLine),
    "",
    "## B6 run ledger",
    runLedgerLine(inputs.runLedger),
  ].join("\n");

  // The ≤ 4 KB ceiling is enforced on the live assembly path, not merely asserted
  // in a fixture: a primer that overruns is a fail-closed programming error (the
  // map is meant to stay bounded). Without this the constant is decoration — the
  // boot path would ship a silently over-budget "lean" primer.
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > PRIMER_MAX_BYTES) {
    throw new Error(
      `orchestrator primer overruns the ${PRIMER_MAX_BYTES}-byte ceiling (assembled ${bytes} bytes)`,
    );
  }

  return {
    version: PRIMER_VERSION,
    cardVersion: PROTOCOL_CARD_VERSION,
    surfaceVersion: CANVAS_OPS_VERSION,
    text,
    digest: sha256Hex(text),
    bytes,
    sections: {
      identity: inputs.identity,
      freshness,
      canvasState,
      card: PROTOCOL_CARD,
      cardVersion: PROTOCOL_CARD_VERSION,
      toolIndex,
      runLedger: inputs.runLedger,
    },
  };
}
