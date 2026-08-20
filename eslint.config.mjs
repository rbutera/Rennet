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
            { sourceTag: "layer:types", onlyDependOnLibsWithTags: ["layer:types"] },
            {
              sourceTag: "layer:protocol",
              onlyDependOnLibsWithTags: ["layer:types", "layer:protocol"],
            },
            {
              sourceTag: "layer:instructions",
              onlyDependOnLibsWithTags: ["layer:types", "layer:instructions"],
            },
            {
              sourceTag: "layer:core",
              onlyDependOnLibsWithTags: [
                "layer:types",
                "layer:protocol",
                "layer:instructions",
                "layer:core",
              ],
            },
            {
              sourceTag: "layer:adapter",
              onlyDependOnLibsWithTags: [
                "layer:types",
                "layer:protocol",
                "layer:instructions",
                "layer:core",
                "layer:adapter",
              ],
            },
            {
              sourceTag: "layer:server",
              onlyDependOnLibsWithTags: [
                "layer:types",
                "layer:protocol",
                "layer:instructions",
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
              sourceTag: "layer:ui",
              onlyDependOnLibsWithTags: [
                "layer:types",
                "layer:protocol",
                "layer:theme",
                "layer:ui",
              ],
            },
            {
              sourceTag: "layer:client",
              onlyDependOnLibsWithTags: ["layer:types", "layer:protocol", "layer:client"],
            },
            {
              // apps/mobile (issue #383 M1): a native shell that consumes the shared client
              // runtime + the projection contract only — never core/adapter/server/ui.
              sourceTag: "layer:mobile",
              onlyDependOnLibsWithTags: [
                "layer:types",
                "layer:protocol",
                "layer:client",
                "layer:mobile",
              ],
            },
            {
              sourceTag: "layer:app",
              onlyDependOnLibsWithTags: [
                "layer:types",
                "layer:protocol",
                "layer:instructions",
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
    // No hardcoded hex colours in the UI package: every colour comes from the
    // shared @rennet/theme tokens (Tailwind utilities or var(--rn-…)), and
    // packages/theme/src/theme.css is the ONLY place raw hex lives (issue #11,
    // re-homed in the 2026-08-19 overhaul). Test files and fixtures are exempt —
    // the hex-lint test lints code strings through the ESLint API (hex-lint.test.ts).
    files: ["packages/app-ui/src/**/*.ts", "packages/app-ui/src/**/*.tsx"],
    ignores: [
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
            "No hardcoded hex colours in packages/app-ui — use a theme utility or var(--rn-…) token from @rennet/theme.",
        },
      ],
    },
  },
];
