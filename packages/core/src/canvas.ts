import { createHash } from "node:crypto";
import { parseAnchor } from "@rennet/protocol";
import type {
  AnalysisCohort,
  AnalysisElement,
  AnalysisLayer,
  Annotation,
  BlastRadiusPaint,
  Canvas,
  CanvasAngle,
  DecisionRecordBody,
  Decomposition,
  DecompositionProposalBody,
  Disposition,
  DispositionType,
  Proposal,
  RspDocType,
  SubstrateChunkRef,
  SubstrateLayer,
} from "@rennet/types";
import { payloadDigest } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// Canvas state model (issue #10)
//
// A canvas is a pure, layered projection over the durable log, scoped to
// (reviewId, patchsetId, angle). L0 substrate and L1 analysis are deterministic
// functions of the decomposition and the admitted RSP documents; L2 is the
// review's dispositions (already event-sourced by slice 1); L3 is the canvas-op
// event stream. Because every input is derived from the durable log, the
// assembled canvas is byte-identical across replays (R17: projections disposable
// and rebuildable). Fleet agents never touch a canvas — the projector places
// only validator-admitted documents, adding zero fabrication surface.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An admitted RSP document, as the projector consumes it: the adapter-minted
 * `docId`, the `docType`, and the validator-admitted `body`. The projector reads
 * only admitted documents; nothing an agent said reaches a canvas unadmitted.
 */
export interface AdmittedDocument {
  docId: string;
  docType: RspDocType;
  body: unknown;
}

/** The fixed docType → canvas-angle routing. A doctype not here is not placed. */
const DOC_TYPE_ANGLE: Partial<Record<RspDocType, CanvasAngle>> = {
  "decision.record": "decisions",
  "decomposition.proposal": "sequence",
  "spec.model": "spec",
  claim: "claims",
  "noise.patternProposal": "noise",
  anomaly: "noise",
};

/** Deterministic canvas identity: a hash of the `(reviewId, patchsetId, angle)` key. */
export function canvasId(reviewId: string, patchsetId: string, angle: CanvasAngle): string {
  return createHash("sha256").update(`${reviewId}\0${patchsetId}\0${angle}`).digest("hex");
}

/**
 * A canvas element's DERIVED identity: a hash of its source `docId` + anchor.
 * Canvas elements mint no identity — an element is addressable only through the
 * admitted document it references. Two projections of the same admitted content
 * produce the same key.
 */
function elementKeyFor(docId: string, discriminator: string): string {
  return createHash("sha256").update(`${docId}\0${discriminator}`).digest("hex");
}

/**
 * A total, locale-INDEPENDENT string order (UTF-16 code units). Placement must be
 * byte-identical across machines and ICU versions, so canvas ordering never uses
 * `localeCompare`, whose collation is locale- and ICU-version-sensitive.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function analysisElement(
  docId: string,
  anchor: string,
  kind: string,
  title: string,
): AnalysisElement {
  return { elementKey: elementKeyFor(docId, anchor), docId, anchor, kind, title };
}

/** Map a hunk id to the chunk that contains it (for anchoring a decision to a cohort). */
function hunkToChunk(decomposition: Decomposition): Map<string, string> {
  const map = new Map<string, string>();
  for (const chunk of decomposition.chunks) {
    for (const hunkId of chunk.hunkIds) map.set(hunkId, chunk.chunkId);
  }
  return map;
}

/**
 * The chunk a `rennet:` anchor lands in, for cohort assignment. A `chunk/<id>`
 * anchor names the chunk directly; a `hunk/<id>` anchor resolves through its
 * containing chunk. Anything else (or an unknown id) is unplaced — a stable
 * catch-all so nothing is silently dropped.
 */
function anchoredChunk(
  anchor: string,
  decomposition: Decomposition,
  hunkChunk: Map<string, string>,
): string {
  const parsed = parseAnchor(anchor);
  if (!parsed.ok) return "";
  if (parsed.anchor.kind === "chunk") {
    return decomposition.chunks.some((chunk) => chunk.chunkId === parsed.anchor.id)
      ? parsed.anchor.id
      : "";
  }
  if (parsed.anchor.kind === "hunk") return hunkChunk.get(parsed.anchor.id) ?? "";
  return "";
}

function isDecisionRecordBody(body: unknown): body is DecisionRecordBody {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { decisions?: unknown }).decisions)
  );
}

function isProposalBody(body: unknown): body is DecompositionProposalBody {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { chunks?: unknown }).chunks) &&
    Array.isArray((body as { readingOrder?: unknown }).readingOrder)
  );
}

