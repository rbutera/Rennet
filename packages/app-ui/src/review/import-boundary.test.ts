import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The review layer resolves every citation through the span-read seam only. Two imports
// are therefore forbidden anywhere in review/: a general markdown parser (reconciliation
// 5 — the R45 subset is hand-rolled, NOT react-markdown) and any filesystem module
// (verification 8.3 — source hydrates via `patchset.readSpan`, never `node:fs`). This is
// an EXECUTABLE guard: a future `import md from "react-markdown"` fails the suite.
const REVIEW_DIR = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN =
  /from\s+["'](react-markdown|remark[\w-]*|rehype[\w-]*|node:fs|node:path|fs|fs\/promises)["']/;

function hasForbiddenImport(source: string): boolean {
  return FORBIDDEN.test(source);
}

const GUARDED_FILES = [
  "citations.ts",
  "rich-text.tsx",
  "code-block.tsx",
  "code-tabs.tsx",
  "reference-chip.tsx",
  "line-comment-editor.tsx",
  "selection-toolbar.tsx",
  // C6 diff surface: the raw diff carries its patch text inline (reconciliation 2), so
  // these need no filesystem and no span-read — the guard keeps that true.
  "diff-source.ts",
  "diff-parse.ts",
  "diff-view.tsx",
  "diff-view-container.tsx",
];

describe("review import boundary", () => {
  it("positive control: the matcher actually flags a forbidden import", () => {
    expect(hasForbiddenImport('import md from "react-markdown";')).toBe(true);
    expect(hasForbiddenImport('import { readFileSync } from "node:fs";')).toBe(true);
    expect(hasForbiddenImport('import remarkGfm from "remark-gfm";')).toBe(true);
    // A legitimate review import must NOT trip the guard.
    expect(hasForbiddenImport('import { useState } from "react";')).toBe(false);
    expect(hasForbiddenImport('import { useCommand } from "../data";')).toBe(false);
  });

  for (const file of GUARDED_FILES) {
    it(`${file} imports no markdown parser and no filesystem module`, () => {
      const source = readFileSync(join(REVIEW_DIR, file), "utf8");
      expect(hasForbiddenImport(source)).toBe(false);
    });
  }
});
