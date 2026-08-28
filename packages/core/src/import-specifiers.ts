/**
 * The shared, deterministic import-specifier vocabulary.
 *
 * Two consumers read the same regexes, the same extension candidate order and the
 * same resolution semantics, so the changeset view and the repo-wide snapshot view
 * answer the same way about the same text:
 *  - `decomposition.ts` derives import-shaped edges BETWEEN CHANGED FILES;
 *  - `project-snapshot.ts` extracts the per-blob import shard for the whole tree.
 *
 * They do NOT see the same text, and this file cannot make them: the snapshot
 * extractor is handed a whole file (and strips block comments first), while the
 * decomposer is handed HUNK FRAGMENTS — added lines plus context lines, with the
 * unchanged middle of a file missing and no block-comment state to strip against.
 * So a statement the decomposer's fragment cuts in half is invisible to it and
 * visible to the extractor, and a specifier the extractor drops as block-comment
 * text can survive in a fragment. Shared vocabulary, honestly different inputs.
 *
 * Everything here is a pure function of its arguments — no clock, no randomness,
 * no IO — because the snapshot extractor's bytes are content-addressed.
 *
 * Honest scope: TEXTUAL. These are regexes, not a parser. A specifier inside a
 * template literal or a line comment is an accepted false positive, and a
 * computed specifier (`import(someVariable)`) is invisible.
 */

/**
 * The four import forms Rennet recognises: `… from '…'` (import/export),
 * bare `import '…'`, `require('…')`, and dynamic `import('…')`. Each carries the
 * specifier in capture group 1. Global regexes — every consumer resets
 * `lastIndex` before use.
 *
 * These are matched against the WHOLE text, not line by line, because a formatter
 * splits the dominant form across lines (`import {\n  a,\n} from "./a";` is what
 * biome and prettier emit for any non-trivial import list) and a line-anchored
 * pattern misses every one of them. The `from` clause pattern therefore spans
 * newlines, and is bounded by two characters it may never cross: a QUOTE (so a
 * match can never skip over an intervening specifier — the specifier that ends
 * one statement stops the scan) and a SEMICOLON (so a preceding `export const x =
 * 1;` cannot reach forward into the next statement's `from` clause). The residual
 * false positive is bounded and benign: an unterminated `export …` before an
 * import can re-report THAT import's specifier, which is a duplicate of a
 * specifier genuinely present in the text, never an invented one.
 */
export const IMPORT_PATTERNS: readonly RegExp[] = [
  /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Extension candidates tried, in order, when resolving a specifier to a file.
 * `.mts`/`.cts` are here because they are in the extractor's eligible set: a
 * `.mts` file that can be an EDGE SOURCE must also be reachable as an
 * extensionless edge TARGET, or the graph is asymmetric for no reason.
 */
export const RESOLVE_EXTS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];

/** Extension candidates tried, in order, for a directory's `index` file. */
export const INDEX_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Resolve a base path to a real file: plain extension candidates first, then a
 * directory `index` file, in the fixed {@link RESOLVE_EXTS}/{@link INDEX_EXTS}
 * order. `exists` is the membership test — the whole-repo file inventory for the
 * snapshot graph, the changed-file set for the decomposer.
 *
 * A candidate equal to `importerPath` means the specifier names the IMPORTING FILE
 * ITSELF, so there is NO edge and the probe stops. It must not fall through to the
 * next extension: `a.ts` containing `import './a'` would otherwise mint a phantom
 * edge to a sibling `a.tsx`.
 */
export function resolveCandidate(
  base: string,
  importerPath: string,
  exists: (path: string) => boolean,
): string | null {
  for (const ext of RESOLVE_EXTS) {
    const candidate = base + ext;
    if (candidate === importerPath) return null;
    if (exists(candidate)) return candidate;
  }
  for (const ext of INDEX_EXTS) {
    const candidate = `${base}/index${ext}`;
    if (candidate === importerPath) return null;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * POSIX-style resolution of a relative specifier against an importing file's path.
 * `.`/empty segments are dropped and `..` pops, so `a/b/c.ts` + `../d` ⇒ `a/d`.
 */
export function resolveRelative(importerPath: string, spec: string): string {
  const importerDir = importerPath.split("/").slice(0, -1);
  const parts = [...importerDir, ...spec.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/**
 * Every import specifier named on the given lines, in per-pattern source order
 * (duplicates kept). The lines are rejoined and scanned as ONE text, so a
 * formatter-split statement — the `import {\n  a,\n} from "./a";` that biome and
 * prettier produce for every non-trivial import list — is seen whole. Scanning
 * physical lines missed all of them.
 */
export function importSpecifiers(lines: readonly string[]): string[] {
  const text = lines.join("\n");
  const specs: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      if (match[1] !== undefined) specs.push(match[1]);
      match = pattern.exec(text);
    }
  }
  return specs;
}

/**
 * Strip block comments from a file's physical lines, returning one scan string per
 * input line (an empty string for a line entirely inside a comment). A block comment
 * that opens and closes on one line collapses to a single space, so the tokens either
 * side of it do not fuse. This is the exact algorithm the reference extractor has
 * always used; it is shared so the import extractor sees the same text.
 */
export function stripBlockComments(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inBlockComment = false;
  for (const raw of lines) {
    let scan = raw;
    if (inBlockComment) {
      const close = raw.indexOf("*/");
      if (close === -1) {
        out.push("");
        continue;
      }
      inBlockComment = false;
      scan = raw.slice(close + 2);
    }
    // Strip any block comment that opens on this line; if it never closes, keep the
    // prefix before it and enter block-comment mode for the following lines.
    for (;;) {
      const open = scan.indexOf("/*");
      if (open === -1) break;
      const close = scan.indexOf("*/", open + 2);
      if (close === -1) {
        scan = scan.slice(0, open);
        inBlockComment = true;
        break;
      }
      scan = `${scan.slice(0, open)} ${scan.slice(close + 2)}`;
    }
    out.push(scan);
  }
  return out;
}
