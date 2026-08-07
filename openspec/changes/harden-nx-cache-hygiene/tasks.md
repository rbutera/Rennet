## 1. Reproduce the cache-correctness bug

- [x] 1.1 Warm the `format` cache, inject a Biome violation into `packages/core/src/index.ts`, show `nx run rennet:format` cache-hits and exits 0 (stale pass)
- [x] 1.2 Show the same tree with `--skip-nx-cache` exits 1 ("Formatter would have… Found 1 error"), proving the cache masks it; restore the file

## 2. Fix the cache config

- [x] 2.1 Add explicit workspace-rooted `inputs` to `format` (every Biome-checked glob + `sharedGlobals`)
- [x] 2.2 Add `biome.json`, `eslint.config.mjs`, `tsconfig.base.json` to `sharedGlobals`
- [x] 2.3 Verify: warm the cache, inject the same violation, `nx run rennet:format` now RE-RUNS and exits 1; unchanged tree still cache-hits

## 3. Target completeness

- [x] 3.1 Add an uncached `real-turn` target to `packages/adapters/project.json` and route the root `real-turn` script through `nx run rennet-adapters:real-turn`

## 4. Agent guidance single-source

- [x] 4.1 Make `AGENTS.md` the real file (refresh the Nx section: targets, trust-the-cache, narrow `--skip-nx-cache`/`nx reset` cases, env gotchas), preserving the nx-managed block
- [x] 4.2 Make `CLAUDE.md` a symlink to `AGENTS.md`; verify `git ls-files -s CLAUDE.md` shows mode 120000

## 5. Verify

- [x] 5.1 Repeat `pnpm check` on an unchanged tree shows cache hits (no full re-run)
- [x] 5.2 Full `pnpm check` exits 0 across all projects (zero errors AND "Successfully ran target(s)")
