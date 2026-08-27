import type { PatchFile } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { fileStats, hunkHeader, numberLines, parsePatch } from "./diff-parse";

// A two-hunk unified diff (the raw `PatchFile.patch` shape). The second hunk starts the
// new side offset from the old (a net insertion earlier in the file), so the dual
// numbering has to track them independently.
const PATCH = [
  "@@ -1,4 +1,5 @@",
  ' import { randomUUID } from "node:crypto"',
  "-export interface SessionContext {",
  "+export interface ScopedSession {",
  "+  readonly scopeId: string",
  "   readonly startedAt: number",
  "@@ -18,2 +19,3 @@",
  " export function scopeGuard() {",
  "-  const scope = DEFAULT",
  "+  const scope = header",
  "+  if (!scope) throw",
].join("\n");

function file(over: Partial<PatchFile>): PatchFile {
  return {
    path: "x.ts",
    status: "modified",
    additions: null,
    deletions: null,
    binary: false,
    patch: "",
    ...over,
  };
}

describe("parsePatch", () => {
  it("parses a multi-hunk patch into the right line types and dual old/new numbers", () => {
    const hunks = parsePatch(PATCH);
    expect(hunks).toHaveLength(2);

    expect(hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    expect(hunks[0]?.lines.map((l) => l.type)).toEqual(["context", "del", "add", "add", "context"]);
    // The marker is stripped; content (indentation included) is preserved.
    expect(hunks[0]?.lines[1]?.text).toBe("export interface SessionContext {");
    expect(hunks[0]?.lines[4]?.text).toBe("  readonly startedAt: number");

    const n0 = numberLines(hunks[0] as (typeof hunks)[number]);
    expect(n0.map((l) => l.oldLine)).toEqual([1, 2, null, null, 3]);
    expect(n0.map((l) => l.newLine)).toEqual([1, null, 2, 3, 4]);

    // The second hunk numbers from its own header (old 18, new 19), independently.
    const n1 = numberLines(hunks[1] as (typeof hunks)[number]);
    expect(n1.map((l) => l.oldLine)).toEqual([18, 19, null, null]);
    expect(n1.map((l) => l.newLine)).toEqual([19, null, 20, 21]);
  });

  it("skips file-header preamble and the no-newline marker, keeps blank context lines", () => {
    const withPreamble = [
      "diff --git a/x.ts b/x.ts",
      "index 111..222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " first",
      "",
      "-old",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");
    const hunks = parsePatch(withPreamble);
    expect(hunks).toHaveLength(1);
    // The bare empty line counts as a blank context line (numbering stays true);
    // the "\ No newline" marker is dropped.
    expect(hunks[0]?.lines.map((l) => l.type)).toEqual(["context", "context", "del", "add"]);
    expect(hunks[0]?.lines[1]?.text).toBe("");
  });

  it("does not mint a phantom trailing line from a trailing newline", () => {
    const hunks = parsePatch("@@ -1,1 +1,1 @@\n-a\n+b\n");
    expect(hunks[0]?.lines).toHaveLength(2);
  });

  it("returns [] for a binary or empty patch", () => {
    expect(parsePatch("")).toEqual([]);
  });
});

describe("hunkHeader", () => {
  it("returns the raw @@ header line verbatim (not a reconstruction from line counts)", () => {
    const [h0] = parsePatch(PATCH);
    // The source header is `@@ -1,4 +1,5 @@` — displayed verbatim, NOT the -1,3 +1,4 that
    // a reconstruction from the parsed line counts would produce.
    expect(hunkHeader(h0 as NonNullable<typeof h0>)).toBe("@@ -1,4 +1,5 @@");
  });

  it("preserves git's trailing function-context tail on the header", () => {
    const withContext = [
      "@@ -18,6 +19,7 @@ export function scopeGuard(): Scope {",
      " export function scopeGuard() {",
      "-  const scope = DEFAULT",
      "+  const scope = header",
    ].join("\n");
    const [h] = parsePatch(withContext);
    // Numbering still comes from the parsed counts…
    expect(h).toMatchObject({ oldStart: 18, newStart: 19 });
    // …but the displayed header keeps the ` @@ export function scopeGuard(): Scope {` tail
    // that a count-based reconstruction drops.
    expect(hunkHeader(h as NonNullable<typeof h>)).toBe(
      "@@ -18,6 +19,7 @@ export function scopeGuard(): Scope {",
    );
  });
});

describe("fileStats", () => {
  it("prefers the projection's own additions/deletions when present", () => {
    expect(fileStats(file({ additions: 10, deletions: 5, patch: PATCH }))).toEqual({
      additions: 10,
      deletions: 5,
    });
  });

  it("falls back to counting the parsed hunks when a count is null", () => {
    // PATCH carries 4 adds and 2 dels across its two hunks.
    expect(fileStats(file({ additions: null, deletions: null, patch: PATCH }))).toEqual({
      additions: 4,
      deletions: 2,
    });
  });

  it("an added file counts every line as an addition", () => {
    const added = file({
      path: "new.ts",
      status: "added",
      patch: "@@ -0,0 +1,2 @@\n+one\n+two",
    });
    expect(fileStats(added)).toEqual({ additions: 2, deletions: 0 });
  });
});
