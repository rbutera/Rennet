import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "@rennet/protocol";
import type { ContextManifest, ContextSendRecord } from "@rennet/types";
import type { ProjectSnapshotStore } from "./project-snapshot-store";

/**
 * The ContextManifest store (issue #30) persists Rennet's composition manifest
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

function contextTextPath(store: ProjectSnapshotStore, repoKey: string, baseOid: string): string {
  return join(contextManifestsDir(store, repoKey), `${baseOid}.context.txt`);
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
    Array.isArray(m.unmanagedSources) &&
    (m.sends === undefined ||
      (Array.isArray(m.sends) && m.sends.every((record) => isContextSendRecord(record))))
  );
}

function isContextSendRecord(value: unknown): value is ContextSendRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.seat === "string" &&
    typeof record.harness === "string" &&
    (record.channel === "prompt" || record.channel === "system-append") &&
    typeof record.attempt === "number" &&
    typeof record.promptBytes === "number" &&
    typeof record.promptDigest === "string" &&
    typeof record.contextIncluded === "boolean" &&
    (record.contextDigest === undefined || typeof record.contextDigest === "string") &&
    typeof record.sentAt === "string"
  );
}

export class ContextManifestStore {
  constructor(private readonly store: ProjectSnapshotStore) {}

  /** Persist a manifest atomically under `<esc>/context-manifests/<baseOid>.json`. */
  save(repoKey: string, baseOid: string, manifest: ContextManifest): void {
    writeAtomic(manifestPath(this.store, repoKey, baseOid), `${canonicalize(manifest)}\n`);
  }

  saveText(repoKey: string, baseOid: string, text: string): void {
    writeAtomic(contextTextPath(this.store, repoKey, baseOid), text);
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

  loadVerified(
    repoKey: string,
    baseOid: string,
  ): { readonly manifest: ContextManifest; readonly text: string } | null {
    const manifest = this.load(repoKey, baseOid);
    if (!manifest) return null;

    let text: string;
    try {
      text = readFileSync(contextTextPath(this.store, repoKey, baseOid), "utf8");
    } catch {
      return null;
    }
    return sha256Hex(text) === manifest.assembledPromptDigest ? { manifest, text } : null;
  }

  appendSends(repoKey: string, baseOid: string, records: readonly ContextSendRecord[]): void {
    if (records.length === 0) return;
    const manifest = this.load(repoKey, baseOid);
    if (!manifest) return;
    this.save(repoKey, baseOid, {
      ...manifest,
      sends: [...(manifest.sends ?? []), ...records],
    });
  }
}
