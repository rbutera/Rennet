import { z } from "zod";

/** A forge repository's provider-qualified identity. It is never a host path. */
export const forgeRepoIdentitySchema = z.object({
  forge: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
});
export type ForgeRepoIdentity = z.infer<typeof forgeRepoIdentitySchema>;

/** The legacy/display spelling carried beside a structured forge identity. */
export function forgeRepositorySlug(repository: ForgeRepoIdentity): string {
  return `${repository.owner}/${repository.name}`;
}

/** Exact provider-qualified equality. Case folding belongs at the forge boundary. */
export function sameForgeRepository(left: ForgeRepoIdentity, right: ForgeRepoIdentity): boolean {
  return left.forge === right.forge && left.owner === right.owner && left.name === right.name;
}

/**
 * A structured identity and its legacy `owner/name` companion may not contradict each other.
 * Either field may be absent on persisted records written before the structured identity existed.
 */
export function forgeRepositoryMatchesLegacy(
  repository: string | undefined,
  forgeRepository: ForgeRepoIdentity | undefined,
): boolean {
  return forgeRepository === undefined || repository === undefined
    ? true
    : repository === forgeRepositorySlug(forgeRepository);
}
