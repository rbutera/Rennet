import { join } from "node:path";
import { type GrillDoc, type GrillSpecSource, parseGrillSpec } from "@rennet/core";
import type { GrillSpec, Patchset } from "@rennet/protocol";
import { createGitShowFileRead } from "./finding-verification-backend";
import type { GitExec } from "./git-range-diff";

// ─────────────────────────────────────────────────────────────────────────────
// Live grill-with-docs source (the parse-on-open half of the Design lens's grill
// path). Mirrors `openspec-change-reader.ts`.
//
// grill-with-docs has no fixed artifact directory. Its documents are ordinary repo
// files — architecture decision records under `docs/adr/**` / `docs/decisions/**`
// and a `CONTEXT.md` glossary / context map. So the reader selects the grill
// documents the reviewed patchset TOUCHES, and reads each AT THE REVIEWED HEAD, not
// off an arbitrary checkout:
//
// Local reviews pin their working-tree bytes in `reviewedTreeOid`; range / PR /
// retrospective reviews use `headOid`. Both are immutable Git objects, so later disk
// edits cannot rewrite a captured board. A legacy local patchset without the new
// field falls back to its committed head.
//
// Deterministic and model-free — no model turn, no gate. When the patchset touches no
// grill document, it returns `null` and the lens shows its honest empty state.
//
// Selecting on CHANGED paths mirrors the OpenSpec reader and is deliberately narrow:
// a decision the change was written against but did not itself touch is out of scope
// here — the Design lens's own investigation (commit history, PR body) finds those.
// ─────────────────────────────────────────────────────────────────────────────

const ADR_PREFIXES = ["docs/adr/", "docs/decisions/"] as const;
const byPath = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Normalise a changed path to forward slashes with no leading `./`. */
function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True for a Markdown ADR under `docs/adr/**` or `docs/decisions/**`. */
function isAdrPath(path: string): boolean {
  return path.endsWith(".md") && ADR_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** True for a `CONTEXT.md` (case-insensitive basename) anywhere in the tree. */
function isContextPath(path: string): boolean {
  return (path.split("/").at(-1) ?? "").toLowerCase() === "context.md";
}

/**
 * The grill documents the reviewed patchset touches, split by kind and sorted for a
 * deterministic reading order. Empty arrays when the patchset touches none.
 */
export function selectedGrillDocPaths(changedFilePaths: readonly string[]): {
  readonly adrs: string[];
  readonly contextDocs: string[];
} {
  const adrs = new Set<string>();
  const contextDocs = new Set<string>();
  for (const raw of changedFilePaths) {
    const path = normalise(raw);
    if (isAdrPath(path)) adrs.add(path);
    else if (isContextPath(path)) contextDocs.add(path);
  }
  return { adrs: [...adrs].sort(byPath), contextDocs: [...contextDocs].sort(byPath) };
}

/**
 * Read the grill-with-docs specification the reviewed patchset touched, parsed into
 * the structured `GrillSpec` the Design lens renders — reading each document from the
 * immutable reviewed tree (`reviewedTreeOid ?? headOid`). Returns `null` when the
 * patchset touches no grill document — the honest "no grill spec in this review" case.
 */
export async function readGrillSpec(patchset: Patchset, git: GitExec): Promise<GrillSpec | null> {
  const selected = selectedGrillDocPaths(patchset.files.map((file) => file.path));
  if (selected.adrs.length === 0 && selected.contextDocs.length === 0) return null;

  const root = patchset.repository.root;
  const reviewedOid = patchset.repository.reviewedTreeOid ?? patchset.repository.headOid;
  const gitShow = createGitShowFileRead({ git, repositoryRoot: root, headOid: reviewedOid });

  const readDocs = async (paths: readonly string[]): Promise<GrillDoc[]> => {
    const docs: GrillDoc[] = [];
    for (const path of paths) {
      const md = await gitShow(join(root, path));
      if (md !== undefined) docs.push({ path, md });
    }
    return docs;
  };

  const [adrs, contextDocs] = await Promise.all([
    readDocs(selected.adrs),
    readDocs(selected.contextDocs),
  ]);
  if (adrs.length === 0 && contextDocs.length === 0) return null;

  const source: GrillSpecSource = {
    ...(adrs.length === 0 ? {} : { adrs }),
    ...(contextDocs.length === 0 ? {} : { contextDocs }),
  };
  return parseGrillSpec(source);
}
