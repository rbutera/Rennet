import type { CommandOutput, Review } from "@rennet/protocol";
import { type RennetState, type StagedAsk, stagedAskCodePosition } from "../store";
import { type ProposedVerdict, partitionAsksByAnchor } from "./selectors";

// ─────────────────────────────────────────────────────────────────────────────
// The hand-off resolution seam (C08 cluster 1, Reconciliation 1/3) — the SINGLE point
// that resolves (a) a review's ENTRY MODE and (b) the LIVING-DRAFT SOURCE the lanes
// render. Mirrors C3's `sidebar-data.ts`, C4's `citations.ts`, C5's `board-data.ts`:
// no mode or draft shape is invented at a call site; every hand-off path goes through here.
//
// THE SWAP (cluster 8) is still OUTSTANDING: the living-draft source is composed from the
// store's staged asks, in-memory, so it does not survive a reload. B11 landed its durable
// half — the ask log and `publish.compose` are registered and served — but nothing here
// reads them yet. When it does, THIS is the only file that changes; the lanes keep reading
// `selectLivingDraft`. That is the seam's whole reason to exist. The span-rework half of
// the swap IS done: `reviseDraftSpan` below fires the served `review.reviseSpan`.
// ─────────────────────────────────────────────────────────────────────────────

/** The hand-off entry mode a review dispatches on (Objective clause 3). */
export type EntryMode = "teammate-pr" | "own-branch" | "retrospective";

/**
 * Resolve the entry mode from a review (Reconciliation 1), keyed on the branch-state facts
 * the `Review` carries: `retrospective` (read-only, no post), `postTarget` (present when the
 * review has a real PR to post to), and the post-target's `viewerDidAuthor` ownership fact.
 *
 * A retrospective review offers NO exits. A review with no post-target is your own branch.
 * A review WITH a post-target splits on ownership: your OWN pull request routes the own-branch
 * lane (Continue / rounds + work orders), a TEAMMATE'S routes Post-review (the review concludes
 * under your name). When the ownership fact is absent — a legacy snapshot, or an honestly
 * unknown author — the split stays teammate-PR rather than claiming an ownership it cannot prove.
 *
 * This is the ONE place the mode is derived — no call site re-derives it.
 */
export function resolveEntryMode(review: Pick<Review, "retrospective" | "postTarget">): EntryMode {
  if (review.retrospective) return "retrospective";
  if (!review.postTarget) return "own-branch";
  // An own already-open PR is still your own branch — rounds keep going and work orders are
  // own-branch-only; it must never be routed down the teammate Post-review lane (C14 §6).
  return review.postTarget.viewerDidAuthor ? "own-branch" : "teammate-pr";
}

/** Whether a mode offers any exit at all — retrospective reviews do not (law 10). */
export const modeHasExits = (mode: EntryMode): boolean => mode !== "retrospective";

