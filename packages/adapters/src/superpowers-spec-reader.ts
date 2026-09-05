import { join } from "node:path";
import { parseSuperpowersSpec, type SuperpowersSpecSource } from "@rennet/core";
import type { Patchset, SuperpowersSpec } from "@rennet/protocol";
import { createGitShowFileRead } from "./finding-verification-backend";
import type { GitExec } from "./git-range-diff";

// ─────────────────────────────────────────────────────────────────────────────
// Live Superpowers source (the parse-on-open half of the Spec angle, for the
// Superpowers format). Mirrors `openspec-change-reader.ts`: the reviewed patchset's
// changed paths select the artifacts, and each is read AT THE REVIEWED HEAD
// (`reviewedTreeOid ?? headOid`) — an immutable Git object, so later disk edits
// cannot rewrite a captured Spec board.
//
// A Superpowers feature's artifacts live at three conventional locations:
//   • design SPEC   — docs/superpowers/specs/<feature>.md
//   • execution PLAN — docs/superpowers/plans/<date>-<feature>.md
//   • progress LEDGER — .superpowers/sdd/<feature>/progress.md
// The changed paths drive selection (any of the three the diff touches). A plan's
// `**Spec:**` pointer resolves its design spec even when the spec itself is not in
// the diff, so a plan-only review still renders its stated spec.
//
// Deterministic and model-free — no model turn, no gate. When the patchset touches
// no Superpowers artifact, it returns `null` and the Spec angle shows its empty state.
// ─────────────────────────────────────────────────────────────────────────────

const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const normalise = (path: string): string => path.replace(/\\/g, "/");

/** The changed paths that are Superpowers artifacts, classified and sorted. */
export interface SuperpowersArtifactPaths {
  readonly plans: readonly string[];
  readonly specs: readonly string[];
  readonly progress: readonly string[];
}

function classify(path: string): keyof SuperpowersArtifactPaths | null {
  const lower = normalise(path).toLowerCase();
  if (!lower.endsWith(".md")) return null;
  if (lower.includes("/superpowers/plans/")) return "plans";
  if (lower.includes("/superpowers/specs/")) return "specs";
  // The ledger lives under `.superpowers/…/progress.md` (its own root, not docs/).
  if (lower.includes("superpowers") && lower.endsWith("/progress.md")) return "progress";
  return null;
}

/**
 * Classify a patchset's changed paths into Superpowers plan/spec/progress artifacts.
 * Each list is de-duplicated and sorted, so selection is deterministic when a patchset
 * touches more than one artifact of a kind.
 */
export function selectedSuperpowersArtifacts(
  changedFilePaths: readonly string[],
): SuperpowersArtifactPaths {
  const buckets: Record<keyof SuperpowersArtifactPaths, Set<string>> = {
    plans: new Set(),
    specs: new Set(),
    progress: new Set(),
  };
  for (const path of changedFilePaths) {
    const kind = classify(path);
    if (kind !== null) buckets[kind].add(normalise(path));
  }
  return {
    plans: [...buckets.plans].sort(byName),
    specs: [...buckets.specs].sort(byName),
    progress: [...buckets.progress].sort(byName),
  };
}

/**
 * The feature name: a plan's stem (date prefix stripped), else a spec's stem, else the
 * progress ledger's session DIRECTORY (`.superpowers/sdd/<feature>/progress.md` — the
 * basename is always `progress`, so the feature is the parent dir).
 */
function featureName(paths: SuperpowersArtifactPaths): string {
  const named = paths.plans[0] ?? paths.specs[0];
  if (named !== undefined) {
    const base = named.split("/").at(-1)?.replace(/\.md$/i, "") ?? "superpowers";
    return base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  }
  const progress = paths.progress[0];
  if (progress !== undefined) {
    const dir = normalise(progress).split("/").at(-2);
    if (dir !== undefined && dir.length > 0) return dir;
  }
  return "superpowers";
}

/** A repo-relative `**Spec:**` pointer from a plan's header, or `undefined`. */
function planSpecPointer(md: string): string | undefined {
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    // Stop at the first task group — the header is above it.
    if (/^\s{0,3}###\s+Task\s+\d/i.test(line)) break;
    const value = /^\s*\*\*Spec:\*\*\s*(\S(?:.*\S)?)\s*$/.exec(line)?.[1];
    if (value !== undefined) return normalise(value.trim());
  }
  return undefined;
}

/**
 * Read the Superpowers feature the reviewed patchset selected, parsed into the
 * structured `SuperpowersSpec` the Spec angle renders — reading each artifact from
 * the immutable reviewed tree (`reviewedTreeOid ?? headOid`). Returns `null` when the
 * patchset touches no Superpowers artifact, or when every selected artifact is absent at
 * the reviewed tree (a deletion-only review).
 */
export async function readSuperpowersSpec(
  patchset: Patchset,
  git: GitExec,
): Promise<SuperpowersSpec | null> {
  const paths = selectedSuperpowersArtifacts(patchset.files.map((file) => file.path));
  if (paths.plans.length === 0 && paths.specs.length === 0 && paths.progress.length === 0) {
    return null;
  }

  const root = patchset.repository.root;
  const reviewedOid = patchset.repository.reviewedTreeOid ?? patchset.repository.headOid;
  const gitShow = createGitShowFileRead({ git, repositoryRoot: root, headOid: reviewedOid });
  const read = (rel: string): Promise<string | undefined> => gitShow(join(root, rel));

  async function readAll(rels: readonly string[]): Promise<{ path: string; md: string }[]> {
    const out: { path: string; md: string }[] = [];
    for (const rel of rels) {
      const md = await read(rel);
      if (md !== undefined) out.push({ path: rel, md });
    }
    return out;
  }

  const [plans, changedSpecs, progress] = await Promise.all([
    readAll(paths.plans),
    readAll(paths.specs),
    readAll(paths.progress),
  ]);

  // Resolve each plan's `**Spec:**` pointer, reading any design spec not already in the diff.
  const specByPath = new Map(changedSpecs.map((spec) => [spec.path, spec] as const));
  for (const plan of plans) {
    const pointer = planSpecPointer(plan.md);
    if (pointer === undefined || specByPath.has(pointer)) continue;
    const md = await read(pointer);
    if (md !== undefined) specByPath.set(pointer, { path: pointer, md });
  }
  const specs = [...specByPath.values()].sort((left, right) => byName(left.path, right.path));

  // Deletion-only review: the paths classified as artifacts, but every one is absent at the
  // reviewed tree (the diff removed them). There is nothing to render — return null, not an
  // empty spec that reads as "a Superpowers feature with no content".
  if (plans.length === 0 && specs.length === 0 && progress.length === 0) return null;

  const source: SuperpowersSpecSource = {
    name: featureName(paths),
    specs,
    plans,
    progress,
  };
  return parseSuperpowersSpec(source);
}
