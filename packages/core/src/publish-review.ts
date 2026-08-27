import type { AskProjection, Disposition, DispositionType } from "@rennet/protocol";
import { sha256Hex } from "@rennet/protocol";
import type { ForgeCapabilities, ForgePullRequestRef } from "./forge-port";

/**
 * The outbound GitHub publish (issue #21) — the forge-NEUTRAL half.
 *
 * This is the first real egress in Rennet: a decomposed review leaving the
 * machine and landing on a pull request AS THE USER. Everything about that is
 * safety-critical, so this module is written to make the dangerous parts
 * STRUCTURAL rather than promised:
 *
 *   • The review event is `COMMENT` and ONLY `COMMENT` — there is no value, and no
 *     code path, that emits `APPROVE` or `REQUEST_CHANGES`. Rennet never approves
 *     or requests-changes on the user's behalf (Contracts R33, publish safety #80).
 *     The disposition TYPES (request-change / approve / …) are per-comment
 *     classifications rendered INTO the comment bodies; the review EVENT stays a
 *     single neutral comment — one event, one notification (#21).
 *   • The outbound bytes are DERIVED from the same canonical `pr-review` payload the
 *     UI previews (`reviewCommentsPayload` in the ui layer). `canonicalReviewPayload`
 *     here reproduces those bytes, so the egress boundary can independently verify
 *     "what you see is what leaves" (R33) with a byte-exact round-trip and fail
 *     CLOSED on any disagreement — the MAIN-side analogue of the #106 UI gate.
 *   • Every flattening lands on the degradation ledger, never a silent drop (#21).
 *   • The idempotency marker is deterministic in (reviewId, target, payload), so a
 *     retry after a dropped outcome finds the prior review and returns it instead of
 *     double-posting (#21 / R17).
 *
 * Node-free at module scope (like `forge-port.ts`): no `node:*`, no filesystem, no
 * process, so a mobile or third-party client can import it. The one digest it needs
 * is `sha256Hex` from `@rennet/protocol` (the portable, node-free SHA-256), exactly
 * as `orchestrator-primer.ts` already does.
 */

/**
 * The review verdict Rennet posts — the real GitHub review event. A review tool must
 * be able to post the actual verdict, so this is the full three-value set, not a lock.
 * The VALUE is resolved from the signed review (see {@link resolveReviewEvent}):
 * derived from the dispositions by default, overridable by an explicit verdict on the
 * post descriptor. The human sign + the consent/forgeRef binding are the safety model;
 * the event is the product.
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
export function deriveReviewEvent(comments: readonly ReviewCommentInput[]): ForgeReviewEvent {
  if (comments.some((comment) => comment.type === "request-change")) return "REQUEST_CHANGES";
  if (comments.some((comment) => comment.type === "approve")) return "APPROVE";
  return "COMMENT";
}

/**
 * Resolve the verdict for a post: an explicit `verdict` (from the signed descriptor)
 * WINS when present; otherwise the verdict is derived from the dispositions. "Derive
 * first, overridable" (Rai, 2026-08-09).
 */
export function resolveReviewEvent(
  comments: readonly ReviewCommentInput[],
  verdict?: ForgeReviewEvent,
): ForgeReviewEvent {
  return verdict ?? deriveReviewEvent(comments);
}

/**
 * One review comment in the canonical `pr-review` shape — the SAME logical fields
 * the ui layer serialises in `reviewCommentsPayload`. A path-grained disposition has
 * `line: undefined` (serialised as `null`) and posts as a file-level note (folded
 * into the review body), which is honest — it genuinely has no single line.
 */
export interface ReviewCommentInput {
  readonly path: string;
  /** The file line the comment anchors to; absent ⇒ a file-level note (no line). */
  readonly line?: number;
  readonly side: "LEFT" | "RIGHT";
  readonly type: DispositionType;
  readonly body: string;
}

/**
 * The canonical outbound bytes for a posted review — reproduced here so the MAIN
 * egress boundary can verify them independently of the renderer.
 *
 * ⚠️ These bytes MUST stay byte-identical to the ui layer's `reviewCommentsPayload`
 * (`packages/app-ui/src/canvas/publish.ts`): same `kind`, same field order, `line ?? null`.
 * The two are separate copies across a layer boundary (ui cannot be imported by
 * core), so a change to one must change the other. The failure direction is SAFE —
 * a drift makes the round-trip check refuse a legitimate publish (fail closed), it
 * never lets a mismatched payload through — but the coupling is pinned by an
 * exact-bytes test (`publish-review.test.ts`) so drift is caught, not merely
 * tolerated. This is the byte-exact contract the #106 fail-closed and this slice
 * both build on.
 */
