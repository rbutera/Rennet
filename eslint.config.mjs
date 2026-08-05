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
              sourceTag: "layer:core",
              onlyDependOnLibsWithTags: ["layer:types", "layer:protocol", "layer:core"],
            },
            {
              sourceTag: "layer:adapter",
              onlyDependOnLibsWithTags: [
                "layer:types",
                "layer:protocol",
                "layer:core",
                "layer:adapter",
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
                "layer:core",
                "layer:adapter",
                "layer:ui",
                "layer:app",
              ],
            },
          ],
        },
      ],
    },
  },
];
