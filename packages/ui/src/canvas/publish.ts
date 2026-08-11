import type { DispositionType, RepositoryProvenance } from "@rennet/types";
import { type CollationDraft, type CollationItem, effectiveBody } from "./collation";
import type { DestinationMode } from "./destination";

// ─────────────────────────────────────────────────────────────────────────────
// The PUBLISH TARGET (issue #22) — pure functions, no React, no DOM.
//
// R40 narrowed the paper to sign + back; #101 made the collation draft the
// forming destination. What #22 still owes is the paper's CONTENT: the two
// context-dependent outbound artifacts a review can produce, DERIVED from the one
// collation draft (Rai, voice 2026-08-07: "everything leads up to one of two
// destinations").
//
//  • own-branch → a PR SUBMISSION (title / body / base / head / draft-default).
//    This is a PREVIEW of what a later, explicit act (#21) would create. Nothing
//    here mutates Git or GitHub — creation is a separate act, and Rennet never
//    pushes source. These are pure functions with no I/O; the whole own-branch
//    path is structurally incapable of mutation.
//  • other-pr  → the REVIEW it will post: every disposition as a line-anchored
//    review comment. The #78 span payload feeds the line anchors; a disposition
//    with no known span posts as a file-level comment (line undefined), honestly.
//
// "What you see is what leaves" (R33): the paper previews `publishTargetPayload`
// and signs the SAME bytes, and the structured card/list the human reads is a
// faithful render of the SAME target the payload was serialised from.
//
// The `layer:ui` boundary allows only `@rennet/types` + this package: nothing
// here imports `@rennet/core`.
// ─────────────────────────────────────────────────────────────────────────────

// ── The own-branch destination: a PR submission preview ──────────────────────

/**
 * A GitHub line anchor for a review comment (own-branch composition + other-pr
 * posting). `line` is the file line the comment lands on; `side` is the diff side
 * (LEFT = the base, RIGHT = the head). Fed by the #78 span payload. A disposition
 * with no known anchor posts as a file-level comment (no line), which is honest —
 * a path-grained disposition genuinely has no single line.
 */
export interface LineAnchor {
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
}

/** Per-item line anchors, keyed by the collation item id. Populated by #78. */
export type LineAnchors = Readonly<Record<string, LineAnchor>>;

/**
 * The metadata a PR submission needs that the collation draft cannot supply — the
 * branch shape and the draft default. Comes from the #20/#21 GitHub source; until
 * that lands the host supplies an honest fixture context.
 */
export interface PrSubmissionContext {
  readonly base: string;
  readonly head: string;
  /** The PR opens as a draft by default; the reviewer can flip it before creating. */
  readonly draftDefault: boolean;
  /** An explicit title override; when absent, one is derived from the head branch. */
  readonly title?: string;
  /**
   * An explicit body override (issue #74, M26). When present it REPLACES the
   * deterministic disposition-grouped body — this is where the drafted-then-edited
   * PR body lands, so the paper previews and signs the human's edited account.
   * When absent, the body is composed from the draft (the pre-M26 behaviour).
   */
  readonly body?: string;
}

/** The PR submission the own-branch paper previews and (via #21) would create. */
export interface PrSubmission {
  readonly title: string;
  readonly body: string;
  readonly base: string;
  readonly head: string;
  readonly draft: boolean;
}

/** A stable ordering label for a disposition type, so the composed body reads well. */
const TYPE_HEADING: Record<DispositionType, string> = {
  "request-change": "Requested changes",
  question: "Questions",
  comment: "Comments",
  approve: "Approvals",
};

const TYPE_ORDER: DispositionType[] = ["request-change", "question", "comment", "approve"];