/**
 * Place admitted `decision.record` documents onto the decisions canvas. Grouping
 * is HARD-BAKED (OQ17 closed): each decision's cohort is its anchored chunk.
 * Cohorts are ordered by that chunk's position in the decomposition reading order
 * (logical-dependency order, correction 8 — never salience/danger/blast-radius),
 * and are NEVER capped. Placement is a pure function of content: elements and
 * cohorts are sorted by derived key, so input document order does not matter.
 */
function projectDecisions(docs: AdmittedDocument[], decomposition: Decomposition): AnalysisLayer {
  const hunkChunk = hunkToChunk(decomposition);
  const cohortElements = new Map<string, AnalysisElement[]>();
  for (const doc of docs) {
    if (!isDecisionRecordBody(doc.body)) continue;
    for (const decision of doc.body.decisions) {
      // A decision's identity is its unique `decisionId` within the admitted
      // document — NEVER its anchor, which several decisions in one cohort
      // legitimately share (the decisions projector groups a cohort BY shared
      // anchored chunk). Keying on docId+anchor would collapse them to one key.
      const element: AnalysisElement = {
        elementKey: elementKeyFor(doc.docId, `decision/${decision.decisionId}`),
        docId: doc.docId,
        anchor: decision.anchor,
        kind: "decision",
        title: decision.title,
      };
      const chunkId = anchoredChunk(decision.anchor, decomposition, hunkChunk);
      const list = cohortElements.get(chunkId) ?? [];
      list.push(element);
      cohortElements.set(chunkId, list);
    }
  }

  const orderIndex = (chunkId: string): number => {
    const index = decomposition.readingOrder.indexOf(chunkId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const chunkTitle = (chunkId: string): string =>
    decomposition.chunks.find((chunk) => chunk.chunkId === chunkId)?.title ?? "unplaced decisions";

  const orderedChunkIds = [...cohortElements.keys()].sort(
    (left, right) => orderIndex(left) - orderIndex(right) || compareCodeUnits(left, right),
  );

  const cohorts: AnalysisCohort[] = [];
  const elements: AnalysisElement[] = [];
  for (const chunkId of orderedChunkIds) {
    const cohortEls = (cohortElements.get(chunkId) ?? []).sort((left, right) =>
      compareCodeUnits(left.elementKey, right.elementKey),
    );
    elements.push(...cohortEls);
    cohorts.push({
      cohortKey: `cohort:${chunkId}`,
      title: chunkTitle(chunkId),
      elementKeys: cohortEls.map((element) => element.elementKey),
    });
  }

  return { elements, cohorts, readingOrder: cohorts.map((cohort) => cohort.cohortKey) };
}

/**
 * Place the sequence canvas. The `decomposition.proposal` document IS this
 * canvas's L1: chunk elements in the admitted `readingOrder`. With no admitted
 * proposal the deterministic decomposition floor stands in (always present,
 * offline) — its chunks in its topological reading order.
 */
function projectSequence(docs: AdmittedDocument[], decomposition: Decomposition): AnalysisLayer {
  // Deterministic selection: pick the lowest docId among admitted proposals so
  // the sequence canvas is a pure function of the doc SET, never of input order.
  const proposal = docs
    .filter((doc) => isProposalBody(doc.body))
    .sort((left, right) => compareCodeUnits(left.docId, right.docId))[0];
  if (proposal && isProposalBody(proposal.body)) {
    const byId = new Map(
      proposal.body.chunks.map((chunk) => [
        chunk.chunkId,
        analysisElement(proposal.docId, `rennet:chunk/${chunk.chunkId}`, "chunk", chunk.title),
      ]),
    );
    const elements = proposal.body.readingOrder
      .map((chunkId) => byId.get(chunkId))
      .filter((element): element is AnalysisElement => element !== undefined);
    return { elements, cohorts: [], readingOrder: elements.map((element) => element.elementKey) };
  }
  // Deterministic floor: place the decomposition's own chunks in its reading order.
  const byId = new Map(
    decomposition.chunks.map((chunk) => [
      chunk.chunkId,
      analysisElement(
        `floor:${decomposition.patchsetId}`,
        `rennet:chunk/${chunk.chunkId}`,
        "chunk",
        chunk.title,
      ),
    ]),
  );
  const elements = decomposition.readingOrder
    .map((chunkId) => byId.get(chunkId))
    .filter((element): element is AnalysisElement => element !== undefined);
  return { elements, cohorts: [], readingOrder: elements.map((element) => element.elementKey) };
}

/**
 * Place the flat angles (spec/claims/noise). Rich per-element bodies are #26; the
 * M0 projection is honest and deterministic: one element per admitted document of
 * the matching angle, ordered by derived key. `claim` renders empty-but-honest
 * when there are no admitted claim documents.
 */
function projectFlat(_angle: CanvasAngle, docs: AdmittedDocument[]): AnalysisLayer {
  const elements = docs
    .map((doc) => analysisElement(doc.docId, `rennet:doc/${doc.docId}`, doc.docType, doc.docType))
    .sort((left, right) => compareCodeUnits(left.elementKey, right.elementKey));
  return { elements, cohorts: [], readingOrder: elements.map((element) => element.elementKey) };
}

/**
 * The L1 analysis projector — a PURE FUNCTION of the admitted documents plus the
 * deterministic ordering rules. Same admitted docs projected twice against the
 * same decomposition yield a deep-equal analysis layer.
 */
export function projectAnalysis(
  angle: CanvasAngle,
  admittedDocs: AdmittedDocument[],
  decomposition: Decomposition,
): AnalysisLayer {
  const docs = admittedDocs.filter((doc) => DOC_TYPE_ANGLE[doc.docType] === angle);
  if (angle === "decisions") return projectDecisions(docs, decomposition);
  if (angle === "sequence") return projectSequence(docs, decomposition);
  return projectFlat(angle, docs);
}

/**
 * The amber blast-radius OVERLAY: proposal chunks whose angle set includes
 * `blast-radius`. It paints onto the other canvases and owns no surface of its
 * own — never a writable layer.
 */
export function projectBlastRadius(admittedDocs: AdmittedDocument[]): BlastRadiusPaint[] {
  const paint: BlastRadiusPaint[] = [];
  for (const doc of admittedDocs) {
    if (!isProposalBody(doc.body)) continue;
    for (const chunk of doc.body.chunks) {
      if (chunk.angles.includes("blast-radius")) {
        paint.push({ target: `rennet:chunk/${chunk.chunkId}`, docId: doc.docId });
      }
    }
  }
  return paint.sort((left, right) => compareCodeUnits(left.target, right.target));
}

/** The L0 substrate: the decomposition chunks the canvas is about (read-only). */
export function projectSubstrate(decomposition: Decomposition): SubstrateLayer {
  const chunks: SubstrateChunkRef[] = decomposition.chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    hunkIds: [...chunk.hunkIds],
    filePaths: [...chunk.filePaths],
  }));
  return { chunks };
}

