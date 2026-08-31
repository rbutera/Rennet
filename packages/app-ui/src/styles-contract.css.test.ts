import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-level contracts for review-fix invariants a behavioural test can't see (happy-dom
// runs no CSS animations, and both 4px and 999px are ramp-legal so design-ramp.test.ts can't
// catch a radius reversion). These pin the exact source declarations.

describe("the app stylesheet scans the vendored @rennet/ui kit", () => {
  // Tailwind v4 only generates utilities it finds in @source-scanned files, and it skips
  // node_modules — where the kit resolves as a workspace symlink. The kit writes the shadcn
  // vocabulary this app never types itself (the radius aliases rounded-lg…, bg-primary, the
  // button brightness hovers). Without an @source at the kit's real path those classes are
  // never emitted and every kit Button/Input renders with Tailwind preflight's
  // border-radius:0 — square, no gold fill. RED-proof: delete the kit @source line and this
  // fires. Guards the "square buttons" regression that shipped once already.
  const css = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");

  it("declares an @source pointing at packages/ui/src/components", () => {
    expect(css).toMatch(/@source\s+"[^"]*\bui\/src\/components"/);
  });

  // RED-proof for the titlebar-overlap regression: the shell's h-14 titlebar and its pt-14
  // content offset live in ./app/shell.tsx. A named glob (@source "./app.tsx") stopped
  // covering that file when Wave 4.1 split the monolith into ./app/, so pt-14 was never
  // generated and the fixed titlebar overlapped the view. Scan the whole tree so a future
  // move can't drop a file's utilities again. Revert to a single-file glob and this fires.
  it("scans the whole app-ui source tree, not a single named file", () => {
    expect(css).toMatch(/@source\s+"\.\/"/);
  });

  // The reduced-motion base rule must zero the DELAY, not only the duration. Three surfaces
  // stagger a reveal with an inline `animationDelay` (the streamed word, the welcome tool
  // row, the skeleton row); collapsing only the duration leaves each element waiting out its
  // full stagger, and the streamed word waits it out at `opacity-0` because its settled
  // opacity comes from a `forwards` fill.
  //
  // WHAT THIS CANNOT CATCH, stated rather than implied: it reads the source text, so it
  // proves the declaration is present and inside the `prefers-reduced-motion` block — not
  // that a browser reduces anything. happy-dom runs no animations and applies no cascade, so
  // the behaviour itself is unproven by any automated test in this repo. Deleting the
  // declaration reddens this; weakening it to a selector that never matches would not.
  it("zeroes animation-delay inside the reduced-motion block, not merely somewhere", () => {
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n {2}\}/.exec(css);
    if (block?.[1] === undefined) throw new Error("no prefers-reduced-motion block in index.css");
    expect(block[1]).toMatch(/animation-delay:\s*0m?s\s*!important/);
    // …and the duration collapse it sits beside is still there — the pair is the rule.
    expect(block[1]).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });

  // Perf audit §5 H9. `--animate-word-in` fills `forwards`, and a live turn renders one
  // animating span per arriving word — so whatever the LANDING frame declares is retained
  // on those spans for as long as they live. `filter: blur(0)` is a filter, not `none`: it
  // is a stacking context and a compositing layer per word, kept for the transcript's
  // lifetime. `transform: translateY(0)` is the same trap. Naming only `opacity` lets the
  // implicit `to` frame interpolate each of them back to the element's underlying `none`,
  // which is the identity value for both — same motion, nothing retained.
  //
  // WHAT THIS CANNOT CATCH, same limit as the rule above: it reads source text. It proves
  // the landing frame is declared this way, not that a browser then releases the layer.
  // Re-adding `filter: blur(0)` to the `to` frame reddens it — that is the reversion it is
  // here for. `streaming-prose.dom.test.tsx` covers the DOM half (a settled word is text,
  // so it carries no animation at all).
  it("lands word-in on opacity alone, so its forwards fill retains no filter or transform", () => {
    const start = css.indexOf("@keyframes word-in {");
    expect(start).toBeGreaterThan(-1);
    const open = css.indexOf("{", start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < css.length && end === -1; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}" && --depth === 0) end = i;
    }
    const body = css.slice(open + 1, end);
    const from = /from\s*\{([^}]*)\}/.exec(body)?.[1] ?? "";
    const to = /\bto\s*\{([^}]*)\}/.exec(body)?.[1] ?? "";

    // The reveal itself is unchanged: it still blurs and lifts on the way IN.
    expect(from).toMatch(/filter:\s*blur\(/);
    expect(from).toMatch(/transform:\s*translateY\(/);
    // It just does not land on either.
    expect(to).toMatch(/opacity:\s*1/);
    expect(to).not.toMatch(/filter/);
    expect(to).not.toMatch(/transform/);
    // …which only matters because the fill is `forwards`.
    expect(css).toMatch(/--animate-word-in:\s*word-in\s[^;]*forwards/);
  });
});

// Two component-source contracts used to live here and no longer do, because the
// components they pinned are gone: the hold-to-sign fill pinned `publish-sheet.tsx`
// (B2, #489 — the canvas publish surface), and the progress-track radius pinned
// `running-review.tsx` (the canvas-era indeterminate bar, which had no production
// consumer left after the board rebuild). Their CSS left with them.
