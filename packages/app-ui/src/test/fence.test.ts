import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// The import fence (INVENTORY §13, C01 §1.3). Fixture DATA arrives ONLY through the
// bridge context — so nothing under a surface directory may import from `src/test/`.
// This walks every NON-TEST module under `packages/app-ui/src` OUTSIDE `src/test/`
// and fails if any of them resolves an import into `src/test/`. A violation means a
// surface is reaching a fixture directly (the S1 anti-pattern), not through a
// MemoryBridge. Test files (`*.test.ts(x)`) are excluded — they legitimately import
// the mount harness and fixture bridges from `src/test/`; the rule is that PRODUCTION
// surface code never does.
//
// Positive control (run once by hand, then reverted): add `import "../test/memory-bridge"`
// to any surface module and this test fails, naming the offending file.
// ─────────────────────────────────────────────────────────────────────────────

const testDir = import.meta.dirname;
const srcRoot = dirname(testDir);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Every import/export-from/dynamic-import specifier string in a source file. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const staticRe = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/g;
  const bareImportRe = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  const dynamicRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticRe, bareImportRe, dynamicRe]) {
    for (const match of source.matchAll(re)) specs.push(match[1] as string);
  }
  return specs;
}

/** True when a relative specifier from `fromFile` resolves into `src/test/`. */
function resolvesIntoTest(fromFile: string, spec: string): boolean {
  if (!spec.startsWith(".")) return false; // package specifiers never point at src/test
  const resolved = resolve(dirname(fromFile), spec);
  return resolved === testDir || resolved.startsWith(testDir + sep);
}

describe("import fence — surfaces never reach a fixture directly", () => {
  const surfaceModules = walk(srcRoot).filter(
    (file) => file !== testDir && !file.startsWith(testDir + sep),
  );

  it("finds a non-trivial set of surface modules to guard (sanity)", () => {
    expect(surfaceModules.length).toBeGreaterThan(20);
  });

  it("no module outside src/test imports from src/test", () => {
    const violations: string[] = [];
    for (const file of surfaceModules) {
      const source = readFileSync(file, "utf8");
      for (const spec of importSpecifiers(source)) {
        if (resolvesIntoTest(file, spec)) {
          violations.push(`${relative(srcRoot, file)} imports "${spec}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
