import { realpathSync } from "node:fs";
import { detectLocus, escapePath, toWindowsView } from "@rennet/core";
import type {
  BaseRefResolution,
  ConventionEntry,
  DependencyEdge,
  EntryPoint,
  OwnershipRule,
  SnapshotFileEntry,
  TestEntry,
  WorkspaceScope,
} from "@rennet/protocol";
import { execaGit, type GitExec } from "./git-range-diff";

/**
 * The deterministic, model-free structural source for a ProjectSnapshot (#14).
 *
 * Everything here is a pure function of the git tree at the resolved
 * default-branch OID — NOT the working tree and NOT a live tool daemon. The
 * snapshot is "pinned to the resolved default-branch OID", so scopes, edges,
 * entry points, tests, ownership and conventions are all read from the blobs at
 * `baseOid` via git plumbing. That is what keeps the map byte-reproducible: two
 * reads at the same OID see the same bytes regardless of the working tree.
 *
 * Internal structure comes from the WORKSPACE TOOLING config (`pnpm-workspace`
 * globs + each member's `package.json`/`project.json`), never a folder heuristic
 * (#142). We deliberately do NOT shell to `nx graph` here: the live graph
 * reflects the working tree and embeds nx-version-specific, churny target data,
 * neither of which can satisfy "pinned to base OID + byte-reproducible". We read
 * the same tooling config the graph is built from, at the pinned OID, and derive
 * the structural facts ourselves.
 */

// ── git plumbing at a pinned OID ─────────────────────────────────────────────

async function tryGit(git: GitExec, root: string, args: string[]): Promise<string | null> {
  try {
    return (await git(root, args, { reject: true })).trim();
  } catch {
    return null;
  }
}

export interface ResolvedBase {
  /**
   * The per-project store key: `escapePath(realpath(git-top-level))` (#141 / R55,
   * design §1.1). Path-keyed and local-first — each checkout PATH (including a
   * worktree on a branch) gets its own store entry, replacing wave-1's
   * `realpath(git-common-dir)` which made all worktrees share one entry.
   */
  readonly repoKey: string;
  /** The repository top-level working directory. */
  readonly root: string;
  readonly baseRef: string;
  readonly baseOid: string;
  readonly baseRefResolution: BaseRefResolution;
}

/**
 * Resolve the pinned default-branch ref + commit OID. Resolution order matches
 * the contract (§2.3): forge metadata → symbolic HEAD → configured upstream →
 * explicit setting — with the most-authoritative WINNING. Forge-metadata
 * resolution needs a ForgePort and is a follow-on; here we implement the three
 * git-local tiers plus an explicit override. It FAILS CLOSED: if none resolve we
 * throw rather than guess a default branch, because pinning to the wrong OID
 * would silently poison every downstream request.
 */
export async function resolveBaseRef(
  root: string,
  options: { git?: GitExec; explicitBaseRef?: string } = {},
): Promise<ResolvedBase> {
  const git = options.git ?? execaGit;
  const gitTopLevel = (await git(root, ["rev-parse", "--show-toplevel"], { reject: true })).trim();
  const locus = detectLocus(root);
  const topLevel =
    locus.kind === "wsl" && gitTopLevel.startsWith("/")
      ? toWindowsView(gitTopLevel, locus.distro)
      : gitTopLevel;
  // The store key is the escaped, realpath-canonical top-level PATH (design §1.1),
  // so a worktree on a branch keys its own local-first entry. `realpath` is the
  // node I/O half of the escaped-path scheme; `escapePath` (core) is the pure half.
  const repoKey = escapePath(realpathSync(topLevel));

  const attempts: { ref: string | null; resolution: BaseRefResolution }[] = [
    // explicit setting is the deliberate human override — highest precedence.
    { ref: options.explicitBaseRef ?? null, resolution: "explicit-setting" },
    // the remote's own declared default branch.
    {
      ref: await tryGit(git, topLevel, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ]),
      resolution: "symbolic-head",
    },
    // the configured upstream of the current branch.
    {
      ref: await tryGit(git, topLevel, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]),
      resolution: "configured-upstream",
    },
  ];

  for (const { ref, resolution } of attempts) {
    if (!ref) continue;
    const oid = await tryGit(git, topLevel, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    if (oid)
      return { repoKey, root: topLevel, baseRef: ref, baseOid: oid, baseRefResolution: resolution };
  }
  throw new Error(
    "ProjectSnapshot: could not resolve the default-branch ref (no origin/HEAD, no upstream, no explicit setting). Pass an explicit base ref.",
  );
}

