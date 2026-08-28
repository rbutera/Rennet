/**
 * The deterministic decomposition floor (issue #7).
 *
 * The always-present, offline, zero-model pass over a captured `Patchset`. It
 * classifies every hunk mechanical-vs-substantive (the ONLY admission authority
 * for verified noise — Contracts R9), groups `file → enclosingSymbol`, chunks the
 * substantive change to a ≤400 changed-LOC budget (splitting an oversize hunk so
 * the budget holds — R18), and computes the code-dependency DAG plus its
 * topological reading order.
 *
 * This is the FLOOR under the hybrid (R9), not the semantic authority, and it is
 * the ordering BASELINE the agent comprehension-ordering pass (#9) reads through.
 * Ordering here is LOGICAL / dependency-based (import edges + a reading-layer
 * tiebreak), never danger / blast-radius / salience (Contracts §1, correction 8).
 *
 * The whole module is a pure function of its inputs: no network, no model, no
 * clock, no filesystem. `decompose(p)` is byte-stable across two runs on the same
 * patchset. The optional tree-sitter symbol enrichment is injected through a port
 * and degrades to `""` when no grammar is available; a missing grammar never
 * blocks the floor.
 */

import {
  type Decomposition,
  type DecompositionBlockingState,
  type DecompositionChunk,
  type DecompositionEdge,
  DIFF_TRUNCATION_MARKER,
  type Hunk,
  type HunkClassification,
  type MechanicalClass,
  type PatchFile,
  type Patchset,
} from "@rennet/protocol";
import { importSpecifiers, resolveCandidate, resolveRelative } from "./import-specifiers";

/** The SmartBear/Cisco 400-LOC review ceiling (Architecture Plan D7 step 3). */
export const DEFAULT_MAX_CHUNK_LOC = 400;

/** The reading layers, low → high: schema, types, core, ui, tests, config, appendix. */
const LAYER = {
  schema: 0,
  types: 1,
  core: 2,
  ui: 3,
  tests: 4,
  config: 5,
  appendix: 6,
} as const;

/**
 * The enclosing-symbol enrichment port. A real implementation (tree-sitter, an
 * adapters concern) parses each file's post-image ONCE and answers for all its
 * hunks (parse-once-dispose — R18). It MUST NOT throw and MUST return `""` where
 * no grammar is available or no symbol encloses the change: a missing grammar
 * degrades, never blocks. The returned array is aligned index-for-index to
 * `hunks`.
 */
export interface SymbolExtractor {
  enclosingSymbols(filePath: string, hunks: readonly Hunk[]): readonly string[];
}

/** The floor's default: every symbol degrades to `""` (group by file alone). */
export const DEGRADED_SYMBOL_EXTRACTOR: SymbolExtractor = {
  enclosingSymbols(_filePath, hunks) {
    return hunks.map(() => "");
  },
};

export interface DecomposeOptions {
  /** The chunk budget in changed LOC. Defaults to `DEFAULT_MAX_CHUNK_LOC`. */
  readonly maxChunkLoc?: number;
  /** Tree-sitter enrichment; defaults to the degraded (`""`) extractor. */
  readonly symbolExtractor?: SymbolExtractor;
}

// ── Raw hunk parsing ─────────────────────────────────────────────────────────

export interface RawHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /**
   * The verbatim `@@` header line as it appeared in the patch. Present on hunks
   * straight from `parseFilePatch`; absent on synthesized fragments (R18 split),
   * whose recomputed ranges no longer match any source line.
   */
  header?: string;
  /** Body lines with their unified-diff prefix (`+`/`-`/` `). */
  body: string[];
}

export interface ParsedFile {
  hunks: RawHunk[];
  hasModeChange: boolean;
  /** Present when the preamble carries both `old mode`/`new mode` lines. */
  modeChange?: { old: string; new: string };
}

