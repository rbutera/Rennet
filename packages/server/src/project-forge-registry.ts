import type { ForgePort, ForgePrSubmissionPort, ForgePublishPort } from "@rennet/core";
import {
  type ForgeRepoIdentity,
  forgeRepositorySlug,
  type Project,
  sameForgeRepository,
} from "@rennet/protocol";

export interface ForgeRegistry<T> {
  has(forge: string): boolean;
  sourceFor(repository: ForgeRepoIdentity): T | undefined;
}

export interface ForgeRegistration<T> {
  readonly forge: string;
  readonly implementation: T;
}

export function createForgeRegistry<T>(
  registrations: readonly ForgeRegistration<T>[],
): ForgeRegistry<T> {
  const byForge = new Map<string, T>(
    registrations.map(({ forge, implementation }) => [forge, implementation] as const),
  );
  return {
    has: (forge) => byForge.has(forge),
    sourceFor: (repository) => byForge.get(repository.forge),
  };
}

export interface ForgeProvider extends Pick<ForgePort, "fetchCiStatus"> {
  readonly review: ForgePublishPort;
  readonly pullRequest: ForgePrSubmissionPort;
}

export async function fetchForgeCiStatus(
  registry: ForgeRegistry<Pick<ForgeProvider, "fetchCiStatus">>,
  ...[ref, headOid, signal]: Parameters<ForgeProvider["fetchCiStatus"]>
): ReturnType<ForgeProvider["fetchCiStatus"]> {
  const source = registry.sourceFor(ref.repo);
  if (source === undefined) {
    throw new Error(`No CI status source is registered for forge "${ref.repo.forge}"`);
  }
  return source.fetchCiStatus(ref, headOid, signal);
}

export interface RepositoryIdentity {
  readonly repository?: string;
  readonly forgeRepository?: ForgeRepoIdentity;
}

/** Structured identity decides when both sides know it. Missing structure falls back to the
 * legacy owner/name comparison, where absence remains silence rather than a contradiction. */
export function repositoryIdentityAgrees(
  left: RepositoryIdentity,
  right: RepositoryIdentity,
): boolean {
  if (left.forgeRepository !== undefined && right.forgeRepository !== undefined) {
    return sameForgeRepository(left.forgeRepository, right.forgeRepository);
  }
  const leftRepository =
    left.repository ??
    (left.forgeRepository === undefined ? undefined : forgeRepositorySlug(left.forgeRepository));
  const rightRepository =
    right.repository ??
    (right.forgeRepository === undefined ? undefined : forgeRepositorySlug(right.forgeRepository));
  return (
    leftRepository === undefined ||
    rightRepository === undefined ||
    leftRepository === rightRepository
  );
}

export async function resolveProjectRepositoryRoot(input: {
  readonly project: Project | undefined;
  readonly target: RepositoryIdentity;
  readonly identityForRoot: (root: string) => Promise<RepositoryIdentity>;
}): Promise<string | undefined> {
  if (
    input.project === undefined ||
    (input.target.repository === undefined && input.target.forgeRepository === undefined)
  ) {
    return undefined;
  }
  const roots = [
    ...new Set([
      ...(input.project.includedRepoPaths ?? []),
      input.project.openPath,
      input.project.path,
    ]),
  ].filter((root) => root.length > 0);
  for (const root of roots) {
    if (repositoryIdentityAgrees(await input.identityForRoot(root), input.target)) return root;
  }
  return undefined;
}

export interface ProjectPullRequestOpenInput {
  readonly commandId: string;
  readonly repository: ForgeRepoIdentity;
  readonly number: number;
  readonly repoPath: string | undefined;
  readonly retrospective: boolean;
}

export type ProjectPullRequestOpener<TResult> = (
  input: ProjectPullRequestOpenInput,
) => Promise<TResult>;

export async function openProjectPullRequest<TResult>(
  registry: ForgeRegistry<ProjectPullRequestOpener<TResult>>,
  input: ProjectPullRequestOpenInput,
): Promise<TResult> {
  const opener = registry.sourceFor(input.repository);
  if (opener === undefined) {
    throw new Error(`No pull-request opener is registered for forge "${input.repository.forge}"`);
  }
  return opener(input);
}
