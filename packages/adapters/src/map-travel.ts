import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeFingerprint, unfingerprinted, verifySnapshotIntegrity } from "@rennet/core";
import type { BuiltSnapshot, ProjectSnapshotManifest } from "@rennet/protocol";
import { canonicalize } from "@rennet/protocol";
import type { ProjectSnapshotStore } from "./project-snapshot-store";

/**
 * Map TRAVEL: how a derived Repo Map reaches a machine other than the one that
 * built it (#141 / R55, design §1.3-§1.4). Three moves, all deterministic and
 * model-free:
 *
 *   - PROMOTE (A.3, opt-in, default off): mirror the local BASE map into
 *     `<repo>/.rennet/map/` on the default branch, so collaborators pick it up
 *     through normal git. Committing content-addressed derived data carries
 *     churn/bloat cost — which is exactly why it is opt-in.
 *   - DISCOVER + VALIDATE (A.4): a committed map is NEVER trusted blind. On
 *     discovery every shard is re-verified to hash to its digest and the
 *     manifest's own fingerprint is re-checked; a map that fails is IGNORED in
 *     favour of a local build, never served.
 *   - PRECEDENCE (A.5): resolve LOCAL first, then a validated COMMITTED map, then
 *     "build". Local wins even on a branch (it is yours, freshest). A committed
 *     map pertains to the repo it physically lives in — no forge identity, no
 *     alias matching (that problem is dissolved by path-keying).
 *
 * Freshness (is the map at the requested base OID?) is NOT decided here — that is
 * `ProjectContextReader.loadFresh`'s fail-closed job. Precedence only decides
 * WHICH source seeds the local store before the reader/generator runs.
 */

/** The in-repo, opt-in PROMOTED map location (default branch). */
export function committedMapDir(repoRoot: string): string {
  return join(repoRoot, ".rennet", "map");
}

/**
 * Read a full {@link BuiltSnapshot} (manifest + every referenced shard's bytes)
 * from a `map/` directory laid out as `manifest.json` + `shards/<digest>.json`.
 * FAIL-SAFE: any missing/unreadable/malformed manifest or shard yields null (the
 * caller then treats the map as absent and builds locally), never a throw.
 */
