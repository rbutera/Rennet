import { describe, expect, it } from "vitest";
import {
  INDEX_EXTS,
  importSpecifiers,
  probeReachesImporter,
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

  it("cannot skip past one statement's specifier to pair with a later one", () => {
    // The `from`-clause pattern may not cross a quote, so a match stops at the first
    // quoted string after it. That is the bound the newline-spanning scan rests on —
    // NOT a guarantee that every capture is an import (see the module doc's ceiling:
    // a `from '…'` inside a template literal after an unterminated export IS caught).
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

  it("DOES capture a `from '…'` string that is not an import — the documented ceiling", () => {
    // The honest limit of a regex scan, kept as a test so the module doc cannot drift
    // back into claiming captures are always real imports. An unterminated `export`
    // followed by SQL in a template literal pairs with the SQL's quoted table name.
    expect(scan(["export const q = `", "  select * from 'users'", "`;"].join("\n"))).toEqual([
      "users",
    ]);
    // Why it is mostly harmless: a bare capture like this names no workspace scope
    // and no relative path, so `queryImportGraph` resolves it to nothing. A CONTRIVED
    // relative one would mint a phantom edge; nothing here prevents that.
    expect(scan(["export const q = `", "  select * from './users'", "`;"].join("\n"))).toEqual([
      "./users",
    ]);
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

describe("probeReachesImporter — telling `named myself` apart from `found nothing`", () => {
  it("is true when the importer is among the probe's plain-extension candidates", () => {
    expect(probeReachesImporter("x/a", "x/a.ts")).toBe(true);
    expect(probeReachesImporter("x/a", "x/a.mts")).toBe(true);
  });

  it("is true when the importer is the probe's directory-index candidate", () => {
    // The workspace-alias case: base `packages/self`, importer `packages/self/index.ts`.
    expect(probeReachesImporter("packages/self", "packages/self/index.ts")).toBe(true);
  });

  it("is false for an unrelated importer, so an ordinary miss still tries the next base", () => {
    expect(probeReachesImporter("packages/self", "packages/other/index.ts")).toBe(false);
    expect(probeReachesImporter("x/a", "x/b.ts")).toBe(false);
    // A DEEPER path than any candidate: `<base>/src/index.ts` is not probed at all.
    expect(probeReachesImporter("packages/self", "packages/self/src/index.ts")).toBe(false);
  });
});
