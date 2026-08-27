/**
 * The durable dossier store (#461 point 5, B7 reconciliation 5).
 *
 * The related-context dossier and its RAW payloads (full comment threads,
 * linked tickets — the depth behind the context tool, never in the dossier)
 * persist under the knowledge-store home pattern:
 *
 *   `~/.rennet/projects/<esc>/dossier/<escaped target@patchset-ref>/dossier.json`
 *   `~/.rennet/projects/<esc>/dossier/<escaped target@patchset-ref>/raw.json`
 *
 * keyed by review target + patchset ref. `dossier.json` holds the CANONICAL
 * `serializeDossier` bytes — the same dossier always writes the same bytes, so
 * the stored record is byte-reproducible.
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

export class DossierStore {
  constructor(private readonly store: ProjectSnapshotStore) {}

  private dir(repoKey: string, key: DossierKey): string {
    const segment = escapePath(`${key.target}@${key.patchsetRef}`);
    return join(this.store.paths(repoKey).projectDir, "dossier", segment);
  }

  /** Persist dossier (canonical `serializeDossier` bytes) + raw payloads atomically. */
  save(
    repoKey: string,
    key: DossierKey,
    items: readonly DossierItem[],
    raw: readonly RawContextPayload[],
  ): void {
    const dir = this.dir(repoKey, key);
    writeAtomic(join(dir, "dossier.json"), `${serializeDossier(items)}\n`);
    writeAtomic(join(dir, "raw.json"), `${JSON.stringify(raw)}\n`);
  }

  /**
   * The stored dossier, or null when absent/unreadable/malformed (fail-safe
   * read, knowledge-store precedent — an honest absence, never a throw).
   */
  load(repoKey: string, key: DossierKey): DossierItem[] | null {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(this.dir(repoKey, key), "dossier.json"), "utf8"),
      );
      if (!Array.isArray(parsed)) return null;
      return parsed.map((item) => dossierItemSchema.parse(item));
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
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(this.dir(repoKey, key), "raw.json"), "utf8"),
      );
      return Array.isArray(parsed) ? (parsed as RawContextPayload[]) : null;
    } catch {
      return null;
    }
  }
}
