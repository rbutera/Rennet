import { join } from "node:path";
import { parseBmadSpec } from "@rennet/core";
import type { BmadSpec, Patchset } from "@rennet/protocol";
import { createGitShowFileRead } from "./finding-verification-backend";
import type { GitExec } from "./git-range-diff";

// ─────────────────────────────────────────────────────────────────────────────
// Live BMAD source (the parse-on-open half of the Design lens's BMAD board), the
// sibling of `openspec-change-reader.ts`.
//
// The Design lens renders the reviewed change's BMAD specification, parsed on open. A
// BMAD project keeps its documents under `.bmad/**` by convention — a `prd.md`, an
// `architecture.md`, and per-feature epic/story files — but `.bmad-core/core-config.yaml`
// may relocate any of them (BMAD v4 points `prd.prdFile`, `architecture.architectureFile`,
// and `devStoryLocation` at `docs/**` by default), and THAT path wins over the convention.
//
// Documents are read AT THE REVIEWED HEAD, not off an arbitrary checkout: local reviews
// pin their working-tree bytes in `reviewedTreeOid`; range / PR / retrospective reviews
// use `headOid`. Both are immutable Git objects, so later disk edits cannot rewrite a
// captured board. Deterministic and model-free — no model turn, no gate. When the
// patchset touches no BMAD document, it returns `null` and the lens shows its empty state.
// ─────────────────────────────────────────────────────────────────────────────

const CONVENTIONAL = {
  prdFile: ".bmad/prd.md",
  architectureFile: ".bmad/architecture.md",
  architectureShardedLocation: ".bmad/architecture",
  storyLocation: ".bmad/stories",
  epicLocation: ".bmad/epics",
} as const;

/** The BMAD document locations, after core-config.yaml overrides fold onto the conventions. */
interface BmadPaths {
  readonly prdFile: string;
  readonly architectureFile: string;
  /** Where a sharded architecture explodes (`docs/architecture/tech-stack.md`, …). */
  readonly architectureShardedLocation: string;
  readonly storyLocation: string;
  readonly epicLocation: string;
  /** Matches an epic document's file basename (default `epic-*.md` / `*.epic.md`). */
  readonly epicBasename: (basename: string) => boolean;
}

