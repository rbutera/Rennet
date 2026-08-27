/**
 * Related-context dossier (#461 §8, B3 task 6.3).
 *
 * One retrieved tracker item, bounded and freshness-stamped, stored durably on
 * the patchset generation (Delta-resident, L1) and inlined verbatim into
 * drafting prompts. Drafters cite items by `id` — which is what makes board
 * citations fall out for free. Retrieval itself is B7's worker; this is the
 * frozen shape.
 */
import { z } from "zod";

export const dossierItemSchema = z.object({
  /** Stable citation key — drafters reference the item by this id. */
  id: z.string().min(1),
  /** The tracker the item came from (e.g. `github`, `jira`, `linear`). */
  tracker: z.string().min(1),
  title: z.string(),
  /** The tracker's own state label, verbatim (e.g. `open`, `In Progress`). */
  state: z.string(),
  /** The BOUNDED body — the retrieval worker truncates before it lands here. */
  body: z.string(),
  /** Acceptance criteria when the tracker item carries them (#461 §7: they sharpen round-report ask verification). */
  acceptanceCriteria: z.string().optional(),
  url: z.string(),
  /** How the item was found (e.g. `branch-name`, `pr-body`, `link-hop`). */
  provenance: z.string().min(1),
  /** Freshness stamp — when the retrieval worker fetched this content. */
  fetchedAt: z.iso.datetime(),
});
export type DossierItem = z.infer<typeof dossierItemSchema>;

/**
 * Deterministic serialization (#461 §8): items sorted by `id`, keys in schema
 * order, no whitespace variance — the same dossier always yields the same
 * bytes, so the stored generation record is byte-reproducible.
 */
export function serializeDossier(items: readonly DossierItem[]): string {
  const ordered = [...items]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => dossierItemSchema.parse(item));
  return JSON.stringify(ordered);
}
