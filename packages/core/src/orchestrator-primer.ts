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

/** The hard byte ceiling for the assembled primer (Orchestrator Context Access §1.1). */
export const PRIMER_MAX_BYTES = 4096;

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
    ...freshness.map(freshnessLine),
    "",
    "## B3 canvas state (counts only)",
    ...canvasState.map(canvasStateLine),
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
