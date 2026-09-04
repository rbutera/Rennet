import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module shared with the generator CLI.
import {
  emitMobilePalette,
  parsePalette,
  parseTheme,
  parseThemes,
} from "../scripts/palette-data.mjs";

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
    "apps/docs/src/styles/theme.css",
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
    for (const path of ["apps/marketing/src/styles/global.css", "apps/docs/src/styles/theme.css"]) {
      const source = readFileSync(root(path), "utf8");
      expect(source, `${path} must import @rennet/theme/palette.css`).toContain(
        "@rennet/theme/palette.css",
      );
    }
  });
});

// Theme packs (issue #481): each themes/<id>.css scopes a COMPLETE re-binding of
// every colour token under [data-rn-theme="<id>"], both scheme blocks. No
// fallback chains — a pack that drops a token is a partial theme and must red the
// gate. parseThemes() throws on any mismatch, so the sweep is structural.
describe("theme packs are complete re-bindings", () => {
  // The default (rennet) palette defines the reference colour-token set that
  // every pack must restate. (Fonts + the depth shadow are theme-invariant and
  // stay on palette.css :root — packs are colour only, so they are excluded from
  // the mobile transpose and from this set already.)
  const referenceTokens = Object.keys(parsePalette().light).sort() as string[];
  const themes = parseThemes() as Record<string, Record<"light" | "dark", Record<string, string>>>;

  it("bundles exactly the expected packs plus the default", () => {
    expect(Object.keys(themes).sort()).toEqual([
      "catppuccin-mocha",
      "dracula",
      "github",
      "one-dark-pro",
      "rennet",
    ]);
  });

  // The set is real (52 semantic roles), so the equality checks below cannot pass
  // vacuously, and the roles the design contract names all survive the mapping.
  it("the reference token set carries every semantic role", () => {
    expect(referenceTokens.length).toBe(52);
    for (const role of [
      "accent",
      "green",
      "warn",
      "model",
      "danger",
      "add",
      "del",
      "sheet",
      "canvas",
      "surface",
      "raised",
      // The lens register: five portable identity slots. Named here so a pack that
      // drops one is caught by role, not only by the arithmetic above.
      "lensRed",
      "lensYellow",
      "lensBlue",
      "lensGreen",
      "lensNeutral",
    ]) {
      expect(referenceTokens, `role ${role} present`).toContain(role);
    }
  });

  for (const id of ["catppuccin-mocha", "dracula", "github", "one-dark-pro", "rennet"]) {
    it(`${id} rebinds every colour token in both schemes`, () => {
      expect(Object.keys(themes[id].light).sort()).toEqual(referenceTokens);
      expect(Object.keys(themes[id].dark).sort()).toEqual(referenceTokens);
    });
  }

  it("the completeness check actually bites (positive control)", () => {
    // Drop one token from a real pack: the same equality the sweep runs must now
    // fail. Proves the sweep distinguishes a complete pack from a partial one.
    const broken = { ...parseTheme("github").light } as Record<string, string>;
    delete broken.accent;
    expect(Object.keys(broken).sort()).not.toEqual(referenceTokens);
  });
});

// Code themes (issue #481 §4) are the independent syntax axis: each
// code-themes/<id>.css rebinds --rn-syn-* (plus the code ground) under
// [data-rn-code-theme="<id>"], both scheme blocks, so code colour can be chosen
// separately from the UI pack.
describe("code themes rebind the full syntax token set", () => {
  const codeDir = fileURLToPath(new URL("./code-themes", import.meta.url));
  const files = readdirSync(codeDir)
    .filter((f) => f.endsWith(".css"))
    .sort();
  const SYNTAX = [
    "--rn-syn-kw",
    "--rn-syn-str",
    "--rn-syn-cmt",
    "--rn-syn-num",
    "--rn-syn-type",
    "--rn-syn-fn",
    "--rn-syn-prop",
    "--rn-syn-var",
  ].sort();

  const block = (css: string, selector: string): string => {
    const start = css.indexOf(selector);
    const open = css.indexOf("{", start);
    return css.slice(open, css.indexOf("}", open));
  };
  const synNames = (scope: string): string[] =>
    [...scope.matchAll(/(--rn-syn-[\w-]+)\s*:/g)].map((m) => m[1] as string).sort();

  it("bundles the expected code themes", () => {
    expect(files.map((f) => f.replace(/\.css$/, ""))).toEqual([
      "catppuccin-mocha",
      "dracula",
      "github",
      "one-dark-pro",
    ]);
  });

  for (const file of files) {
    const id = file.replace(/\.css$/, "");
    it(`${id} binds every syntax token in both schemes`, () => {
      const css = readFileSync(`${codeDir}/${file}`, "utf8");
      expect(synNames(block(css, `[data-rn-code-theme="${id}"] {`))).toEqual(SYNTAX);
      expect(synNames(block(css, `[data-rn-code-theme="${id}"][data-scheme="dark"]`))).toEqual(
        SYNTAX,
      );
    });
  }
});