// ── Canvas-op events + fold (L3, session-scoped) ─────────────────────────────

/**
 * The canvas-op event family — append-only, like review events. L3 annotations
 * and proposals are event-sourced so the conversation's manipulation history
 * survives exactly the way review state does. No canvas event writes L2.
 */
export type CanvasEvent =
  | { type: "CanvasAnnotated"; version: 1; canvasId: string; annotation: Annotation }
  | { type: "AnnotationPinned"; version: 1; canvasId: string; annotationId: string }
  | { type: "AnnotationCleared"; version: 1; canvasId: string; annotationId: string }
  | { type: "ProposalRaised"; version: 1; canvasId: string; proposal: Proposal }
  | {
      type: "ProposalAdjudicated";
      version: 1;
      canvasId: string;
      proposalId: string;
      outcome: "accepted" | "dismissed";
    }
  | { type: "SessionEnded"; version: 1; canvasId: string };

/** The L3 state a fold produces: the session's annotations and proposals. */
export interface CanvasOpState {
  annotations: Annotation[];
  proposals: Proposal[];
}

/**
 * Fold the canvas-op events into L3 state, applying the session lifecycle: an
 * annotation is ephemeral until pinned; on `SessionEnded` every UNPINNED
 * annotation is dropped while pinned ones survive, and session-scoped proposals
 * are cleared. Annotations added after a `SessionEnded` belong to the next
 * session.
 */
