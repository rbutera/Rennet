import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

/**
 * How many per-OID manifests to retain under `map/manifests/` (issue #246). An
 * `advance` ADDS a manifest keyed by its base OID rather than replacing the one
 * before it, so a review pinned to an older OID keeps a readable manifest through a
 * background rehydration instead of being evicted to a `stale` refusal. This bounds
 * the growth: the newest N are kept, older ones are pruned. N is generous because a
 * manifest is a few KB and a review's lifetime spans only a handful of advances; the
 * residual (a review outliving N advances) still fails closed to `stale`, never wrong.
 */
export const MANIFEST_RETENTION = 32;

/** A git OID safe to use as a filename segment (hex only — never a path/separator). */
function isSafeOid(oid: string): boolean {
  return oid.length > 0 && /^[0-9a-fA-F]+$/.test(oid);
}

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
  /** `map/manifest.json` — the CURRENT (latest tip) manifest pointer. */
  readonly manifestPath: string;
  /** `map/manifests/` — per-OID manifests, one `<baseOid>.json` per built tip (#246). */
  readonly manifestsDir: string;
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
      manifestsDir: join(mapDir, "manifests"),
      shardsDir: join(mapDir, "shards"),
      overlaysDir: join(projectDir, "overlays"),
      knowledgeDir: join(projectDir, "knowledge"),
    };
  }

  private manifestPath(repoKey: string): string {
    return this.paths(repoKey).manifestPath;
  }

  /** `map/manifests/<baseOid>.json` — the per-OID manifest for a pinned read (#246). */
  private manifestAtPath(repoKey: string, oid: string): string {
    return join(this.paths(repoKey).manifestsDir, `${oid}.json`);
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
   * Parse + FULLY validate a manifest file at `path`, or null when absent/
   * unreadable/malformed. FAIL-SAFE (Rule 75): a corrupt store degrades to "no
   * snapshot yet" (forcing a clean rebuild), never a throw and never a partial read.
   */
  private readManifestFile(path: string): ProjectSnapshotManifest | null {
    try {
      const raw = readFileSync(path, "utf8");
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

  /**
   * The current stored manifest (the LATEST built tip) for a repo, or null when
   * absent/unreadable/malformed. FAIL-SAFE. This is the "what is newest" accessor —
   * incremental-reuse planning, the advance watcher, overlays and existence checks
   * all want the latest, and it advances on every build exactly as before.
   */
  loadManifest(repoKey: string): ProjectSnapshotManifest | null {
    return this.readManifestFile(this.manifestPath(repoKey));
  }

  /**
   * The manifest for a SPECIFIC base OID (issue #246): reads `map/manifests/<oid>.json`,
   * so a read pinned to an older OID keeps a readable manifest after a background
   * advance published a newer tip — the eviction that used to fail it closed to
   * `stale` is gone because an advance ADDS a per-OID manifest rather than replacing
   * the one before it. Falls back to the current pointer when it happens to match the
   * requested OID (covers the current tip and any snapshot written before per-OID
   * manifests existed). FAIL-SAFE: absent/malformed/unsafe-oid → null, never a throw.
   */
  loadManifestAt(repoKey: string, oid: string): ProjectSnapshotManifest | null {
    if (isSafeOid(oid)) {
      const at = this.readManifestFile(this.manifestAtPath(repoKey, oid));
      if (at) return at;
    }
    const current = this.loadManifest(repoKey);
    return current && current.baseOid === oid ? current : null;
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
   *
   * The manifest is published TWICE (issue #246): to the current pointer
   * `map/manifest.json` (latest tip, unchanged) AND to a per-OID file
   * `map/manifests/<baseOid>.json`. Because shards are content-addressed and never
   * deleted by an advance, a review still pinned to an older base OID keeps a fully
   * readable manifest through a background rehydration — an advance ADDS rather than
   * replaces, so it can no longer evict a pinned read to a `stale` refusal. The
   * per-OID dir is bounded by {@link MANIFEST_RETENTION}.
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
    // Per-OID manifest FIRST (the pinned-read surface), then the current pointer —
    // so a reader that follows the pointer to the new tip always finds the matching
    // per-OID file already on disk. Same canonical bytes to both.
    const baseOid = built.manifest.baseOid;
    if (isSafeOid(baseOid)) {
      const manifestsDir = this.paths(repoKey).manifestsDir;
      mkdirSync(manifestsDir, { recursive: true });
      this.writeAtomic(this.manifestAtPath(repoKey, baseOid), manifestBytes);
    }
    this.writeAtomic(this.manifestPath(repoKey), manifestBytes);
    // Bound the per-OID dir AFTER publishing, protecting the just-written OID (= the
    // current pointer's target) from eviction so a prune failure never blocks a build
    // and the current tip is never pruned out from under its own pointer.
    this.evictOldManifests(repoKey, baseOid);
  }

  /**
   * Prune `map/manifests/` to the newest {@link MANIFEST_RETENTION} files by mtime
   * (issue #246), so per-OID manifests do not grow without bound. FAIL-SAFE: any fs
   * error (a missing dir, a race) is swallowed — pruning is best-effort housekeeping
   * and must never break an advance or a read.
   *
   * ⭐ The CURRENT pointer's own manifest (`keepOid`) is NEVER a prune candidate (#246
   * F1). Sorting by mtime alone let equal-mtime ties (rapid advances under a coarse
   * clock) select the current tip's file for deletion; the current-pointer fallback
   * hid it until one further advance, at which point a review pinned to the just-
   * previous tip went `stale` after a SINGLE advance instead of the advertised window —
   * silently recreating the eviction this fixes. Excluding it by NAME (not by mtime)
   * closes that structurally. The residual is the honest one: a review outliving the
   * retention window of NEWER advances can still have its (non-current) pin pruned and
   * then reads `stale` — never wrong.
   */
  private evictOldManifests(repoKey: string, keepOid: string): void {
    try {
      const manifestsDir = this.paths(repoKey).manifestsDir;
      const keepName = isSafeOid(keepOid) ? `${keepOid}.json` : null;
      const entries = readdirSync(manifestsDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const full = join(manifestsDir, name);
          return { name, full, mtimeMs: statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      // Keep the current tip's file unconditionally, plus the newest of the rest up to
      // the budget; prune whatever remains. Never the current tip, whatever its mtime.
      const keepPresent = keepName !== null && entries.some((e) => e.name === keepName);
      const others = entries.filter((e) => e.name !== keepName);
      const keepOthers = keepPresent ? MANIFEST_RETENTION - 1 : MANIFEST_RETENTION;
      for (const stale of others.slice(Math.max(0, keepOthers))) {
        try {
          unlinkSync(stale.full);
        } catch {
          // A concurrent prune already removed it, or a permission race — skip it.
        }
      }
    } catch {
      // No manifests dir yet, or an unreadable dir — nothing to prune.
    }
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