export const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseFilePatch(patch: string): ParsedFile {
  const lines = patch.split("\n");
  const hunks: RawHunk[] = [];
  let current: RawHunk | null = null;
  let hasModeChange = false;
  let oldMode: string | undefined;
  let newMode: string | undefined;
  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        header: line,
        body: [],
      };
      continue;
    }
    if (current === null) {
      // Preamble, before the first hunk: the only signal we read here is a mode
      // change (a mode-only file has no hunk body at all).
      const mode = /^(old|new) mode (\d+)$/.exec(line);
      if (mode) {
        hasModeChange = true;
        if (mode[1] === "old") oldMode = mode[2];
        else newMode = mode[2];
      }
      continue;
    }
    const first = line.charAt(0);
    if (first === "+" || first === "-" || first === " ") current.body.push(line);
    // "\ No newline at end of file" and blank inter-hunk lines are not body: ignore.
  }
  if (current) hunks.push(current);
  return {
    hunks,
    hasModeChange,
    ...(oldMode !== undefined && newMode !== undefined
      ? { modeChange: { old: oldMode, new: newMode } }
      : {}),
  };
}

export function addedOf(body: readonly string[]): string[] {
  return body.filter((l) => l.charAt(0) === "+").map((l) => l.slice(1));
}

export function deletedOf(body: readonly string[]): string[] {
  return body.filter((l) => l.charAt(0) === "-").map((l) => l.slice(1));
}

function contextOf(body: readonly string[]): string[] {
  return body.filter((l) => l.charAt(0) === " ").map((l) => l.slice(1));
}

function changedLocOf(body: readonly string[]): number {
  return body.filter((l) => l.charAt(0) === "+" || l.charAt(0) === "-").length;
}

// ── Oversize hunk splitting (R18) ────────────────────────────────────────────

/**
 * Split one raw hunk's body into contiguous fragments each carrying ≤ `maxLoc`
 * changed lines, recomputing each fragment's line ranges. A hunk with ≤ `maxLoc`
 * changed lines is returned unchanged (as a single-element array). Cuts fall
 * before a changed line so no fragment straddles a `+`/`-` boundary mid-line.
 */
function splitOversizeRawHunk(hunk: RawHunk, maxLoc: number): RawHunk[] {
  if (changedLocOf(hunk.body) <= maxLoc) return [hunk];

  const fragments: RawHunk[] = [];
  let oldCursor = hunk.oldStart;
  let newCursor = hunk.newStart;
  let fragBody: string[] = [];
  let fragOldStart = hunk.oldStart;
  let fragNewStart = hunk.newStart;
  let fragOldLines = 0;
  let fragNewLines = 0;
  let fragChanged = 0;

  const flush = (): void => {
    fragments.push({
      oldStart: fragOldStart,
      oldLines: fragOldLines,
      newStart: fragNewStart,
      newLines: fragNewLines,
      body: fragBody,
    });
    fragBody = [];
    fragOldStart = oldCursor;
    fragNewStart = newCursor;
    fragOldLines = 0;
    fragNewLines = 0;
    fragChanged = 0;
  };

  for (const line of hunk.body) {
    const first = line.charAt(0);
    const isChanged = first === "+" || first === "-";
    if (isChanged && fragChanged >= maxLoc && fragBody.length > 0) flush();
    fragBody.push(line);
    if (first === "+") {
      newCursor += 1;
      fragNewLines += 1;
      fragChanged += 1;
    } else if (first === "-") {
      oldCursor += 1;
      fragOldLines += 1;
      fragChanged += 1;
    } else {
      oldCursor += 1;
      newCursor += 1;
      fragOldLines += 1;
      fragNewLines += 1;
    }
  }
  if (fragBody.length > 0) flush();
  return fragments;
}

// ── Mechanical classification ────────────────────────────────────────────────

const LOCKFILE_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "podfile.lock",
  "mix.lock",
  "pubspec.lock",
  "packages.lock.json",
  "gradle.lockfile",
]);

const VENDOR_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "third-party",
  "bower_components",
  "pods",
  ".yarn",
  "godeps",
]);

const GENERATED_SEGMENTS = new Set(["dist", "build", "generated", "__generated__"]);

const GENERATED_MARKERS = ["@generated", "do not edit", "code generated by", "generated file"];

/**
 * How many lines of the NEW file count as the "header region" for generated-file
 * marker detection. Generated-file banners ("@generated", "Code generated by …",
 * "DO NOT EDIT") are emitted at the very top of the file by the generator, so a
 * marker beyond this region is not a generated-file signal.
 *
 * Chosen at 10: real banners sit on line 1-2, but a leading license block, a
 * shebang, or a few blank/comment lines can push a banner down a handful of
 * lines, so 10 gives comfortable slack while still excluding the file body.
 */