export function readMapFromDir(mapDir: string): BuiltSnapshot | null {
  let manifest: ProjectSnapshotManifest;
  try {
    manifest = JSON.parse(readFileSync(join(mapDir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
  if (
    !manifest ||
    typeof manifest.fingerprint !== "string" ||
    typeof manifest.shards !== "object" ||
    manifest.shards === null ||
    !Array.isArray(manifest.symbols) ||
    !Array.isArray(manifest.references) ||
    !Array.isArray(manifest.imports)
  ) {
    return null;
  }

  // Every digest the manifest references: structural shards + per-file symbol shards
  // + per-file reference shards (#200) + per-file import shards. Missing any of these
  // is a shard the integrity gate would flag, so they MUST be enumerated here or a
  // valid committed map would fail validation for want of a shard family's bytes.
  const digests = new Set<string>();
  for (const ref of Object.values(manifest.shards)) {
    if (!ref || typeof (ref as { digest?: unknown }).digest !== "string") return null;
    digests.add((ref as { digest: string }).digest);
  }
  for (const entry of [...manifest.symbols, ...manifest.references, ...manifest.imports]) {
    if (!Array.isArray(entry) || typeof entry[1] !== "string") return null;
    digests.add(entry[1]);
  }

  const shards = new Map<string, string>();
  for (const digest of digests) {
    try {
      shards.set(digest, readFileSync(join(mapDir, "shards", `${digest}.json`), "utf8"));
    } catch {
      return null; // a referenced shard is missing → the whole map is unusable.
    }
  }
  return { manifest, shards };
}

/**
 * Validate a map's INTEGRITY + FINGERPRINT (A.4): every referenced shard is
 * present and hashes back to its digest, and the manifest's own fingerprint
 * recomputes. This is the "never trust a committed map blind" gate.
 */
export function validateMap(built: BuiltSnapshot): boolean {
  return verifySnapshotIntegrity(built.manifest, (digest) => built.shards.get(digest)).ok;
}

/** Atomic write to `path`, creating parent dirs (temp + rename on one filesystem). */
function writeAtomic(path: string, bytes: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

/** Write a {@link BuiltSnapshot} into a `map/` directory (manifest + shards). */
function writeMapToDir(mapDir: string, built: BuiltSnapshot): void {
  for (const [digest, bytes] of built.shards) {
    writeAtomic(join(mapDir, "shards", `${digest}.json`), bytes);
  }
  writeAtomic(join(mapDir, "manifest.json"), `${canonicalize(built.manifest)}\n`);
}

/** The outcome of a promotion attempt. */
export interface PromoteResult {
  readonly promoted: boolean;
  /** Why promotion did not happen (no local map, or the local map failed validation). */
  readonly reason?: "no-local-map" | "invalid-local-map";
  /** The in-repo location the map was written to (when promoted). */
  readonly committedMapDir?: string;
}

/**
 * PROMOTE (A.3): mirror a repo's LOCAL base map into `<repo>/.rennet/map/` and
 * record `promoted: true` in `config.json`. Opt-in and explicit — nothing calls
 * this on the build path. The local map is validated BEFORE it is written into
 * the repo, so promotion never commits a corrupt map. Writes files only; it never
 * `git add`/`commit`s — staging is the user's act (design §1.6 / A.2).
 */
export function promoteMap(
  store: ProjectSnapshotStore,
  repoKey: string,
  repoRoot: string,
): PromoteResult {
  const built = readMapFromDir(store.paths(repoKey).mapDir);
  if (!built) return { promoted: false, reason: "no-local-map" };
  if (!validateMap(built)) return { promoted: false, reason: "invalid-local-map" };

  const target = committedMapDir(repoRoot);
  writeMapToDir(target, built);
  store.updateConfig(repoKey, (current) => ({ ...current, promoted: true }));
  return { promoted: true, committedMapDir: target };
}

/** The outcome of committed-map discovery. */
export interface DiscoverResult {
  /** A committed map exists at `<repo>/.rennet/map/`. */
  readonly found: boolean;
  /** It passed integrity + fingerprint validation. */
  readonly valid: boolean;
  /** It was seeded into the local store (valid + not already present locally). */
  readonly seeded: boolean;
}

/**
 * DISCOVER + VALIDATE (A.4): if the repo carries a committed map, validate it and
 * — when valid and the local store has nothing yet — SEED the local store from it
 * (via `store.advance`, which re-verifies before it publishes). A corrupt or
 * mismatched committed map is reported `found:true, valid:false, seeded:false`
 * and NEVER seeded, so it can never be served to a review.
 */
export function discoverCommittedMap(
  store: ProjectSnapshotStore,
  repoKey: string,
  repoRoot: string,
): DiscoverResult {
  const mapDir = committedMapDir(repoRoot);
  const built = readMapFromDir(mapDir);
  if (!built) {
    // `found` answers "does this repo carry a committed map?", which is a question
    // about the FILE, not about whether this build can read it. A map written by an
    // older schema (no `imports` family, say) is present and unusable — reporting it
    // `found:false` would say the repo carries no map at all, which is a lie the
    // operator cannot act on. Present-but-unreadable is `found:true, valid:false`,
    // the same answer a corrupt one gets, and it is never seeded either way.
    return { found: existsSync(join(mapDir, "manifest.json")), valid: false, seeded: false };
  }
  if (!validateMap(built)) return { found: true, valid: false, seeded: false };

  // Don't clobber a local map the user already has (local wins, §1.4). Seed only
  // when the local store is empty.
  if (store.loadManifest(repoKey)) return { found: true, valid: true, seeded: false };

  // The committed manifest carries the PROMOTER's `repoKey`, and `repoKey` is part
  // of the fingerprint pin (#4), so seeding verbatim would leave a manifest whose
  // `repoKey`-keyed store dir (THIS checkout) disagrees with its own identity and,
  // worse, whose fingerprint no longer self-verifies once served. Re-key to THIS
  // checkout and RECOMPUTE the fingerprint over the localized pin — which yields
  // EXACTLY what a clean local build of the same tree at this path would produce
  // (identical shards, same baseOid/baseRef, this repoKey). `store.advance` keys
  // on `manifest.repoKey`, so the re-keyed manifest lands under this checkout's dir.
  const rekeyed = { ...unfingerprinted(built.manifest), repoKey };
  const localManifest: ProjectSnapshotManifest = {
    ...rekeyed,
    fingerprint: computeFingerprint(rekeyed),
  };
  store.advance({ manifest: localManifest, shards: built.shards });
  return { found: true, valid: true, seeded: true };
}

/** Where a resolved map came from (design §1.4 precedence). */
export type MapSource = "local" | "committed" | "build";

/** The precedence resolution: which source is authoritative, and whether it seeded. */
export interface ResolvedMapSource {
  readonly source: MapSource;
  /** True when a committed map was validated and seeded into the local store. */
  readonly seeded: boolean;
}

/**
 * PRECEDENCE (A.5): local `~/.rennet/projects/<esc>/map` first, then a validated
 * committed `<repo>/.rennet/map`, then "build". Local wins even on a non-default
 * branch. When only a committed map exists and it validates, it is seeded locally
 * and reported as `committed`; otherwise the caller builds. This decides the
 * SOURCE, never freshness — the reader still gates every read at the requested OID.
 */
export function resolveMapSource(
  store: ProjectSnapshotStore,
  repoKey: string,
  repoRoot: string,
): ResolvedMapSource {
  if (store.loadManifest(repoKey)) return { source: "local", seeded: false };
  const discovered = discoverCommittedMap(store, repoKey, repoRoot);
  if (discovered.seeded) return { source: "committed", seeded: true };
  return { source: "build", seeded: false };
}
