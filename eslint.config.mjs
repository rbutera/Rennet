import nx from "@nx/eslint-plugin";

// Shared no-restricted-syntax selectors. Kept as consts because ESLint flat config
// REPLACES a rule's options rather than merging them: a file matched by two blocks
// that both set `no-restricted-syntax` keeps only the LAST block's selectors. So the
// invoke block below re-lists the hex selector to avoid silently dropping it on
// app-ui surface files (a past stale-pass class of bug). Reference the const, never
// re-type the selector.
const NO_HARDCODED_HEX = {
  selector: "Literal[value=/#[0-9a-fA-F]{3,8}/]",
  message:
    "No hardcoded hex colours in the UI packages — use a theme utility or var(--rn-…) token from @rennet/theme.",
};

// The standing law (C01 §2.7, proposal): no app-ui surface/component code calls the
// bridge's `.invoke` directly. Reads go through `useCommand`, writes through
// `useMutation`, live narration through `useCommandStream` — the `src/data/` hooks
// over `useBridge()`. This bans the method call itself (any `.invoke(...)`), so it
// catches `bridge.invoke`, `temp.bridge.invoke`, and `RennetBridge.invoke` alike.
const NO_DIRECT_INVOKE = {
  selector: "CallExpression[callee.property.name='invoke']",
  message:
    "No direct bridge.invoke in app-ui surfaces — read through useCommand, write through useMutation, stream through useCommandStream (data/ hooks over useBridge). Only src/data/ may call .invoke.",
};

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
      "no-restricted-syntax": ["error", NO_HARDCODED_HEX],
    },
  },
  {
    // The bridge seam is a standing architecture law, not a consent gate (Rule Zero):
    // every app-ui surface reaches the bridge through the data-seam hooks, never by
    // calling `.invoke` itself. The seam internals under `src/data/` are the ONE
    // sanctioned caller and are exempt; tests drive MemoryBridge directly and are
    // exempt too. Placed AFTER the hex block so it wins the merge on surface files —
    // hence it re-lists NO_HARDCODED_HEX to keep hex enforced there.
    //
    // ── LEGACY QUARANTINE (strangler-fig), done as a CHECKED BASELINE ──────────
    // Incumbent surfaces still on the Surface/prop-bridge model carry live `.invoke`
    // calls today. They are NOT whole-file ignored — that would exempt NEWLY added
    // `.invoke` calls too, defeating the fence. Instead the EXISTING calls are
    // recorded in `eslint-suppressions.json` (ESLint's suppressions baseline), which
    // the CLI auto-loads. Effect: every current legacy call still passes, but a NEW
    // `.invoke` in a quarantined file pushes the per-file count past the baseline and
    // FAILS. C03–C14 drain the legacy calls and prune the baseline (a drained call
    // leaves an unused suppression, which ESLint also flags); C14 verifies it is empty.
    // Regenerate after draining:
    //   pnpm exec eslint packages/app-ui/src --suppress-rule no-restricted-syntax --prune-suppressions
    files: ["packages/app-ui/src/**/*.ts", "packages/app-ui/src/**/*.tsx"],
    ignores: [
      "packages/app-ui/src/data/**",
      "packages/app-ui/src/**/*.test.ts",
      "packages/app-ui/src/**/*.test.tsx",
    ],
    rules: {
      "no-restricted-syntax": ["error", NO_HARDCODED_HEX, NO_DIRECT_INVOKE],
    },
  },
];