const GENERATED_HEADER_LINES = 10;

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function isLockfile(path: string): boolean {
  return LOCKFILE_BASENAMES.has(basename(path).toLowerCase());
}

function isVendored(path: string): boolean {
  return segments(path).some((s) => VENDOR_SEGMENTS.has(s.toLowerCase()));
}

export function isGeneratedPath(path: string): boolean {
  const base = basename(path).toLowerCase();
  if (/\.(min\.js|min\.css|map)$/.test(base)) return true;
  if (/\.pb\.go$/.test(base) || /_pb2\.py$/.test(base) || /\.g\.dart$/.test(base)) return true;
  if (/\.generated\./.test(base)) return true;
  return segments(path).some((s) => GENERATED_SEGMENTS.has(s.toLowerCase()));
}

/** git's own-line binary-hunk header (`--binary` / full-index form). */
const GIT_BINARY_PATCH = /^GIT binary patch$/m;
/** git's default bodyless-binary sentinel. */
const BINARY_FILES_DIFFER = /^Binary files .+ differ$/m;

/**
 * A binary blob: not text-diffable, so the floor cannot ingest its content.
 * `binary` is set by the capture. The two structural sentinels are defensive
 * backstops for the paths that do NOT set it: `Binary files … differ` (git's
 * default) and a `GIT binary patch` header (git's `--binary` / full-index form,
 * which the REST parser does not currently flag — so without this a real binary
 * blob would become a synthetic zero-LOC substantive hunk).
 */
function isBinaryFile(file: PatchFile): boolean {
  if (file.binary) return true;
  return BINARY_FILES_DIFFER.test(file.patch) || GIT_BINARY_PATCH.test(file.patch);
}

/**
 * A submodule (gitlink) pointer advance: the diff records the child repo's OID
 * moving, never the child's own changes, so the content behind the pointer is not
 * ingested.
 *
 * Detection is STRUCTURAL and keyed on metadata that ordinary file content cannot
 * forge, NOT on the `Subproject commit <oid>` body line — a real text file whose
 * content is literally `Subproject commit deadbeef` would otherwise be
 * misclassified as a submodule and hidden in the appendix (the worst direction).
 * Every real git submodule form carries one of:
 *  - the `160000` gitlink tree mode, in the index line (modified) or a mode line
 *    (added/deleted);
 *  - git's `diff.submodule=log` block, whose `Submodule <path> …` lines sit at
 *    column 0 (never a `+`/`-` diff body line, so they cannot collide with file
 *    content): a pointer advance `Submodule <path> <a>..<b>[:| (status)]` (path may
 *    contain spaces; range `..` or `...`; OID any length, incl. sha-256), or a
 *    dirty working tree `Submodule <path> contains modified/untracked content`.
 *
 * The invariant that keeps this honest: detection NEVER keys on a `+`/`-` diff
 * body line. A `Subproject commit <oid>` body line — even with git's `-dirty`
 * suffix — is forgeable by ordinary file content, and stamping such a file
 * `submodule` would hide a real change in the appendix (the dangerous direction).
 * So a submodule whose diff carries ONLY the bare pointer body line and no
 * column-0 metadata (e.g. the short-form dirty `+…-dirty`) stays substantive — its
 * `-/+ Subproject commit` lines remain VISIBLE to the reviewer (the safe
 * direction); it just misses the ingestion-gap badge.
 */
function isSubmoduleChange(file: PatchFile): boolean {
  const p = file.patch;
  const gitlink =
    /^index [0-9a-f]+\.+[0-9a-f]+ 160000\b/m.test(p) ||
    /^(?:old|new|new file|deleted file) mode 160000\b/m.test(p) ||
    /^Submodule .+? [0-9a-f]+\.{2,3}[0-9a-f]+/m.test(p) ||
    /^Submodule .+ contains (?:modified|untracked) content/m.test(p);
  if (!gitlink) return false;
  // A gitlink↔regular-file TYPE CHANGE carries BOTH a 160000 signal and a regular
  // file-mode section (`100644`/`100755`/`120000`) in the same PatchFile; the
  // regular half is real reviewable text that must not be hidden in the appendix.
  // When both are present, fall back to substantive — the safe direction.
  const regularFile =
    /^(?:old|new|new file|deleted file) mode (?:100644|100755|120000)\b/m.test(p) ||
    /^index [0-9a-f]+\.+[0-9a-f]+ (?:100644|100755|120000)\b/m.test(p);
  return !regularFile;
}

