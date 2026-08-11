import { describe, expect, it } from "vitest";
import type { TokenType } from "../syntax/languages";
import {
  basename,
  groupReferencesByFile,
  isClickableSymbolToken,
  type SymbolReferenceRow,
} from "./symbol";

describe("isClickableSymbolToken", () => {
  it("is true for symbol identifiers, false for inert chrome", () => {
    const clickable: TokenType[] = ["function", "type", "variable", "property"];
    for (const type of clickable) expect(isClickableSymbolToken(type)).toBe(true);
    const inert: TokenType[] = [
      "plain",
      "keyword",
      "string",
      "comment",
      "number",
      "operator",
      "punctuation",
    ];
    for (const type of inert) expect(isClickableSymbolToken(type)).toBe(false);
  });
});

describe("groupReferencesByFile", () => {
  const sites: SymbolReferenceRow[] = [
    { path: "src/b.ts", line: 10, scope: null },
    { path: "src/a.ts", line: 3, scope: "pkg-a" },
    { path: "src/a.ts", line: 1, scope: "pkg-a" },
    { path: "src/a.ts", line: 3, scope: "pkg-a" },
  ];

  it("groups by file, ascending + de-duplicated lines, files ordered by path", () => {
    expect(groupReferencesByFile(sites)).toEqual([
      { path: "src/a.ts", lines: [1, 3] },
      { path: "src/b.ts", lines: [10] },
    ]);
  });

  it("is empty for no sites", () => {
    expect(groupReferencesByFile([])).toEqual([]);
  });
});

describe("basename", () => {
  it("returns the last path segment, or the whole string when there is no slash", () => {
    expect(basename("src/canvas/symbol.ts")).toBe("symbol.ts");
    expect(basename("symbol.ts")).toBe("symbol.ts");
  });
});