export function canonicalReviewPayload(comments: readonly ReviewCommentInput[]): string {
  return JSON.stringify({
    kind: "pr-review",
    comments: comments.map((comment) => ({
      path: comment.path,
      line: comment.line ?? null,
      side: comment.side,
      type: comment.type,
      body: comment.body,
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
 * (`anchor.span`/`anchor.side` present, #78) posts at `span.startLine` on the side
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
      const line = disposition.anchor.span?.startLine;
      const side: "LEFT" | "RIGHT" = disposition.anchor.side === "deletions" ? "LEFT" : "RIGHT";
      return {
        path: disposition.anchor.path,
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

/**
 * Compose the DEFAULT outbound review comments from the durable ASK PROJECTION (B11
 * cluster 3, #458 R29–R36) — the projection equivalent of
 * {@link reviewCommentsFromDispositions}. The durable projection is now the living-draft
 * authority the desktop and phone share, so `publish.compose(mode:"review")` sources the
 * outbound comments from HERE (superseding `review.dispositions`), and the post commands
 * re-derive the same bytes off the same projection (single-source, R33).
 *
 * Two strata, GitHub's shape:
 *   • LINE comments — a staged ask whose `anchor` is a `path:line` code position, plus
 *     every `lineComments` entry (`path`→line→body). An ask and a bare line comment on the
 *     SAME `path:line` collapse to ONE comment (the client's dual-claim rule): the ask
 *     wins, since it carries the intent `type` and its own body.
 *   • BODY prose — a staged ask whose anchor is a quoted prose span (no `path:line`) has no
 *     repo path, so it is not a GitHub review COMMENT. It feeds the round work-order exit
 *     (B11 cluster 4), not this one, and is excluded here rather than posted pathless.
 *
 * Deterministic order (path, then line) so the canonical payload is byte-stable regardless
 * of the projection's Record key order — a projection round-tripped through disk composes
 * identically.
 */
export function reviewCommentsFromProjection(projection: AskProjection): ReviewCommentInput[] {
  const comments: ReviewCommentInput[] = [];
  const claimed = new Set<string>();
  for (const ask of Object.values(projection.stagedAsks)) {
    const at = parsePathLine(ask.anchor);
    if (!at) continue; // a prose ask has no repo path — the round-work-order exit's input, not this one
    claimed.add(`${at.path}:${at.line}`);
    comments.push({ path: at.path, line: at.line, side: "RIGHT", type: ask.type, body: ask.body });
  }
  for (const [path, lines] of Object.entries(projection.lineComments)) {
    for (const [lineStr, body] of Object.entries(lines)) {
      const line = Number(lineStr);
      if (claimed.has(`${path}:${line}`)) continue; // a staged ask already claims this line
      comments.push({ path, line, side: "RIGHT", type: "comment", body });
    }
  }
  return comments.sort((left, right) =>
    left.path !== right.path
      ? left.path < right.path
        ? -1
        : 1
      : (left.line ?? 0) - (right.line ?? 0),
  );
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

/** The class of a flattening the ledger records (never a silent drop, #21). */
export type PublishDegradationKind = "file-level-fold";

/** One degradation applied while building the outbound post, shown to the reviewer. */
export interface PublishDegradation {
  readonly kind: PublishDegradationKind;
  readonly path: string;
  readonly detail: string;
}

/** The forge-neutral batched review post, assembled from the canonical comments. */
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

/** A human label for a disposition type, rendered into the comment body. */
const TYPE_LABEL: Record<DispositionType, string> = {
  "request-change": "Requested change",
  question: "Question",
  comment: "Comment",
  approve: "Approval",
};

/**
 * Render a comment body with its disposition type as a legible prefix. The review
 * EVENT is a neutral comment, so the classification (requested change, question, …)
 * has to live in the body to be visible. An empty body renders as the bare label.
 */
function formatCommentBody(type: DispositionType, body: string): string {
  const trimmed = body.trim();
  return trimmed === "" ? `**${TYPE_LABEL[type]}**` : `**${TYPE_LABEL[type]}** — ${trimmed}`;
}

/**
 * A stable identity string for a target, for the idempotency marker + the consent
 * binding. Includes the head OID so a review pinned to one head cannot be reused to
 * authorise a post against a different head, AND the opaque `forgeRef` (the PR node
 * id). The forgeRef is load-bearing here: the adapter POSTS by `pullRequestId:
 * forgeRef` while `findExistingReview` READS by coordinates, and forgeRef and the
 * coordinates are independent renderer-supplied fields — so a token bound to one PR's
 * coordinates must NOT authorise a post to a different node id. Binding both closes
 * that gap: the consent token and the idempotency marker key on the exact
 * (coordinates, head, node id) the user approved.
 */
export function forgeTargetKey(target: ForgeReviewTarget): string {
  const { forge, owner, name } = target.ref.repo;
  return `${forge}/${owner}/${name}#${target.ref.number}@${target.headOid}:${target.forgeRef}`;
}

/**
 * The deterministic idempotency marker for a post (R17 / #21): a content
 * fingerprint over (reviewId, target identity, canonical payload). Identical inputs
 * ⇒ identical marker, so a retry after a dropped outcome recomputes the same marker,
 * finds the already-created review carrying it, and returns instead of double-posting.
 */
export function buildReviewMarker(
  reviewId: string,
  target: ForgeReviewTarget,
  payload: string,
): string {
  return sha256Hex(`${reviewId} ${forgeTargetKey(target)} ${payload}`);
}

/** The embedded marker form (an invisible HTML comment on the rendered review body). */
export function markerComment(marker: string): string {
  return `<!-- rennet:review:${marker} -->`;
}

/** Extract the marker from a review body, or `null` when absent (for read-back). */
export function extractMarker(body: string): string | null {
  return body.match(/<!-- rennet:review:([0-9a-f]{64}) -->/)?.[1] ?? null;
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
 * Assemble the forge-neutral batched review post from the canonical comments.
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
  comments: readonly ReviewCommentInput[],
  options: BuildReviewPostOptions,
): ForgeReviewPost {
  const threads: ForgeReviewThread[] = [];
  const fileLevel: ReviewCommentInput[] = [];
  const ledger: PublishDegradation[] = [];

  for (const comment of comments) {
    if (comment.line === undefined) {
      fileLevel.push(comment);
      continue;
    }
    threads.push({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: formatCommentBody(comment.type, comment.body),
    });
  }

  const marker = buildReviewMarker(options.reviewId, options.target, options.payload);
  const sections: string[] = ["Rennet review."];

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

  sections.push(markerComment(marker));
  const body = sections.join("\n\n");
  const event = resolveReviewEvent(comments, options.verdict);

  return { target: options.target, event, body, threads, marker, ledger };
}

// ── The forge-neutral egress port (issue #21) ────────────────────────────────

/**
 * The exact forge request a post would send, WITHOUT sending it — the primary
 * dry-run evidence. The `body` is the request payload the adapter constructed (a
 * `{ query, variables }` GraphQL document for GitHub). It carries NO secret: the
 * bearer token is an Authorization HEADER added only at real send time, never part
 * of this descriptor, so a dry-run descriptor is safe to surface and log.
 */
export interface ForgeRequestDescriptor {
  readonly endpoint: string;
  readonly method: string;
  readonly body: unknown;
}

/** The outcome of a real (or reconciled) publish. */
export interface ForgePublishOutcome {
  /** The forge's opaque id for the review. */
  readonly reviewRef: string;
  readonly url: string | null;
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
   * Construct the exact forge request for `post` WITHOUT sending it. Pure and
   * network-free: the primary dry-run evidence and the same bytes a real send uses.
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
   * Post the review as ONE batched review event (one notification). Idempotent:
   * queries for the marker first and returns the existing review (reused: true)
   * rather than double-posting, so a retry after a dropped outcome yields exactly one
   * review. Throws {@link ForgeRateLimited} on a secondary rate limit — never retries
   * into a storm.
   */
  publishReview(post: ForgeReviewPost): Promise<ForgePublishOutcome>;
}
