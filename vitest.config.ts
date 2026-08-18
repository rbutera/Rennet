import { configDefaults, defineConfig } from "vitest/config";

// Root config for the package `test` targets, which invoke `vitest run <path>`
// from the workspace root. Without it, vitest's default include sweeps every
// matching file under the root — including per-agent git worktrees nested at
// `.claude/worktrees/<name>/`, whose copies lack linked node_modules and fail
// with transform errors that have nothing to do with the checkout under test.
// The positional path filter is a SUBSTRING match, so `packages/ui/src` also
// matches `.claude/worktrees/x/packages/ui/src`; the exclude is the only fence.
// (apps/desktop passes its own -c config and is unaffected.)
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
