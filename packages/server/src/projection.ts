// The R19 recipient-specific projection (issue #380). A frame-boundary codec: it
// maps between the PRIVATE contract (host-absolute paths, what a loopback client
// sees) and the PUBLIC projection (repo references, what a token-bearing REMOTE
// client sees). It is NOT a fork of dispatch — dispatch, the stores, and the
// private contract are untouched. The listener calls it only for `projected`
// connections; loopback connections never touch this module.
//
// Outbound (server→remote): structural host-path fields become `repoReference`
// objects (`{repoKey, displayName, relativePath?}`); then a blanket scrub replaces
// known-root and home-dir prefixes in every remaining string with a display token.
// Model-authored ask-stream prose and successful signed `publish.compose` aggregates are NEVER
// scrubbed: they are intentional content whose exact bytes the client reads and acts on.
//
// Inbound (remote→server): a command's host-path input arrives as a `repoKey` (or a
// repo reference) and is resolved back to the host path via the connection's root
// table. An unresolvable reference is a typed `invalid_input`, never a guessed path.

import { realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { escapePath } from "@rennet/core";
import type { CommandName, ProjectProgressEvent, RepoReference } from "@rennet/protocol";

/** A repository the server may name outbound / accept inbound, in both path forms + its key. */
interface RootEntry {
  /** The path as the stores hold it (a project path, a review's repository root). */
  readonly hostPath: string;
  /** `realpathSync(hostPath)` when it resolves, else `hostPath` — the store key is derived from this. */
  readonly realPath: string;
  /** `escapePath(realPath)` — the snapshot-store repo key; stable + off-machine-meaningless. */
  readonly repoKey: string;
  /** A human label (basename, disambiguated on collision). */
  readonly displayName: string;
}

export interface ProjectionContext {
  /** Every known root, longest `hostPath`/`realPath` first so a nested repo matches before its parent. */
  readonly roots: readonly RootEntry[];
  /** The user's home directory, substituted with `~` in free text. */
  readonly homeDir: string;
  /** `repoKey` → the host path to resolve inbound references to. */
  readonly byRepoKey: ReadonlyMap<string, string>;
  /**
   * COMPAT (attention, additive, #383): true when the daemon's attention system holds an
   * active high-priority attention for this review id. Present only when the daemon advertises
   * the attention capability; absent ⇒ the projected review omits its `attention` summary and
   * a client falls back to deriving needs-you from the flagged queue + live events.
   */
  readonly reviewNeedsYou?: (reviewId: string) => boolean;
  /**
   * COMPAT (attention, additive, #383 batch): true while a review-scoped model turn is in flight
   * on this review (the in-flight registry, NOT `pendingPatchsetId` — that is staleness). Present
   * only alongside `reviewNeedsYou`; both gate on the attention capability.
   */
  readonly reviewIsRunning?: (reviewId: string) => boolean;
}

/** Thrown when an inbound reference names a repo the server does not know; becomes `rpcError invalid_input`. */
export class ProjectionResolveError extends Error {
  constructor(reference: string) {
    super(`unknown repository reference: ${reference}`);
    this.name = "ProjectionResolveError";
  }
}

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Build the projection context from the host roots the server could emit (the
 * dispatch-granted roots ∪ every stored project path) and the home dir. Cheap
 * enough to rebuild per request, so it always reflects the current project set.
 */
export function buildProjectionContext(
  hostRoots: Iterable<string>,
  homeDir: string,
): ProjectionContext {
  const seen = new Set<string>();
  const entries: RootEntry[] = [];
  const nameCounts = new Map<string, number>();
  for (const hostPath of hostRoots) {
    if (!hostPath || seen.has(hostPath)) continue;
    seen.add(hostPath);
    const realPath = tryRealpath(hostPath);
    const repoKey = escapePath(realPath);
    const name = basename(hostPath) || hostPath;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    entries.push({ hostPath, realPath, repoKey, displayName: name });
  }
  // Disambiguate colliding basenames with a short parent segment, so two repos both
  // named `web` read as `web` and `app/web` rather than an ambiguous pair.
  const disambiguated = entries.map((entry) =>
    (nameCounts.get(entry.displayName) ?? 0) > 1
      ? { ...entry, displayName: shortLabel(entry.hostPath) }
      : entry,
  );
  const byRepoKey = new Map<string, string>();
  for (const entry of disambiguated)
    if (!byRepoKey.has(entry.repoKey)) byRepoKey.set(entry.repoKey, entry.hostPath);
  // Longest first: a repo nested under another must match its own root, not the parent's.
  const roots = [...disambiguated].sort((a, b) => b.hostPath.length - a.hostPath.length);
  return { roots, homeDir, byRepoKey };
}

/** What {@link createCachedProjectionContext} needs off a stored project: its roots. */
interface ProjectRoots {
  readonly path: string;
  readonly openPath: string;
  readonly includedRepoPaths?: readonly string[];
}

/** The inputs the cached projection context is built from. */
export interface CachedProjectionContextDeps {
  /** The stored projects — read only when the cache misses. */
  readonly listProjects: () => readonly ProjectRoots[];
  /** The dispatch-granted roots. APPEND-ONLY: its size is used as its version. */
  readonly grantedRoots: ReadonlySet<string>;
  /** `projects.json` — stat'd (never read) per call to detect any writer's change. */
  readonly projectsPath: string;
  readonly homeDir: string;
}

/**
 * A memoized {@link buildProjectionContext} over the stored projects (perf audit §4 H3).
 *
 * The context is rebuilt inside EVERY projected fan-out — including once per streamed
 * ask token while a phone is paired — and a rebuild cost a whole `projects.json` read,
 * a zod parse per project, and a `realpathSync` per root. None of that changes between
 * two frames of the same turn.
 *
 * The cache key is deliberately not a hand-maintained invalidation hook at each mutation
 * site (a site is easy to add and forget). It is what the roots are actually derived
 * FROM: the granted-roots set's size — that set is append-only, so size IS its version —
 * and `projects.json`'s own filesystem identity (nanosecond mtime + size + inode). Any
 * writer invalidates it: this daemon's own add/rename/remove, a second process, or a
 * hand edit. The per-call cost drops to one `stat`.
 *
 * A missing `projects.json` (nothing added yet) stamps as `absent` and is itself cached,
 * so the empty-workspace path does not stat-and-rebuild forever either.
 */
export function createCachedProjectionContext(
  deps: CachedProjectionContextDeps,
): () => ProjectionContext {
  let cached: { key: string; context: ProjectionContext } | undefined;
  return () => {
    const key = `${deps.grantedRoots.size}|${statStamp(deps.projectsPath)}`;
    if (cached?.key !== key) {
      const roots = new Set<string>(deps.grantedRoots);
      for (const project of deps.listProjects()) {
        roots.add(project.path);
        roots.add(project.openPath);
        for (const repoPath of project.includedRepoPaths ?? []) roots.add(repoPath);
      }
      cached = { key, context: buildProjectionContext(roots, deps.homeDir) };
    }
    return cached.context;
  };
}

/** A file's change stamp: ns mtime + size + inode, or `absent`. Never reads the bytes. */
function statStamp(path: string): string {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.mtimeNs}:${stats.size}:${stats.ino}`;
  } catch {
    return "absent";
  }
}

/** The last two path segments (`parent/name`), for disambiguating a colliding basename. */
function shortLabel(path: string): string {
  const parts = path.split(sep).filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

/** Does `path` equal `root` or sit under it? Returns the matched root form when so. */
function matchRoot(path: string, entry: RootEntry): string | null {
  for (const root of [entry.realPath, entry.hostPath]) {
    if (path === root) return root;
    if (path.startsWith(root + sep)) return root;
  }
  return null;
}

/**
 * Project a host-absolute path to a repo reference. A path under a known root keeps
 * its repo-relative tail as `relativePath`. An UNKNOWN path still never leaks: it is
 * referenced by its own escaped key + basename (a remote client cannot resolve it
 * inbound — correct, it is not a project it can act on — but no host path crosses).
 */
export function toRepoReference(absPath: string, ctx: ProjectionContext): RepoReference {
  for (const entry of ctx.roots) {
    const root = matchRoot(absPath, entry);
    if (root === null) continue;
    const rel = absPath === root ? undefined : absPath.slice(root.length + 1);
    return {
      repoKey: entry.repoKey,
      displayName: entry.displayName,
      ...(rel ? { relativePath: rel } : {}),
    };
  }
  const realPath = tryRealpath(absPath);
  return { repoKey: escapePath(realPath), displayName: basename(absPath) || absPath };
}

/** Substitute known roots (→ `<displayName>`) and the home dir (→ `~`) in one string. */
export function scrubRoots(text: string, ctx: ProjectionContext): string {
  let out = text;
  for (const entry of ctx.roots) {
    for (const root of [entry.realPath, entry.hostPath]) {
      if (root) out = out.split(root).join(`<${entry.displayName}>`);
    }
  }
  if (ctx.homeDir) out = out.split(ctx.homeDir).join("~");
  return out;
}

/** Deep-scrub every string in a value for known-root and home-dir prefixes. */
export function scrubProjectedValue(value: unknown, ctx: ProjectionContext): unknown {
  if (typeof value === "string") return scrubRoots(value, ctx);
  if (Array.isArray(value)) return value.map((item) => scrubProjectedValue(item, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = scrubProjectedValue(val, ctx);
    return out;
  }
  return value;
}

// A leftover absolute filesystem path — POSIX (`/etc/passwd`, ≥2 segments) or Windows
// (`C:\Users\…`) — that `scrubRoots` did NOT convert because it lies outside every known root and
// the home dir. The negative lookbehind excludes a `/` that follows a word char, `:`, `/`, `>`, or
// `~`, so a URL (`https://host/path`), a repo-relative remainder after a `<root>` substitution, and
// a `~/…` home path are all left intact — only a genuine absolute path is caught (#382 M2 finding 8).
const ABSOLUTE_PATH_RE = /(?<![\w:/>~])(?:[a-zA-Z]:\\[^\s"']+|\/(?:[\w.-]+\/)+[\w.-]+)/g;

/** Redact absolute filesystem paths a root/home substitution missed — for projected error text so a
 *  raw `/var/...` or `C:\...` never reaches a projected client (#382 M2 finding 8). */
export function redactAbsolutePaths(text: string): string {
  return text.replace(ABSOLUTE_PATH_RE, "<path>");
}

/** Deep variant for a structured `details` payload: scrub roots/home, then redact any leftover
 *  absolute path in every string. Used only on the projected `rpcError` details. */
export function redactAbsolutePathsDeep(value: unknown, ctx: ProjectionContext): unknown {
  if (typeof value === "string") return redactAbsolutePaths(scrubRoots(value, ctx));
  if (Array.isArray(value)) return value.map((item) => redactAbsolutePathsDeep(item, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = redactAbsolutePathsDeep(val, ctx);
    return out;
  }
  return value;
}

// ── Board projections (B4: board events/state before a projected broadcast) ───

/**
 * Project one board event for a `projected` connection. The board wire schema
 * has no structural host-path field — a `code_ref` cites the patchset by
 * repo-relative path (B3 contract) — so the wrap is the blanket deep scrub:
 * known-root and home-dir prefixes in every string become display tokens,
 * exactly the free-text rule `projectCommandOutput` applies. Board prose
 * attributes are model/agent-authored and get ONLY this blanket pass. A future
 * kind that carries a structural host path adds its projector here, beside the
 * review/project ones. Loopback connections never touch this (module contract).
 */
export function projectBoardEvent(event: unknown, ctx: ProjectionContext): unknown {
  return scrubProjectedValue(event, ctx);
}

/** Project a board state projection (its elements) for a `projected` connection — same rule. */
export function projectBoardProjection(elements: unknown, ctx: ProjectionContext): unknown {
  return scrubProjectedValue(elements, ctx);
}

// ── Structural projectors (host-path fields → repo references) ────────────────

function projectProvenance(
  provenance: Record<string, unknown>,
  ctx: ProjectionContext,
): Record<string, unknown> {
  return {
    ...provenance,
    root: toRepoReference(String(provenance.root), ctx),
    commonDir: toRepoReference(String(provenance.commonDir), ctx),
  };
}

function projectPatchset(
  patchset: Record<string, unknown>,
  ctx: ProjectionContext,
): Record<string, unknown> {
  return {
    ...patchset,
    repository: projectProvenance(patchset.repository as Record<string, unknown>, ctx),
  };
}

function projectReview(
  review: Record<string, unknown>,
  ctx: ProjectionContext,
): Record<string, unknown> {
  // COMPAT (attention, #383): attach the attention summary only when the daemon advertises
  // the capability (⇒ `reviewNeedsYou` is wired). `running` is the live-turn signal already on
  // the review (a pending patchset is a turn producing its successor); `needsYou` is the
  // attention registry's high-priority flag for this review. Absent ⇒ old daemon, client derives.
  const attention = ctx.reviewNeedsYou
    ? {
        needsYou: ctx.reviewNeedsYou(String(review.id)),
        // A live turn, from the in-flight registry — NOT pendingPatchsetId (that is staleness).
        running: ctx.reviewIsRunning?.(String(review.id)) ?? false,
      }
    : undefined;
  return {
    ...review,
    repositoryRoot: toRepoReference(String(review.repositoryRoot), ctx),
    patchsets: (review.patchsets as Record<string, unknown>[]).map((ps) =>
      projectPatchset(ps, ctx),
    ),
    ...(attention ? { attention } : {}),
  };
}

function projectProject(
  project: Record<string, unknown>,
  ctx: ProjectionContext,
): Record<string, unknown> {
  const included = project.includedRepoPaths as string[] | undefined;
  return {
    ...project,
    path: toRepoReference(String(project.path), ctx),
    openPath: toRepoReference(String(project.openPath), ctx),
    ...(included ? { includedRepoPaths: included.map((p) => toRepoReference(p, ctx)) } : {}),
  };
}

function projectDiscovery(
  discovery: Record<string, unknown>,
  ctx: ProjectionContext,
): Record<string, unknown> {
  return {
    ...discovery,
    path: toRepoReference(String(discovery.path), ctx),
    repos: (discovery.repos as Record<string, unknown>[]).map((repo) => ({
      ...repo,
      path: toRepoReference(String(repo.path), ctx),
    })),
  };
}

function projectSummary(
  summary: Record<string, unknown>,
  ctx: ProjectionContext,
): Record<string, unknown> {
  return { ...summary, path: toRepoReference(String(summary.path), ctx) };
}

function projectSettingsProject(
  project: Record<string, unknown>,
  ctx: ProjectionContext,
): Record<string, unknown> {
  return { ...project, repoPath: toRepoReference(String(project.repoPath), ctx) };
}

/**
 * Project a command's OUTPUT for a projected connection. Key-driven over the known
 * structural surface (the design Context inventory): every command that returns a
 * `review`/`project`/`projects`/`discovery`/`repos`/`path` shape is covered without
 * enumerating them, then the deep scrub replaces known-root and home-dir prefixes.
 */
export function projectCommandOutput(
  command: CommandName,
  output: unknown,
  ctx: ProjectionContext,
): unknown {
  // A successful publish composition is signed outbound prose, not host metadata. Its artifact,
  // descriptor, canonical payload, and composition id are one correlated exact-bytes object;
  // rewriting any string here would make the phone preview different bytes from the operation it
  // signs. An unavailable result is operational text, however, and can contain a raw spawn/read/
  // persistence error, so it crosses the same scrubbed error boundary as projected RPC failures.
  if (command === "publish.compose") {
    const status =
      output && typeof output === "object" && !Array.isArray(output)
        ? (output as Record<string, unknown>).status
        : undefined;
    return status === "review" || status === "pr" ? output : redactAbsolutePathsDeep(output, ctx);
  }
  let projected: unknown = output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const o = { ...(output as Record<string, unknown>) };
    if (o.review && typeof o.review === "object")
      o.review = projectReview(o.review as Record<string, unknown>, ctx);
    if (o.project && typeof o.project === "object") {
      o.project = [
        "settings.resetRepoValue",
        "settings.pinRepoValue",
        "settings.setProjectValue",
      ].includes(command)
        ? projectSettingsProject(o.project as Record<string, unknown>, ctx)
        : projectProject(o.project as Record<string, unknown>, ctx);
    }
    if (Array.isArray(o.projects)) {
      o.projects = (o.projects as Record<string, unknown>[]).map((project) =>
        command === "settings.get"
          ? projectSettingsProject(project, ctx)
          : projectProject(project, ctx),
      );
    }
    if (o.discovery && typeof o.discovery === "object")
      o.discovery = projectDiscovery(o.discovery as Record<string, unknown>, ctx);
    if (Array.isArray(o.repos))
      o.repos = (o.repos as Record<string, unknown>[]).map((s) => projectSummary(s, ctx));
    if (o.run && typeof o.run === "object" && !Array.isArray(o.run)) {
      const run = { ...(o.run as Record<string, unknown>) };
      if (Array.isArray(run.repos)) {
        run.repos = (run.repos as Record<string, unknown>[]).map((summary) =>
          projectSummary(summary, ctx),
        );
      }
      o.run = run;
    }
    // `repository.choose` returns a top-level host `path` string (nullable).
    if (typeof o.path === "string") o.path = toRepoReference(o.path, ctx);
    // The display transcript (`session.transcript`) is stored RAW — the capture sink keeps the
    // reviewer's own host paths on their own disk — so R19 is enforced HERE, the one place it
    // belongs. Its rows carry arbitrary harness text (a `Bash` command line, a `Read` argument,
    // model prose), which is exactly the shape a projected `rpcError` gets: known roots and the
    // home dir substituted, THEN any leftover absolute path redacted. The blanket scrub below
    // alone would let a `/var/…` or `C:\…` outside every known root cross to a phone.
    if (command === "session.transcript" && Array.isArray(o.rows))
      o.rows = (o.rows as unknown[]).map((row) => redactAbsolutePathsDeep(row, ctx));
    projected = o;
  }
  return scrubProjectedValue(projected, ctx);
}

/** Project a progress event: the processed-repo summary's `path`, and scrub note/detail. */
export function projectProgressEvent(
  event: ProjectProgressEvent,
  ctx: ProjectionContext,
): ProjectProgressEvent {
  return scrubProjectedValue(
    (() => {
      if (event.kind === "repo-done")
        return {
          ...event,
          summary: projectSummary(event.summary as unknown as Record<string, unknown>, ctx),
        };
      if (event.kind === "done")
        return {
          ...event,
          repos: event.repos.map((s) =>
            projectSummary(s as unknown as Record<string, unknown>, ctx),
          ),
          ...(event.run
            ? {
                run: {
                  ...event.run,
                  repos: event.run.repos.map((summary) =>
                    projectSummary(summary as unknown as Record<string, unknown>, ctx),
                  ),
                },
              }
            : {}),
        };
      // project.detail's prs-start / repo-prs carry a forge identity, not a host
      // path — no projection needed; scrubbing below is a no-op on them.
      return event;
    })(),
    ctx,
  ) as ProjectProgressEvent;
}

// ── Inbound resolution (repo references → host paths) ─────────────────────────

/** Command → the input field(s) carrying a HOST path a projected client references. Others are repo-relative. */
export const INBOUND_HOST_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "repository.choose": ["path"],
  "review.capture": ["repoPath"],
  "review.openPr": ["repoPath"],
  "review.checkFreshness": ["repoPath"],
  "review.regenerate": ["repoPath"],
  "project.discover": ["path"],
  "settings.guidance": ["repoPath"],
  "settings.setRepoVisibility": ["repoPath"],
  "settings.resetRepoValue": ["repoPath"],
  "settings.pinRepoValue": ["repoPath"],
  "settings.setProjectValue": ["repoPath"],
  "settings.setGuidance": ["repoPath"],
};

/**
 * Input fields named `path` that are REPO-RELATIVE (a file inside the diff), NOT host
 * paths — so they pass through untouched. Maintained beside the host-path table so
 * the drift test (`projection.test.ts`) can force any NEW `path` field to be
 * classified into one list or the other, rather than silently leaking.
 */
export const INBOUND_REPO_RELATIVE_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "review.setDisposition": ["path"],
  "review.uiEvidence": ["path"],
  "review.refine": ["path"],
  "review.openInEditor": ["path"],
};

/** Extract a repoKey from an inbound value that is either the key string or a `{repoKey}` reference. */
function referenceKey(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { repoKey?: unknown }).repoKey === "string"
  ) {
    return (value as { repoKey: string }).repoKey;
  }
  return null;
}

