import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseOpenSpecChange } from "@rennet/core";
import type { OpenSpecChange } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// Live OpenSpec source (the parse-on-open half of the Spec angle).
//
// The Spec angle renders the review's ACTUALLY-SELECTED OpenSpec change, parsed
// from disk on open — replacing the frozen fixture. The real use case is reviewing
// a PR that adds or edits a change under `openspec/changes/<name>/`: this reader
// finds that change from the reviewed patchset's changed paths and reads its
// artifacts from the review's checked-out repository root (the files AS REVIEWED),
// then hands the strings to the node-free `parseOpenSpecChange`.
//
// Deterministic and model-free — no model turn, no gate. When the review touches no
// change, it returns `null` and the Spec angle shows its honest empty state rather
// than a fixture.
// ─────────────────────────────────────────────────────────────────────────────

const CHANGES_PREFIX = "openspec/changes/";

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
    const rest = normalised.slice(CHANGES_PREFIX.length);
    const name = rest.split("/")[0];
    if (name && name.length > 0) names.add(name);
  }
  const sorted = [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return sorted[0] ?? null;
}

/** Read a file as UTF-8, or `undefined` when it does not exist (an optional artifact). */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read every `specs/<capability>/spec.md` under a change dir, in sorted capability order. */
async function readSpecDeltas(changeDir: string): Promise<{ capability: string; md: string }[]> {
  const specsDir = join(changeDir, "specs");
  const entries = await readdir(specsDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const capabilities = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const deltas: { capability: string; md: string }[] = [];
  for (const capability of capabilities) {
    const md = await readOptional(join(specsDir, capability, "spec.md"));
    if (md !== undefined) deltas.push({ capability, md });
  }
  return deltas;
}

/**
 * Read the OpenSpec change the reviewed patchset selected, parsed into the structured
 * `OpenSpecChange` the Spec angle renders. `repositoryRoot` is the review's checked-out
 * root; `changedFilePaths` are the patchset's changed paths (used to pick the change).
 * Returns `null` when the patchset touches no `openspec/changes/<name>/` — the honest
 * "no OpenSpec change in this review" case.
 */
export async function readOpenSpecChange(
  repositoryRoot: string,
  changedFilePaths: readonly string[],
): Promise<OpenSpecChange | null> {
  const name = selectedOpenSpecChangeName(changedFilePaths);
  if (name === null) return null;

  const changeDir = resolve(repositoryRoot, CHANGES_PREFIX, name);
  const [proposalMd, designMd, tasksMd, specDeltas] = await Promise.all([
    readOptional(join(changeDir, "proposal.md")),
    readOptional(join(changeDir, "design.md")),
    readOptional(join(changeDir, "tasks.md")),
    readSpecDeltas(changeDir),
  ]);

  return parseOpenSpecChange({
    name,
    ...(proposalMd !== undefined ? { proposalMd } : {}),
    ...(designMd !== undefined ? { designMd } : {}),
    ...(tasksMd !== undefined ? { tasksMd } : {}),
    specDeltas,
  });
}
