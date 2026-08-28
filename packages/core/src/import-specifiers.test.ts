import { describe, expect, it } from "vitest";
import {
  INDEX_EXTS,
  importSpecifiers,
  RESOLVE_EXTS,
  resolveCandidate,
  resolveRelative,
  stripBlockComments,
} from "./import-specifiers";

// The shared vocabulary both the changeset decomposer and the repo-wide snapshot
// extractor read. Testing it here rather than through either consumer is the point:
// a regression in the regexes or the candidate order breaks BOTH views at once.

describe("importSpecifiers — the scan is over TEXT, not physical lines", () => {
  const scan = (source: string): string[] => importSpecifiers(source.split("\n"));

  it("captures single-line forms", () => {
    expect(
      scan(
        [
          "import { a } from './a';",
          "export { b } from './b';",
          "import './c';",
          "const d = require('./d');",
          "const e = await import('./e');",
        ].join("\n"),
      ).sort(),
    ).toEqual(["./a", "./b", "./c", "./d", "./e"]);
  });

  it("captures a formatter-split import — the dominant form biome and prettier emit", () => {
    expect(scan(["import {", "  alpha,", "  beta,", "} from './split';"].join("\n"))).toEqual([
      "./split",
    ]);
  });

  it("captures a formatter-split `export … from` and `import type … from`", () => {
    expect(scan(["export {", "  gamma,", "} from './re-export';"].join("\n"))).toEqual([
      "./re-export",
    ]);
    expect(scan(["import type {", "  Delta,", "} from './types';"].join("\n"))).toEqual([
      "./types",
    ]);
  });

  it("captures a split import carrying an inline comment", () => {
    expect(
      scan(["import {", "  epsilon, // the useful one", "} from './commented';"].join("\n")),
    ).toEqual(["./commented"]);
  });

  it("stops a `from` clause at a statement terminator, so it cannot reach forward", () => {
    // A preceding, COMPLETED statement must not pair with the next statement's
    // `from` clause. Without the semicolon bound this reports './y' twice.
    expect(scan(["export const x = 1;", "import { y } from './y';"].join("\n"))).toEqual(["./y"]);
  });

  it("can never invent a specifier the text does not contain", () => {
    // The `from`-clause pattern may not cross a quote, so a match can never skip over
    // one statement's specifier into another's. This is what makes the newline-
    // spanning scan safe: every capture is written verbatim in the source.
    const found = new Set(
      scan(
        [
          "import { a } from './first';",
          "import {",
          "  b,",
          "} from './second';",
          "export { c } from './third';",
        ].join("\n"),
      ),
    );
    expect([...found].sort()).toEqual(["./first", "./second", "./third"]);
  });

  it("a physical-line scan would have missed the split forms (the regression this fixes)", () => {
    // The control: scanning each line ALONE finds nothing in a split import, which is
    // exactly what the repo-wide graph used to see for most of a formatted codebase.
    const lines = ["import {", "  alpha,", "} from './split';"];
    expect(lines.flatMap((line) => importSpecifiers([line]))).toEqual([]);
    expect(importSpecifiers(lines)).toEqual(["./split"]);
  });
});

describe("stripBlockComments", () => {
  it("blanks a multi-line block comment and collapses a one-line one", () => {
    expect(
      stripBlockComments(["a /* x */ b", "/*", "import './hidden';", "*/", "import './shown';"]),
    ).toEqual(["a   b", "", "", "", "import './shown';"]);
  });
});

describe("resolveRelative", () => {
  it("pops `..` and drops `.`/empty segments, POSIX-style", () => {
    expect(resolveRelative("a/b/c.ts", "../d")).toBe("a/d");
    expect(resolveRelative("a/b/c.ts", "./d")).toBe("a/b/d");
    expect(resolveRelative("a/b/c.ts", "../../e/f")).toBe("e/f");
  });
});

describe("resolveCandidate — the one probing loop both consumers share", () => {
  const inventory = (...paths: string[]) => {
    const set = new Set(paths);
    return (path: string): boolean => set.has(path);
  };

  it("prefers a plain extension over a directory index", () => {
    expect(resolveCandidate("x/util", "x/a.ts", inventory("x/util.ts", "x/util/index.ts"))).toBe(
      "x/util.ts",
    );
  });

  it("falls back to a directory index", () => {
    expect(resolveCandidate("x/util", "x/a.ts", inventory("x/util/index.ts"))).toBe(
      "x/util/index.ts",
    );
  });

  it("resolves to a `.mts` / `.cts` target", () => {
    // A `.mts` file is an eligible extraction SOURCE, so it must be reachable as an
    // extensionless TARGET too.
    expect(resolveCandidate("x/native", "x/a.ts", inventory("x/native.mts"))).toBe("x/native.mts");
    expect(resolveCandidate("x/legacy", "x/a.ts", inventory("x/legacy.cts"))).toBe("x/legacy.cts");
    expect(RESOLVE_EXTS).toContain(".mts");
    expect(INDEX_EXTS).toContain(".cts");
  });

  it("yields NOTHING for a self-import, rather than falling through to a sibling", () => {
    // `a.ts` importing `./a` names itself. Continuing down the extension list found
    // `a.tsx` and minted an edge between two unrelated files.
    expect(resolveCandidate("x/a", "x/a.ts", inventory("x/a.ts", "x/a.tsx"))).toBeNull();
    // The control: the same inventory resolves for a DIFFERENT importer.
    expect(resolveCandidate("x/a", "x/other.ts", inventory("x/a.ts", "x/a.tsx"))).toBe("x/a.ts");
  });

  it("yields nothing when the inventory holds no candidate", () => {
    expect(resolveCandidate("x/nowhere", "x/a.ts", inventory("x/a.ts"))).toBeNull();
  });
});
