// ─────────────────────────────────────────────────────────────────────────────
// @rennet/ui DOM-test harness (issue #53).
//
// The rest of the suite renders with `react-dom/server` in vitest's default NODE
// environment: SSR strings, static node-count assertions. That harness cannot
// exercise onScroll firing, keydown-in-a-textarea, click→adjudicate wiring, or a
// useEffect resolving — which is exactly why the #11 Canvas UI shipped four
// interaction bugs past green tests. This module is the mounted-DOM counterpart.
//
// A test FILE opts in by declaring `// @vitest-environment happy-dom` on its very
// first line (per-file pragma — the global environment stays node, so the ~157
// existing SSR tests are untouched), then imports its mounting primitives here.
//
// vitest runs WITHOUT `globals`, so @testing-library/react's own auto-cleanup
// (which keys off a global `afterEach`) never registers. We register it here: the
// top-level `afterEach(cleanup)` binds to the suite of whichever isolated test
// file imports this module, so every mounted tree is unmounted between tests.
// ─────────────────────────────────────────────────────────────────────────────
import { cleanup, type RenderOptions, type RenderResult, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach } from "vitest";

// The desktop renderer's primary production platform is macOS. happy-dom reports a
// Linux-like platform by default, while the long-standing interaction fixtures press
// Command chords. Pin the harness explicitly; platform-specific matcher unit tests pass
// their platform directly and cover Windows/Linux separately.
Object.defineProperty(globalThis.navigator, "platform", {
  configurable: true,
  value: "MacIntel",
});

// Unmount and reset browser-owned state between tests in this file.
afterEach(() => {
  cleanup();
  try {
    globalThis.localStorage?.clear();
  } catch {
    return;
  }
});

/** The RTL render handle, plus a ready-to-drive user-event instance. */
export type MountResult = RenderResult & {
  user: ReturnType<typeof userEvent.setup>;
};

/**
 * Mount a component into a real (happy-dom) document. Returns the full RTL handle
 * (`container`, `getBy*`, `rerender`, `unmount`, …) plus a configured
 * `user` for high-level interaction. Downstream UI slices (#17, #22, #35, #36,
 * #37) mount through this so interaction coverage is the default, not the SSR
 * exception.
 */
export function mount(ui: ReactElement, options?: RenderOptions): MountResult {
  const result = render(ui, options);
  return { ...result, user: userEvent.setup() };
}

export { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
export { userEvent };