/**
 * A file diff truncated by the capture. The `DIFF_TRUNCATION_MARKER` is emitted
 * ONLY as a terminal frame (`…content\n\n<marker>`) by `visible()`; requiring the
 * blank-line frame at end-of-patch keeps a source line that happens to contain
 * the literal marker text from raising a false truncation gap.
 */
export function patchHasTruncationFrame(patch: string): boolean {
  const trimmed = patch.replace(/\s+$/, "");
  if (!trimmed.endsWith(DIFF_TRUNCATION_MARKER)) return false;
  const before = trimmed.slice(0, trimmed.length - DIFF_TRUNCATION_MARKER.length);
  return before.endsWith("\n\n");
}

/**
 * True when a generated-file marker sits in the file HEADER region.
 *
 * Marker detection must be scoped to the top of the NEW file, not anywhere in
 * the diff. `generatedByMarker` is file-scoped: a single matching hunk stamps
 * EVERY hunk in the file `generated` and routes them to the skimmed appendix.
 * A stray "// do not edit by hand" comment buried in the file body is not a
 * generated-file signal, so honouring it there hides a real hand-edit from
 * review as verified noise (acceptance #5, the worst false-negative direction).
 *
 * The port reads unified diffs, not full files, so the header is only visible
 * when a hunk covers the top of the file. We walk each non-deleted body line and
 * track its line number in the NEW file (`newStart` is the first such line;
 * added and context lines advance it, deleted lines do not exist in the new
 * file). A marker is honoured only while that line number is within the header
 * region. A generated file modified only deep in its body without a path signal
 * therefore falls through to review rather than the appendix — the SAFE
 * direction: a generated file shown to a reviewer is harmless; a hand-edit
 * hidden in the appendix is not.
 */
function hasGeneratedHeaderMarker(hunk: RawHunk): boolean {
  if (hunk.newStart > GENERATED_HEADER_LINES) return false;
  let newLineNo = hunk.newStart;
  for (const line of hunk.body) {
    if (line.charAt(0) === "-") continue; // deleted: not present in the new file
    if (newLineNo > GENERATED_HEADER_LINES) break;
    const lower = line.slice(1).toLowerCase();
    if (GENERATED_MARKERS.some((marker) => lower.includes(marker))) return true;
    newLineNo += 1; // an added or context line occupies a line in the new file
  }
  return false;
}

function stripAllWhitespace(lines: readonly string[]): string {
  return lines.join("\n").replace(/\s+/g, "");
}

/**
 * A hunk is formatting-only when its added and deleted content are identical
 * after removing all whitespace, and both sides are non-empty (a pure insertion
 * or deletion is substantive, not a reformat).
 */
function isFormattingOnly(body: readonly string[]): boolean {
  const added = addedOf(body);
  const deleted = deletedOf(body);
  if (added.length === 0 || deleted.length === 0) return false;
  return stripAllWhitespace(added) === stripAllWhitespace(deleted);
}

/** The file-level mechanical class, if any: signals that stamp every hunk. */
function fileMechanicalClass(file: PatchFile): MechanicalClass | null {
  // Un-ingestable content first: a binary blob or a submodule pointer must never
  // read as reviewed substantive change, whatever its path (R18). The parallel
  // blocking state names it as un-ingested.
  if (isSubmoduleChange(file)) return "submodule";
  if (isBinaryFile(file)) return "binary";
  if (isLockfile(file.path)) return "lockfile";
  if (isVendored(file.path)) return "vendored";
  if (isGeneratedPath(file.path)) return "generated";
  return null;
}

/**
 * The incomplete-ingestion blockers for a patchset (R18). Deterministic: any
 * patchset-wide truncation first, then per-file states in the caller's
 * path-sorted file order. A file can carry more than one state, for example a
 * truncated binary.
 */
