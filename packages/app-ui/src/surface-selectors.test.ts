import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// A SELECTOR A SURFACE NO LONGER RENDERS IS A TEST THAT CANNOT FAIL.
//
// `lens-board-tools` 6.5 deleted `preparation-bench.tsx`, and with it the only element
// that ever carried `[data-screen="session-preparation"]`. The in-package tests were
// rewritten; three Playwright specs were not, and went on asserting the selector — plus
// everything chained off it — against a surface that no longer exists. `pnpm check` could
// not see it, because e2e needs a display and is not in the gate.
//
// So the gate gets this instead: a sweep over the e2e specs and the app-ui sources for
// selectors that name a deleted surface. It is a substring sweep, not a parse, and that is
// the limit — it catches a selector a rewrite missed, which is the failure that actually
// happened, and it does NOT catch a spec asserting a selector that exists on the wrong
// surface. The counted-literal discipline applies: the number of files swept and the
// number of retired selectors are both hard-coded, because deriving either from the walk
// would let an empty walk satisfy both sides.
// ─────────────────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Selectors whose surface this repository deleted, and what replaced each. A future
 *  reintroduction is a deliberate act and removes its row here. */
const RETIRED_SELECTORS: ReadonlyArray<{ readonly selector: string; readonly replacedBy: string }> =
  [
    {
      // The bench's root (`preparation-bench.tsx`, deleted in `lens-board-tools` 6.5).
      selector: 'data-screen="session-preparation"',
      replacedBy: '`[data-testid="workspace-header"]` over the board view',
    },
    {
      // The bench's five-reader grid.
      selector: 'data-testid="bench-readers"',
      replacedBy: '`[data-kind="lens-switcher"] [data-lens]` — the rail',
    },
    {
      // The line the bench printed above its stack of landed boards.
      selector: 'data-testid="bench-boards-landing"',
      replacedBy: "the board's own in-progress mark",
    },
  ];

const SWEPT_DIRECTORIES = ["apps/desktop/e2e", "packages/app-ui/src"] as const;

/** Every file this sweep reads, so the count below is a real measurement of it. */
function sweptFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry.name)) found.push(full);
    }
  };
  for (const dir of SWEPT_DIRECTORIES) walk(path.join(repoRoot, dir));
  return found;
}

/**
 * The only files allowed to name a retired selector: this registry, which must spell them
 * out to sweep for them, and the one DOM test that asserts the bench's root is absent from
 * the rendered app. Named explicitly rather than pattern-matched, so a third file cannot
 * quietly join them.
 */
const ALLOWED = new Set([
  "packages/app-ui/src/surface-selectors.test.ts",
  "packages/app-ui/src/board/live-board.dom.test.tsx",
]);

describe("no test asserts a selector its surface no longer renders", () => {
  it("sweeps a real corpus — not an empty one", () => {
    const files = sweptFiles();
    // HARD-CODED floors, not `files.length > 0`: an empty walk would satisfy both this
    // and the sweep below, which is exactly how a sweep comes to prove nothing.
    expect(files.length).toBeGreaterThan(150);
    expect(RETIRED_SELECTORS).toHaveLength(3);
    expect(files.some((f) => f.includes("apps/desktop/e2e/"))).toBe(true);
    expect(files.some((f) => f.includes("packages/app-ui/src/board/"))).toBe(true);
  });

  it("positive control: the matcher finds a retired selector when one is present", () => {
    const probe = `await expect(page.locator('[${RETIRED_SELECTORS[0]?.selector}]')).toBeVisible();`;
    expect(RETIRED_SELECTORS.some(({ selector }) => probe.includes(selector))).toBe(true);
    // …and does not fire on the selector that replaced it.
    const rewritten =
      "await expect(page.locator('[data-testid=\"workspace-header\"]')).toBeVisible();";
    expect(RETIRED_SELECTORS.some(({ selector }) => rewritten.includes(selector))).toBe(false);
  });

  for (const { selector, replacedBy } of RETIRED_SELECTORS) {
    it(`no surviving reference to [${selector}] — use ${replacedBy}`, () => {
      const offenders = sweptFiles()
        .filter((file) => fs.readFileSync(file, "utf8").includes(selector))
        .map((file) => path.relative(repoRoot, file))
        .filter((rel) => !ALLOWED.has(rel));
      expect(offenders).toEqual([]);
    });
  }
});
