import { join } from "node:path";
import { parseOpenSpecChange } from "@rennet/core";
import type { OpenSpecChange, Patchset } from "@rennet/protocol";
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
// Local reviews pin their complete working-tree bytes in `reviewedTreeOid`; range / PR /
// retrospective reviews use `headOid`. Both are immutable Git objects, so later disk
// edits cannot rewrite a captured Spec board. A legacy local patchset without the new
// field falls back to its committed head rather than mutable checkout bytes.
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
 * `OpenSpecChange` the Spec angle renders — reading each artifact from the immutable
 * reviewed tree (`reviewedTreeOid ?? headOid`).
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
  const reviewedOid = patchset.repository.reviewedTreeOid ?? patchset.repository.headOid;
  const gitShow = createGitShowFileRead({ git, repositoryRoot: root, headOid: reviewedOid });
  const read: ReadArtifact = (rel) => gitShow(join(root, rel));
  const listCapabilities: ListSpecCapabilities = (specsRel) =>
    listGitCapabilities(git, root, reviewedOid, specsRel);

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
