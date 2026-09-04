import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// t3.css styles the vendored app from OUTSIDE it, by keying on `data-*` hooks that
// upstream happens to write. That is the whole reason the file needs no vendored edits
// and no PATCHES.md row — and it is also its one failure mode, named in the file's own
// header: "a fold that changes those blocks upstream shows here as missing styling".
//
// A renamed or deleted hook does not error. The selector simply stops matching, the
// composer quietly goes back to 22px corners, the branch strip reappears under the chat
// box, and nothing anywhere says so. Every other test in the repo would stay green.
//
// So this file reads the REAL t3.css and the REAL vendored source, and asserts that every
// upstream hook the stylesheet leans on still exists in the tree it is styling. It is a
// fold tripwire, not a styling test.
//
// WHAT IT CANNOT CATCH, and this matters: a hook can survive on an element that has MOVED.
// If upstream keeps `data-slot="composer-context-strip"` but renders it somewhere else, or
// keeps `data-chat-header` on a header that no longer wraps the controls, this still
// passes while the override does the wrong thing. Presence is checkable from a string;
// position is not. Only looking at the app catches that half.
//
// POSITIVE CONTROLS RUN, 2026-09-04 (each applied alone, this file run, then reverted):
//   1. `data-slot="composer-context-strip"` renamed to `...-strip-x` in the VENDORED
//      ComposerSurface.tsx → 1 failed, naming that hook.
//   2. the vendored `[font-size:var(--font-size-prompt,` renamed → 1 failed.
//      This one FIRST RAN GREEN and that is the useful part: the assertion was
//      `toContain("var(--font-size-prompt,")`, upstream reads the variable twice on that
//      line (once for desktop, once in a coarse-pointer media query), and renaming only
//      the declaration that governs the composer left the media query satisfying it. The
//      assertion is now anchored on the base declaration and the control reddens. A hook
//      sweep that matches a bare name matches the wrong occurrence sooner or later.
//   3. the `[data-slot="composer-context-strip"]{display:none}` rule deleted from t3.css
//      → 3 failed: the "really uses each hook" sweep, "the branch strip is hidden", and
//      the chrome contract — so the rule assertions are not satisfied by the sweep alone.
// ─────────────────────────────────────────────────────────────────────────────

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Comments are stripped FIRST, and that is not tidiness. This file's prose names the very
// hooks and utilities it asserts on, so parsing the raw text made a hook mentioned only in
// a comment read as a hook that is used, and made a sentence containing `.text-sm` read as
// an unscoped selector — which is how the first run of this suite failed. Every assertion
// below is about rules that exist, so it reads only rules.
const css = readFileSync(here("./t3.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const vendor = (path: string): string =>
  readFileSync(here(`../../../vendor/t3code/apps/web/src/${path}`), "utf8");

/** Every upstream attribute hook t3.css depends on, and the vendored file that writes it. */
const HOOKS: readonly (readonly [hook: string, source: string])[] = [
  ['data-slot="composer-shell"', "components/chat/ComposerSurface.tsx"],
  ['data-slot="composer-host"', "components/chat/ComposerSurface.tsx"],
  ['data-slot="composer-context-strip"', "components/chat/ComposerSurface.tsx"],
  ['data-chat-composer-main-surface="true"', "components/chat/ComposerSurface.tsx"],
  ['data-chat-composer-surface="true"', "components/chat/ChatComposer.tsx"],
  ['data-chat-composer-overlay="true"', "components/ChatView.tsx"],
  ["data-chat-header", "components/ChatView.tsx"],
  ["data-with-context", "components/chat/ComposerSurface.tsx"],
];

describe("the upstream hooks t3.css styles through still exist", () => {
  it("t3.css really uses each hook (the sweep is not asserting against a dead list)", () => {
    for (const [hook] of HOOKS) {
      expect(css, `t3.css targets ${hook}`).toContain(hook);
    }
  });

  for (const [hook, source] of HOOKS) {
    it(`${hook} is still written by ${source}`, () => {
      // `data-with-context` is written as a JSX prop without a string value, so match the
      // attribute name alone; the rest appear verbatim.
      expect(vendor(source), `${hook} missing from the vendored source`).toContain(
        hook === "data-with-context" ? "data-with-context=" : hook,
      );
    });
  }

  it("the composer's prompt font-size variable is still the one upstream reads", () => {
    // Not an attribute but the same class of dependency: t3.css sets
    // `--font-size-prompt`, and it only does anything because ComposerPromptEditor reads
    // it. Upstream's own default is the fallback in that same expression.
    //
    // Anchored on the BASE declaration, `[font-size:var(--font-size-prompt,`, not on the
    // bare variable name. Upstream reads it twice on one line — once for the desktop
    // composer and once inside a coarse-pointer media query that floors it at 16px — and
    // a looser `toContain("var(--font-size-prompt,")` was satisfied by the media query
    // alone. The control that renamed only the base read stayed GREEN against that
    // version; this is the assertion that catches it.
    expect(vendor("components/ComposerPromptEditor.tsx")).toContain(
      "[font-size:var(--font-size-prompt,",
    );
    expect(css).toContain("--font-size-prompt:");
  });
});

describe("what the overrides actually say", () => {
  /** The declarations of every rule whose selector list mentions `needle`. */
  const rulesMentioning = (needle: string): string[] => {
    const out: string[] = [];
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if ((match[1] ?? "").includes(needle)) out.push(match[2] ?? "");
    }
    return out;
  };

  it("scopes every override to the two mounts, so nothing leaks into Rennet's own screens", () => {
    // The hazard this file's header names: a utility redefined in this build wins for the
    // WHOLE document. Every rule that touches a shared utility class must therefore be a
    // descendant of a mount. A bare `.text-sm { … }` here would restyle Rennet.
    for (const utility of [".text-base", ".text-sm", ".text-xs", ".text-lg", ".text-xl"]) {
      const rules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)]
        .map((m) => m[1] ?? "")
        .filter((selector) => selector.includes(utility));
      expect(rules.length, `${utility} is overridden`).toBeGreaterThan(0);
      for (const selector of rules) {
        for (const part of selector.split(",")) {
          if (!part.includes(utility)) continue;
          expect(
            part.includes('[data-slot="t3-native-chat"]') ||
              part.includes('[data-slot="t3-thread-view"]'),
            `${utility} override is not scoped to a mount: ${part.trim()}`,
          ).toBe(true);
        }
      }
    }
  });

  it("the branch strip is hidden, and the seam upstream cut for it is closed with it", () => {
    // Two halves of one change. Hiding the strip without clearing the clip-paths leaves a
    // notch bitten out of the composer's bottom edge for a control that is not there —
    // which looks like a rendering bug, not a removed feature.
    expect(rulesMentioning('[data-slot="composer-context-strip"]').join(";")).toContain(
      "display: none",
    );
    expect(rulesMentioning("[data-with-context]").join(";")).toContain("clip-path: none");
  });

  it("the composer's corners come off Rennet's radius scale, not a literal", () => {
    const corners = rulesMentioning('[data-slot="composer-host"]').join(";");
    expect(corners).toContain("var(--radius-surface");
    // The value upstream ships, which this exists to replace, must be gone from the
    // override — a rule that re-stated 22px would be a no-op wearing a fix's name.
    expect(corners).not.toContain("22px");
  });
});