function collectBlockingStates(
  patchset: Patchset,
  files: readonly PatchFile[],
): DecompositionBlockingState[] {
  const states: DecompositionBlockingState[] = [];
  if (patchset.truncated) {
    states.push({
      reason: "truncated",
      path: null,
      detail:
        "The captured diff was truncated at the size cap; changes past the cut were not " +
        "ingested and are not reviewed. Absence of findings over the un-ingested tail is not " +
        "evidence of cleanliness.",
    });
  }
  for (const file of files) {
    if (patchHasTruncationFrame(file.patch)) {
      states.push({
        reason: "truncated",
        path: file.path,
        detail: `${file.path}: the diff was truncated at the size cap; content past the cut was not ingested.`,
      });
    }
    if (isSubmoduleChange(file)) {
      states.push({
        reason: "submodule",
        path: file.path,
        detail: `${file.path}: submodule change; the child repository's own content is not part of this diff.`,
      });
    } else if (isBinaryFile(file)) {
      states.push({
        reason: "binary",
        path: file.path,
        detail: `${file.path}: binary file; its content is not text-diffable and was not ingested for review.`,
      });
    }
  }
  return states;
}

// ── Reading layers ───────────────────────────────────────────────────────────

function isTest(path: string): boolean {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return true;
  return segments(path).some(
    (s) => s === "__tests__" || s === "test" || s === "tests" || s === "e2e",
  );
}

function isSchema(path: string): boolean {
  if (/\.(sql|prisma)$/.test(path)) return true;
  return segments(path).some((s) => s === "migration" || s === "migrations" || s === "schema");
}

function isTypes(path: string): boolean {
  if (/\.d\.ts$/.test(path)) return true;
  if (path.startsWith("packages/types/")) return true;
  return segments(path).some((s) => s === "types");
}

function isConfig(path: string): boolean {
  const base = basename(path).toLowerCase();
  if (/\.(json|ya?ml|toml|ini)$/.test(base)) return true;
  if (/\.config\.[cm]?[jt]s$/.test(base)) return true;
  if (base.startsWith(".") || base.startsWith("tsconfig")) return true;
  return false;
}

function isUi(path: string): boolean {
  if (/\.(tsx|jsx|css|scss|less|html)$/.test(path)) return true;
  // `ui` is the vendored kit (packages/ui); `app-ui` is Rennet's composites
  // (packages/app-ui, renamed from packages/ui) — both are UI, not core.
  return segments(path).some(
    (s) => s === "ui" || s === "app-ui" || s === "components" || s === "renderer",
  );
}

function layerOf(path: string): number {
  if (isTest(path)) return LAYER.tests;
  if (isSchema(path)) return LAYER.schema;
  if (isTypes(path)) return LAYER.types;
  if (isConfig(path)) return LAYER.config;
  if (isUi(path)) return LAYER.ui;
  return LAYER.core;
}

// ── Import-derived dependency edges ──────────────────────────────────────────
//
// The regexes, the extension candidate order and the probing loop all live in
// `./import-specifiers`, shared with the snapshot-wide import extractor so the
// changeset view and the repo-wide import graph resolve the same text the same
// way. What they do NOT share is the text itself: this side sees hunk fragments,
// the snapshot side sees whole files (see that module's header).

function resolveToChangedFile(
  importerPath: string,
  spec: string,
  changed: ReadonlySet<string>,
): string | null {
  if (!spec.startsWith(".")) return null;
  return resolveCandidate(resolveRelative(importerPath, spec), importerPath, (path) =>
    changed.has(path),
  );
}

// ── Working chunk (id assigned after all chunks are built) ───────────────────

interface WorkingChunk {
  kind: "substantive" | "appendix";
  title: string;
  layer: number;
  filePath: string;
  hunks: Hunk[];
}

function firstFilePath(chunk: DecompositionChunk): string {
  return chunk.filePaths[0] ?? "";
}

// ── The floor ────────────────────────────────────────────────────────────────

