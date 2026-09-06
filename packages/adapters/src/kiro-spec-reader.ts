import { join } from "node:path";
import { type KiroSpecSource, parseKiroSpec } from "@rennet/core";
import type { KiroSpec, Patchset } from "@rennet/protocol";
import { createGitShowFileRead } from "./finding-verification-backend";
import type { GitExec } from "./git-range-diff";

// ─────────────────────────────────────────────────────────────────────────────
// Live Kiro source (the parse-on-open half of the Design angle, for Kiro specs).
//
// The Design angle renders the review's ACTUALLY-SELECTED Kiro feature, parsed on
// open. The feature is picked from the reviewed patchset's changed paths
// (`.kiro/specs/<feature>/`), and its artifacts are read AT THE REVIEWED HEAD, not off
// an arbitrary checkout:
//
// Local reviews pin their complete working-tree bytes in `reviewedTreeOid`; range / PR /
// retrospective reviews use `headOid`. Both are immutable Git objects, so later disk
// edits cannot rewrite a captured Design board. A legacy local patchset without the new
// field falls back to its committed head rather than mutable checkout bytes.
//
// Deterministic and model-free — no model turn, no gate. When the patchset touches no
// Kiro feature, it returns `null` and the Design angle shows its honest empty state.
// This mirrors `readOpenSpecChange`, the OpenSpec sibling.
// ─────────────────────────────────────────────────────────────────────────────

const SPECS_PREFIX = ".kiro/specs/";
const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The feature directory name selected by the reviewed patchset: the first (sorted)
 * `<feature>` under `.kiro/specs/<feature>/` that the changed paths touch, or `null`
 * when none do. Sorting makes the pick deterministic when a patchset touches more than
 * one feature.
 */
export function selectedKiroFeatureName(changedFilePaths: readonly string[]): string | null {
  const names = new Set<string>();
  for (const path of changedFilePaths) {
    const normalised = path.replace(/\\/g, "/");
    if (!normalised.startsWith(SPECS_PREFIX)) continue;
    const name = normalised.slice(SPECS_PREFIX.length).split("/")[0];
    if (name && name.length > 0) names.add(name);
  }
  return [...names].sort(byName)[0] ?? null;
}

/** Read a repo-relative file at the reviewed state, or `undefined` when it is absent. */
type ReadArtifact = (repoRelativePath: string) => Promise<string | undefined>;

/**
 * Read the Kiro feature the reviewed patchset selected, parsed into the structured
 * `KiroSpec` the Design angle renders — reading each artifact from the immutable
 * reviewed tree (`reviewedTreeOid ?? headOid`).
 * Returns `null` when the patchset touches no `.kiro/specs/<feature>/` — the honest
 * "no Kiro spec in this review" case.
 */
export async function readKiroSpec(patchset: Patchset, git: GitExec): Promise<KiroSpec | null> {
  const source = await readKiroSpecSource(patchset, git);
  return source === null ? null : parseKiroSpec(source);
}

/**
 * The raw artifact text for the Kiro feature the reviewed patchset selected, read from
 * the immutable reviewed tree — the same read {@link readKiroSpec} does, WITHOUT the
 * parse step. The Design assembler consumes this raw source directly (a deterministic
 * host-side board build, no model turn), while the Spec angle parses it.
 * Returns `null` when the patchset touches no `.kiro/specs/<feature>/`.
 */
export async function readKiroSpecSource(
  patchset: Patchset,
  git: GitExec,
): Promise<KiroSpecSource | null> {
  const feature = selectedKiroFeatureName(patchset.files.map((file) => file.path));
  if (feature === null) return null;

  const root = patchset.repository.root;
  const featureRel = `${SPECS_PREFIX}${feature}`;
  const reviewedOid = patchset.repository.reviewedTreeOid ?? patchset.repository.headOid;
  const gitShow = createGitShowFileRead({ git, repositoryRoot: root, headOid: reviewedOid });
  const read: ReadArtifact = (rel) => gitShow(join(root, rel));

  const [requirementsMd, designMd, tasksMd, bugfixMd] = await Promise.all([
    read(`${featureRel}/requirements.md`),
    read(`${featureRel}/design.md`),
    read(`${featureRel}/tasks.md`),
    read(`${featureRel}/bugfix.md`),
  ]);

  // A deletion-only patchset names the feature via its removed paths, but no artifact
  // survives at the reviewed tree — that is "no Kiro spec here", not an empty spec.
  if (
    requirementsMd === undefined &&
    designMd === undefined &&
    tasksMd === undefined &&
    bugfixMd === undefined
  )
    return null;

  return {
    feature,
    ...(requirementsMd !== undefined ? { requirementsMd } : {}),
    ...(designMd !== undefined ? { designMd } : {}),
    ...(tasksMd !== undefined ? { tasksMd } : {}),
    ...(bugfixMd !== undefined ? { bugfixMd } : {}),
  };
}
