// The kickoff state machine (issue #382 M2, task 5.1, wireframe 20). Starting a review from the
// phone: a pasted/shared PR link → `review.openPr`, or an own-branch → `review.capture`, both
// streaming progress and landing the new review in the list. Pure and framework-free (URL
// parsing, repo matching, and the state transitions unit-test without React); the screen wires
// the invocation + `onProgress` on top.
//
// The phone never holds a host path: `review.openPr` / `review.capture` take `repoPath`, which the
// daemon's projection resolves from a `repoKey` the projected `projects.list` handed the phone
// (the established M1 pattern — the inbound repoKey→path map). So kickoff addresses a repo by its
// projected key, never a host path.

/** A projected repo reference as `projects.list` delivers it to the phone (no host path). */
export interface ProjectedRepoRef {
  readonly repoKey: string;
  readonly displayName: string;
  readonly relativePath?: string;
}

/** A projected project row the kickoff screen offers as an own-branch capture target. */
export interface KickoffProject {
  readonly id: string;
  readonly name: string;
  /** The reviewable repo reference (the projected `openPath`). */
  readonly repo: ProjectedRepoRef;
  readonly primaryBranch: string;
}

/** A parsed PR reference — enough to pass through as `ref` and to match a known repo. */
export interface ParsedPrRef {
  /** The exact ref to hand `review.openPr` (`owner/repo#N` or the original URL). */
  readonly ref: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/**
 * Parse a PR reference: a GitHub PR URL (`https://github.com/owner/repo/pull/123`) or the short
 * form `owner/repo#123`. Returns null for anything that is not a PR ref (the field then stays
 * disabled rather than starting a review on garbage). `review.openPr` accepts both forms, so the
 * original trimmed input is passed through as `ref`.
 */
export function parsePrRef(input: string): ParsedPrRef | null {
  const trimmed = input.trim();
  const url = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i.exec(trimmed);
  if (url) {
    return {
      ref: trimmed,
      owner: url[1] as string,
      repo: url[2] as string,
      number: Number(url[3]),
    };
  }
  const short = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/.exec(trimmed);
  if (short) {
    return {
      ref: trimmed,
      owner: short[1] as string,
      repo: short[2] as string,
      number: Number(short[3]),
    };
  }
  return null;
}

/**
 * Match a parsed PR ref to a known project's repo key, so `review.openPr` addresses the right local
 * clone. Repo matching PREFERS an exact `owner/repo` match (#382 M2 finding 9): a bare repo-name
 * match is used ONLY when it is unique, so two paired projects sharing a repo name (a fork and its
 * upstream, `me/rennet` and `you/rennet`) can never route a PR to the wrong clone. Returns undefined
 * when nothing matches exactly and the bare name is absent or ambiguous — the screen then says so
 * honestly rather than opening the PR against a guessed clone.
 */
export function matchProjectRepoKey(
  projects: readonly KickoffProject[],
  parsed: ParsedPrRef,
): string | undefined {
  const ownerRepo = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  // 1) Exact `owner/repo` — unambiguous, always wins.
  const exact = projects.find(
    (p) => p.repo.displayName.toLowerCase() === ownerRepo || p.name.toLowerCase() === ownerRepo,
  );
  if (exact) return exact.repo.repoKey;
  // 2) Bare repo name — only when EXACTLY ONE project matches (else it is ambiguous, so refuse).
  const wanted = parsed.repo.toLowerCase();
  const byName = projects.filter(
    (p) => p.repo.displayName.toLowerCase() === wanted || p.name.toLowerCase() === wanted,
  );
  return byName.length === 1 ? byName[0]?.repo.repoKey : undefined;
}

/** The kickoff lifecycle the screen renders (wireframe 20 progress → the new review appears). */
export type KickoffState =
  | { readonly status: "idle" }
  | { readonly status: "starting"; readonly kind: "pr" | "capture"; readonly note?: string }
  | { readonly status: "started"; readonly reviewId: string }
  | { readonly status: "failed"; readonly reason: string };

export type KickoffAction =
  | { readonly type: "start"; readonly kind: "pr" | "capture" }
  | { readonly type: "progress"; readonly note: string }
  | { readonly type: "started"; readonly reviewId: string }
  | { readonly type: "failed"; readonly reason: string }
  | { readonly type: "reset" };

/** Fold a kickoff action. Truthful: a failure surfaces its reason; progress notes ride `starting`. */
export function kickoffReducer(state: KickoffState, action: KickoffAction): KickoffState {
  switch (action.type) {
    case "start":
      return { status: "starting", kind: action.kind };
    case "progress":
      return state.status === "starting" ? { ...state, note: action.note } : state;
    case "started":
      return { status: "started", reviewId: action.reviewId };
    case "failed":
      return { status: "failed", reason: action.reason };
    case "reset":
      return { status: "idle" };
  }
}

export const initialKickoff: KickoffState = { status: "idle" };
