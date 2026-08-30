import { type ForgeRepoIdentity, sameForgeRepository } from "@rennet/protocol";

export interface RepositoryIdentity {
  readonly repository?: string;
  readonly forgeRepository?: ForgeRepoIdentity;
}

/**
 * Compare repository identities without breaking sessions persisted before the structured
 * field existed. Two structured identities decide exactly; otherwise the legacy repository
 * strings exclude only on a positive contradiction.
 */
export function repositoryIdentitiesAgree(
  left: RepositoryIdentity,
  right: RepositoryIdentity,
): boolean {
  if (left.forgeRepository !== undefined && right.forgeRepository !== undefined) {
    return sameForgeRepository(left.forgeRepository, right.forgeRepository);
  }
  return (
    left.repository === undefined ||
    right.repository === undefined ||
    left.repository === right.repository
  );
}
