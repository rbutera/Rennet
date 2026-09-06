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
// files — architecture decision records under a `docs/adr/**` / `docs/decisions/**`
// directory AT ANY DEPTH (a multi-context repo keeps context-local ADRs under
// `src/<context>/docs/adr/**`), a `CONTEXT.md` glossary, and — in a multi-context
// repo — a root `CONTEXT-MAP.md`. So the reader selects the grill documents the
// reviewed patchset TOUCHES, and reads each AT THE REVIEWED HEAD, not off an
// arbitrary checkout:
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

// A `docs/adr/` or `docs/decisions/` directory at any depth — the root's own or a
// context-local `src/<context>/docs/adr/`. `(^|/)` anchors the segment to a path
// boundary so a stray `mydocs/adr/` never matches.
const ADR_DIR = /(^|\/)docs\/(adr|decisions)\//;
const byPath = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Normalise a changed path to forward slashes with no leading `./`. */
function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True for a Markdown ADR under a `docs/adr/**` or `docs/decisions/**` dir at any depth. */
function isAdrPath(path: string): boolean {
  return path.endsWith(".md") && ADR_DIR.test(path);
}

/** True for a `CONTEXT.md` (case-insensitive basename) anywhere in the tree. */
function isContextPath(path: string): boolean {
  return (path.split("/").at(-1) ?? "").toLowerCase() === "context.md";
}

/** True for a `CONTEXT-MAP.md` (case-insensitive basename) — the multi-context marker. */
function isContextMapPath(path: string): boolean {
  return (path.split("/").at(-1) ?? "").toLowerCase() === "context-map.md";
}

/**
 * The grill documents the reviewed patchset touches, split by kind and sorted for a
 * deterministic reading order. Empty arrays when the patchset touches none.
 */
export function selectedGrillDocPaths(changedFilePaths: readonly string[]): {
  readonly adrs: string[];
  readonly contextDocs: string[];
  readonly contextMaps: string[];
} {
  const adrs = new Set<string>();
  const contextDocs = new Set<string>();
  const contextMaps = new Set<string>();
  for (const raw of changedFilePaths) {
    const path = normalise(raw);
    if (isAdrPath(path)) adrs.add(path);
    else if (isContextMapPath(path)) contextMaps.add(path);
    else if (isContextPath(path)) contextDocs.add(path);
  }
  return {
    adrs: [...adrs].sort(byPath),
    contextDocs: [...contextDocs].sort(byPath),
    contextMaps: [...contextMaps].sort(byPath),
  };
}

/**
 * Read the grill-with-docs specification the reviewed patchset touched, parsed into
 * the structured `GrillSpec` the Design lens renders — reading each document from the
 * immutable reviewed tree (`reviewedTreeOid ?? headOid`). Returns `null` when the
 * patchset touches no grill document — the honest "no grill spec in this review" case.
 */
export async function readGrillSpec(patchset: Patchset, git: GitExec): Promise<GrillSpec | null> {
  const source = await readGrillSpecSource(patchset, git);
  return source === null ? null : parseGrillSpec(source);
}

/**
 * The raw document text for the grill-with-docs specification the reviewed patchset
 * touched, read from the immutable reviewed tree — the same read {@link readGrillSpec}
 * does, WITHOUT the parse step. The Design assembler consumes this raw source directly
 * (a deterministic host-side board build, no model turn), while the Spec angle parses
 * it. Returns `null` when the patchset touches no grill document.
 */
export async function readGrillSpecSource(
  patchset: Patchset,
  git: GitExec,
): Promise<GrillSpecSource | null> {
  const selected = selectedGrillDocPaths(patchset.files.map((file) => file.path));
  if (
    selected.adrs.length === 0 &&
    selected.contextDocs.length === 0 &&
    selected.contextMaps.length === 0
  )
    return null;

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

  const [adrs, contextDocs, contextMaps] = await Promise.all([
    readDocs(selected.adrs),
    readDocs(selected.contextDocs),
    readDocs(selected.contextMaps),
  ]);
  if (adrs.length === 0 && contextDocs.length === 0 && contextMaps.length === 0) return null;

  return {
    ...(adrs.length === 0 ? {} : { adrs }),
    ...(contextDocs.length === 0 ? {} : { contextDocs }),
    ...(contextMaps.length === 0 ? {} : { contextMaps }),
  };
}
