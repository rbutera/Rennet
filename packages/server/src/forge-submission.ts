import { forgeForRemoteHost, type GitExec, resolveForgeRemote } from "@rennet/adapters";
import type {
  ForgePrSubmission,
  ForgePrSubmissionOutcome,
  ForgePrSubmissionPort,
  ForgePrSubmissionTarget,
} from "@rennet/core";
import type { ForgeRegistry } from "./project-forge-registry";

/** Resolve the submitter in the repository's execution locus before mutating git. */
export type ForgePrSubmissionResolver = (
  repoRoot: string,
) => ForgePrSubmissionPort | Promise<ForgePrSubmissionPort>;

export interface ResolvedForgePullRequestDestination {
  readonly remoteName: string;
  readonly target: ForgePrSubmissionTarget;
  /**
   * Every remote configured in this clone (`git remote`), read while the destination was
   * being resolved because that is the only place on the publish path holding a git handle
   * for the repository's locus. It exists for `forgeBaseBranch` below: a patchset's
   * `baseRef` can be a remote-tracking spelling, and only the repository knows which
   * leading segment is a remote name rather than the first part of a branch name.
   */
  readonly remotes: readonly string[];
}

/**
 * The branch name a forge will accept as a pull request's base, from a patchset's
 * recorded `baseRef`.
 *
 * A local capture records the spelling it measured against, which may be a
 * remote-tracking ref (`origin/main`). A forge only knows its own branches: GitHub
 * answers 422 for `base: "origin/main"` and GitLab the same for `target_branch`. Strip
 * one leading `<remote>/` when `<remote>` is a remote of this repository — and only
 * then, so a genuine branch called `origin/thing` in a clone with no remote named
 * `origin` survives intact. Longest remote name first, so nested spellings resolve the
 * same way twice. The one shape this cannot tell apart is a branch whose own first
 * segment is also a remote's name (`release/1.2` beside a remote called `release`);
 * git warns about that ambiguity itself, and a read at this seam would not settle it.
 */
export function forgeBaseBranch(baseRef: string, remotes: readonly string[]): string {
  const byLength = [...remotes].sort((left, right) => right.length - left.length);
  for (const remote of byLength) {
    const prefix = `${remote}/`;
    if (remote.length > 0 && baseRef.startsWith(prefix) && baseRef.length > prefix.length) {
      return baseRef.slice(prefix.length);
    }
  }
  return baseRef;
}

export async function resolveForgePullRequestDestination(input: {
  readonly registry: ForgeRegistry<ForgePrSubmissionResolver>;
  readonly git: GitExec;
  readonly repoRoot: string;
}): Promise<ResolvedForgePullRequestDestination | null> {
  const remote = await resolveForgeRemote(input.git, input.repoRoot, {
    supportsForge: (forge) => input.registry.has(forge),
  });
  if (remote === null) return null;

  const remotes = (await input.git(input.repoRoot, ["remote"], { reject: false }))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return {
    remoteName: remote.name,
    remotes: remotes.includes(remote.name) ? remotes : [...remotes, remote.name],
    target: {
      repo: {
        forge: forgeForRemoteHost(remote.identity.host),
        owner: remote.identity.owner,
        name: remote.identity.name,
      },
    },
  };
}

export async function submitForgePullRequest(input: {
  readonly registry: ForgeRegistry<ForgePrSubmissionResolver>;
  readonly git: GitExec;
  readonly repoRoot: string;
  /** The branch the pull request is ABOUT — its head on the remote, and its name there. */
  readonly headRef: string;
  /**
   * The branch the work is ON (workspace-settings D4). Under `share` — and for every
   * session written before the setting existed — it is `headRef`, and the refspec below is
   * byte-identical to the one this function has always pushed. Under `own` beside a
   * checkout that already had the branch out it is the sibling `rennet/<headRef>`, so the
   * push sends the sibling's commits to the reviewed branch's NAME on the remote and the
   * reviewer's local branch does not move.
   */
  readonly workBranch?: string;
  readonly submission: ForgePrSubmission;
  readonly destination: ResolvedForgePullRequestDestination;
}): Promise<ForgePrSubmissionOutcome> {
  const resolveSubmitter = input.registry.sourceFor(input.destination.target.repo);
  if (resolveSubmitter === undefined) {
    throw new Error(
      `No pull-request submitter is registered for forge "${input.destination.target.repo.forge}"`,
    );
  }

  const submitter = await resolveSubmitter(input.repoRoot);
  const source = input.workBranch ?? input.headRef;
  await input.git(input.repoRoot, [
    "push",
    input.destination.remoteName,
    `refs/heads/${source}:refs/heads/${input.headRef}`,
  ]);
  return submitter.submitPullRequest({
    target: input.destination.target,
    submission: input.submission,
  });
}
