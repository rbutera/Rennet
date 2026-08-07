## Why

Agents keep reaching for `--skip-nx-cache` because they have observed the Nx cache returning a *stale pass* and, separately, the Nx task-history DB throwing `FOREIGN KEY constraint failed` and exiting 1 after printing "Successfully ran target" (issue #45). Every skip defeats the cache and slows the gate. There is a concrete, reproducible cache-correctness bug behind the reflex.

Reproduced on `origin/main`:
- `format` runs on the root `rennet` project and checks child-project files (`biome check packages/*/src apps/desktop/src ...`), but declares **no `inputs`**, so its cache key defaults to the root project's own files only (Nx assigns `packages/*/src` files to the child projects, not to the root). A real Biome violation introduced into `packages/core/src/index.ts` is therefore **cache-hit and exits 0** on a warm cache (stale pass), while the same tree with `--skip-nx-cache` correctly exits 1 ("Formatter would have… Found 1 error"). The cache is what masks the failure — the exact reason `--skip-nx-cache` feels necessary.
- The same class covers shared config files (`biome.json`, `eslint.config.mjs`, `tsconfig.base.json`): they are not in `sharedGlobals`, so editing them does not invalidate the per-project `lint`/`typecheck`/`test`/`build` caches that depend on them.

The `FOREIGN KEY` / exit-1-while-green crash is a known Nx-internal SQLite task-history concurrency bug (Nx 19.7+, still present in 23.1.0; nrwl/nx#28035, #28424). It has no config switch in Nx 23 (`useLegacyCache` was removed in Nx 21, and there is no `NX_DISABLE_DB` in this build), and it only triggers when **two separate Nx processes write the same task-history DB concurrently**. Rennet's worktree-per-agent model already isolates that DB across agents; the residual risk (two Nx invocations in one worktree) is documented, not silently worked around.

## What Changes

- Give `format` explicit workspace-rooted `inputs` covering exactly the globs Biome checks, plus `sharedGlobals`, so any change to a checked file invalidates the cache. This fixes the stale-pass.
- Add `biome.json`, `eslint.config.mjs`, and `tsconfig.base.json` to `sharedGlobals` so a shared-config change busts every dependent cache. Correctness over a rare cache miss on config edits.
- Bring the last ad-hoc gate-adjacent command (`real-turn`, the gated live-Claude integration test) into the task graph as an uncached Nx target so nothing routinely runs outside Nx.
- Refresh agent guidance: make `AGENTS.md` the real source of truth and `CLAUDE.md` a symlink to it (Nx's own convention, and what issue #45 asks). Document the nx-targets, the trust-the-cache rule, the *narrow* legitimate `--skip-nx-cache` / `nx reset` cases (the task-history DB crash), and the shell/env gotchas agents keep hitting on nimbus.

The `pnpm check` gate entrypoint and its target list are unchanged; only cache inputs, one new uncached target, and docs change.

## Capabilities

### New Capabilities

- `nx-cache-hygiene`: The workspace's Nx cache is correct — no cacheable gate target can return a stale pass when a file it checks changes — and every routine command runs through the task graph, with agent guidance in a single-source `AGENTS.md`.

### Modified Capabilities

None.

## Impact

- `nx.json` (`sharedGlobals`), root `package.json` (`nx.targets.format.inputs`, `real-turn` script), `packages/adapters/project.json` (`real-turn` target), `AGENTS.md` (now the real file), `CLAUDE.md` (now a symlink).
- No production dependency change. No change to what `pnpm check` runs or to any pass/fail verdict on a clean tree; the only behavioural change is that a *dirty* tree can no longer stale-pass `format`, and shared-config edits now invalidate dependent caches.
