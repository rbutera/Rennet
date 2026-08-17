import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Root is pinned to this file's directory (apps/desktop) so the globs below resolve
// there regardless of the cwd the gate runs from.
//
// Why this file exists: the test target used to scope with a bare `vitest run
// apps/desktop/src` positional. That positional is matched against test-file paths with
// forward slashes, so on a win32 host (backslash paths) it silently stopped scoping and
// vitest fell back to its default include — which swept up `e2e/*.spec.ts` (Playwright
// specs) and tried to run them under vitest. An explicit root + include/exclude is
// separator-independent and deterministic on every platform.
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**", "out/**"],
  },
});
