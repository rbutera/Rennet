import nx from "@nx/eslint-plugin";

// ── Local `rennet` plugin: three DISTINCT rule ids ───────────────────────────
// The strangler baseline (eslint-suppressions.json) suppresses a per-file COUNT
// per rule id. Folding hex + invoke + toggle under the single `no-restricted-syntax`
// id merged their counts, so removing one selector's violation while adding another
// selector's in the same file kept the count equal and PASSED. Splitting them into
// three own-id rules makes each count independent — a new toggle can no longer hide
// behind a drained hex, and vice versa.
const HEX_MESSAGE =
  "No hardcoded hex colours in the UI packages — use a theme utility or var(--rn-…) token from @rennet/theme.";
const INVOKE_MESSAGE =
  "No direct bridge.invoke in app-ui surfaces — read through useCommand, write through useMutation, stream through useCommandStream (data/ hooks over useBridge). Only src/data/ may call .invoke.";
const TOGGLE_MESSAGE =
  "No hand-rolled segmented control in app-ui surfaces — use ToggleGroup/Toggle from @rennet/ui instead of hand-rolling a group of aria-pressed buttons or a role=radiogroup with pressed children (autopsy S6).";

/** A rule that reports a single esquery selector — the invoke + hex fences. */
function selectorRule(selector, message) {
  return {
    meta: { type: "problem", schema: [], docs: { description: message } },
    create: (context) => ({
      [selector](node) {
        context.report({ node, message });
      },
    }),
  };
}

/** True if `el` (a JSXElement) has an `aria-pressed` attribute of its own. */
function hasAriaPressed(el) {
  return (
    el?.type === "JSXElement" &&
    el.openingElement.attributes.some(
      (a) => a.type === "JSXAttribute" && a.name?.name === "aria-pressed",
    )
  );
}

/** True if any ancestor of `node` is a `.map(...)` call — a dynamic group. */
function insideMapCallback(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (
      n.type === "CallExpression" &&
      n.callee?.type === "MemberExpression" &&
      n.callee.property?.name === "map"
    ) {
      return true;
    }
  }
  return false;
}

/** True if a JSXElement sibling of `el` also carries `aria-pressed` — a static group. */
function hasPressedSibling(el) {
  const kids = el.parent?.children;
  return (
    Array.isArray(kids) &&
    kids.some((k) => k !== el && k.type === "JSXElement" && hasAriaPressed(k))
  );
}

/** True if any nested JSXElement under `el` carries `aria-pressed` (static subtree). */
function subtreeHasAriaPressed(el) {
  for (const child of el.children ?? []) {
    if (child.type === "JSXElement" && (hasAriaPressed(child) || subtreeHasAriaPressed(child))) {
      return true;
    }
  }
  return false;
}

// Kit-not-hand-rolled (autopsy S6): app-ui surfaces must not hand-roll a
// "pick one of N" segmented control. The tell is a GROUP of pressed buttons — the
// prior rule flagged EVERY lone `aria-pressed`, which wrongly caught legitimate
// single two-state buttons (a pin, a mute) and MISSED expression/loop-generated
// groups. This rule fires only on the group shape: (1) two-or-more sibling
// `aria-pressed` buttons, (2) an `aria-pressed` rendered in a `.map()` (the dynamic
// segmented control), or (3) a `role="radiogroup"` whose subtree hand-rolls
// `aria-pressed` (a real radiogroup uses role=radio + aria-checked). A lone
// `aria-pressed` passes — that is a genuine toggle, not a segmented control.
const noHandrolledToggle = {
  meta: { type: "problem", schema: [], docs: { description: TOGGLE_MESSAGE } },
  create(context) {
    return {
      "JSXAttribute[name.name='aria-pressed']"(node) {
        const el = node.parent?.parent;
        if (el?.type !== "JSXElement") return;
        if (insideMapCallback(el) || hasPressedSibling(el)) {
          context.report({ node, message: TOGGLE_MESSAGE });
        }
      },
      "JSXAttribute[name.name='role'][value.value='radiogroup']"(node) {
        const el = node.parent?.parent;
        if (el?.type === "JSXElement" && subtreeHasAriaPressed(el)) {
          context.report({ node, message: TOGGLE_MESSAGE });
        }
      },
    };
  },
};

