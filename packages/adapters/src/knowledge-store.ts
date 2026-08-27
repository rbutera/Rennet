import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateKnowledgeSet } from "@rennet/core";
import type { KnowledgeSet } from "@rennet/protocol";
import { canonicalize } from "@rennet/protocol";
import type { ProjectSnapshotStore } from "./project-snapshot-store";

/**
 * The LLM knowledge layer store (layer c, #14 knowledge half — design §1/§6).
 *
 * The learned statement set lives LOCAL-FIRST under the project's reserved
 * `knowledge/` home (`~/.rennet/projects/<esc>/knowledge/knowledge.json`), and is
 * PROMOTED (opt-in, default off) into `<repo>/.rennet/knowledge/knowledge.json`
 * alongside the promoted structural map, so collaborators pick it up via git. It
 * rides Track A's promotion/discovery/validation exactly like the map:
 *  - PROMOTE: mirror the local set into the repo on the default branch (validated
 *    BEFORE it is written, so a malformed set is never committed).
 *  - DISCOVER + VALIDATE: a committed set is NEVER trusted blind — it is
 *    structurally validated on discovery and seeded locally only when the local
 *    store has none yet (local wins, §1.4).
 *  - PRECEDENCE: local first, committed fallback.
 *
 * FAIL-SAFE reads (Rule 75): a missing/unreadable/malformed set reads as "no
 * knowledge yet" (an honest absence the reader degrades to), never a throw. And
 * freshness (is the set for the requested base OID?) is NOT decided here — that is
 * `queryKnowledge`'s job, which resolves each statement's anchors against the
 * fresh snapshot and discloses the invalidated ones as pending.
 */

/** The knowledge set filename inside the `knowledge/` dir (local and committed). */
export const KNOWLEDGE_FILE = "knowledge.json";

/** The in-repo, opt-in PROMOTED knowledge location (default branch). */
export function committedKnowledgeDir(repoRoot: string): string {
  return join(repoRoot, ".rennet", "knowledge");
}

/** Read + structurally validate a knowledge set from a file, or null on any problem. */
function readSetFrom(path: string): KnowledgeSet | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return validateKnowledgeSet(parsed) ?? null;
}

/** Atomic write to `path`, creating parent dirs (temp + rename on one filesystem). */
export function writeAtomic(path: string, bytes: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

/** The outcome of a knowledge promotion attempt. */
export interface PromoteKnowledgeResult {
  readonly promoted: boolean;
  /** Why promotion did not happen (no local set, or it failed validation). */
  readonly reason?: "no-local-knowledge" | "invalid-local-knowledge";
  /** The in-repo location written to (when promoted). */
  readonly committedKnowledgeDir?: string;
}

/** The outcome of committed-knowledge discovery. */
export interface DiscoverKnowledgeResult {
  readonly found: boolean;
  readonly valid: boolean;
  readonly seeded: boolean;
}

export class KnowledgeStore {
  constructor(private readonly store: ProjectSnapshotStore) {}

  private localPath(repoKey: string): string {
    return join(this.store.paths(repoKey).knowledgeDir, KNOWLEDGE_FILE);
  }

  /** The local knowledge set for a repo, or null when absent/unreadable/malformed. */
  loadLocal(repoKey: string): KnowledgeSet | null {
    return readSetFrom(this.localPath(repoKey));
  }

  /** Persist a knowledge set atomically under `<esc>/knowledge/knowledge.json`. */
  save(repoKey: string, set: KnowledgeSet): void {
    writeAtomic(this.localPath(repoKey), `${canonicalize(set)}\n`);
  }

  /** The committed knowledge set in a repo, or null when absent/unreadable/malformed. */
  loadCommitted(repoRoot: string): KnowledgeSet | null {
    return readSetFrom(join(committedKnowledgeDir(repoRoot), KNOWLEDGE_FILE));
  }

  /**
   * PROMOTE (opt-in): mirror a repo's LOCAL knowledge set into
   * `<repo>/.rennet/knowledge/`. The local set is validated BEFORE it is written,
   * so promotion never commits a malformed set. Writes files only; it never
   * `git add`/`commit`s — staging is the user's act (design §1.6).
   */
  promote(repoKey: string, repoRoot: string): PromoteKnowledgeResult {
    const raw = this.loadLocalRaw(repoKey);
    if (raw === null) return { promoted: false, reason: "no-local-knowledge" };
    const set = validateKnowledgeSet(raw);
    if (!set) return { promoted: false, reason: "invalid-local-knowledge" };

    const target = committedKnowledgeDir(repoRoot);
    writeAtomic(join(target, KNOWLEDGE_FILE), `${canonicalize(set)}\n`);
    this.store.updateConfig(repoKey, (current) => ({ ...current, promoted: true }));
    return { promoted: true, committedKnowledgeDir: target };
  }

  /**
   * DISCOVER + VALIDATE: if the repo carries a committed knowledge set, validate it
   * and — when valid and the local store has none — SEED the local store from it,
   * re-keyed to THIS checkout's repoKey (the committed set carries the promoter's
   * key). A malformed committed set is reported `found:true, valid:false` and NEVER
   * seeded, so it can never be served.
   */
  discoverCommitted(repoKey: string, repoRoot: string): DiscoverKnowledgeResult {
    const committed = this.loadCommitted(repoRoot);
    if (!committed) {
      // Distinguish "no committed file" from "present but malformed".
      const rawExists = this.rawExists(join(committedKnowledgeDir(repoRoot), KNOWLEDGE_FILE));
      return { found: rawExists, valid: false, seeded: false };
    }
    if (this.loadLocal(repoKey)) return { found: true, valid: true, seeded: false };
    this.save(repoKey, { ...committed, repoKey });
    return { found: true, valid: true, seeded: true };
  }

  /**
   * PRECEDENCE (§1.4): the local set first, then a validated committed set (seeded
   * locally on the way). Decides the SOURCE only; freshness is `queryKnowledge`'s
   * job against the fresh snapshot.
   */
  resolve(repoKey: string, repoRoot: string): KnowledgeSet | null {
    const local = this.loadLocal(repoKey);
    if (local) return local;
    this.discoverCommitted(repoKey, repoRoot);
    return this.loadLocal(repoKey);
  }

  /** The raw parsed local JSON (unvalidated) — used to distinguish absent from malformed. */
  private loadLocalRaw(repoKey: string): unknown {
    try {
      return JSON.parse(readFileSync(this.localPath(repoKey), "utf8"));
    } catch {
      return null;
    }
  }

  private rawExists(path: string): boolean {
    try {
      readFileSync(path, "utf8");
      return true;
    } catch {
      return false;
    }
  }
}
