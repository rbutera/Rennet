import type {
  AskProjection,
  CodeRef,
  Disposition,
  DispositionType,
  HandoffDisposition,
  Patchset,
  StagedAsk,
} from "@rennet/protocol";
import { sha256Hex } from "@rennet/protocol";
import type { ForgeCapabilities, ForgePullRequestRef } from "./forge-port";

/**
 * The outbound GitHub publish (issue #21) — the forge-NEUTRAL half.
 *
 * This is the first real egress in Rennet: a decomposed review leaving the
 * machine and landing on a pull request AS THE USER. Everything about that is
 * load-bearing, so this module keeps the preview and egress shapes structural:
 *
 *   • One artifact owns the opener, line comments, and body-note provenance.
 *   • One post descriptor owns the event, body, and threads the reviewer previews.
 *   • `canonicalReviewPayload` binds the exact opener and both comment strata, so
 *     the egress boundary can independently verify "what you see is what leaves".
 *   • Every flattening lands on the degradation ledger, never a silent drop (#21).
 *   • The idempotency marker is deterministic in (reviewId, target, event, payload), so a
 *     retry after a dropped outcome finds the prior review and returns it instead of
 *     double-posting (#21 / R17).
 *
 * Node-free at module scope (like `forge-port.ts`): no `node:*`, no filesystem, no
 * process, so a mobile or third-party client can import it. The one digest it needs
 * is `sha256Hex` from `@rennet/protocol` (the portable, node-free SHA-256).
 */

/**
 * The review verdict Rennet posts — the real GitHub review event. A review tool must
 * be able to post the actual verdict, so this is the full three-value set, not a lock.
 * The VALUE is resolved from the signed review (see {@link resolveReviewEvent}):
 * derived from the dispositions by default, overridable by an explicit verdict on the
 * post descriptor. The event shown on the signing surface is the event the forge receives.
 */
export type ForgeReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** The default verdict when none is derived or specified (a neutral comment). */
export const DEFAULT_REVIEW_EVENT: ForgeReviewEvent = "COMMENT";

/**
 * Derive the review verdict from the dispositions (the default when no explicit verdict
 * is supplied): any requested change makes the whole review `REQUEST_CHANGES`; else, if
 * there are approvals and nothing was requested-changed, `APPROVE`; else a neutral
 * `COMMENT`. Questions and plain comments alone never escalate past `COMMENT`.
 */
export function deriveReviewEvent(
  outbound: readonly { readonly type: DispositionType }[],
): ForgeReviewEvent {
  if (outbound.some((item) => item.type === "request-change")) return "REQUEST_CHANGES";
  if (outbound.some((item) => item.type === "approve")) return "APPROVE";
  return "COMMENT";
}

/**
 * Resolve the verdict for a post: an explicit `verdict` (from the signed descriptor)
 * WINS when present; otherwise the verdict is derived from the dispositions. "Derive
 * first, overridable" (Rai, 2026-08-09).
 */
export function resolveReviewEvent(
  outbound: readonly { readonly type: DispositionType }[],
  verdict?: ForgeReviewEvent,
): ForgeReviewEvent {
  return verdict ?? deriveReviewEvent(outbound);
}

/**
 * Resolve the event for a composed, opener-backed review preview. With no asks, the authored
 * opener is still real review content and the useful default is approval; any durable override
 * wins, and a non-empty outbound set keeps the disposition-derived semantics above.
 */
export function resolveComposedReviewEvent(
  outbound: readonly { readonly type: DispositionType }[],
  verdict?: ForgeReviewEvent,
): ForgeReviewEvent {
  return verdict ?? (outbound.length === 0 ? "APPROVE" : deriveReviewEvent(outbound));
}

/**
 * One review comment in the canonical `pr-review` shape — the SAME logical fields
 * the ui layer serialises in `reviewCommentsPayload`. A path-grained disposition has
 * `line: undefined` (serialised as `null`) and posts as a file-level note (folded
 * into the review body), which is honest — it genuinely has no single line.
 */
export interface ReviewCommentInput {
  readonly path: string;
  /** First line of a genuine multi-line range; absent for a single-line comment. */
  readonly startLine?: number;
  /** The final file line the comment anchors to; absent ⇒ a file-level note (no line). */
  readonly line?: number;
  readonly side: "LEFT" | "RIGHT";
  readonly type: DispositionType;
  readonly body: string;
}