export function foldCanvas(canvasId: string, events: CanvasEvent[]): CanvasOpState {
  let annotations: Annotation[] = [];
  let proposals: Proposal[] = [];
  for (const event of events) {
    // Canvas-scoped: an op addressed to another canvas never touches this one —
    // no cross-canvas annotation leak, no cross-canvas SessionEnded clear.
    if (event.canvasId !== canvasId) continue;
    switch (event.type) {
      case "CanvasAnnotated":
        annotations = [
          ...annotations.filter((a) => a.annotationId !== event.annotation.annotationId),
          { ...event.annotation },
        ];
        break;
      case "AnnotationPinned":
        annotations = annotations.map((a) =>
          a.annotationId === event.annotationId ? { ...a, pinned: true } : a,
        );
        break;
      case "AnnotationCleared":
        annotations = annotations.filter((a) => a.annotationId !== event.annotationId);
        break;
      case "ProposalRaised":
        proposals = [
          ...proposals.filter((p) => p.proposalId !== event.proposal.proposalId),
          { ...event.proposal },
        ];
        break;
      case "ProposalAdjudicated":
        proposals = proposals.map((p) =>
          p.proposalId === event.proposalId ? { ...p, status: event.outcome } : p,
        );
        break;
      case "SessionEnded":
        annotations = annotations.filter((a) => a.pinned);
        proposals = [];
        break;
    }
  }
  return { annotations, proposals };
}

// ── buildCanvas: the full four-layer projection ──────────────────────────────

/** The inputs `buildCanvas` is a pure function of. */
export interface BuildCanvasInput {
  reviewId: string;
  patchsetId: string;
  angle: CanvasAngle;
  admittedDocs: AdmittedDocument[];
  decomposition: Decomposition;
  dispositions: Disposition[];
  canvasEvents: CanvasEvent[];
}

/**
 * Assemble the four-layer canvas. This is a PURE FUNCTION of its inputs, so
 * replaying the same events rebuilds a byte-identical canvas. L2 is the review's
 * dispositions covered by this canvas's substrate; the orchestrator never
 * contributes to L2.
 */
export function buildCanvas(input: BuildCanvasInput): Canvas {
  const id = canvasId(input.reviewId, input.patchsetId, input.angle);
  const substrate = projectSubstrate(input.decomposition);
  const canvasPaths = new Set(substrate.chunks.flatMap((chunk) => chunk.filePaths));
  const analysis = projectAnalysis(input.angle, input.admittedDocs, input.decomposition);
  const { annotations, proposals } = foldCanvas(id, input.canvasEvents);
  return {
    canvasId: id,
    reviewId: input.reviewId,
    patchsetId: input.patchsetId,
    angle: input.angle,
    layers: {
      substrate,
      analysis,
      disposition: {
        dispositions: input.dispositions.filter((d) => canvasPaths.has(d.anchor.path)),
      },
      annotation: { annotations, proposals },
    },
    overlay: projectBlastRadius(input.admittedDocs),
  };
}

/** The canonical digest of a canvas, for byte-identical replay assertions. */
export function canvasDigest(canvas: Canvas): string {
  return payloadDigest(canvas);
}

// ── Successor-canvas carry ───────────────────────────────────────────────────
// The successor canvas has NO carry logic of its own: it reads the review's
// dispositions, which the live review fold (PatchsetActivated → carryDispositions,
// exact-lineage byte-identical, fails closed on any change) has already narrowed.
// A second copy here would be a byte-identical duplicate of the live path that the
// canvas is never the source of truth for, so it is deliberately absent.

// ── Actor-partitioned command vocabularies (structural L2 sovereignty) ────────

/**
 * The USER canvas op vocabulary (renderer → engine, direct UI). It includes the
 * ONLY op that writes L2 (`canvas.disposition`) plus adjudication, navigation,
 * selection, and pin/clear.
 */
export const USER_CANVAS_COMMANDS = [
  "canvas.disposition",
  "canvas.adjudicateProposal",
  "canvas.setCohortExpansion",
  "canvas.select",
  "canvas.pinAnnotation",
  "canvas.clearAnnotation",
] as const;

/**
 * The ORCHESTRATOR canvas op vocabulary (MCP tools, `visibility: model`). It
 * contains NO disposition writer — L2 is user-sovereign, enforced by the shape of
 * this list, never by a prompt.
 */
export const ORCHESTRATOR_CANVAS_OPS = [
  "canvas.describe",
  "canvas.view",
  "canvas.focus",
  "canvas.annotate",
  "canvas.propose",
  "canvas.recompute",
] as const;

export type UserCanvasCommand = (typeof USER_CANVAS_COMMANDS)[number];
export type OrchestratorCanvasOp = (typeof ORCHESTRATOR_CANVAS_OPS)[number];

/**
 * The effects an orchestrator op may produce. There is deliberately NO variant
 * carrying a disposition write: an orchestrator op is read-only, an L3 annotation,
 * or an L3 proposal — never L2. A disposition proposal becomes L2 only when the
 * USER adjudicates it (a user command).
 */
export type OrchestratorEffect =
  | { kind: "read" }
  | { kind: "annotate"; event: CanvasEvent }
  | { kind: "propose"; event: CanvasEvent };