const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const stripQuotes = (value: string): string => value.replace(/^["']|["']$/g, "").trim();
const normalise = (path: string): string => path.replace(/\\/g, "/");

/** Turn a BMAD `epicFilePattern` (e.g. `epic-{n}*.md`) into a basename matcher. */
function epicPatternMatcher(pattern: string | undefined): (basename: string) => boolean {
  if (pattern === undefined) {
    return (basename) => /^epic-.*\.md$/i.test(basename) || /\.epic\.md$/i.test(basename);
  }
  const source = pattern
    .split(/(\{n\}|\*)/)
    .map((part) => {
      if (part === "{n}") return "\\d+(?:\\.\\d+)*";
      if (part === "*") return ".*";
      return part.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
    })
    .join("");
  const regex = new RegExp(`^${source}$`, "i");
  return (basename) => regex.test(basename);
}

/**
 * Read the load-bearing keys out of `.bmad-core/core-config.yaml`: the PRD file, the
 * sharded-PRD (epic) location, the epic file pattern, the architecture file, the
 * sharded-architecture location, and the story location. A minimal targeted scan — the
 * file's other keys are irrelevant to where the documents live — that stays
 * dependency-free (mirrors `parseWorkspaceGlobs`).
 */
export function resolveBmadPaths(configYaml: string | undefined): BmadPaths {
  let prdFile: string = CONVENTIONAL.prdFile;
  let architectureFile: string = CONVENTIONAL.architectureFile;
  let architectureShardedLocation: string = CONVENTIONAL.architectureShardedLocation;
  let storyLocation: string = CONVENTIONAL.storyLocation;
  let epicLocation: string = CONVENTIONAL.epicLocation;
  let epicPattern: string | undefined;

  if (configYaml !== undefined) {
    let section: string | undefined;
    for (const raw of configYaml.split("\n")) {
      if (raw.trim().length === 0 || raw.trimStart().startsWith("#")) continue;
      const top = /^([A-Za-z0-9_]+):\s*(.*?)\s*(?:#.*)?$/.exec(raw);
      if (top && !/^\s/.test(raw)) {
        const key = top[1] ?? "";
        const value = stripQuotes(top[2] ?? "");
        if (value.length === 0) {
          section = key;
          continue;
        }
        section = undefined;
        if (key === "devStoryLocation") storyLocation = value;
        continue;
      }
      const nested = /^\s+([A-Za-z0-9_]+):\s*(.*?)\s*(?:#.*)?$/.exec(raw);
      if (!nested) continue;
      const key = nested[1] ?? "";
      const value = stripQuotes(nested[2] ?? "");
      if (value.length === 0) continue;
      if (section === "prd") {
        if (key === "prdFile") prdFile = value;
        if (key === "prdShardedLocation") epicLocation = value;
        if (key === "epicFilePattern") epicPattern = value;
      } else if (section === "architecture") {
        if (key === "architectureFile") architectureFile = value;
        if (key === "architectureShardedLocation") architectureShardedLocation = value;
      }
    }
  }

  return {
    prdFile: normalise(prdFile),
    architectureFile: normalise(architectureFile),
    architectureShardedLocation: normalise(architectureShardedLocation).replace(/\/$/, ""),
    storyLocation: normalise(storyLocation).replace(/\/$/, ""),
    epicLocation: normalise(epicLocation).replace(/\/$/, ""),
    epicBasename: epicPatternMatcher(epicPattern),
  };
}

const basenameOf = (path: string): string => normalise(path).split("/").at(-1) ?? "";
const isMarkdown = (path: string): boolean => /\.md$/i.test(path);
const underDir = (path: string, dir: string): boolean =>
  dir.length > 0 && normalise(path).startsWith(`${dir}/`);

function isStoryPath(path: string, paths: BmadPaths): boolean {
  const p = normalise(path);
  return isMarkdown(p) && (underDir(p, paths.storyLocation) || /\.story\.md$/i.test(p));
}

function isEpicPath(path: string, paths: BmadPaths): boolean {
  const p = normalise(path);
  return (
    isMarkdown(p) &&
    underDir(p, paths.epicLocation) &&
    paths.epicBasename(basenameOf(p)) &&
    !isStoryPath(p, paths)
  );
}

/** A shard of an exploded architecture document (`docs/architecture/tech-stack.md`, …). */
function isArchitectureShardPath(path: string, paths: BmadPaths): boolean {
  const p = normalise(path);
  return (
    isMarkdown(p) &&
    underDir(p, paths.architectureShardedLocation) &&
    !isStoryPath(p, paths) &&
    !isEpicPath(p, paths)
  );
}

/**
 * The BMAD documents the reviewed patchset touches, resolved through `paths`, or `null`
 * when the patchset touches none. The anchor `name` is the touched story's id (from its
 * `N.M` filename), else the touched epic basename, else the PRD — the closest BMAD analog
 * of OpenSpec's selected change name. Touched epic/story paths are sorted for determinism.
 */
export function selectedBmadSpec(
  changedFilePaths: readonly string[],
  paths: BmadPaths,
): {
  name: string;
  epicPaths: string[];
  storyPaths: string[];
  architectureShardPaths: string[];
} | null {
  const epicPaths = new Set<string>();
  const storyPaths = new Set<string>();
  const architectureShardPaths = new Set<string>();
  let touchesPrd = false;
  let touchesArchitecture = false;

  for (const raw of changedFilePaths) {
    const path = normalise(raw);
    if (path === paths.prdFile) touchesPrd = true;
    else if (path === paths.architectureFile) touchesArchitecture = true;
    else if (isStoryPath(path, paths)) storyPaths.add(path);
    else if (isEpicPath(path, paths)) epicPaths.add(path);
    else if (isArchitectureShardPath(path, paths)) architectureShardPaths.add(path);
  }

  const stories = [...storyPaths].sort(byName);
  const epics = [...epicPaths].sort(byName);
  const architectureShards = [...architectureShardPaths].sort(byName);
  if (
    !touchesPrd &&
    !touchesArchitecture &&
    stories.length === 0 &&
    epics.length === 0 &&
    architectureShards.length === 0
  ) {
    return null;
  }

  const firstStory = stories[0];
  const firstEpic = epics[0];
  const name =
    firstStory !== undefined
      ? (/(\d+(?:\.\d+)+)/.exec(basenameOf(firstStory))?.[1] ??
        basenameOf(firstStory).replace(/\.md$/i, ""))
      : firstEpic !== undefined
        ? basenameOf(firstEpic).replace(/\.md$/i, "")
        : "prd";

  return {
    name,
    epicPaths: epics,
    storyPaths: stories,
    architectureShardPaths: architectureShards,
  };
}

/**
 * Read the BMAD specification the reviewed patchset selected, parsed into the structured
 * `BmadSpec` the Design lens renders — reading each document from the immutable reviewed
 * tree (`reviewedTreeOid ?? headOid`) and honoring `.bmad-core/core-config.yaml` path
 * overrides. The PRD and architecture documents are always read (once BMAD is selected);
 * a sharded architecture is recovered from its touched shards when the monolith is gone.
 * Every touched epic and story is read too — the bounded, review-relevant document set.
 * Returns `null` when the patchset touches no BMAD document, or when every selected
 * document is absent at the reviewed tree (a deletion-only change).
 */
export async function readBmadSpec(patchset: Patchset, git: GitExec): Promise<BmadSpec | null> {
  const root = patchset.repository.root;
  const reviewedOid = patchset.repository.reviewedTreeOid ?? patchset.repository.headOid;
  const gitShow = createGitShowFileRead({ git, repositoryRoot: root, headOid: reviewedOid });
  const read = (rel: string): Promise<string | undefined> => gitShow(join(root, rel));

  const configYaml = await read(".bmad-core/core-config.yaml");
  const paths = resolveBmadPaths(configYaml);

  const selected = selectedBmadSpec(
    patchset.files.map((file) => file.path),
    paths,
  );
  if (selected === null) return null;

  const [prdMd, architectureMonolith] = await Promise.all([
    read(paths.prdFile),
    read(paths.architectureFile),
  ]);

  // A sharded architecture explodes the monolith into `docs/architecture/*.md`; when the
  // monolith is absent, the touched shards (e.g. `tech-stack.md`) ARE the architecture
  // document — parse their concatenation so the Tech Stack table still renders.
  const architectureShards: string[] = [];
  for (const path of selected.architectureShardPaths) {
    const md = await read(path);
    if (md !== undefined) architectureShards.push(md);
  }
  const architectureMd =
    architectureMonolith ??
    (architectureShards.length > 0 ? architectureShards.join("\n\n") : undefined);

  const epics: { path: string; md: string }[] = [];
  for (const path of selected.epicPaths) {
    const md = await read(path);
    if (md !== undefined) epics.push({ path, md });
  }
  const stories: { path: string; md: string }[] = [];
  for (const path of selected.storyPaths) {
    const md = await read(path);
    if (md !== undefined) stories.push({ path, md });
  }

  // A deletion-only patchset selects a BMAD path whose bytes are gone at the reviewed
  // tree: every read comes back absent. There is no document to render — return null
  // rather than a hollow spec that is a name wrapping empty arrays.
  if (
    prdMd === undefined &&
    architectureMd === undefined &&
    epics.length === 0 &&
    stories.length === 0
  ) {
    return null;
  }

  return parseBmadSpec({
    name: selected.name,
    ...(prdMd !== undefined ? { prdMd } : {}),
    ...(architectureMd !== undefined ? { architectureMd } : {}),
    epics,
    stories,
  });
}