export function decompose(patchset: Patchset, options: DecomposeOptions = {}): Decomposition {
  const maxChunkLoc = options.maxChunkLoc ?? DEFAULT_MAX_CHUNK_LOC;
  const extractor = options.symbolExtractor ?? DEGRADED_SYMBOL_EXTRACTOR;

  // Files are already path-sorted by capture; sort defensively for determinism.
  const files = [...patchset.files].sort((a, b) => compare(a.path, b.path));

  const hunks: Hunk[] = [];
  const classifications: HunkClassification[] = [];
  let hunkSeq = 0;

  interface FileHunk {
    hunk: Hunk;
    kind: "substantive" | "mechanical";
  }
  const perFile = new Map<string, FileHunk[]>();

  for (const file of files) {
    const parsed = parseFilePatch(file.patch);
    const fileClass = fileMechanicalClass(file);
    const generatedByMarker =
      fileClass === null && parsed.hunks.some((h) => hasGeneratedHeaderMarker(h));
    const fileHunks: FileHunk[] = [];

    const emit = (
      raw: RawHunk,
      kind: "substantive" | "mechanical",
      mechanical: MechanicalClass | null,
      split?: { index: number; total: number },
    ): Hunk => {
      hunkSeq += 1;
      const hunk: Hunk = {
        id: `h${hunkSeq}`,
        filePath: file.path,
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
        fileStatus: file.status,
        oldStart: raw.oldStart,
        oldLines: raw.oldLines,
        newStart: raw.newStart,
        newLines: raw.newLines,
        addedLines: addedOf(raw.body),
        deletedLines: deletedOf(raw.body),
        contextLines: contextOf(raw.body),
        changedLoc: changedLocOf(raw.body),
        ...(split === undefined ? {} : { splitOf: split }),
      };
      hunks.push(hunk);
      classifications.push({ hunkId: hunk.id, kind, mechanical, enclosingSymbol: "" });
      fileHunks.push({ hunk, kind });
      return hunk;
    };

    if (parsed.hunks.length === 0) {
      // No text hunks: a pure rename, a mode-only change, a binary blob, or a
      // file-level mechanical file with no body. Represent it with one synthetic
      // hunk so totality holds (every changed file is accounted for).
      const synthetic: RawHunk = { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, body: [] };
      let mechanical: MechanicalClass | null = fileClass;
      if (mechanical === null) {
        if (
          file.status === "renamed" &&
          (file.additions ?? 0) === 0 &&
          (file.deletions ?? 0) === 0
        ) {
          mechanical = "pure-rename";
        } else if (parsed.hasModeChange) {
          mechanical = "mode-only";
        }
      }
      // Binary blobs and submodule pointers are caught by `fileMechanicalClass`
      // above, so they classify `binary` / `submodule` (never substantive) and
      // route to the skimmable appendix, with a parallel blocking state.
      // Only a genuinely empty bodyless file with no signal at all stays
      // substantive here.
      emit(synthetic, mechanical === null ? "substantive" : "mechanical", mechanical);
      perFile.set(file.path, fileHunks);
      continue;
    }

    for (const raw of parsed.hunks) {
      let mechanical: MechanicalClass | null = fileClass;
      if (mechanical === null && generatedByMarker) mechanical = "generated";
      if (mechanical === null && isFormattingOnly(raw.body)) mechanical = "formatting-only";

      if (mechanical !== null) {
        emit(raw, "mechanical", mechanical);
        continue;
      }
      // Substantive: split an oversize hunk to honour the ≤maxChunkLoc budget.
      const fragments = splitOversizeRawHunk(raw, maxChunkLoc);
      if (fragments.length === 1) {
        emit(raw, "substantive", null);
      } else {
        fragments.forEach((fragment, index) => {
          emit(fragment, "substantive", null, { index, total: fragments.length });
        });
      }
    }
    perFile.set(file.path, fileHunks);
  }

  // Symbol enrichment (grouping key). Run per file over its substantive hunks;
  // the port degrades to "" and never blocks.
  const symbolByHunkId = new Map<string, string>();
  for (const file of files) {
    const substantive = (perFile.get(file.path) ?? [])
      .filter((fh) => fh.kind === "substantive")
      .map((fh) => fh.hunk);
    if (substantive.length === 0) continue;
    const symbols = extractor.enclosingSymbols(file.path, substantive);
    substantive.forEach((hunk, index) => {
      const symbol = symbols[index] ?? "";
      symbolByHunkId.set(hunk.id, symbol);
    });
  }
  for (const classification of classifications) {
    const symbol = symbolByHunkId.get(classification.hunkId);
    if (symbol !== undefined) classification.enclosingSymbol = symbol;
  }

  // ── Chunking ────────────────────────────────────────────────────────────
  const workingChunks: WorkingChunk[] = [];

  // Substantive chunks: group `file → symbol`, greedy-merge to the budget.
  for (const file of files) {
    const substantive = (perFile.get(file.path) ?? [])
      .filter((fh) => fh.kind === "substantive")
      .map((fh) => fh.hunk);
    if (substantive.length === 0) continue;

    const firstAppearance = new Map<string, number>();
    substantive.forEach((hunk, index) => {
      const symbol = symbolByHunkId.get(hunk.id) ?? "";
      if (!firstAppearance.has(symbol)) firstAppearance.set(symbol, index);
    });
    const ordered = substantive
      .map((hunk, index) => ({ hunk, index, symbol: symbolByHunkId.get(hunk.id) ?? "" }))
      .sort((a, b) => {
        const fa = (firstAppearance.get(a.symbol) ?? 0) - (firstAppearance.get(b.symbol) ?? 0);
        return fa !== 0 ? fa : a.index - b.index;
      });

    let bucket: Hunk[] = [];
    let bucketLoc = 0;
    const flushBucket = (): void => {
      if (bucket.length === 0) return;
      workingChunks.push(makeSubstantiveChunk(file.path, bucket, symbolByHunkId));
      bucket = [];
      bucketLoc = 0;
    };
    for (const { hunk } of ordered) {
      if (bucket.length > 0 && bucketLoc + hunk.changedLoc > maxChunkLoc) flushBucket();
      bucket.push(hunk);
      bucketLoc += hunk.changedLoc;
    }
    flushBucket();
  }

  // Appendix chunks: one per file that has mechanical hunks, collected last.
  for (const file of files) {
    const mechanical = (perFile.get(file.path) ?? [])
      .filter((fh) => fh.kind === "mechanical")
      .map((fh) => fh.hunk);
    if (mechanical.length === 0) continue;
    workingChunks.push({
      kind: "appendix",
      title: file.path,
      layer: LAYER.appendix,
      filePath: file.path,
      hunks: mechanical,
    });
  }

  const chunks: DecompositionChunk[] = workingChunks.map((wc, index) => ({
    chunkId: `c${index + 1}`,
    kind: wc.kind,
    title: wc.title,
    layer: wc.layer,
    filePaths: [wc.filePath],
    hunkIds: wc.hunks.map((h) => h.id),
    changedLoc: wc.hunks.reduce((sum, h) => sum + h.changedLoc, 0),
  }));

  // ── The dependency DAG (import edges) ─────────────────────────────────────
  const chunkIndexById = new Map<string, number>();
  chunks.forEach((chunk, index) => {
    chunkIndexById.set(chunk.chunkId, index);
  });

  // A file → the chunk id of its FIRST substantive chunk (its "definition").
  const definingChunk = new Map<string, string>();
  for (const chunk of chunks) {
    if (chunk.kind !== "substantive") continue;
    const file = chunk.filePaths[0];
    if (file !== undefined && !definingChunk.has(file)) definingChunk.set(file, chunk.chunkId);
  }
  // A hunk id → the chunk that contains it.
  const chunkByHunkId = new Map<string, string>();
  for (const chunk of chunks) {
    for (const hunkId of chunk.hunkIds) chunkByHunkId.set(hunkId, chunk.chunkId);
  }
  const hunkById = new Map<string, Hunk>();
  for (const hunk of hunks) hunkById.set(hunk.id, hunk);

  const changedPaths = new Set(files.map((f) => f.path));
  // Candidate edges keyed by a structured, collision-free key (a JSON-encoded
  // [from, to] tuple) so there is no in-band delimiter to split on later. The
  // stored value is the tuple itself, consumed directly below.
  const candidateEdges = new Map<string, readonly [string, string]>();
  for (const chunk of chunks) {
    if (chunk.kind !== "substantive") continue;
    for (const hunkId of chunk.hunkIds) {
      const hunk = hunkById.get(hunkId);
      if (!hunk) continue;
      const specs = importSpecifiers([...hunk.addedLines, ...hunk.contextLines]);
      for (const spec of specs) {
        const target = resolveToChangedFile(hunk.filePath, spec, changedPaths);
        if (target === null) continue;
        const fromChunk = definingChunk.get(target);
        const toChunk = chunkByHunkId.get(hunkId);
        if (fromChunk === undefined || toChunk === undefined || fromChunk === toChunk) continue;
        candidateEdges.set(JSON.stringify([fromChunk, toChunk]), [fromChunk, toChunk]);
      }
    }
  }

  // Add edges deterministically, dropping any that would close a cycle so the
  // stored edge set is a guaranteed DAG (V103).
  const sortedCandidates = [...candidateEdges.values()].sort((a, b) => {
    const [af, at] = a;
    const [bf, bt] = b;
    const byFrom = (chunkIndexById.get(af) ?? 0) - (chunkIndexById.get(bf) ?? 0);
    if (byFrom !== 0) return byFrom;
    return (chunkIndexById.get(at) ?? 0) - (chunkIndexById.get(bt) ?? 0);
  });
  const adjacency = new Map<string, Set<string>>();
  for (const chunk of chunks) adjacency.set(chunk.chunkId, new Set());
  const edges: DecompositionEdge[] = [];
  for (const [from, to] of sortedCandidates) {
    if (reaches(adjacency, to, from)) continue; // would close a cycle → drop
    adjacency.get(from)?.add(to);
    edges.push({ from, to, kind: "enables" });
  }

  // ── Topological reading order (Kahn, deterministic tiebreak) ──────────────
  const readingOrder = topologicalOrder(chunks, edges, chunkIndexById);

  return {
    patchsetId: patchset.id,
    hunks,
    classifications,
    chunks,
    edges,
    readingOrder,
    residue: [],
    blockingStates: collectBlockingStates(patchset, files),
  };
}