function resolveReference(value: unknown, ctx: ProjectionContext): string {
  const key = referenceKey(value);
  const hostPath = key === null ? undefined : ctx.byRepoKey.get(key);
  if (!hostPath) throw new ProjectionResolveError(String(key ?? value));
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { relativePath?: unknown }).relativePath === "string"
  ) {
    return join(hostPath, (value as { relativePath: string }).relativePath);
  }
  return hostPath;
}

/**
 * Resolve a projected command's host-path inputs back to real host paths. A missing
 * field is left absent (optional inputs stay optional); a present-but-unresolvable
 * reference throws `ProjectionResolveError` (→ `invalid_input`), never a guess.
 */
export function resolveCommandInput(
  command: CommandName,
  input: unknown,
  ctx: ProjectionContext,
): unknown {
  if (command === "projects.add" && input && typeof input === "object") {
    const out = { ...(input as Record<string, unknown>) };
    if (out.discovery && typeof out.discovery === "object") {
      const discovery = { ...(out.discovery as Record<string, unknown>) };
      discovery.path = resolveReference(discovery.path, ctx);
      if (Array.isArray(discovery.repos)) {
        discovery.repos = (discovery.repos as Record<string, unknown>[]).map((repo) => ({
          ...repo,
          path: resolveReference(repo.path, ctx),
        }));
      }
      out.discovery = discovery;
    }
    return out;
  }
  const fields = INBOUND_HOST_PATH_FIELDS[command];
  if (!fields || !input || typeof input !== "object") return input;
  const out = { ...(input as Record<string, unknown>) };
  for (const field of fields) {
    if (!(field in out) || out[field] === undefined) continue;
    out[field] = resolveReference(out[field], ctx);
  }
  return out;
}