/** The complete set of event types orchestrator dispatch can EVER emit (L3 only). */
export const ORCHESTRATOR_EMITTABLE_EVENT_TYPES: readonly CanvasEvent["type"][] = [
  "CanvasAnnotated",
  "ProposalRaised",
] as const;

/** A payload for an orchestrator op. All fields optional; unused ops ignore it. */
export interface OrchestratorOpPayload {
  canvasId?: string;
  target?: string;
  kind?: Annotation["kind"];
  body?: string;
  proposal?: Proposal;
  annotationId?: string;
}

/**
 * Dispatch an orchestrator canvas op to its effect. The return type structurally
 * excludes any disposition write: `annotate` yields a `CanvasAnnotated` (L3),
 * `propose` a `ProposalRaised` (L3), and describe/view/focus/recompute are
 * read-only. No branch produces a `DispositionSet`/`DispositionCleared`.
 */
export function dispatchOrchestratorCanvasOp(
  op: OrchestratorCanvasOp,
  payload: OrchestratorOpPayload = {},
): OrchestratorEffect {
  switch (op) {
    case "canvas.annotate":
      return {
        kind: "annotate",
        event: {
          type: "CanvasAnnotated",
          version: 1,
          canvasId: payload.canvasId ?? "",
          annotation: {
            annotationId: payload.annotationId ?? "",
            target: payload.target ?? "",
            kind: payload.kind ?? "highlight",
            body: payload.body ?? "",
            pinned: false,
          },
        },
      };
    case "canvas.propose":
      return {
        kind: "propose",
        event: {
          type: "ProposalRaised",
          version: 1,
          canvasId: payload.canvasId ?? "",
          proposal: payload.proposal ?? {
            proposalId: "",
            kind: "disposition",
            target: payload.target ?? "",
            payload: payload.body ?? "",
            status: "pending",
          },
        },
      };
    default:
      return { kind: "read" };
  }
}

/** The effects a user canvas command may produce (the ONLY surface that reaches L2). */
export type UserCanvasEffect =
  | {
      kind: "disposition";
      anchorPath: string;
      type: DispositionType | null;
      body: string;
    }
  | { kind: "annotationPin"; event: CanvasEvent }
  | { kind: "annotationClear"; event: CanvasEvent }
  | { kind: "proposalAdjudicated"; event: CanvasEvent }
  | { kind: "select" }
  | { kind: "cohortExpansion" };

/** The payload for a user canvas command. */
export interface UserCanvasCommandPayload {
  canvasId?: string;
  anchorPath?: string;
  type?: DispositionType | null;
  body?: string;
  annotationId?: string;
  proposalId?: string;
  outcome?: "accepted" | "dismissed";
}

/**
 * Dispatch a user canvas command to its effect. `canvas.disposition` is the
 * sovereign L2 write; adjudicating a disposition proposal with `accepted` also
 * yields an L2 disposition (accepting is a user act). Pin/clear are L3.
 */
export function dispatchUserCanvasCommand(
  command: UserCanvasCommand,
  payload: UserCanvasCommandPayload = {},
): UserCanvasEffect {
  switch (command) {
    case "canvas.disposition":
      return {
        kind: "disposition",
        anchorPath: payload.anchorPath ?? "",
        type: payload.type ?? null,
        body: payload.body ?? "",
      };
    case "canvas.adjudicateProposal":
      if (payload.outcome === "accepted") {
        return {
          kind: "disposition",
          anchorPath: payload.anchorPath ?? "",
          type: payload.type ?? "approve",
          body: payload.body ?? "",
        };
      }
      return {
        kind: "proposalAdjudicated",
        event: {
          type: "ProposalAdjudicated",
          version: 1,
          canvasId: payload.canvasId ?? "",
          proposalId: payload.proposalId ?? "",
          outcome: payload.outcome ?? "dismissed",
        },
      };
    case "canvas.pinAnnotation":
      return {
        kind: "annotationPin",
        event: {
          type: "AnnotationPinned",
          version: 1,
          canvasId: payload.canvasId ?? "",
          annotationId: payload.annotationId ?? "",
        },
      };
    case "canvas.clearAnnotation":
      return {
        kind: "annotationClear",
        event: {
          type: "AnnotationCleared",
          version: 1,
          canvasId: payload.canvasId ?? "",
          annotationId: payload.annotationId ?? "",
        },
      };
    case "canvas.select":
      return { kind: "select" };
    case "canvas.setCohortExpansion":
      return { kind: "cohortExpansion" };
  }
}