/**
 * One review-BODY note — the body stratum (B11 P0 finding 2). An ask with no diff position
 * (a prose/quote-of-board ask, or a path-only ask) cannot pin to a line, so it travels in
 * the review BODY rather than vanishing from the posted review (handoff-and-exits.md "The
 * review's two strata"). Identity and source provenance travel with the canonical artifact so
 * the signing surface can account for the note before it leaves.
 */
export interface ReviewBodyNote {
  /** Stable ask identity carried onto the signing surface. */
  readonly id: string;
  readonly type: DispositionType;
  readonly body: string;
  /** Source provenance (the prose span / path), visible before signing. */
  readonly anchor: string;
}

/** The complete signed review artifact. The opener is model-authored but reviewer-owned. */
export interface ReviewArtifact {
  readonly opener: string;
  readonly comments: readonly ReviewCommentInput[];
  readonly bodyNotes: readonly ReviewBodyNote[];
}

function assertNonblankReviewOpener(opener: string): void {
  if (opener.trim().length === 0) throw new Error("Review artifact opener must be nonblank");
}

/**
 * The canonical outbound bytes for a posted review — reproduced here so the MAIN
 * egress boundary can verify them independently of the renderer.
 *
 * The field order is intentional and pinned by an exact-bytes test. `opener` is
 * serialized without trimming, before comments and body notes, so the payload binds
 * the prose the reviewer previewed as well as both outbound comment strata.
 */
export function canonicalReviewPayload(artifact: ReviewArtifact): string {
  assertNonblankReviewOpener(artifact.opener);
  return JSON.stringify({
    kind: "pr-review",
    opener: artifact.opener,
    comments: artifact.comments.map((comment) => ({
      path: comment.path,
      ...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
      line: comment.line ?? null,
      side: comment.side,
      type: comment.type,
      body: comment.body,
    })),
    bodyNotes: artifact.bodyNotes.map((note) => ({
      ...(note.id === undefined ? {} : { id: note.id }),
      ...(note.anchor === undefined ? {} : { anchor: note.anchor }),
      type: note.type,
      body: note.body,
    })),
  });
}

/**
 * Compose the DEFAULT (unedited) outbound comments for a team-PR review from a
 * review's stored dispositions — the daemon-side, node-free composition a projected
 * client (the phone) posts through `publish.compose` (issue #382 M2, Finding C
 * ruling (a)). The phone by publish decision 4 never edits the outbound review, so
 * the default is the whole product: one comment per disposition, in a deterministic
 * path-then-line order (the same initial order the desktop's collation draft shows,
 * `draftFromBatch` in the ui layer). This is the one-source composition — the daemon
 * composes it, the phone previews AND posts exactly it, and `publish.review`
 * re-verifies these very bytes via {@link canonicalReviewPayload}.
 *
 * Anchor mapping mirrors the ui `reviewComments`: a span-grained disposition
 * (`anchor.span`/`anchor.side` present, #78) posts its complete span on the side
 * its `AnchorSide` selects (`deletions` → the pre-image `LEFT`, `additions`/`context`
 * → the post-image `RIGHT`); a path-grained disposition has no line and posts
 * file-level. The comment `type` and `body` are the disposition's own.
 */
export function reviewCommentsFromDispositions(
  dispositions: readonly Disposition[],
): ReviewCommentInput[] {
  return [...dispositions]
    .sort((left, right) => {
      if (left.anchor.path !== right.anchor.path) {
        return left.anchor.path < right.anchor.path ? -1 : 1;
      }
      return (left.anchor.span?.startLine ?? 0) - (right.anchor.span?.startLine ?? 0);
    })
    .map((disposition) => {
      const span = disposition.anchor.span;
      const line = span?.endLine ?? span?.startLine;
      const side: "LEFT" | "RIGHT" = disposition.anchor.side === "deletions" ? "LEFT" : "RIGHT";
      return {
        path: disposition.anchor.path,
        ...(span?.endLine !== undefined && span.endLine > span.startLine
          ? { startLine: span.startLine }
          : {}),
        ...(line === undefined ? {} : { line }),
        side,
        type: disposition.type,
        body: disposition.body,
      };
    });
}

