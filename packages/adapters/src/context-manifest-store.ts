import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "@rennet/protocol";
import type { ContextManifest } from "@rennet/types";
import type { ProjectSnapshotStore } from "./project-snapshot-store";

/**
 * The ContextManifest store (issue #30) — persists the "what was sent" manifest
 * LOCAL-FIRST under the R55 project entry (`~/.rennet/projects/<esc>/
 * context-manifests/<baseOid>.json`), so it RELOADS across restart rather than
 * being recomputed from scratch every open. Keyed by the review's pinned base OID,
 * because that (with the deterministic assembly) is what the manifest is a function
 * of — a different patchset base gets its own entry.
 *
 * FAIL-SAFE reads (Rule 75): a missing/unreadable/malformed manifest reads as an
 * honest absence (`null`), never a throw and never a fabricated stand-in — the
 * panel's job is to show the real manifest OR honest absence, never invented
 * content (Rule Zero: a lie in the UI is a bug).
 */

/** The manifest directory inside the project entry. */
function contextManifestsDir(store: ProjectSnapshotStore, repoKey: string): string {
  return join(store.paths(repoKey).projectDir, "context-manifests");
}

/** The manifest file for one base OID. */
function manifestPath(store: ProjectSnapshotStore, repoKey: string, baseOid: string): string {
  return join(contextManifestsDir(store, repoKey), `${baseOid}.json`);
}

/** Atomic write to `path`, creating parent dirs (temp + rename on one filesystem). */
function writeAtomic(path: string, bytes: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

/** A minimal structural guard so a malformed persisted manifest reads as absence, never served. */
function isContextManifest(value: unknown): value is ContextManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.repoRecordId === "string" &&
    typeof m.projectSnapshotId === "string" &&
    typeof m.assembledPromptDigest === "string" &&
    typeof m.totalBytes === "number" &&
    typeof m.exhaustive === "boolean" &&
    Array.isArray(m.documents) &&
    Array.isArray(m.members) &&
    Array.isArray(m.unmanagedSources)
  );
}

export class ContextManifestStore {
  constructor(private readonly store: ProjectSnapshotStore) {}

  /** Persist a manifest atomically under `<esc>/context-manifests/<baseOid>.json`. */
  save(repoKey: string, baseOid: string, manifest: ContextManifest): void {
    writeAtomic(manifestPath(this.store, repoKey, baseOid), `${canonicalize(manifest)}\n`);
  }

  /** The persisted manifest for a base OID, or null when absent/unreadable/malformed. */
  load(repoKey: string, baseOid: string): ContextManifest | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath(this.store, repoKey, baseOid), "utf8"));
    } catch {
      return null;
    }
    return isContextManifest(parsed) ? parsed : null;
  }
}
