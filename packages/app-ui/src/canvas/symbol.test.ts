import { describe, expect, it } from "vitest";
import type { TokenType } from "../syntax/shiki";
import {
  basename,
  groupReferencesByFile,
  type SymbolReferenceRow,
  splitIdentifierRuns,
  tokenMayContainSymbol,
  tokenTextMayContainSymbol,
} from "./symbol";

describe("tokenMayContainSymbol", () => {
  it("is true for symbol-bearing token classes (incl. plain), false for inert chrome", () => {
    // `plain` MUST be included — the tokenizer classifies ordinary identifiers as plain.
    const bearing: TokenType[] = ["plain", "function", "type", "variable", "property"];
    for (const type of bearing) expect(tokenMayContainSymbol(type)).toBe(true);
    const inert: TokenType[] = [
      "keyword",
      "string",
      "comment",
      "number",
      "operator",
      "punctuation",
    ];
    for (const type of inert) expect(tokenMayContainSymbol(type)).toBe(false);
  });
});

describe("tokenTextMayContainSymbol", () => {
  it("excludes a QUOTED property key (a string in key position), keeps a bare key", () => {
    // `"name":` tokenizes as a `property` whose text keeps the quotes — a string, not
    // a symbol. A bare `name:` key stays symbol-bearing.
    expect(tokenTextMayContainSymbol("property", '"name"')).toBe(false);
    expect(tokenTextMayContainSymbol("property", "'name'")).toBe(false);
    expect(tokenTextMayContainSymbol("property", "name")).toBe(true);
  });
  it("still admits ordinary identifiers and excludes inert chrome", () => {
    expect(tokenTextMayContainSymbol("plain", "count")).toBe(true);
    expect(tokenTextMayContainSymbol("function", "doThing")).toBe(true);
    expect(tokenTextMayContainSymbol("string", '"count"')).toBe(false);
    expect(tokenTextMayContainSymbol("keyword", "const")).toBe(false);
  });
});

describe("splitIdentifierRuns", () => {
  it("separates an identifier from a leading-whitespace gap (the merged-token case)", () => {
    expect(splitIdentifierRuns("  count")).toEqual([
      { text: "  ", isIdentifier: false },
      { text: "count", isIdentifier: true },
    ]);
  });

  it("splits several identifiers merged into one token", () => {
    expect(splitIdentifierRuns("foo bar")).toEqual([
      { text: "foo", isIdentifier: true },
      { text: " ", isIdentifier: false },
      { text: "bar", isIdentifier: true },
    ]);
  });

  it("returns a single identifier segment for a bare identifier (incl. digits/$_)", () => {
    expect(splitIdentifierRuns("value2")).toEqual([{ text: "value2", isIdentifier: true }]);
    expect(splitIdentifierRuns("$_priv")).toEqual([{ text: "$_priv", isIdentifier: true }]);
  });

  it("returns a single gap segment when there is no identifier", () => {
    expect(splitIdentifierRuns("   ")).toEqual([{ text: "   ", isIdentifier: false }]);
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