/**
 * Parse a staged ask's `anchor` as a `path:line` code position, or `null` for a prose
 * span. The trailing `:<digits>` is the line; everything before it is the path. This is
 * the portable twin of app-ui's `parseLineAnchor` (`handoff/selectors.ts`) — core cannot
 * import app-ui, and C9 converges the two on this copy when it swaps the client onto the
 * durable projection.
 */
function parsePathLine(anchor: string): { path: string; line: number } | null {
  const match = /^(.+):(\d+)$/.exec(anchor);
  if (!match?.[1] || !match[2]) return null;
  return { path: match[1], line: Number(match[2]) };
}

interface AskCodePosition {
  readonly path: string;
  readonly startLine?: number;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
}

/** Canonical captured provenance wins; `anchor` + `side` read older durable logs. */
function activeFileForCodeRef(ref: CodeRef, activePatchset: Patchset) {
  if (ref.patchsetId !== activePatchset.id) return undefined;
  const matches = activePatchset.files.filter((candidate) =>
    ref.side === "base"
      ? candidate.path === ref.path || candidate.previousPath === ref.path
      : candidate.path === ref.path,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function askCodePosition(ask: StagedAsk, activePatchset?: Patchset): AskCodePosition | null {
  if (ask.codeRef !== undefined) {
    const file =
      activePatchset === undefined ? undefined : activeFileForCodeRef(ask.codeRef, activePatchset);
    if (activePatchset !== undefined && file === undefined) return null;
    return {
      path: file?.path ?? ask.codeRef.path,
      ...(ask.codeRef.endLine > ask.codeRef.startLine ? { startLine: ask.codeRef.startLine } : {}),
      line: ask.codeRef.endLine,
      side: ask.codeRef.side === "base" ? "LEFT" : "RIGHT",
    };
  }
  const legacy = parsePathLine(ask.anchor);
  return legacy === null ? null : { ...legacy, side: ask.side ?? "RIGHT" };
}

function askPositionKey(position: AskCodePosition): string {
  return `${position.path}:${position.startLine ?? position.line}:${position.line}:${position.side}`;
}

/**
 * Compose the DEFAULT outbound review comments from the durable ASK PROJECTION (B11
 * cluster 3, #458 R29–R36) — the projection equivalent of
 * {@link reviewCommentsFromDispositions}. The durable projection is now the living-draft
 * authority the desktop and phone share, so `publish.compose(mode:"review")` sources the
 * outbound comments from HERE (superseding `review.dispositions`), and the post commands
 * re-derive the same bytes off the same projection (single-source, R33).
 *
 * Two strata, GitHub's shape:
 *   • LINE comments — a staged ask whose canonical `codeRef` resolves uniquely in the
 *     active patchset, or whose legacy `anchor` is a `path:line`, plus every `lineComments`
 *     entry (`path`→line→body). Position identity includes side, so a LEFT ask and RIGHT
 *     bare comment at the same path/line remain distinct.
 *   • BODY notes — prose asks and canonical refs that no longer resolve in the active
 *     patchset have no trustworthy active diff position, so
 *     {@link reviewBodyNotesFromProjection} surfaces them as review-BODY notes. The two
 *     functions PARTITION `stagedAsks`, so every ask appears exactly once.
 *
 * Deterministic order (path, then line) so the canonical payload is byte-stable regardless
 * of the projection's Record key order — a projection round-tripped through disk composes
 * identically.
 */
export function reviewCommentsFromProjection(
  projection: AskProjection,
  activePatchset?: Patchset,
): ReviewCommentInput[] {
  const comments: ReviewCommentInput[] = [];
  const claimed = new Set<string>();
  for (const ask of Object.values(projection.stagedAsks)) {
    const at = askCodePosition(ask, activePatchset);
    if (!at) continue; // a no-line ask travels in the body — see reviewBodyNotesFromProjection
    claimed.add(askPositionKey(at));
    comments.push({
      path: at.path,
      ...(at.startLine === undefined ? {} : { startLine: at.startLine }),
      line: at.line,
      side: at.side,
      type: ask.type,
      body: ask.body,
    });
  }
  for (const [path, lines] of Object.entries(projection.lineComments)) {
    for (const [lineStr, body] of Object.entries(lines)) {
      const line = Number(lineStr);
      if (claimed.has(askPositionKey({ path, line, side: "RIGHT" }))) continue;
      comments.push({ path, line, side: "RIGHT", type: "comment", body });
    }
  }
  return comments.sort((left, right) =>
    left.path !== right.path
      ? left.path < right.path
        ? -1
        : 1
      : (left.startLine ?? left.line ?? 0) - (right.startLine ?? right.line ?? 0) ||
        (left.line ?? 0) - (right.line ?? 0) ||
        (left.side === right.side ? 0 : left.side === "LEFT" ? -1 : 1),
  );
}

/**
 * The review's BODY stratum (B11 P0 finding 2, handoff-and-exits.md "The review's two
 * strata"). Every staged ask with no trustworthy active diff line — prose, path-only, or a
 * canonical CodeRef that does not resolve uniquely in the active patchset — becomes a
 * review-BODY note. This is the exact complement of
 * {@link reviewCommentsFromProjection}: together they partition `stagedAsks`, so reviewer
 * intent is never silently dropped or posted on a stale line.
 * Deterministic order (anchor, then body) so the canonical payload is byte-stable.
 */
export function reviewBodyNotesFromProjection(
  projection: AskProjection,
  activePatchset?: Patchset,
): ReviewBodyNote[] {
  const notes: ReviewBodyNote[] = [];
  for (const ask of Object.values(projection.stagedAsks)) {
    if (askCodePosition(ask, activePatchset)) continue;
    notes.push({ id: ask.id, type: ask.type, body: ask.body, anchor: ask.anchor });
  }
  return notes.sort((left, right) => {
    const la = left.anchor ?? "";
    const ra = right.anchor ?? "";
    if (la !== ra) return la < ra ? -1 : 1;
    return left.body < right.body ? -1 : left.body > right.body ? 1 : 0;
  });
}

/**
 * Compose the ROUND work-order's dispositions from the durable ask projection (B11
 * cluster 4, #458 R29–R36) — the round-exit twin of {@link reviewCommentsFromProjection},
 * disjoint by design: the review exit posts only the code-anchored subset to GitHub,
 * the round exit hands EVERY staged ask (prose + code-anchored) to the coding agent.
 * So this maps all of `projection.stagedAsks`; `buildHandoffBundle` then keeps the
 * addressed types (request-change / comment), the same filter the disposition path uses.
 *
 * A canonical CodeRef resolves only against its captured active patchset. A matching
 * renamed base-side ref maps to the current file path while preserving its full span and
 * deletion side. A frozen or ambiguous ref keeps only its captured path, with no span or
 * side to reinterpret. Legacy asks still read `anchor` + `side`.
 *
 * Deterministic order (path, then line, then durable ask id) so the same asks always compose the same bundle
 * (a stable digest — the dispatch idempotency key), regardless of the projection's Record
 * key order or a disk round-trip.
 */
export function handoffDispositionsFromProjection(
  projection: AskProjection,
  activePatchset: Patchset,
): HandoffDisposition[] {
  const dispositions: HandoffDisposition[] = Object.values(projection.stagedAsks).map((ask) => {
    const common = {
      id: ask.id,
      type: ask.type,
      body: ask.body,
      ...(ask.finding === undefined ? {} : { finding: ask.finding }),
    };
    if (ask.codeRef !== undefined) {
      const ref = ask.codeRef;
      const file = activeFileForCodeRef(ref, activePatchset);
      if (file === undefined) return { ...common, path: ref.path };
      return {
        ...common,
        path: file.path,
        span: { startLine: ref.startLine, endLine: ref.endLine },
        side: ref.side === "base" ? ("deletions" as const) : ("additions" as const),
      };
    }
    const at = parsePathLine(ask.anchor);
    return at
      ? {
          ...common,
          path: at.path,
          span: { startLine: at.line },
          // Honor the ask's diff side (B11 finding 7): a deletion-side ask resolves the
          // pre-image hunk, not the hardcoded additions side. Absent ⇒ additions.
          side: ask.side === "LEFT" ? ("deletions" as const) : ("additions" as const),
        }
      : {
          ...common,
          path: ask.anchor,
        };
  });
  return dispositions.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    const byLine = (left.span?.startLine ?? 0) - (right.span?.startLine ?? 0);
    if (byLine !== 0) return byLine;
    const leftId = left.id ?? "";
    const rightId = right.id ?? "";
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

/** A reference to the exact PR + head a review is pinned to. */
export interface ForgeReviewTarget {
  /** The PR the review lands on (forge / owner / name / number). */
  readonly ref: ForgePullRequestRef;
  /** The forge's opaque PR node id — carried, interpreted ONLY inside the adapter. */
  readonly forgeRef: string;
  /** The reviewed head commit OID, pinned at review start (GraphQL `commitOID`). */
  readonly headOid: string;
}

/** A single line-anchored review thread (a comment that HAS a line). */
export interface ForgeReviewThread {
  readonly path: string;
  readonly line: number;
  /** Present only for a genuine multi-line span (`startLine < line`). */
  readonly startLine?: number;
  readonly side: "LEFT" | "RIGHT";
  readonly body: string;
}

/** The class of a flattening the ledger records (never a silent drop, #21). A `body-note`
 *  is a pathless ask woven into the review body (B11 finding 2) — recorded, not dropped. */
export type PublishDegradationKind = "file-level-fold" | "thread-fold" | "body-note";

/** One degradation applied while building the outbound post, shown to the reviewer. */
export interface PublishDegradation {
  readonly kind: PublishDegradationKind;
  readonly path: string;
  readonly detail: string;
}

/** The forge-neutral batched review post, assembled from the canonical artifact. */
export interface ForgeReviewPost {
  readonly target: ForgeReviewTarget;
  /** The resolved review verdict (derived from the dispositions, or an override). */
  readonly event: ForgeReviewEvent;
  /** The review-level body: header + folded file-level notes + the idempotency marker. */
  readonly body: string;
  /** The line-anchored threads. A no-line comment is folded into `body`, never here. */
  readonly threads: readonly ForgeReviewThread[];
  /** The deterministic idempotency marker embedded (as an HTML comment) in `body`. */
  readonly marker: string;
  /** Every flattening applied, in draft order — surfaced, never silent. */
  readonly ledger: readonly PublishDegradation[];
}

/** The exact signed post projection carried across the publish wire. */
export interface ForgeReviewPostDescriptor {
  readonly event: ForgeReviewEvent;
  readonly body: string;
  readonly threads: readonly ForgeReviewThread[];
}

/** Remove adapter-only target, marker, and ledger fields from a composed post. */
export function forgeReviewPostDescriptor(post: ForgeReviewPost): ForgeReviewPostDescriptor {
  return { event: post.event, body: post.body, threads: post.threads };
}

/** A human label for a disposition type, rendered into the comment body. */
const TYPE_LABEL: Record<DispositionType, string> = {
  "request-change": "Requested change",
  question: "Question",
  comment: "Comment",
  approve: "Approval",
};

/**
 * Render a comment body with its disposition type as a legible prefix, so each thread keeps
 * its own classification within the review-level event. An empty body renders as the bare label.
 */
function formatCommentBody(type: DispositionType, body: string): string {
  const trimmed = body.trim();
  return trimmed === "" ? `**${TYPE_LABEL[type]}**` : `**${TYPE_LABEL[type]}** — ${trimmed}`;
}

/**
 * A stable identity string for a target and its idempotency marker. Includes the head OID so a
 * review pinned to one head cannot be reused against a different head, AND the opaque `forgeRef`
 * (the PR node
 * id). The forgeRef is load-bearing here: the adapter POSTS by `pullRequestId:
 * forgeRef` while `findExistingReview` READS by coordinates, and forgeRef and the
 * coordinates are independent persisted fields. Binding both prevents an outcome from being
 * reconciled against a different (coordinates, head, node id) target.
 */
export function forgeTargetKey(target: ForgeReviewTarget): string {
  const { forge, owner, name } = target.ref.repo;
  return `${forge}/${owner}/${name}#${target.ref.number}@${target.headOid}:${target.forgeRef}`;
}

/**
 * The deterministic idempotency marker for a post (R17 / #21): a content
 * fingerprint over (reviewId, target identity, event, canonical payload). Identical inputs
 * ⇒ identical marker, so a retry after a dropped outcome recomputes the same marker,
 * finds the already-created review carrying it, and returns instead of double-posting.
 */
export function buildReviewMarker(
  reviewId: string,
  target: ForgeReviewTarget,
  payload: string,
  event: ForgeReviewEvent,
): string {
  return sha256Hex(`${reviewId} ${forgeTargetKey(target)} ${event} ${payload}`);
}

/** The embedded marker form (an invisible HTML comment on the rendered review body). */
export function markerComment(marker: string): string {
  return `<!-- rennet:review:${marker} -->`;
}

/** Extract the marker from a review body, or `null` when absent (for read-back). */
export function extractMarker(body: string): string | null {
  const matches = [...body.matchAll(/<!-- rennet:review:([0-9a-f]{64}) -->/g)];
  return matches.at(-1)?.[1] ?? null;
}

export interface BuildReviewPostOptions {
  readonly reviewId: string;
  readonly target: ForgeReviewTarget;
  /** The canonical payload bytes (the marker + round-trip both key off this). */
  readonly payload: string;
  /** The forge's advertised capabilities (degradation is written against these). */
  readonly capabilities: ForgeCapabilities;
  /**
   * An explicit review verdict that OVERRIDES the one derived from the dispositions.
   * Absent ⇒ derive it ("derive first, overridable"). This is the seam a sign-time
   * verdict picker feeds; until that UI exists the field simply stays unset and the
   * derived verdict posts.
   */
  readonly verdict?: ForgeReviewEvent;
}

/**
 * Assemble the forge-neutral batched review post from the canonical artifact.
 *
 * Line-anchored comments become threads. A no-line comment cannot be a batched
 * review thread (a `DraftPullRequestReviewThread` requires a line), so it is FOLDED
 * into the review body as a "File-level notes" bullet with a path pointer-back — and
 * EVERY fold is recorded on the ledger (`file-level-fold`), so a reviewer sees it was
 * flattened, never silently dropped (#21). The fold is written against the forge's
 * capability flags rather than the forge name: a forge that can carry file-level
 * threads inside a single batched review would not fold here — GitHub's batched
 * `addPullRequestReview` cannot, so it does.
 */
export function buildForgeReviewPost(
  artifact: ReviewArtifact,
  options: BuildReviewPostOptions,
): ForgeReviewPost {
  assertNonblankReviewOpener(artifact.opener);
  const threads: ForgeReviewThread[] = [];
  const fileLevel: ReviewCommentInput[] = [];
  const foldedThreads: {
    readonly comment: ReviewCommentInput;
    readonly detail: string;
  }[] = [];
  const ledger: PublishDegradation[] = [];

  for (const comment of artifact.comments) {
    if (comment.line === undefined) {
      fileLevel.push(comment);
      continue;
    }
    const isRange = comment.startLine !== undefined && comment.startLine < comment.line;
    if (isRange && !options.capabilities.supportsMultiLineAnchors) {
      foldedThreads.push({
        comment,
        detail: `The forge cannot anchor lines ${comment.startLine}–${comment.line} — folded into the review body.`,
      });
      continue;
    }
    if (options.capabilities.supportsBatchedReview) {
      threads.push({
        path: comment.path,
        ...(isRange ? { startLine: comment.startLine } : {}),
        line: comment.line,
        side: comment.side,
        body: formatCommentBody(comment.type, comment.body),
      });
    } else {
      foldedThreads.push({
        comment,
        detail: "The forge cannot submit one batched review — folded into the review body.",
      });
    }
  }

  // The event is part of the outbound operation but not the canonical artifact payload. Resolve
  // it before the marker so a verdict-only recompose cannot reconcile to an older review whose
  // body bytes happen to match.
  const event = resolveReviewEvent([...artifact.comments, ...artifact.bodyNotes], options.verdict);
  const marker = buildReviewMarker(options.reviewId, options.target, options.payload, event);
  const sections: string[] = [artifact.opener];

  // The BODY stratum (B11 finding 2): a pathless/prose ask has no diff line, so it is woven
  // into the review body under a "Review notes" heading rather than dropped — and each is
  // ledgered (`body-note`), so the reviewer sees it travelled in the body, never a silent drop.
  const bodyNotes = artifact.bodyNotes;
  if (bodyNotes.length > 0) {
    const notes = bodyNotes.map((note) => {
      ledger.push({
        kind: "body-note",
        path: "",
        detail: "No diff position — woven into the review body as a review note.",
      });
      return `- ${formatCommentBody(note.type, note.body)}`;
    });
    sections.push(`## Review notes\n${notes.join("\n")}`);
  }

  if (fileLevel.length > 0) {
    // A no-line comment cannot ride a batched review thread — a
    // `DraftPullRequestReviewThread` requires a line — so it folds into the review
    // body and is ledgered. This is a property of the BATCHED review construction
    // (one event, one notification), not of the forge's general ability to hold
    // file-level threads; the capability flags stay in `options` for the anchoring
    // degradations (out-of-diff, multi-line) that a later slice writes against them.
    const notes = fileLevel.map((comment) => {
      ledger.push({
        kind: "file-level-fold",
        path: comment.path,
        detail: "No line anchor — folded into the review body as a file-level note.",
      });
      return `- \`${comment.path}\` — ${formatCommentBody(comment.type, comment.body)}`;
    });
    sections.push(`## File-level notes\n${notes.join("\n")}`);
  }

  if (foldedThreads.length > 0) {
    const notes = foldedThreads.map(({ comment, detail }) => {
      ledger.push({
        kind: "thread-fold",
        path: comment.path,
        detail,
      });
      const anchor =
        comment.startLine === undefined
          ? `${comment.line}`
          : `${comment.startLine}–${comment.line}`;
      return `- \`${comment.path}:${anchor}\` — ${formatCommentBody(comment.type, comment.body)}`;
    });
    sections.push(`## Line comments\n${notes.join("\n")}`);
  }

  sections.push(markerComment(marker));
  const body = sections.join("\n\n");
  return { target: options.target, event, body, threads, marker, ledger };
}

// ── The forge-neutral egress port (issue #21) ────────────────────────────────

/**
 * One exact HTTP mutation in a forge publish operation. It carries NO secret: the
 * bearer token is an Authorization HEADER added only at real send time, never part
 * of this descriptor, so a dry-run descriptor is safe to surface and log.
 */
export interface ForgeHttpRequestDescriptor {
  readonly endpoint: string;
  readonly method: string;
  readonly body: unknown;
}

/**
 * The complete ordered mutation sequence a post would send, WITHOUT sending it.
 * GitHub uses one GraphQL request; GitLab approval uses a note followed by a
 * head-pinned approval request. The real send consumes these same descriptors.
 */
export interface ForgeRequestDescriptor {
  readonly requests: readonly ForgeHttpRequestDescriptor[];
}

/** The outcome of a real (or reconciled) publish. */
export interface ForgePublishOutcome {
  /** The forge's opaque id for the review. */
  readonly reviewRef: string;
  readonly url: string;
  /** True when an existing review carrying the marker was reused (idempotent no-op). */
  readonly reused: boolean;
}

/**
 * A forge secondary-rate-limit signal. Thrown (never a silent retry loop) so the
 * caller backs off on the forge's own schedule instead of a retry storm (#21 /
 * backlog bead 96). `retryAfterMs` is the forge's advised wait when it gave one.
 */
export class ForgeRateLimited extends Error {
  constructor(
    readonly retryAfterMs: number | null,
    readonly reason: string,
  ) {
    super(`Forge secondary rate limit: ${reason}`);
    this.name = "ForgeRateLimited";
  }
}

/**
 * The forge-neutral egress port. Deliberately SEPARATE from the read-only
 * `ForgePort` (list/fetch/diff): the read port has no egress capability by
 * construction, so a component that only needs to READ a forge cannot be handed the
 * ability to POST as the user. The changeset/review code depends on `ForgePort`; only
 * the publish command reaches a `ForgePublishPort`.
 */
export interface ForgePublishPort {
  readonly capabilities: ForgeCapabilities;
  /**
   * Construct the complete ordered forge mutation sequence for `post` WITHOUT
   * sending it. Pure and network-free: the primary dry-run evidence and the same
   * bytes a real send uses.
   */
  buildReviewRequest(post: ForgeReviewPost): ForgeRequestDescriptor;
  /**
   * Query the PR for an existing review whose body carries `marker`, for the
   * query-before-post idempotency reconcile. Returns `null` when none exists.
   */
  findExistingReview(
    target: ForgeReviewTarget,
    marker: string,
  ): Promise<ForgePublishOutcome | null>;
  /**
   * Post the provider-specific review operation. Idempotent: queries for the marker
   * first and reuses its review note rather than double-posting. Providers with a
   * separate approval mutation reconcile that mutation against the reused note.
   * Throws {@link ForgeRateLimited} on a secondary rate limit — never retries into a
   * storm.
   */
  publishReview(post: ForgeReviewPost): Promise<ForgePublishOutcome>;
}
