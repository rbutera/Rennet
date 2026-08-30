import {
  type ForgeRepoIdentity,
  forgeRepositorySlug,
  type Project,
  sameForgeRepository,
} from "@rennet/protocol";

export interface ProjectForgeRegistry<T> {
  sourceFor(repository: ForgeRepoIdentity): T | undefined;
}

export interface ProjectForgeRegistration<T> {
  readonly forge: string;
  readonly implementation: T;
}

export function createProjectForgeRegistry<T>(
  registrations: readonly ProjectForgeRegistration<T>[],
): ProjectForgeRegistry<T> {
  const byForge = new Map<string, T>(
    registrations.map(({ forge, implementation }) => [forge, implementation] as const),
  );
  return { sourceFor: (repository) => byForge.get(repository.forge) };
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
  registry: ProjectForgeRegistry<ProjectPullRequestOpener<TResult>>,
  input: ProjectPullRequestOpenInput,
): Promise<TResult> {
  const opener = registry.sourceFor(input.repository);
  if (opener === undefined) {
    throw new Error(`No pull-request opener is registered for forge "${input.repository.forge}"`);
  }
  return opener(input);
}
