import { describe, expect, it } from "vitest";
import { counterpartPathFor, implementationPathFor, isTestPath, testPathsFor } from "./counterpart";

describe("isTestPath", () => {
  it("matches the reversible .test./.spec. suffix convention", () => {
    expect(isTestPath("src/foo.test.ts")).toBe(true);
    expect(isTestPath("src/foo.spec.tsx")).toBe(true);
    expect(isTestPath("src/foo.test.mjs")).toBe(true);
    expect(isTestPath("src/foo.ts")).toBe(false);
    // A __tests__ directory is NOT used here: it yields no reversible impl path.
    expect(isTestPath("src/__tests__/foo.ts")).toBe(false);
  });
});

describe("implementationPathFor", () => {
  it("drops the .test/.spec infix, keeping the extension", () => {
    expect(implementationPathFor("src/foo.test.ts")).toBe("src/foo.ts");
    expect(implementationPathFor("a/b/widget.spec.tsx")).toBe("a/b/widget.tsx");
  });
  it("returns null for a non-test path", () => {
    expect(implementationPathFor("src/foo.ts")).toBeNull();
  });
});

describe("testPathsFor", () => {
  it("offers .test. then .spec. candidates, keeping the extension", () => {
    expect(testPathsFor("src/foo.ts")).toEqual(["src/foo.test.ts", "src/foo.spec.ts"]);
    expect(testPathsFor("a/widget.tsx")).toEqual(["a/widget.test.tsx", "a/widget.spec.tsx"]);
  });
  it("is empty for a test path or a non-JS/TS path", () => {
    expect(testPathsFor("src/foo.test.ts")).toEqual([]);
    expect(testPathsFor("README.md")).toEqual([]);
  });
});

describe("counterpartPathFor", () => {
  it("resolves in both directions when both files were captured", () => {
    const captured = new Set(["src/foo.ts", "src/foo.test.ts"]);
    expect(counterpartPathFor("src/foo.ts", captured)).toBe("src/foo.test.ts");
    expect(counterpartPathFor("src/foo.test.ts", captured)).toBe("src/foo.ts");
  });

  it("prefers .test. when both reversible test names were captured", () => {
    const captured = new Set(["src/foo.ts", "src/foo.spec.ts", "src/foo.test.ts"]);
    expect(counterpartPathFor("src/foo.ts", captured)).toBe("src/foo.test.ts");
  });

  it("returns null when either side is outside the captured change", () => {
    const implementationOnly = new Set(["src/foo.ts"]);
    expect(counterpartPathFor("src/foo.ts", implementationOnly)).toBeNull();

    const counterpartOnly = new Set(["src/foo.test.ts"]);
    expect(counterpartPathFor("src/foo.ts", counterpartOnly)).toBeNull();
    expect(counterpartPathFor("src/foo.test.ts", counterpartOnly)).toBeNull();
  });
});
