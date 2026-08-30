import { forgeForRemoteHost, type GitExec, resolveForgeRemote } from "@rennet/adapters";
import type {
  ForgePrSubmission,
  ForgePrSubmissionOutcome,
  ForgePrSubmissionTarget,
} from "@rennet/core";
import type { ForgeProvider, ForgeRegistry } from "./project-forge-registry";

export interface ResolvedForgePullRequestDestination {
  readonly remoteName: string;
  readonly target: ForgePrSubmissionTarget;
}

export async function resolveForgePullRequestDestination(input: {
  readonly registry: ForgeRegistry<Pick<ForgeProvider, "pullRequest">>;
  readonly git: GitExec;
  readonly repoRoot: string;
}): Promise<ResolvedForgePullRequestDestination | null> {
  const remote = await resolveForgeRemote(input.git, input.repoRoot, {
    supportsForge: (forge) => input.registry.has(forge),
  });
  if (remote === null) return null;

  return {
    remoteName: remote.name,
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
  readonly registry: ForgeRegistry<Pick<ForgeProvider, "pullRequest">>;
  readonly git: GitExec;
  readonly repoRoot: string;
  readonly headRef: string;
  readonly submission: ForgePrSubmission;
  readonly destination: ResolvedForgePullRequestDestination;
}): Promise<ForgePrSubmissionOutcome> {
  const provider = input.registry.sourceFor(input.destination.target.repo);
  if (provider === undefined) {
    throw new Error(
      `No pull-request submitter is registered for forge "${input.destination.target.repo.forge}"`,
    );
  }

  await input.git(input.repoRoot, [
    "push",
    input.destination.remoteName,
    `refs/heads/${input.headRef}:refs/heads/${input.headRef}`,
  ]);
  return provider.pullRequest.submitPullRequest({
    target: input.destination.target,
    submission: input.submission,
  });
}
