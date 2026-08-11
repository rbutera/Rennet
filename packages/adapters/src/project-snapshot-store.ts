import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "@rennet/protocol";
import type {
  BuiltSnapshot,
  ProjectSnapshotManifest,
  ReferenceShard,
  SymbolShard,
} from "@rennet/types";

/**
 * The app-owned, LOCAL-FIRST ProjectSnapshot store (R27/R55, #141).
 *
 * The derived snapshot lives under `~/.rennet/projects/<escaped-absolute-path>/`,
 * keyed by the repo's escaped top-level PATH (the RepoRecord `repoKey` =
 * `escapePath(realpath(git-top-level))`, design §1.1). Path-keying replaces
 * wave-1's `sha256Hex(realpath(git-common-dir))`: each checkout PATH — including a
 * worktree on a branch — now gets its OWN local-first entry ("yours, freshest,
 * especially on a branch"), instead of all worktrees sharing one. The base
 * directory is injected (the desktop app passes `~/.rennet/projects`, or
 * `snapshotStoreFor()` supplies that default); tests pass a temp dir.
 *
 * Per-project layout (design §1.1):
 *
 *   <baseDir>/<escaped-path>/
 *     config.json                       ← promotion + relocation + aliases + visibility
 *     map/                              ← the default-branch BASE map (manifest.json + shards/)
 *     overlays/<non-default-base-oid>/  ← per-non-default-base overlays  (LATER WAVE)
 *     knowledge/                        ← learned statements               (LATER WAVE)
 *
 * THIS wave populates `config.json` + `map/`. `overlays/` and `knowledge/` are
 * part of the resolved-path interface ({@link ProjectPaths}) so later waves have a
 * fixed home, but nothing writes them yet.
 *
 * ⛔ This is NOT the in-repo `.rennet/map/` path — that is the OPT-IN PROMOTED
 * mirror (default off), written on the default branch by `promoteMap` and
 * discovered/validated by `discoverCommittedMap` (see `map-travel.ts`). The local
 * store here is always authoritative; the committed mirror is a shared fallback.
 *
 * Shards are content-addressed (`map/shards/<digest>.json`), so a write is
 * idempotent and safe to repeat. The manifest is advanced ATOMICALLY: all shards
 * are written first, then the manifest is written to a temp file and `rename`d
 * over `map/manifest.json` (atomic on a single filesystem). If the process dies
 * mid-write the old manifest still points at its own complete shards, so a reader
 * never sees a half-built snapshot.
 */

/** The current project-config schema version. Bumped on a breaking config shape change. */
export const PROJECT_CONFIG_VERSION = 1;

/** How visible the derived map is to git (design §1.6 / R14). */
export type ProjectVisibility = "local" | "git-visible";

/**
 * Per-project config, stored at `<escaped-path>/config.json`. Every field beyond
 * `version` is OPTIONAL so a project that has only ever built a local map has a
 * trivially-valid (or absent) config; defaults are read-through, never migrated.
 */
export interface ProjectConfig {
  /** Config schema version. */
  readonly version: number;
  /**
   * The canonical absolute top-level path this project was keyed from (BEFORE
   * escaping). Recorded so `relocate`/aliases can disambiguate the lossy escaped
   * segment back to a real path.
   */
  readonly path?: string;
  /**
   * Opt-in promotion state (A.3): when true, the base map is MIRRORED into
   * `<repo>/.rennet/map/` on the default branch so collaborators pick it up via
   * git. Default OFF — a project never writes into the repo unless promoted.
   */
  readonly promoted?: boolean;
  /** Alternative escaped paths that resolve to THIS project (A.6, aliases). */
  readonly aliases?: readonly string[];
  /** The escaped path this project was relocated FROM, if any (A.6). */
  readonly relocatedFrom?: string;
  /** Visibility of the derived map to git (A.2). Absent ⇒ `local`. */
  readonly visibility?: ProjectVisibility;
}

/**
 * Fully validate a parsed value as a {@link ProjectConfig}: `version` must be a
 * number, and every OPTIONAL field, WHEN PRESENT, must hold its declared type —
 * in particular `visibility` must be one of the two enum members, so a garbage
 * `visibility: "bogus"` is rejected as malformed rather than flowing on as a value.
 */
function isValidProjectConfig(value: unknown): value is ProjectConfig {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "number") return false;
  if (record.path !== undefined && typeof record.path !== "string") return false;
  if (record.promoted !== undefined && typeof record.promoted !== "boolean") return false;
  if (record.relocatedFrom !== undefined && typeof record.relocatedFrom !== "string") return false;
  if (
    record.aliases !== undefined &&
    (!Array.isArray(record.aliases) || record.aliases.some((a) => typeof a !== "string"))
  ) {
    return false;
  }
  if (
    record.visibility !== undefined &&
    record.visibility !== "local" &&
    record.visibility !== "git-visible"
  ) {
    return false;
  }
  return true;
}

