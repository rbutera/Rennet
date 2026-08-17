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
              sourceTag: "layer:ui",
              onlyDependOnLibsWithTags: ["layer:types", "layer:protocol", "layer:ui"],
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
                "layer:app",
              ],
            },
          ],
        },
      ],
    },
  },
  {
    // No hardcoded hex colours in the UI package: every colour is a glass token
    // (var(--…)) defined in packages/ui/src/tokens.css, the ONLY place raw hex
    // lives (issue #11). Test files and fixtures are exempt — the hex-lint test
    // lints code strings through the ESLint API. Mirrored by hex-lint.test.ts.
    files: ["packages/ui/src/**/*.ts", "packages/ui/src/**/*.tsx"],
    ignores: [
      "packages/ui/src/**/*.test.ts",
      "packages/ui/src/**/*.test.tsx",
      "packages/ui/src/canvas/fixtures.ts",
      // A REAL parsed OpenSpec change (data, not styling): its spec text carries
      // issue refs like #178 that the hex selector would false-match.
      "packages/ui/src/canvas/openspec.fixture.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/#[0-9a-fA-F]{3,8}/]",
          message:
            "No hardcoded hex colours in packages/ui — use a glass token from tokens.css, e.g. var(--code-bg).",
        },
      ],
    },
  },
];
