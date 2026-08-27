/**
 * The durable dossier store (#461 point 5, B7 reconciliation 5).
 *
 * The related-context dossier and its RAW payloads (full comment threads,
 * linked tickets — the depth behind the context tool, never in the dossier)
 * persist under the knowledge-store home pattern as ONE envelope:
 *
 *   `~/.rennet/projects/<esc>/dossier/<escaped target@patchset-ref>/record.json`
 *
 * keyed by review target + patchset ref. The envelope's `dossier` field holds
 * the CANONICAL `serializeDossier` bytes verbatim — the same dossier always
 * writes the same bytes, so the stored record is byte-reproducible — and the
 * single `writeAtomic` publish means dossier and raw payloads land together or
 * not at all (a crash cannot leave a dossier whose raw depth is missing).
 *
 * B8 GENERATION-ATTACH SEAM: #461 stores the dossier "durably on the patchset
 * generation, re-run per round under append-then-freeze". Generation lifecycle
 * is B8/B9's; when the round runner lands it attaches this store's key
 * (`target` + `patchsetRef`) to the generation record and re-runs retrieval per
 * round — this store is the durable home either way, and B8 re-keys nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { escapePath } from "@rennet/core";
import type { DossierItem } from "@rennet/protocol";
import { dossierItemSchema, serializeDossier } from "@rennet/protocol";
import { z } from "zod";
import { writeAtomic } from "./knowledge-store";
import type { ProjectSnapshotStore } from "./project-snapshot-store";
import type { RawContextPayload } from "./related-context";

/** The store key: one review target at one patchset ref. */
export interface DossierKey {
  /** The review target (e.g. `pr-123`, a branch name — the caller's stable id). */
  readonly target: string;
  /** The patchset ref the retrieval ran against. */
  readonly patchsetRef: string;
}

/** Persisted state crosses a trust boundary on the way back in: parse, never cast. */
const rawPayloadSchema = z.object({
  id: z.string(),
  tracker: z.string(),
  payload: z.unknown(),
});
const recordSchema = z.object({
  /** The canonical `serializeDossier` bytes, verbatim. */
  dossier: z.string(),
  raw: z.array(rawPayloadSchema),
});

export class DossierStore {
  constructor(private readonly store: ProjectSnapshotStore) {}

  private recordPath(repoKey: string, key: DossierKey): string {
    const segment = escapePath(`${key.target}@${key.patchsetRef}`);
    return join(this.store.paths(repoKey).projectDir, "dossier", segment, "record.json");
  }

  /** Persist dossier (canonical bytes) + raw payloads in ONE atomic publish. */
  save(
    repoKey: string,
    key: DossierKey,
    items: readonly DossierItem[],
    raw: readonly RawContextPayload[],
  ): void {
    writeAtomic(
      this.recordPath(repoKey, key),
      `${JSON.stringify({ dossier: serializeDossier(items), raw })}\n`,
    );
  }

  private record(repoKey: string, key: DossierKey): z.infer<typeof recordSchema> | null {
    try {
      const parsed = recordSchema.safeParse(
        JSON.parse(readFileSync(this.recordPath(repoKey, key), "utf8")),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * The stored dossier, or null when absent/unreadable/malformed (fail-safe
   * read, knowledge-store precedent — an honest absence, never a throw).
   */
  load(repoKey: string, key: DossierKey): DossierItem[] | null {
    const record = this.record(repoKey, key);
    if (!record) return null;
    try {
      const items: unknown = JSON.parse(record.dossier);
      if (!Array.isArray(items)) return null;
      return items.map((item) => dossierItemSchema.parse(item));
    } catch {
      return null;
    }
  }

  /**
   * The raw payloads read seam — what the existing context-tool surface serves
   * for depth on demand (reconciliation 6: no new command-registry row here;
   * B10 owns dispatch binding). Null on absence/corruption, same fail-safe rule.
   */
  loadRaw(repoKey: string, key: DossierKey): RawContextPayload[] | null {
    return this.record(repoKey, key)?.raw ?? null;
  }
}