/** The resolved on-disk paths for one project's local store entry. */
export interface ProjectPaths {
  /** `<baseDir>/<escaped-path>/` — the project root in the local store. */
  readonly projectDir: string;
  /** `config.json`. */
  readonly configPath: string;
  /** `map/` — the default-branch BASE map dir (manifest.json + shards/). */
  readonly mapDir: string;
  /** `map/manifest.json`. */
  readonly manifestPath: string;
  /** `map/shards/`. */
  readonly shardsDir: string;
  /** `overlays/` — per-non-default-base overlays (LATER WAVE; dir home reserved). */
  readonly overlaysDir: string;
  /** `knowledge/` — learned statements (LATER WAVE; dir home reserved). */
  readonly knowledgeDir: string;
}

export class ProjectSnapshotStore {
  constructor(private readonly baseDir: string) {}

  /** Monotonic suffix for temp files, so concurrent writes never collide. */
  private tmpSeq = 0;

  /**
   * The resolved on-disk paths for a project. `repoKey` is ALREADY the escaped,
   * filesystem-safe segment (`escapePath(...)`), so it is used directly as the
   * directory name — no hashing, so the store is human-legible and `relocate`
   * (§1.5) can rename a directory rather than re-key an opaque hash.
   */
  paths(repoKey: string): ProjectPaths {
    const projectDir = join(this.baseDir, repoKey);
    const mapDir = join(projectDir, "map");
    return {
      projectDir,
      configPath: join(projectDir, "config.json"),
      mapDir,
      manifestPath: join(mapDir, "manifest.json"),
      shardsDir: join(mapDir, "shards"),
      overlaysDir: join(projectDir, "overlays"),
      knowledgeDir: join(projectDir, "knowledge"),
    };
  }

  private manifestPath(repoKey: string): string {
    return this.paths(repoKey).manifestPath;
  }

  private shardPath(repoKey: string, digest: string): string {
    return join(this.paths(repoKey).shardsDir, `${digest}.json`);
  }

  // NOTE (#3, deferred): a single composed fail-closed `loadCurrent(repoKey,
  // requestedBaseOid)` gate — one call that loads the manifest, checks freshness
  // (`isSnapshotFresh`) AND integrity (`verifySnapshotIntegrity` over the store's
  // shard loader) before handing any snapshot to a consumer — lives in
  // `ProjectContextReader.loadFresh` (the first real consumer). The pieces here
  // (`loadManifest`, `loadShard`) are the fail-safe primitives it composes.