describe("T3's own workspace chrome stays out of the review", () => {
  const source = readFileSync(here("./native-chat.tsx"), "utf8");

  it("neither mount renders T3's sidebar", () => {
    // The mounts render `ChatView` under their own router, never T3's `_chat` layout
    // route, which is where the sidebar and its inset live. This is an ABSENCE assertion
    // and it can only ever be as good as the name it looks for: it pins that no sidebar
    // component is imported or rendered here, and it would not notice a sidebar that
    // arrived from inside ChatView under a different name. The rendered-tree half is not
    // reachable without booting the sidecar, so this is the honest half.
    expect(source).not.toMatch(/import\s+.*Sidebar.*\s+from/);
    expect(source).not.toMatch(/<[A-Za-z]*Sidebar[\s/>]/);
    // Control: the thing it DOES render is named here, so the file being empty or renamed
    // could not make the two assertions above pass vacuously.
    expect(source).toContain("<ChatView");
  });

  it("the thread header and the branch strip are hidden by rule, not by hope", () => {
    // Both are upstream chrome Rennet replaces with its own frame. They are covered by
    // the hook sweep above; asserted here too so the three pieces of "T3's workspace
    // chrome is off" read as one contract in one place.
    expect(css).toContain("[data-chat-header]");
    expect(css).toContain('[data-slot="composer-context-strip"]');
  });
});
