## ADDED Requirements

### Requirement: No cacheable gate target returns a stale pass
Every cacheable gate target (`format`, `architecture`, `licenses`, `lint`, `typecheck`, `test`, `build`) SHALL declare Nx `inputs` that include every file whose content determines the target's verdict, so that a change to any such file invalidates the cache. A target MUST NOT cache-hit and report success on a tree in which a file it inspects now fails.

#### Scenario: A format violation cannot survive a warm cache
- **WHEN** the `format` cache is warm and a Biome violation is then introduced into a checked source file (for example `packages/core/src/index.ts`)
- **THEN** `nx run rennet:format` re-runs (cache miss) and exits non-zero, matching the `--skip-nx-cache` verdict

#### Scenario: A shared-config change invalidates dependent caches
- **WHEN** a shared config file (`biome.json`, `eslint.config.mjs`, or `tsconfig.base.json`) changes
- **THEN** the cacheable targets that consume it are treated as changed on the next run rather than served from cache

#### Scenario: A type error in a compiled test file cannot survive a warm cache
- **WHEN** the `build` cache is warm and a type error is then introduced into a test file the package's tsconfig compiles (for example `packages/core/src/index.test.ts`)
- **THEN** `nx run rennet-core:build` re-runs (cache miss) and exits non-zero, matching the `--skip-nx-cache` verdict

#### Scenario: A module-boundary tag change cannot survive a warm cache
- **WHEN** the `architecture` cache is warm and a project's `layer:` tag in its `project.json` is then changed so a previously-forbidden import becomes allowed
- **THEN** `nx run rennet:architecture` re-runs (cache miss) and exits non-zero, matching the `--skip-nx-cache` verdict

### Requirement: An unchanged tree serves from cache
Running the full gate twice on a byte-identical tree SHALL serve every cacheable task from the cache on the second run.

#### Scenario: Repeat gate is a full cache hit
- **WHEN** `pnpm check` is run twice with no file changes in between
- **THEN** the second run reports cache hits for every cacheable task and re-runs none of them

### Requirement: Routine commands run through the task graph
Every command routinely needed for development or the gate SHALL be exposed as an Nx target, so no routine invocation bypasses the task graph. Long-running, interactive, or live-network commands MAY be uncached.

#### Scenario: The live-Claude integration test is an Nx target
- **WHEN** the gated real-turn integration test is run
- **THEN** it is invoked as `nx run rennet-adapters:real-turn` (uncached), not as an ad-hoc `vitest` call outside Nx

### Requirement: A single source of truth for agent instructions
`AGENTS.md` SHALL be the real instructions file and `CLAUDE.md` SHALL be a symbolic link to it, tracked in git as mode `120000`. The instructions SHALL state the trust-the-cache rule and enumerate the narrow, legitimate cases for `--skip-nx-cache` / `nx reset`.

#### Scenario: CLAUDE.md is a tracked symlink to AGENTS.md
- **WHEN** `git ls-files -s CLAUDE.md` is inspected
- **THEN** it reports mode `120000` and its content resolves to `AGENTS.md`