  /**
   * The current stored manifest for a repo, or null when absent/unreadable/
   * malformed. FAIL-SAFE (Rule 75): a corrupt store degrades to "no snapshot
   * yet" (forcing a clean rebuild), never a throw and never a partial read.
   */
  loadManifest(repoKey: string): ProjectSnapshotManifest | null {
    try {
      const raw = readFileSync(this.manifestPath(repoKey), "utf8");
      const parsed = JSON.parse(raw) as ProjectSnapshotManifest;
      // A manifest that parses as JSON but is malformed in `shards` (missing/null/
      // non-object) or `symbols` (non-array) must degrade to "no snapshot" here,
      // NOT slip through to throw later: the downstream gate does
      // `Object.keys(manifest.shards)` and `for (…of manifest.symbols)`, which
      // throw on null/non-iterable. Validating the full read shape keeps
      // loadManifest's contract literal — "malformed → null, never a throw"
      // (Rule 75, fail-safe on the vital "never serve/never crash on a corrupt
      // store" circuit).
      if (
        !parsed ||
        typeof parsed.baseOid !== "string" ||
        typeof parsed.fingerprint !== "string" ||
        typeof parsed.shards !== "object" ||
        parsed.shards === null ||
        !Array.isArray(parsed.symbols) ||
        // v2: `references` is a required manifest field. A manifest lacking it (a v1
        // snapshot on disk, or a malformed write) degrades to "no snapshot" HERE, so
        // the freshness gate re-derives rather than serving without the reference
        // dimension — and the downstream integrity/materialize never sees a
        // reference-less v2 manifest from the store.
        !Array.isArray(parsed.references)
      ) {
        return null;
      }
      // Deep-validate the INNER shapes too, not just the top-level containers.
      // The downstream gate does `manifest.shards[slot].digest` and destructures
      // `for (const [, digest] of manifest.symbols)` — both THROW on a null shard
      // value or a non-iterable symbol entry (e.g. `shards.files = null`,
      // `symbols: [null]`), shapes the container-only check above still admits.
      // A store that produced such a manifest is corrupt; degrade to "no
      // snapshot" HERE so the contract stays literal ("malformed → null, never a
      // throw", Rule 75) instead of throwing inside a later "never a throw" gate.
      for (const ref of Object.values(parsed.shards)) {
        if (
          !ref ||
          typeof ref !== "object" ||
          typeof (ref as { digest?: unknown }).digest !== "string"
        ) {
          return null;
        }
      }
      for (const entry of parsed.symbols) {
        if (!Array.isArray(entry) || entry.length < 2 || typeof entry[1] !== "string") {
          return null;
        }
      }
      // Same deep-validation for the reference-shard pointers (v2).
      for (const entry of parsed.references) {
        if (!Array.isArray(entry) || entry.length < 2 || typeof entry[1] !== "string") {
          return null;
        }
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** Load a shard's bytes by digest, or undefined if absent/unreadable. */
  loadShard(repoKey: string, digest: string): string | undefined {
    try {
      return readFileSync(this.shardPath(repoKey, digest), "utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * The per-file symbol shards a stored manifest references, parsed back into
   * {@link SymbolShard}s for incremental-reuse planning. A shard that is missing
   * or malformed is skipped (it will simply be re-extracted).
   */
  loadSymbolShards(manifest: ProjectSnapshotManifest): SymbolShard[] {
    const shards: SymbolShard[] = [];
    for (const [, digest] of manifest.symbols) {
      const bytes = this.loadShard(manifest.repoKey, digest);
      if (bytes === undefined) continue;
      // Integrity: only reuse a shard whose bytes actually hash to its digest.
      if (sha256Hex(bytes) !== digest) continue;
      try {
        const parsed = JSON.parse(bytes) as SymbolShard;
        if (parsed && typeof parsed.blobOid === "string" && Array.isArray(parsed.symbols)) {
          shards.push(parsed);
        }
      } catch {
        // skip malformed
      }
    }
    return shards;
  }

  /**
   * The per-file REFERENCE shards a stored manifest references, parsed back into
   * {@link ReferenceShard}s for incremental-reuse planning (#200). A shard that is
   * missing or malformed is skipped (it will simply be re-extracted). The exact
   * analogue of {@link loadSymbolShards}. `manifest.references` is coerced to `[]`
   * defensively so a manifest that somehow lacks it never throws here.
   */
  loadReferenceShards(manifest: ProjectSnapshotManifest): ReferenceShard[] {
    const shards: ReferenceShard[] = [];
    for (const [, digest] of manifest.references ?? []) {
      const bytes = this.loadShard(manifest.repoKey, digest);
      if (bytes === undefined) continue;
      if (sha256Hex(bytes) !== digest) continue;
      try {
        const parsed = JSON.parse(bytes) as ReferenceShard;
        if (parsed && typeof parsed.blobOid === "string" && Array.isArray(parsed.references)) {
          shards.push(parsed);
        }
      } catch {
        // skip malformed
      }
    }
    return shards;
  }

  /**
   * Advance the stored snapshot to `built`, atomically. Every referenced shard
   * is written first (content-addressed), then the manifest is written to a temp
   * file and renamed over the live `map/manifest.json`. The old snapshot is fully
   * readable until the final rename.
   */
  advance(built: BuiltSnapshot): void {
    const repoKey = built.manifest.repoKey;
    const shardsDir = this.paths(repoKey).shardsDir;
    mkdirSync(shardsDir, { recursive: true });

    for (const [digest, bytes] of built.shards) {
      const path = join(shardsDir, `${digest}.json`);
      // A pre-existing content-addressed shard is trustworthy ONLY if its
      // on-disk bytes actually hash back to the digest. `existsSync` alone is not
      // enough: an earlier non-atomic write truncated by a crash leaves a file
      // that EXISTS but is corrupt, and publishing a fresh manifest that points
      // at it would serve a truncated shard (#2). So verify the bytes, and
      // (re)write the known-good bytes on any absence or mismatch. The write is
      // atomic (temp + rename in the same dir), so a crash mid-rewrite cannot
      // itself leave a truncated shard behind.
      if (!this.shardIsIntact(path, digest)) this.writeAtomic(path, bytes);
    }

    // Canonical bytes (sorted keys, LF) so the stored manifest is itself
    // byte-reproducible for a given OID, matching the shard bytes.
    const manifestBytes = `${canonicalize(built.manifest)}\n`;
    this.writeAtomic(this.manifestPath(repoKey), manifestBytes);
  }

  // ── config.json (A.1 config read/write; the promotion/visibility state) ──────

  /**
   * The stored project config, or null when absent/unreadable/malformed. FAIL-SAFE
   * (Rule 75): a corrupt config reads as "no config" (all defaults) rather than
   * throwing — a project always has a usable, default-off config.
   */
  loadConfig(repoKey: string): ProjectConfig | null {
    const state = this.loadConfigState(repoKey);
    return state.status === "ok" ? state.config : null;
  }

  /**
   * The DISTINCT on-disk config state, FULLY validated (not just `version`), so a
   * caller can tell an absent config (safe to write) from a malformed one — an
   * unparseable file OR a well-formed one carrying an invalid field, e.g.
   * `visibility: "bogus"`. A malformed config must NOT be overwritten (Rule 75) and
   * must NOT leak an invalid value into a resolver, so this is the reader the
   * settings surface uses. `loadConfig`/`loadConfigOrDefault` keep their fail-safe
   * "absent-or-default" contract for the map read paths by folding on `ok`.
   */
  loadConfigState(
    repoKey: string,
  ): { status: "absent" | "malformed"; config: null } | { status: "ok"; config: ProjectConfig } {
    let raw: string;
    try {
      raw = readFileSync(this.paths(repoKey).configPath, "utf8");
    } catch {
      return { status: "absent", config: null };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "malformed", config: null };
    }
    if (!isValidProjectConfig(parsed)) return { status: "malformed", config: null };
    return { status: "ok", config: parsed };
  }

  /** The stored config, or a fresh default when none exists yet. */
  loadConfigOrDefault(repoKey: string): ProjectConfig {
    return this.loadConfig(repoKey) ?? { version: PROJECT_CONFIG_VERSION };
  }

  /** Persist the project config atomically under `<escaped-path>/config.json`. */
  saveConfig(repoKey: string, config: ProjectConfig): void {
    const { projectDir, configPath } = this.paths(repoKey);
    mkdirSync(projectDir, { recursive: true });
    this.writeAtomic(configPath, `${canonicalize(config)}\n`);
  }

  /**
   * Read-modify-write a project's config atomically. The updater receives the
   * current config (an absent config folds to a fresh default) and returns the
   * next one. Returns the written config for the caller to act on.
   *
   * REFUSES (throws) when the on-disk config is MALFORMED (Rule 75): read-modify-
   * write over a default would silently discard the unparseable bytes, so the file
   * is left byte-for-byte untouched and the caller gets a thrown error. The guard
   * lives HERE, at the adapter, so EVERY writer (promotion, the visibility switch)
   * is protected — not only the settings composition that happens to check first.
   */
  updateConfig(repoKey: string, update: (current: ProjectConfig) => ProjectConfig): ProjectConfig {
    const state = this.loadConfigState(repoKey);
    if (state.status === "malformed") {
      throw new Error(
        `refusing to overwrite a malformed project config at ${this.paths(repoKey).configPath}; fix or remove it first`,
      );
    }
    const next = update(state.config ?? { version: PROJECT_CONFIG_VERSION });
    this.saveConfig(repoKey, next);
    return next;
  }

  /** Whether an on-disk shard file exists AND its bytes hash back to `digest`. */
  private shardIsIntact(path: string, digest: string): boolean {
    try {
      return sha256Hex(readFileSync(path, "utf8")) === digest;
    } catch {
      return false;
    }
  }

  /**
   * Write `bytes` to `path` atomically: to a sibling temp file, then `rename`
   * over the target (atomic on a single filesystem). A reader never sees a
   * partial file, and a crash mid-write leaves the target untouched. Ensures the
   * parent dir exists first, so a config/manifest write to a fresh project works.
   */
  private writeAtomic(path: string, bytes: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${this.tmpSeq++}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  }
}

/**
 * The default local-store base directory: `~/.rennet/projects/` (design §1.1).
 * The desktop app injects this; tests pass a temp dir instead.
 */
export function defaultProjectsBaseDir(): string {
  return join(homedir(), ".rennet", "projects");
}

/**
 * Compose the app's local-first ProjectSnapshot store. `baseDir` defaults to
 * `~/.rennet/projects/`; a caller (the desktop app, a test) may override it.
 */
export function snapshotStoreFor(baseDir: string = defaultProjectsBaseDir()): ProjectSnapshotStore {
  return new ProjectSnapshotStore(baseDir);
}
