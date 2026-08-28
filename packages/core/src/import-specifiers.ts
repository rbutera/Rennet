/**
 * The shared, deterministic import-specifier vocabulary.
 *
 * Two consumers read the same regexes and the same resolution semantics, so the
 * changeset view and the repo-wide snapshot view can never drift apart:
 *  - `decomposition.ts` derives import-shaped edges BETWEEN CHANGED FILES;
 *  - `project-snapshot.ts` extracts the per-blob import shard for the whole tree.
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
 */
export const IMPORT_PATTERNS: readonly RegExp[] = [
  /\b(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Extension candidates tried, in order, when resolving a specifier to a file. */
export const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** Extension candidates tried, in order, for a directory's `index` file. */
export const INDEX_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

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

/** Every import specifier named on the given lines, in source order (duplicates kept). */
export function importSpecifiers(lines: readonly string[]): string[] {
  const specs: string[] = [];
  for (const line of lines) {
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match = pattern.exec(line);
      while (match !== null) {
        if (match[1] !== undefined) specs.push(match[1]);
        match = pattern.exec(line);
      }
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