// ── the file inventory at the OID ────────────────────────────────────────────

/** The tracked file inventory at `baseOid`, from `git ls-tree`. Blobs only. */
export async function listTree(
  root: string,
  baseOid: string,
  git: GitExec = execaGit,
): Promise<SnapshotFileEntry[]> {
  // `-r` recurse, `-l` long (size), `-z` NUL records with literal (unquoted) paths.
  const output = await git(root, ["ls-tree", "-r", "-l", "-z", baseOid], { reject: true });
  const files: SnapshotFileEntry[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    // "<mode> <type> <oid> <size>\t<path>"
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    const path = record.slice(tab + 1);
    const [mode, type, oid, size] = meta;
    if (type !== "blob" || !mode || !oid) continue;
    files.push({ path, blobOid: oid, size: Number.parseInt(size ?? "0", 10) || 0, mode });
  }
  return files;
}

/**
 * Line counts for every TEXT file in the tree at `oid`, as `path → lines`.
 *
 * This is the inventory a citation resolves against when the citing seat read
 * BEYOND the diff (W5): board lint needs "does `<path>` exist at the review
 * commit, and does `<start>-<end>` fit inside it?" for the whole tree, not only
 * the changed files. One `git grep -c` pass answers it for the whole repo in
 * milliseconds (~80 ms over Rennet's 2.4k files) — every line matches the empty
 * pattern, so the match count IS the line count.
 *
 * `-I` skips binaries (which have no lines to cite) and `-z` writes the count
 * after a NUL so a path containing `:` still parses. Records are
 * `<oid>:<path>\0<n>\n`, and the path between the `:` and the NUL is RAW — git
 * does not escape it, so it may itself contain a newline. The NUL is therefore the
 * only reliable field separator: the scan anchors on it and reads the decimal count
 * up to the following newline, rather than splitting records on `\n` (which a path
 * containing one would corrupt, taking the next record down with it).
 * A tree with no text files at all makes `git grep` exit 1; that surfaces as a
 * throw, and the caller degrades to the diff-derived inventory.
 */
export async function listTreeLineCounts(
  root: string,
  oid: string,
  git: GitExec = execaGit,
): Promise<Map<string, number>> {
  const output = await git(root, ["grep", "-I", "-c", "-z", "-e", "", oid, "--"], { reject: true });
  const counts = new Map<string, number>();
  const prefix = `${oid}:`;
  for (const [, qualified = "", lines = ""] of output.matchAll(/([^\0]*)\0(\d+)(?:\n|$)/g)) {
    if (!qualified.startsWith(prefix)) continue;
    counts.set(qualified.slice(prefix.length), Number(lines));
  }
  return counts;
}

/**
 * Both tree inventories for one review — head and base — as the board lint's
 * citation grounding.
 *
 * SETTLED, never `Promise.all`: the two reads are independent, so a base read that
 * fails must not throw away a perfectly good head read and degrade BOTH sides. A
 * side that could not be read comes back EMPTY, which grounds that side exactly as
 * it was before the whole-tree read existed — the diff-derived inventory alone.
 * Partial knowledge beats none.
 */
export async function readTreeLineCounts(
  root: string,
  headOid: string,
  baseOid: string,
  git: GitExec = execaGit,
): Promise<{ head: Map<string, number>; base: Map<string, number> }> {
  const [head, base] = await Promise.allSettled([
    listTreeLineCounts(root, headOid, git),
    listTreeLineCounts(root, baseOid, git),
  ]);
  return {
    head: head.status === "fulfilled" ? head.value : new Map(),
    base: base.status === "fulfilled" ? base.value : new Map(),
  };
}

/** Read a blob's UTF-8 text by its OID at the pinned tree. */
export async function readBlobText(
  root: string,
  blobOid: string,
  git: GitExec = execaGit,
): Promise<string> {
  return git(root, ["cat-file", "blob", blobOid], { reject: true });
}

// ── workspace tooling at the OID (scopes / edges / entry points) ─────────────

interface Member {
  readonly root: string;
  readonly pkg: PackageJson;
  readonly project?: ProjectJson;
}