/** One line comment in the living draft — its ask, resolved to its `path:line`. */
export interface LineComment {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
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
    const position = stagedAskCodePosition(ask);
    if (!position) continue; // partitionAsksByAnchor already proved this; guard for types
    const group = byPath.get(position.path) ?? [];
    group.push({ ...position, ask });
    byPath.set(position.path, group);
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

/** One composed review-body note, including stable identity and visible source provenance. */
export type ReviewBodyNote = NonNullable<
  Extract<CommandOutput<"publish.compose">, { status: "review" }>["bodyNotes"]
>[number];

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
 * `publish.review` receives. `bodyNotes` are asks with no trustworthy diff position; `body` is
 * the file-level composed comments with no line; `lineGroups` are the line-anchored comments
 * grouped by file path; `arithmetic` is the `N request changes · M comments` tally over the
 * composed comments.
 *
 * `verdict` is the composed event — the daemon's derived proposal, or the durable override when
 * one is set. It is the ONE verdict: the daemon folds it into the composition binding, so this is
 * exactly what posts (a different event would be refused as a stale composition). `proposed` is
 * the verdict the composed comments derive to on their own, so the control can say "overridden —
 * proposed X" and offer the revert; flipping the verdict writes the durable override and
 * recomposes, it never travels as a separate post argument.
 */
export interface ReviewDraft {
  readonly bodyNotes: readonly ReviewBodyNote[];
  readonly body: readonly ReviewComment[];
  readonly lineGroups: readonly ComposedLineGroup[];
  readonly verdict: ProposedVerdict;
  readonly proposed: ProposedVerdict;
  readonly arithmetic: { readonly requestChanges: number; readonly comments: number };
  readonly destination: string;
}

/**
 * Carry the daemon's body notes and split its composed comments into file-level vs file-grouped
 * line comments, preserving compose order. The lane renders THIS and posts the same composition —
 * no re-derivation.
 */
export function composeReviewDraft(
  composed: Extract<CommandOutput<"publish.compose">, { status: "review" }>,
): ReviewDraft {
  const body: ReviewComment[] = [];
  const byPath = new Map<string, ComposedLineComment[]>();
  for (const comment of composed.comments) {
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
  // The same derivation core runs (`deriveReviewEvent`) over the same set the daemon uses —
  // BOTH strata, comments AND body notes: a request-change wins, else an approval, else a
  // neutral comment. Mirrored here (app-ui cannot import core) so the control names what the
  // composition actually proposes when the durable override differs. Deriving over the line
  // comments alone would claim "overridden — proposed comment" for a pathless request-change
  // ask, with a revert button that reverts to nothing — a lie about the reviewer's own verdict.
  const bodyNotes = composed.bodyNotes ?? [];
  const outbound = [...composed.comments, ...bodyNotes];
  const requestChanges = outbound.filter((comment) => comment.type === "request-change").length;
  const proposed: ProposedVerdict = outbound.some((c) => c.type === "request-change")
    ? "REQUEST_CHANGES"
    : outbound.some((c) => c.type === "approve")
      ? "APPROVE"
      : "COMMENT";
  return {
    bodyNotes,
    body,
    lineGroups,
    verdict: composed.verdict,
    proposed,
    arithmetic: { requestChanges, comments: outbound.length - requestChanges },
    destination: composed.destination,
  };
}

/**
 * Fire B11's registered `review.reviseSpan` for one staged ask. Bound in `exits.ts` over
 * `useMutation` (no surface calls `bridge.invoke`) and threaded to the lanes as a prop, exactly
 * like the `publish.*` egresses. Absent ⇒ no rework is wired to that mount.
 */
export type ReviseSpan = (args: {
  askId: string;
  span: string;
  instruction: string;
}) => Promise<CommandOutput<"review.reviseSpan">>;

/**
 * The span-rework seam (Objective clause 4) — the SINGLE point selection-steer Revise reaches.
 * Now bound to B11's real command: the daemon's one-shot worker reworks the ask's body, splices
 * the refined span back in place (CAS-guarded against a concurrent edit) and lands it on the
 * durable ask log; this stages the returned body so the lane shows the rework it actually got.
 *
 * Resolves the honest reason the rework did NOT land (`no-change` / `unavailable` / a thrown
 * bridge failure), or `undefined` when it did — never a silent success. No call site reworks a
 * span itself; every Revise routes through here.
 *
 * `land` receives the ask with its reworked body. It is the LANE's job because a lane may render
 * the ask through a shadow the store's `stagedAsks` does not own (the post-review lane's inline
 * `draftEdits`): landing only the ask there would leave a stale shadow on screen while the panel
 * closed as success — a fabricated success. Every lane's `land` must make the rework VISIBLE.
 */
export async function reviseDraftSpan(
  revise: ReviseSpan,
  land: (ask: StagedAsk) => void,
  ask: StagedAsk,
  span: string,
  instruction: string,
): Promise<string | undefined> {
  let result: CommandOutput<"review.reviseSpan">;
  try {
    result = await revise({ askId: ask.id, span, instruction });
  } catch (reason) {
    return reason instanceof Error ? reason.message : "The rework did not run.";
  }
  if (result.status !== "reworked") return result.reason;
  // A body swap in place, under the ask's own id — exactly like a hand edit (receipt-is-undo
  // lives on the daemon's ask log, which already recorded the inverse of this write).
  land({ ...ask, body: result.reworkedBody });
  return undefined;
}
