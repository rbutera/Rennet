import type { CommandOutput, Review } from "@rennet/protocol";
import type { RennetState, StagedAsk } from "../store";
import { type ProposedVerdict, parseLineAnchor, partitionAsksByAnchor } from "./selectors";

// ─────────────────────────────────────────────────────────────────────────────
// The hand-off resolution seam (C08 cluster 1, Reconciliation 1/3) — the SINGLE point
// that resolves (a) a review's ENTRY MODE and (b) the LIVING-DRAFT SOURCE the lanes
// render. Mirrors C3's `sidebar-data.ts`, C4's `citations.ts`, C5's `board-data.ts`:
// no mode or draft shape is invented at a call site; every hand-off path goes through here.
//
// THE GATED SWAP (cluster 8): the living-draft source is composed from the store's staged
// asks TODAY. When B11's continuously-redrafted durable composition projection lands (and
// the registered `publish.compose` read), THIS is the only file that changes — the lanes
// keep reading `selectLivingDraft`. That is the seam's whole reason to exist.
// ─────────────────────────────────────────────────────────────────────────────

/** The hand-off entry mode a review dispatches on (Objective clause 3). */
export type EntryMode = "teammate-pr" | "own-branch" | "retrospective";

/**
 * Resolve the entry mode from a review (Reconciliation 1), keyed on the two branch-state
 * facts the `Review` carries: `retrospective` (read-only, no post) and `postTarget`
 * (present exactly when the review can post to a real PR — a teammate's PR to review).
 * A non-retrospective review with no post-target is your own branch: you dispatch rounds
 * and open the PR yourself. A retrospective review offers NO exits.
 *
 * `postTarget` + `retrospective` are the only branch-state signals on the snapshot today;
 * this resolver is the one place to refine the split (e.g. an own already-open PR) when an
 * ownership signal is added — no call site re-derives the mode.
 */
export function resolveEntryMode(review: Pick<Review, "retrospective" | "postTarget">): EntryMode {
  if (review.retrospective) return "retrospective";
  return review.postTarget ? "teammate-pr" : "own-branch";
}

/** Whether a mode offers any exit at all — retrospective reviews do not (law 10). */
export const modeHasExits = (mode: EntryMode): boolean => mode !== "retrospective";

/** One line comment in the living draft — its ask, resolved to its `path:line`. */
export interface LineComment {
  readonly path: string;
  readonly line: number;
  readonly ask: StagedAsk;
}

/** Line comments sharing a file path — GitHub's line-comment stratum, grouped (R40). */
export interface LineCommentGroup {
  readonly path: string;
  readonly comments: readonly LineComment[];
}

/**
 * The living-draft source: the ordered review-body asks and the line comments grouped by
 * file path, in GitHub's two-strata shape. This is the STRUCTURE a lane renders — the
 * opener block, intent tags, provenance lines and `RichText` are the lane's presentation;
 * the seam owns which asks are body, which are line comments, and their file grouping.
 */
export interface LivingDraft {
  readonly body: readonly StagedAsk[];
  readonly lineGroups: readonly LineCommentGroup[];
}

/**
 * Compose the living draft from the store's staged asks (the review's own acts) — the
 * cluster-1 source. Body asks keep their staged order; line comments group by file path,
 * each group in first-seen order. The `publish.compose` read and B11's durable projection
 * are the swap this function absorbs (cluster 8); every lane reads THIS, never the store
 * directly, so the swap touches this file alone.
 */
export const composeLivingDraft = (asks: Readonly<Record<string, StagedAsk>>): LivingDraft => {
  const { body, line } = partitionAsksByAnchor(asks);
  const byPath = new Map<string, LineComment[]>();
  for (const ask of line) {
    const parsed = parseLineAnchor(ask.anchor);
    if (!parsed) continue; // partitionAsksByAnchor already proved the parse; guard for types
    const group = byPath.get(parsed.path) ?? [];
    group.push({ path: parsed.path, line: parsed.line, ask });
    byPath.set(parsed.path, group);
  }
  const lineGroups: LineCommentGroup[] = [...byPath.entries()].map(([path, comments]) => ({
    path,
    comments,
  }));
  return { body, lineGroups };
};

