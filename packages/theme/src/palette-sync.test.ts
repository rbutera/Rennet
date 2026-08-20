import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module shared with the generator CLI.
import { emitMobilePalette, parsePalette } from "../scripts/palette-data.mjs";

// The palette has ONE source: src/palette.css. Web surfaces import it and
// consume var(--rn-*); mobile consumes a GENERATED transpose. These tests make
// that structural instead of aspirational: a stale generated file, a copied
// hex, or a rogue --rn-* definition anywhere else reddens the gate.

const root = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

describe("mobile palette transpose is generated, never hand-edited", () => {
  it("the committed palette.generated.ts is byte-identical to a fresh generation", () => {
    const committed = readFileSync(root("apps/mobile/src/theme/palette.generated.ts"), "utf8");
    expect(committed).toBe(emitMobilePalette());
  });
});

describe("no palette copies outside palette.css", () => {
  const consumers = [
    "apps/marketing/src/styles/global.css",
    "docs/src/styles/theme.css",
    "packages/app-ui/src/index.css",
    "apps/mobile/src/theme/tokens.ts",
  ] as const;

  it("consumer stylesheets define no --rn-* custom property of their own", () => {
    for (const path of consumers) {
      const source = readFileSync(root(path), "utf8");
      // Consuming `var(--rn-x)` is the point; DEFINING `--rn-x: value` outside
      // the palette forks the source of truth. A definition is a --rn-* name at
      // the start of a declaration (line start), not inside var(...).
      const defining = [...source.matchAll(/^\s*(--rn-[\w-]+)\s*:/gm)].map((m) => m[1]);
      expect(defining, `${path} must not define --rn-* vars`).toEqual([]);
    }
  });

  it("consumer surfaces restate none of the canonical palette hexes", () => {
    const palette = parsePalette() as Record<string, Record<string, string>>;
    const canonical = new Set(
      Object.values(palette)
        .flatMap((scheme) => Object.values(scheme))
        .filter((value) => value.startsWith("#"))
        .map((value) => value.toLowerCase()),
    );
    // Ubiquitous neutrals that legitimately appear outside the palette
    // (pure white surfaces, near-black ink on gold) stay banned — the whole
    // point is that even those route through var(--rn-*).
    for (const path of consumers) {
      const source = readFileSync(root(path), "utf8").toLowerCase();
      const restated = [...source.matchAll(/#[0-9a-f]{6}\b/g)]
        .map((m) => m[0])
        .filter((hex) => canonical.has(hex));
      expect(restated, `${path} restates canonical palette hexes`).toEqual([]);
    }
  });

  it("marketing and docs import the shared palette", () => {
    for (const path of ["apps/marketing/src/styles/global.css", "docs/src/styles/theme.css"]) {
      const source = readFileSync(root(path), "utf8");
      expect(source, `${path} must import @rennet/theme/palette.css`).toContain(
        "@rennet/theme/palette.css",
      );
    }
  });
});
