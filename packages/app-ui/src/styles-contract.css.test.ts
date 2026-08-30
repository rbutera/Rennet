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
});

// Two component-source contracts used to live here and no longer do, because the
// components they pinned are gone: the hold-to-sign fill pinned `publish-sheet.tsx`
// (B2, #489 — the canvas publish surface), and the progress-track radius pinned
// `running-review.tsx` (the canvas-era indeterminate bar, which had no production
// consumer left after the board rebuild). Their CSS left with them.