function makeSubstantiveChunk(
  filePath: string,
  bucket: readonly Hunk[],
  symbolByHunkId: ReadonlyMap<string, string>,
): WorkingChunk {
  const symbols = new Set(bucket.map((h) => symbolByHunkId.get(h.id) ?? ""));
  symbols.delete("");
  const title = symbols.size === 1 ? `${filePath} · ${[...symbols][0]}` : filePath;
  return {
    kind: "substantive",
    title,
    layer: layerOf(filePath),
    filePath,
    hunks: [...bucket],
  };
}

/** Whether `target` is reachable from `source` over the current adjacency. */
function reaches(
  adjacency: ReadonlyMap<string, Set<string>>,
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  const seen = new Set<string>();
  const stack = [source];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || seen.has(node)) continue;
    seen.add(node);
    if (node === target) return true;
    for (const next of adjacency.get(node) ?? []) stack.push(next);
  }
  return false;
}

function topologicalOrder(
  chunks: readonly DecompositionChunk[],
  edges: readonly DecompositionEdge[],
  chunkIndexById: ReadonlyMap<string, number>,
): string[] {
  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const chunk of chunks) {
    indegree.set(chunk.chunkId, 0);
    successors.set(chunk.chunkId, []);
  }
  for (const edge of edges) {
    successors.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const byId = new Map(chunks.map((c) => [c.chunkId, c]));
  const key = (id: string): [number, string, number] => {
    const chunk = byId.get(id);
    return [
      chunk?.layer ?? 0,
      firstFilePath(chunk ?? ({ filePaths: [] } as never)),
      chunkIndexById.get(id) ?? 0,
    ];
  };
  const readyLess = (a: string, b: string): number => {
    const [la, fa, ia] = key(a);
    const [lb, fb, ib] = key(b);
    if (la !== lb) return la - lb;
    if (fa !== fb) return compare(fa, fb);
    return ia - ib;
  };

  const ready = chunks.filter((c) => (indegree.get(c.chunkId) ?? 0) === 0).map((c) => c.chunkId);
  ready.sort(readyLess);
  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    order.push(next);
    for (const successor of successors.get(next) ?? []) {
      const remaining = (indegree.get(successor) ?? 0) - 1;
      indegree.set(successor, remaining);
      if (remaining === 0) {
        ready.push(successor);
        ready.sort(readyLess);
      }
    }
  }
  return order;
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