interface PackageJson {
  readonly name?: string;
  readonly private?: boolean;
  readonly main?: string;
  readonly module?: string;
  readonly types?: string;
  readonly exports?: unknown;
  readonly bin?: string | Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

interface ProjectJson {
  readonly name?: string;
  readonly sourceRoot?: string;
  readonly projectType?: "library" | "application";
  readonly tags?: string[];
  readonly implicitDependencies?: string[];
}

/**
 * Minimal reader for the `packages:` block of `pnpm-workspace.yaml`. It reads the
 * top-level block sequence of glob strings and nothing else — the rest of the
 * file (overrides, trust policy, age gates) is irrelevant to the workspace
 * shape. A full YAML parse is a trivial follow-on if the globs ever get exotic;
 * this stays dependency-free and is exercised against the real file in tests.
 */
export function parseWorkspaceGlobs(yaml: string): string[] {
  const lines = yaml.split("\n");
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of lines) {
    if (/^packages:\s*(#.*)?$/.test(raw)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    // A list item under the block: optional indent, "- ", optional quotes.
    const item = /^\s+-\s+["']?([^"'#\n]+?)["']?\s*(#.*)?$/.exec(raw);
    if (item?.[1]) {
      globs.push(item[1].trim());
      continue;
    }
    // A blank or comment line inside the block is skipped; anything else at
    // column 0 ends the block.
    if (/^\s*(#.*)?$/.test(raw)) continue;
    if (/^\S/.test(raw)) break;
  }
  return globs;
}

/** Whether a directory path matches a pnpm-workspace glob (supports `*` and `**`). */
export function matchesGlob(glob: string, dir: string): boolean {
  // Build a regex from the glob: `**` matches any depth (crossing `/`), `*`
  // matches a single path segment, everything else is a literal.
  const source = glob
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === "**") return ".*";
      if (part === "*") return "[^/]+";
      return part.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`).test(dir);
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The workspace member roots: directories matching a glob that contain a package.json. */
function memberRoots(files: readonly SnapshotFileEntry[], globs: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    if (!file.path.endsWith("/package.json")) continue;
    const dir = directoryOf(file.path);
    if (globs.some((glob) => matchesGlob(glob, dir))) roots.add(dir);
  }
  return [...roots].sort();
}

export interface WorkspaceStructure {
  readonly scopes: WorkspaceScope[];
  readonly edges: DependencyEdge[];
  readonly entryPoints: EntryPoint[];
}

/**
 * Read the workspace structure (scopes, edges, entry points) from the `files`
 * inventory, which is already pinned to the base OID by the caller. Blob reads
 * are OID-addressed (by `file.blobOid`), so no separate `baseOid` is needed here.
 */
export async function readWorkspaceStructure(
  root: string,
  files: readonly SnapshotFileEntry[],
  git: GitExec = execaGit,
): Promise<WorkspaceStructure> {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const workspaceFile = byPath.get("pnpm-workspace.yaml");
  const globs = workspaceFile
    ? parseWorkspaceGlobs(await readBlobText(root, workspaceFile.blobOid, git))
    : [];
  const roots = memberRoots(files, globs);

  const members: Member[] = [];
  for (const memberRoot of roots) {
    const pkgFile = byPath.get(`${memberRoot}/package.json`);
    if (!pkgFile) continue;
    const pkg = safeJson<PackageJson>(await readBlobText(root, pkgFile.blobOid, git));
    if (!pkg) continue;
    const projFile = byPath.get(`${memberRoot}/project.json`);
    const project = projFile
      ? safeJson<ProjectJson>(await readBlobText(root, projFile.blobOid, git))
      : null;
    members.push({ root: memberRoot, pkg, project: project ?? undefined });
  }

  // Canonical scope name = package.json name (or the dir if unnamed). Build
  // lookup maps so edges from BOTH package deps (package names) and
  // implicitDependencies (nx project names) resolve to the canonical name.
  const canonicalByPackageName = new Map<string, string>();
  const canonicalByProjectName = new Map<string, string>();
  const scopeNames = new Set<string>();
  for (const member of members) {
    const name = member.pkg.name ?? member.root;
    scopeNames.add(name);
    if (member.pkg.name) canonicalByPackageName.set(member.pkg.name, name);
    if (member.project?.name) canonicalByProjectName.set(member.project.name, name);
  }

  const scopes: WorkspaceScope[] = [];
  const entryPoints: EntryPoint[] = [];
  const edges: DependencyEdge[] = [];

  for (const member of members) {
    const name = member.pkg.name ?? member.root;
    scopes.push({
      name,
      root: member.root,
      sourceRoot: member.project?.sourceRoot,
      type: member.project?.projectType,
      private: member.pkg.private === true,
      tags: [...(member.project?.tags ?? [])],
    });

    const bin =
      typeof member.pkg.bin === "string"
        ? ([[name, member.pkg.bin]] as [string, string][])
        : Object.entries(member.pkg.bin ?? {});
    entryPoints.push({
      scope: name,
      main: member.pkg.main,
      module: member.pkg.module,
      types: member.pkg.types,
      exports: member.pkg.exports,
      bin,
    });

    const manifestDeps = {
      ...member.pkg.dependencies,
      ...member.pkg.devDependencies,
      ...member.pkg.peerDependencies,
    };
    for (const [dep, spec] of Object.entries(manifestDeps)) {
      // Only workspace-internal edges, and only to a known sibling scope.
      if (!spec.startsWith("workspace:")) continue;
      const to = canonicalByPackageName.get(dep);
      if (to && to !== name) edges.push({ from: name, to, kind: "manifest" });
    }
    for (const dep of member.project?.implicitDependencies ?? []) {
      const to = canonicalByProjectName.get(dep) ?? (scopeNames.has(dep) ? dep : undefined);
      if (to && to !== name) edges.push({ from: name, to, kind: "implicit" });
    }
  }

  return { scopes, edges, entryPoints };
}

// ── conventions, ownership, tests (all at the OID) ───────────────────────────

const CONVENTION_KINDS: readonly {
  readonly test: RegExp;
  readonly kind: ConventionEntry["kind"];
}[] = [
  { test: /^biome\.jsonc?$/, kind: "formatter" },
  { test: /^\.prettierrc/, kind: "formatter" },
  { test: /^eslint\.config\.(m|c)?js$/, kind: "linter" },
  { test: /^\.eslintrc/, kind: "linter" },
  { test: /^tsconfig(\.\w+)?\.json$/, kind: "typescript" },
  { test: /^pnpm-workspace\.yaml$/, kind: "workspace" },
  { test: /^nx\.json$/, kind: "nx" },
  { test: /^\.editorconfig$/, kind: "editorconfig" },
];

/**
 * The configured conventions present at the OID. A convention entry's `digest`
 * is the file's git blob OID — a content identity that is already in the tree
 * listing (no extra read) and is a pure function of the bytes. Root-level config
 * files are matched by name; any tracked `.rennet/` file is included as
 * human-authored config (R27/R55).
 */
export function readConventions(files: readonly SnapshotFileEntry[]): ConventionEntry[] {
  const out: ConventionEntry[] = [];
  for (const file of files) {
    const dir = directoryOf(file.path);
    const base = file.path.slice(file.path.lastIndexOf("/") + 1);
    if (dir === "") {
      const match = CONVENTION_KINDS.find((entry) => entry.test.test(base));
      if (match) out.push({ path: file.path, digest: file.blobOid, kind: match.kind });
    } else if (file.path.startsWith(".rennet/")) {
      out.push({ path: file.path, digest: file.blobOid, kind: "rennet" });
    }
  }
  return out;
}

const OWNERSHIP_PATHS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"] as const;

/** CODEOWNERS rules in FILE ORDER (git's last-match-wins semantics are order-significant). */
export async function readOwnership(
  root: string,
  files: readonly SnapshotFileEntry[],
  git: GitExec = execaGit,
): Promise<OwnershipRule[]> {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const found = OWNERSHIP_PATHS.map((path) => byPath.get(path)).find(Boolean);
  if (!found) return [];
  const text = await readBlobText(root, found.blobOid, git);
  const rules: OwnershipRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern) rules.push({ pattern, owners });
  }
  return rules;
}

const TEST_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
];

function matchesTestGlob(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base) || /\.(test|spec)\.\w+$/.test(base)) {
    return /\.spec\./.test(base) ? "**/*.spec.*" : "**/*.test.*";
  }
  if (/(^|\/)(test|tests|__tests__)\//.test(path)) {
    return path.includes("/__tests__/")
      ? "**/__tests__/**"
      : path.includes("/tests/")
        ? "**/tests/**"
        : "**/test/**";
  }
  return null;
}

/** Classify the file inventory into test files by the configured test globs. */
export function readTests(
  files: readonly SnapshotFileEntry[],
  scopes: readonly WorkspaceScope[],
): TestEntry[] {
  const roots = [...scopes]
    .map((scope) => ({ name: scope.name, root: scope.root }))
    .sort((l, r) => r.root.length - l.root.length);
  const tests: TestEntry[] = [];
  for (const file of files) {
    const matchedBy = matchesTestGlob(file.path);
    if (!matchedBy) continue;
    const owner = roots.find(
      (scope) => file.path === scope.root || file.path.startsWith(`${scope.root}/`),
    );
    tests.push({ path: file.path, scope: owner?.name ?? null, matchedBy });
  }
  return tests;
}

export { TEST_GLOBS };
