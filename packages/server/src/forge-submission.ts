import { forgeForRemoteHost, type GitExec, resolveForgeRemote } from "@rennet/adapters";
import type { ForgePrSubmission, ForgePrSubmissionOutcome } from "@rennet/core";
import type { ForgeProvider, ForgeRegistry } from "./project-forge-registry";

export async function submitForgePullRequest(input: {
  readonly registry: ForgeRegistry<Pick<ForgeProvider, "pullRequest">>;
  readonly git: GitExec;
  readonly repoRoot: string;
  readonly headRef: string;
  readonly submission: ForgePrSubmission;
}): Promise<ForgePrSubmissionOutcome> {
  const remote = await resolveForgeRemote(input.git, input.repoRoot, {
    supportsForge: (forge) => input.registry.has(forge),
  });
  if (remote === null) {
    throw new Error(
      "No supported forge remote is configured for this repository, so there is nowhere to open a pull request.",
    );
  }

  const repository = {
    forge: forgeForRemoteHost(remote.identity.host),
    owner: remote.identity.owner,
    name: remote.identity.name,
  };
  const provider = input.registry.sourceFor(repository);
  if (provider === undefined) {
    throw new Error(`No pull-request submitter is registered for forge "${repository.forge}"`);
  }

  await input.git(input.repoRoot, [
    "push",
    remote.name,
    `refs/heads/${input.headRef}:refs/heads/${input.headRef}`,
  ]);
  return provider.pullRequest.submitPullRequest({
    target: { repo: repository },
    submission: input.submission,
  });
}