/**
 * Compose the living draft off the store's staged asks. A surface subscribing to the stable
 * `stagedAsks` map memoizes `composeLivingDraft` over it directly; this selector is the
 * whole-state reader for non-render call sites. Both share the one composition.
 */
export const selectLivingDraft = (s: RennetState): LivingDraft =>
  composeLivingDraft(s.review.stagedAsks);

// ─────────────────────────────────────────────────────────────────────────────
// The COMPOSED review draft (C08 cluster 6, exact-preview contract — architecture-contracts.md
// "Posting to GitHub", R33). `composeLivingDraft` above is the reviewer's local WORKING set
// (staged asks); the outbound review is not those bytes — the daemon's `publish.compose` is the
// single-source authority the post round-trips (the client cannot forge bytes the compositionId
// would reject). So the Post Review lane previews THIS — the daemon's composed comments — and
// posts exactly them. The reviewer "sees the exact outbound GitHub payload before the external
// mutation"; the renderer never constructs a different body after preview.
// ─────────────────────────────────────────────────────────────────────────────

/** One composed review comment (the byte-exact `publish.compose(mode:"review")` shape). */
export type ReviewComment = Extract<
  CommandOutput<"publish.compose">,
  { status: "review" }
>["comments"][number];

/** A composed line comment resolved to its `path:line`. */
export interface ComposedLineComment {
  readonly path: string;
  readonly line: number;
  readonly comment: ReviewComment;
}

/** Composed line comments sharing a file path (GitHub's line-comment stratum). */
export interface ComposedLineGroup {
  readonly path: string;
  readonly comments: readonly ComposedLineComment[];
}

/**
 * The composed outbound review the lane PREVIEWS and POSTS — byte-exact with what
 * `publish.review` receives. `body` is the comments with no line (the review body stratum);
 * `lineGroups` are the line-anchored comments grouped by file path; `verdict` is the daemon's
 * derived proposal (still flippable at the control — the event is a separate post arg);
 * `arithmetic` is the `N request changes · M comments` tally over the composed comments.
 */
export interface ReviewDraft {
  readonly body: readonly ReviewComment[];
  readonly lineGroups: readonly ComposedLineGroup[];
  readonly verdict: ProposedVerdict;
  readonly arithmetic: { readonly requestChanges: number; readonly comments: number };
  readonly destination: string;
}

/**
 * Split the daemon's composed comments into GitHub's two strata (body vs file-grouped line
 * comments), preserving compose order. A comment with a `line` is a line comment; one without
 * is a review-body note. The lane renders THIS and posts the same composition — no re-derivation.
 */
export function composeReviewDraft(
  composed: Extract<CommandOutput<"publish.compose">, { status: "review" }>,
): ReviewDraft {
  const body: ReviewComment[] = [];
  const byPath = new Map<string, ComposedLineComment[]>();
  let requestChanges = 0;
  for (const comment of composed.comments) {
    if (comment.type === "request-change") requestChanges += 1;
    if (comment.line === undefined) {
      body.push(comment);
      continue;
    }
    const group = byPath.get(comment.path) ?? [];
    group.push({ path: comment.path, line: comment.line, comment });
    byPath.set(comment.path, group);
  }
  const lineGroups: ComposedLineGroup[] = [...byPath.entries()].map(([path, comments]) => ({
    path,
    comments,
  }));
  return {
    body,
    lineGroups,
    verdict: composed.verdict,
    arithmetic: { requestChanges, comments: composed.comments.length - requestChanges },
    destination: composed.destination,
  };
}

/**
 * The span-rework seam (Objective clause 4) — the SINGLE point selection-steer Revise reaches.
 * Cluster 8 binds it to B11/B9's real span-rework command (exactly as `selectLivingDraft` is the
 * living-draft-source swap); until they land the affordance renders (task 4.3) and execution is
 * deliberately gated. No call site reworks a span itself — every Revise routes through here.
 */
export function reviseDraftSpan(span: string, instruction: string): void {
  // ponytail: gated boundary — the real rework command lands in cluster 8 (B11/B9). Wiring it
  // here (and nowhere else) is the seam's whole reason to exist; not a hollow pass of a
  // completable task — a genuinely blocked one, left un-wired on purpose. The args are named
  // so cluster 8's binding is a body swap, not a signature change.
  void span;
  void instruction;
}