/** A human default title from the head branch: `feat/publish-sheet` → `Publish sheet`. */
function titleFromHead(head: string): string {
  const tail = head.split("/").pop() ?? head;
  const words = tail.replace(/[-_]+/g, " ").trim();
  if (words === "") return "Untitled change";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Compose the PR submission body from the collation draft. Items are grouped by
 * disposition type (requested changes first, approvals last) and, within a group,
 * kept in DRAFT ORDER — the order the user composed is the order it reads, exactly
 * as it does in the outbound bytes. The effective body (refined once present, else
 * the sovereign raw) is what lands; an empty body renders as a bare path bullet.
 *
 * Pure: it reads the draft and returns a string. It never mutates the draft and it
 * touches nothing outside — this is the whole point of "zero Git/GitHub mutation"
 * being structural rather than promised.
 */
export function composePrSubmissionBody(draft: CollationDraft): string {
  const sections: string[] = [];
  for (const type of TYPE_ORDER) {
    const items = draft.filter((item) => item.type === type);
    if (items.length === 0) continue;
    const lines = items.map((item) => {
      const body = effectiveBody(item).trim();
      return body === "" ? `- \`${item.path}\`` : `- \`${item.path}\` — ${body}`;
    });
    sections.push(`## ${TYPE_HEADING[type]}\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

/**
 * Build the PR submission from the collation draft + the branch context. Pure and
 * side-effect-free: it constructs a value, it does not create a PR. The actual
 * creation is a separate explicit act (#21); this is the preview the paper shows.
 */
export function composePrSubmission(
  draft: CollationDraft,
  context: PrSubmissionContext,
): PrSubmission {
  // The body is the drafted-then-edited account (M26 override) when the host supplies
  // one, else the deterministic disposition grouping. A non-empty override wins; an
  // empty/whitespace override falls back to the composed body so the preview is never
  // blank (the same honesty floor the drafting producer enforces upstream).
  const overrideBody = context.body?.trim();
  return {
    title: context.title ?? titleFromHead(context.head),
    body: overrideBody && overrideBody !== "" ? overrideBody : composePrSubmissionBody(draft),
    base: context.base,
    head: context.head,
    draft: context.draftDefault,
  };
}

/**
 * The canonical outbound bytes for a PR submission — a stable, key-ordered JSON so
 * the previewed bytes equal the bytes a later #21 create would send. Serialised
 * with an explicit field order (not object-key order) so the bytes are stable
 * regardless of how the submission object was built.
 */
export function prSubmissionPayload(submission: PrSubmission): string {
  return JSON.stringify({
    kind: "pr-submission",
    title: submission.title,
    body: submission.body,
    base: submission.base,
    head: submission.head,
    draft: submission.draft,
  });
}

// ── The other-pr destination: line-anchored review comments ──────────────────

/** One review comment the other-pr paper previews and (via #21) would post. */
export interface ReviewComment {
  readonly path: string;
  /** The file line, when a span anchor is known (#78). Undefined → a file comment. */
  readonly line?: number;
  readonly side: "LEFT" | "RIGHT";
  readonly type: DispositionType;
  readonly body: string;
  /**
   * Whether `body` is the agent-refined form (#19) or the raw sovereign fallback.
   * Until #19 ships nothing sets `refined`, so every comment is `refined: false`
   * and the paper renders the raw body with an honest "raw" marker.
   */
  readonly refined: boolean;
}

/**
 * Derive the review comments from the collation draft, in DRAFT ORDER (the order
 * the review reads). Each item becomes one comment; its line anchor comes from the
 * #78 span payload keyed by item id, else it posts file-level (no line). The body
 * is the effective body — the refined form once #19 lands, else the raw fallback —
 * and `refined` records which, so the paper can mark a raw comment honestly.
 */
export function reviewComments(draft: CollationDraft, anchors: LineAnchors = {}): ReviewComment[] {
  return draft.map((item) => {
    const anchor = anchors[item.id];
    return {
      path: item.path,
      line: anchor?.line,
      side: anchor?.side ?? "RIGHT",
      type: item.type,
      body: effectiveBody(item),
      refined: item.refined !== undefined,
    };
  });
}

/**
 * The review verdict Rennet posts — the real GitHub review event. This mirrors
 * `@rennet/core`'s `ForgeReviewEvent`; the `layer:ui` boundary forbids importing
 * core, so the value is a legible twin (exactly as `reviewCommentsPayload` twins
 * core's `canonicalReviewPayload` across the same boundary).
 */
export type ForgeReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/**
 * Derive the review verdict from the collated comments — the twin of
 * `@rennet/core`'s `deriveReviewEvent`, so the paper can DISPLAY the verdict the
 * engine will post. Any requested change ⇒ `REQUEST_CHANGES`; else any approval ⇒
 * `APPROVE`; else a neutral `COMMENT`. Questions and plain comments never escalate.
 *
 * ⚠️ Kept byte-for-byte equivalent to core's `deriveReviewEvent` (both key on
 * `type`, same precedence). The sign wire passes this value as the explicit
 * `verdict` so what the paper shows and what the engine posts are the SAME value —
 * a `publish-review.test.ts`-style pin guards against drift.
 */
export function deriveReviewEvent(comments: readonly ReviewComment[]): ForgeReviewEvent {
  if (comments.some((comment) => comment.type === "request-change")) return "REQUEST_CHANGES";
  if (comments.some((comment) => comment.type === "approve")) return "APPROVE";
  return "COMMENT";
}

/**
 * The pinned publish target the sign wire hands to `publish.review` (the protocol
 * `publishTargetSchema` shape). A LOCAL capture has no GitHub PR identity yet — the
 * #20/#21 GitHub source supplies the real (owner, name, number, node id). Until
 * then this builds an honest PREVIEW target from the review's provenance: the REAL
 * reviewed `headOid`, with placeholder coordinates the UI labels as a local
 * preview. Nothing is posted (the wire dry-runs), so the placeholder only needs to
 * satisfy the schema and let the engine construct + integrity-check the real
 * GitHub request end to end.
 */
export interface PreviewPublishTarget {
  readonly repo: { readonly forge: string; readonly owner: string; readonly name: string };
  readonly number: number;
  readonly forgeRef: string;
  readonly headOid: string;
}

/** Build the local-preview publish target from the active patchset's provenance. */
export function previewPublishTarget(repository: RepositoryProvenance): PreviewPublishTarget {
  const name = repository.root.split("/").filter(Boolean).at(-1) ?? "repository";
  return {
    repo: { forge: "github", owner: "local", name },
    number: 1,
    forgeRef: "local-preview",
    headOid: repository.headOid,
  };
}

/** A short, human label for a preview target: `local/<name>#<number>`. */
export function previewTargetLabel(target: PreviewPublishTarget): string {
  return `${target.repo.owner}/${target.repo.name}#${target.number}`;
}

/** The canonical outbound bytes for a posted review — the ordered comment list. */
export function reviewCommentsPayload(comments: readonly ReviewComment[]): string {
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

// ── The unified target: one review state, two variants ───────────────────────

/**
 * The outbound artifact for the active variant, DERIVED from the one collation
 * draft. `own-branch` yields a PR submission; `other-pr` yields the review to
 * post. Both come from the SAME draft, so the two variants are two framings of one
 * review state, not two data sources.
 */
export type PublishTarget =
  | { readonly mode: "own-branch"; readonly submission: PrSubmission }
  | { readonly mode: "other-pr"; readonly comments: readonly ReviewComment[] };

/** Everything the host must supply beyond the draft to build a target. */
export interface PublishContext {
  /** Branch shape + draft default for the own-branch PR submission. */
  readonly submission: PrSubmissionContext;
  /** Line anchors (#78) for the other-pr review comments. */
  readonly anchors?: LineAnchors;
}

/** Build the variant-specific outbound target from the one collation draft. */
export function publishTarget(
  mode: DestinationMode,
  draft: CollationDraft,
  context: PublishContext,
): PublishTarget {
  if (mode === "own-branch") {
    return { mode, submission: composePrSubmission(draft, context.submission) };
  }
  return { mode, comments: reviewComments(draft, context.anchors) };
}

/**
 * The canonical outbound bytes for a target — the SAME bytes the paper previews
 * and signs. "What you see is what leaves": the sheet is handed exactly this, and
 * emits exactly this on sign.
 */
export function publishTargetPayload(target: PublishTarget): string {
  return target.mode === "own-branch"
    ? prSubmissionPayload(target.submission)
    : reviewCommentsPayload(target.comments);
}

/**
 * Whether the sheet's INDEPENDENT `payload` and `variantMode` props AGREE with the
 * structured `target` it renders (issue #106, defense-in-depth for R33 "what you
 * see is what leaves"). The paper renders the human-legible card from `target` but
 * signs the independent `payload`, and frames the sheet with the independent
 * `variant` — so a caller that hands a `payload` NOT equal to
 * `publishTargetPayload(target)`, or a `variant.mode` not equal to `target.mode`,
 * would present ONE artifact (the card, from `target`) while signing ANOTHER (the
 * bytes, from `payload`) under a mislabelling frame. That is precisely the
 * disagreement R33 forbids, so the sheet must fail CLOSED (block signing) on it
 * rather than emit a mismatched payload. Agreement holds when BOTH the variant
 * framing matches the target's mode AND the signed bytes equal the target's
 * canonical bytes. Pure — no React, no DOM — so the fail-closed decision is guarded
 * by a red-able test rather than only holding by construction in the live caller.
 */
export function publishTargetAgrees(
  target: PublishTarget,
  payload: string,
  variantMode: DestinationMode,
): boolean {
  return variantMode === target.mode && payload === publishTargetPayload(target);
}

/** How many dispositions the target carries, for the sheet's disable/empty state. */
export function targetItemCount(target: PublishTarget): number {
  return target.mode === "own-branch" ? draftBodyCount(target.submission) : target.comments.length;
}

/**
 * The own-branch submission is empty when its composed body is empty (no
 * dispositions), which mirrors an empty comment list on the other side.
 */
function draftBodyCount(submission: PrSubmission): number {
  return submission.body.trim() === "" ? 0 : 1;
}

/** Read the refined-vs-raw split for a set of comments (for the sheet's marker). */
export function refinedCount(comments: readonly ReviewComment[]): number {
  return comments.filter((comment) => comment.refined).length;
}

export type { CollationItem };
