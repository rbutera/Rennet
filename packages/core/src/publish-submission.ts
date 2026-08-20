/**
 * The own-branch PR submission (issue #257 / #107) — the forge-NEUTRAL half.
 *
 * This is the action Rennet is named for: on a single human sign-click, push the
 * review's own branch and open a real pull request. It is a DIFFERENT verb on the
 * same GitHub egress the review post (`publish-review.ts`) travels — push + create,
 * not comment — so it lives beside that module rather than folding into it.
 *
 *   • The outbound PR is DERIVED from the same canonical `pr-submission` payload the
 *     UI previews (`prSubmissionPayload` in the ui layer). `canonicalPrSubmissionPayload`
 *     here reproduces those bytes, so the MAIN egress boundary can independently
 *     verify "what you see is what leaves" (R33) with a byte-exact round-trip and
 *     refuse on any disagreement — the previewed PR is exactly the one that opens.
 *   • The `head` is a BRANCH ref, never a commit SHA (#107): a GitHub PR cannot open
 *     with a bare SHA as `head`.
 *   • There is NO consent token: pushing your own branch is not publishing
 *     (AGENTS.md), and the sign-click is the whole authorization.
 *
 * Node-free at module scope (like `publish-review.ts`): no `node:*`, so a mobile or
 * third-party client can import it.
 */

/** The forge repo an own-branch PR opens against (owner/name under a forge). */
export interface ForgePrSubmissionTarget {
  readonly repo: { readonly forge: string; readonly owner: string; readonly name: string };
}

/** The PR to open — title/body (with the human's edits)/base/head/draft. */
export interface ForgePrSubmission {
  readonly title: string;
  readonly body: string;
  readonly base: string;
  /** The head BRANCH ref (never a commit SHA, #107). */
  readonly head: string;
  readonly draft: boolean;
}

/** The outcome of an own-branch PR submission. */
export interface ForgePrSubmissionOutcome {
  /** The created (or reused) pull request's web URL. */
  readonly url: string;
  /** The pull request number. */
  readonly number: number;
  /** True when an open PR from this head already existed and was reused (idempotent). */
  readonly reused: boolean;
}

/**
 * The canonical outbound bytes for a PR submission — reproduced here so the MAIN
 * egress boundary can verify them independently of the renderer.
 *
 * ⚠️ These bytes MUST stay byte-identical to the ui layer's `prSubmissionPayload`
 * (`packages/app-ui/src/canvas/publish.ts`): same `kind`, same field order. The two are
 * separate copies across a layer boundary (ui cannot be imported by core), so a
 * change to one must change the other. The failure direction is SAFE — a drift makes
 * the round-trip check refuse a legitimate submission (fail closed), it never lets a
 * mismatched payload through — and the coupling is pinned by an exact-bytes test.
 */
export function canonicalPrSubmissionPayload(submission: ForgePrSubmission): string {
  return JSON.stringify({
    kind: "pr-submission",
    title: submission.title,
    body: submission.body,
    base: submission.base,
    head: submission.head,
    draft: submission.draft,
  });
}

/**
 * The forge-neutral own-branch submission port. Separate from the read-only
 * `ForgePort` and the review-egress `ForgePublishPort`: opening a PR is its own
 * capability, handed only to the component that composes the sign → push → create
 * action. The push itself is a host-side git operation the composer performs before
 * calling this; this port owns only the forge's create-PR verb.
 */
export interface ForgePrSubmissionPort {
  /**
   * Open a pull request for `submission` against `target`. Idempotent by head branch:
   * an open PR from the same head is reused (reused: true) rather than opening a
   * second, so a retry after a dropped outcome — or a double sign — yields exactly one
   * PR.
   */
  submitPullRequest(input: {
    target: ForgePrSubmissionTarget;
    submission: ForgePrSubmission;
  }): Promise<ForgePrSubmissionOutcome>;
}