const rennet = {
  rules: {
    "no-hardcoded-hex": selectorRule("Literal[value=/#[0-9a-fA-F]{3,8}/]", HEX_MESSAGE),
    "no-direct-invoke": selectorRule(
      "CallExpression[callee.property.name='invoke']",
      INVOKE_MESSAGE,
    ),
    "no-handrolled-toggle": noHandrolledToggle,
  },
};

export default [
  {
    // vendor/: the T3 Code snapshot keeps upstream's formatting and lint; see
    // vendor/t3code/PATCHES.md for the rule.
    ignores: ["**/dist/**", "**/out/**", "**/coverage/**", "node_modules/**", "vendor/**"],
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
              // layer:vendor is the vendored T3 Code snapshot (vendor/t3code). The
              // server may import its contracts, but only from ONE module — the
              // daemon-side T3 client — which the no-restricted-imports block below
              // enforces file by file.
              sourceTag: "layer:server",
              onlyDependOnLibsWithTags: [
                "layer:protocol",
                "layer:prompts",
                "layer:core",
                "layer:adapter",
                "layer:server",
                "layer:vendor",
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
    plugins: { rennet },
    rules: {
      "rennet/no-hardcoded-hex": "error",
    },
  },
  {
    // The bridge seam is a standing architecture law, not a consent gate (Rule Zero):
    // every app-ui surface reaches the bridge through the data-seam hooks, never by
    // calling `.invoke` itself. The seam internals under `src/data/` are the ONE
    // sanctioned caller and are exempt; tests drive MemoryBridge directly and are
    // exempt too. Hex is enforced on these same surfaces by the block ABOVE (app-ui
    // is in its `files`) — with distinct rule ids there is no options-REPLACE merge to
    // guard against, so the two fences stack cleanly across blocks.
    //
    // ── LEGACY QUARANTINE (strangler-fig), done as a CHECKED BASELINE ──────────
    // Incumbent surfaces still on the Surface/prop-bridge model carry live `.invoke`
    // calls (and map-rendered hand-rolled segmented controls) today. They are NOT
    // whole-file ignored — that would exempt NEWLY added violations too, defeating the
    // fence. Instead the EXISTING violations are recorded in `eslint-suppressions.json`
    // (ESLint's suppressions baseline), which the CLI auto-loads. Because each fence
    // now has its OWN rule id, the baseline holds a SEPARATE per-file count per rule:
    // a new toggle can no longer mask itself behind a drained invoke/hex. A new
    // `.invoke` / hand-rolled group pushes that rule's per-file count past the baseline
    // and FAILS. C03–C14 drain the legacy sites and prune the baseline (a drained entry
    // leaves an unused suppression, which ESLint also flags); C14 verifies it is empty.
    // Regenerate after draining:
    //   pnpm exec eslint packages/app-ui/src \
    //     --suppress-rule rennet/no-hardcoded-hex \
    //     --suppress-rule rennet/no-direct-invoke \
    //     --suppress-rule rennet/no-handrolled-toggle --prune-suppressions
    files: ["packages/app-ui/src/**/*.ts", "packages/app-ui/src/**/*.tsx"],
    ignores: [
      "packages/app-ui/src/data/**",
      "packages/app-ui/src/**/*.test.ts",
      "packages/app-ui/src/**/*.test.tsx",
    ],
    plugins: { rennet },
    rules: {
      "rennet/no-direct-invoke": "error",
      "rennet/no-handrolled-toggle": "error",
    },
  },
  {
    // `effect` and `@t3tools/*` are imported by vendored code and by exactly one Rennet
    // module, the daemon-side T3 client (AGENTS.md, "Vendored T3 Code"). Everything else in
    // the server stays Promise-shaped; the client is the seam that converts.
    files: ["packages/server/src/**/*.ts"],
    ignores: ["packages/server/src/t3/client.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["effect", "effect/*", "@t3tools/*"],
              message:
                "Only packages/server/src/t3/client.ts may import effect or @t3tools/*; consume its Promise/AsyncIterable API instead.",
            },
          ],
        },
      ],
    },
  },
];
