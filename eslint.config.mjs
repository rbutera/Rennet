import nx from "@nx/eslint-plugin";

export default [
  {
    ignores: ["**/dist/**", "**/out/**", "**/coverage/**", "node_modules/**"],
  },
  ...nx.configs["flat/base"],
  ...nx.configs["flat/typescript"],
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          allowCircularSelfDependency: false,
          depConstraints: [
            {
              sourceTag: "layer:protocol",
              onlyDependOnLibsWithTags: ["layer:protocol"],
            },
            {
              // @rennet/prompts: the prompt-text + RSP prompt-contract package. It
              // absorbed the deleted @rennet/instructions surface in B02, so it may
              // import @rennet/protocol (for the contract types) and nothing else.
              sourceTag: "layer:prompts",
              onlyDependOnLibsWithTags: ["layer:protocol", "layer:prompts"],
            },
            {
              sourceTag: "layer:core",
              onlyDependOnLibsWithTags: ["layer:protocol", "layer:prompts", "layer:core"],
            },
            {
              sourceTag: "layer:adapter",
              onlyDependOnLibsWithTags: [
                "layer:protocol",
                "layer:prompts",
                "layer:core",
                "layer:adapter",
              ],
            },
            {
              sourceTag: "layer:server",
              onlyDependOnLibsWithTags: [
                "layer:protocol",
                "layer:prompts",
                "layer:core",
                "layer:adapter",
                "layer:server",
              ],
            },
            {
              // layer:theme is the shared design-token package (CSS only, no
              // runtime imports) — the UI consumes its stylesheet.
              sourceTag: "layer:theme",
              onlyDependOnLibsWithTags: ["layer:theme"],
            },
            {
              // layer:ui-kit is the vendored shadcn/Base UI component kit
              // (@rennet/ui): headless primitives themed by tokens only. It may
              // import protocol + theme and nothing else — no core.
              sourceTag: "layer:ui-kit",
              onlyDependOnLibsWithTags: ["layer:protocol", "layer:theme", "layer:ui-kit"],
            },
            {
              // layer:ui is @rennet/app-ui, Rennet's composites/screens: it
              // consumes the kit (layer:ui-kit) plus protocol + theme.
              sourceTag: "layer:ui",
              onlyDependOnLibsWithTags: [
                "layer:protocol",
                "layer:theme",
                "layer:ui-kit",
                "layer:ui",
              ],
            },
            {
              sourceTag: "layer:client",
              onlyDependOnLibsWithTags: ["layer:protocol", "layer:client"],
            },
            {
              // apps/mobile (issue #383 M1): a native shell that consumes the shared client
              // runtime + the projection contract only — never core/adapter/server/ui.
              sourceTag: "layer:mobile",
              onlyDependOnLibsWithTags: ["layer:protocol", "layer:client", "layer:mobile"],
            },
            {
              sourceTag: "layer:app",
              onlyDependOnLibsWithTags: [
                "layer:protocol",
                "layer:prompts",
                "layer:core",
                "layer:adapter",
                "layer:server",
                "layer:ui",
                "layer:client",
                "layer:app",
              ],
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/server/**/*.ts", "packages/server/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "electron",
              message: "packages/server is Electron-free; inject effects via RennetServerOptions.",
            },
          ],
        },
      ],
    },
  },
  {
    // No hardcoded hex colours in EITHER UI package — the vendored kit
    // (packages/ui) and the composites (packages/app-ui): every colour comes from
    // the shared @rennet/theme tokens (Tailwind utilities or var(--rn-…)), and
    // packages/theme/src/theme.css is the ONLY place raw hex lives (issue #11,
    // re-homed in the 2026-08-19 overhaul). Test files and fixtures are exempt —
    // the hex-lint test lints code strings through the ESLint API (hex-lint.test.ts).
    files: [
      "packages/ui/src/**/*.ts",
      "packages/ui/src/**/*.tsx",
      "packages/app-ui/src/**/*.ts",
      "packages/app-ui/src/**/*.tsx",
    ],
    ignores: [
      "packages/ui/src/**/*.test.ts",
      "packages/ui/src/**/*.test.tsx",
      "packages/app-ui/src/**/*.test.ts",
      "packages/app-ui/src/**/*.test.tsx",
      "packages/app-ui/src/canvas/fixtures.ts",
      // A REAL parsed OpenSpec change (data, not styling): its spec text carries
      // issue refs like #178 that the hex selector would false-match.
      "packages/app-ui/src/canvas/openspec.fixture.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/#[0-9a-fA-F]{3,8}/]",
          message:
            "No hardcoded hex colours in the UI packages — use a theme utility or var(--rn-…) token from @rennet/theme.",
        },
      ],
    },
  },
];
