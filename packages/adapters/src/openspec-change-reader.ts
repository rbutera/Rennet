import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseOpenSpecChange } from "@rennet/core";
import type { OpenSpecChange, Patchset } from "@rennet/types";
import { createGitShowFileRead } from "./finding-verification-backend";
import type { GitExec } from "./git-range-diff";

// ─────────────────────────────────────────────────────────────────────────────
// Live OpenSpec source (the parse-on-open half of the Spec angle).
//
// The Spec angle renders the review's ACTUALLY-SELECTED OpenSpec change, parsed on
// open — replacing the frozen fixture. The change is picked from the reviewed
// patchset's changed paths (`openspec/changes/<name>/`), and its artifacts are read
// AT THE REVIEWED HEAD, not off an arbitrary checkout:
//
//   • WORKING-TREE review (`intent.surface === "working-tree"`): the reviewed content,
//     including uncommitted edits, IS the working tree at `repository.root` — read it
//     off disk.
//   • RANGE / PR / RETROSPECTIVE review (any other surface, incl. an absent intent):
//     the reviewed head is `repository.headOid`, which is diffed WITHOUT a checkout, so
//     read the blob at that OID via `git show` (and list `specs/` via `git ls-tree`).
//     A PR that ADDS or EDITS a change is invisible on the base checkout — this is the
//     path that makes it visible. Same seam #206's verification reader uses
//     (`createVerificationFileReaderForPatchset`).
//
// Deterministic and model-free — no model turn, no gate. When the patchset touches no
// change, it returns `null` and the Spec angle shows its honest empty state.
// ─────────────────────────────────────────────────────────────────────────────

const CHANGES_PREFIX = "openspec/changes/";
const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The change directory name selected by the reviewed patchset: the first (sorted)
 * `<name>` under `openspec/changes/<name>/` that the changed paths touch, or `null`
 * when none do. Sorting makes the pick deterministic when a patchset touches more
 * than one change.
 */
export function selectedOpenSpecChangeName(changedFilePaths: readonly string[]): string | null {
  const names = new Set<string>();
  for (const path of changedFilePaths) {
    const normalised = path.replace(/\\/g, "/");
    if (!normalised.startsWith(CHANGES_PREFIX)) continue;
    const name = normalised.slice(CHANGES_PREFIX.length).split("/")[0];
    if (name && name.length > 0) names.add(name);
  }
  return [...names].sort(byName)[0] ?? null;
}

/** Read a repo-relative file at the reviewed state, or `undefined` when it is absent. */
type ReadArtifact = (repoRelativePath: string) => Promise<string | undefined>;
/** The candidate capability names under a change's `specs/` dir at the reviewed state. */
type ListSpecCapabilities = (specsRelativePath: string) => Promise<string[]>;

/** Read a file off disk as UTF-8, or `undefined` when it does not exist. */
async function readDisk(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The immediate subdirectory names under a disk `specs/` dir (empty when absent). */
async function listDiskCapabilities(specsDir: string): Promise<string[]> {
  const entries = await readdir(specsDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(byName);
}

/** The immediate entry names of a `specs/` tree at `headOid` (empty when absent). */
async function listGitCapabilities(
  git: GitExec,
  root: string,
  headOid: string,
  specsRelativePath: string,
): Promise<string[]> {
  if (headOid.length === 0) return [];
  // `git ls-tree <headOid>:<specs>` lists the tree's immediate entries; a missing tree
  // errors, which `reject: false` turns into empty output. Names alone are enough — the
  // per-capability `spec.md` read filters out any non-capability entry.
  const out = await git(root, ["ls-tree", "--name-only", `${headOid}:${specsRelativePath}`], {
    reject: false,
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort(byName);
}

/**
 * Read the OpenSpec change the reviewed patchset selected, parsed into the structured
 * `OpenSpecChange` the Spec angle renders — reading each artifact AT THE REVIEWED HEAD
 * (disk for a working-tree review, `git show <headOid>:<path>` for a range/PR review).
 * Returns `null` when the patchset touches no `openspec/changes/<name>/` — the honest
 * "no OpenSpec change in this review" case.
 */
export async function readOpenSpecChange(
  patchset: Patchset,
  git: GitExec,
): Promise<OpenSpecChange | null> {
  const name = selectedOpenSpecChangeName(patchset.files.map((file) => file.path));
  if (name === null) return null;

  const root = patchset.repository.root;
  const changeRel = `${CHANGES_PREFIX}${name}`;
  const isWorkingTree = patchset.intent?.surface === "working-tree";

  let read: ReadArtifact;
  let listCapabilities: ListSpecCapabilities;
  if (isWorkingTree) {
    read = (rel) => readDisk(join(root, rel));
    listCapabilities = (specsRel) => listDiskCapabilities(join(root, specsRel));
  } else {
    const headOid = patchset.repository.headOid;
    const gitShow = createGitShowFileRead({ git, repositoryRoot: root, headOid });
    read = (rel) => gitShow(join(root, rel));
    listCapabilities = (specsRel) => listGitCapabilities(git, root, headOid, specsRel);
  }

  const [proposalMd, designMd, tasksMd, capabilities] = await Promise.all([
    read(`${changeRel}/proposal.md`),
    read(`${changeRel}/design.md`),
    read(`${changeRel}/tasks.md`),
    listCapabilities(`${changeRel}/specs`),
  ]);

  const specDeltas: { capability: string; md: string }[] = [];
  for (const capability of capabilities) {
    const md = await read(`${changeRel}/specs/${capability}/spec.md`);
    if (md !== undefined) specDeltas.push({ capability, md });
  }

  return parseOpenSpecChange({
    name,
    ...(proposalMd !== undefined ? { proposalMd } : {}),
    ...(designMd !== undefined ? { designMd } : {}),
    ...(tasksMd !== undefined ? { tasksMd } : {}),
    specDeltas,
  });
}
