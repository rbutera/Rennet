---
tags: [rennet, tooling, plans]
categories: [project]
status: active
created: 2026-08-04
updated: 2026-08-05
---

# Rennet Repo Bootstrap Plan

> [!IMPORTANT] Current implementation authority, 2026-08-06
> ⛔ **SUPERSEDED 2026-08-06: the banner below (originally 2026-08-05) restated two rules that are now reversed. Rennet is MIT throughout — there is no Apache-2.0 / AGPL-3.0-only split any more, every package is MIT. And the Claude Agent SDK is ADOPTED, not banned. See Master Plan R2/R3.**
> Bootstrap **Rennet** from [[Rennet Master Plan]], [[Rennet Architecture Contracts]], and [[Rennet Navi Handoff]], not from stale recipes retained below. The final layout is `packages/{types, protocol, core, adapters, ui, instructions, tsconfig}` plus `apps/{desktop, mobile-placeholder}`, `scripts/`, and non-workspace `spikes/`. ~~`types` and `protocol` are Apache-2.0; the rest of the open app is `AGPL-3.0-only`~~ (superseded, see note above — all MIT). `ui` imports only `types` and `protocol`. Use `ForgePort`, never `GithubPort`. ~~Never import or bundle the Claude Agent SDK~~ (superseded, see note above — SDK adopted). Use occurrence/lineage identity, validated hybrid decomposition, and the six-angle set without Subtraction.
> The private monorepo now exists at `github.com/rbutera/rennet`. Historical neutral-name and “do not create the GitHub repo” steps below are superseded; public namespace and release registration remain deferred.

Repository bootstrap and engineering principles for [[Code Review Harness App]]. The product name is Rennet; the filename is retained only to preserve existing Obsidian links. Personal product owned by Rai, not the enterprise client work. Built largely by autonomous agents, so the repo itself has to be the control system: the layout makes wrong imports impossible, the gates make wrong claims impossible, and `CLAUDE.md` makes the doctrine legible without a human in the loop.

Toolchain and version facts come from [[References/Desktop and Mobile Stack 2026]] (verified 2026-08-04). Product decisions come from [[Code Review Harness App]]. Design doctrine comes from [[Code Review App Design Directions]].

**Design premise of this plan:** an autonomous agent will happily install `better-sqlite3`, import `node:fs` into `core/`, and key review state on `process.cwd()`, and every one of those is a decision that costs months to undo. So each of the three load-bearing rules gets a mechanical gate, not a paragraph. A rule with no failing check is a suggestion.

---

## 0. The licence problem, first, because it moves a package

⛔ **SUPERSEDED 2026-08-06: this entire section is historical.** Rennet is MIT throughout — every package, including `core`, `adapters`, `instructions`, `ui`, and `apps/desktop` — so the AGPL-viral-linking problem this section analyses no longer applies, and the Apache-2.0/AGPL-3.0-only package split below was never built. The section is kept as the record of the reasoning that led to (and was later reversed from) that split; do not build from it.

This is the highest-consequence finding in the plan and it changes the repo layout, so it goes before the tree.

The plan of record is: open-source core and desktop app, **paid** mobile companion ([[Code Review Harness App]] Decisions, 2026-08-04). If the intended licence is AGPL-3.0, three things collide:

1. **AGPL is viral across linking.** If `apps/mobile` imports `@rennet/core` and core is AGPL, the mobile app is a derivative work and must ship under AGPL, source included. That kills "paid closed companion" as stated.
2. **The App Store precedent.** Apple's App Store terms impose usage and device restrictions that the FSF holds to be incompatible with GPL-family "no further restrictions" clauses. VLC was pulled from the App Store in 2011 over exactly this and came back only after the copyright holders relicensed. Same family of problem for AGPL. **Not legal advice, and a solicitor should confirm before any money changes hands**, but plan as though it is real, because the mitigation is free and the cure is not.
3. **The mitigation only works if you own the copyright.** Rai can grant Apple-compatible terms for his own code. He cannot for a contributor's, unless the contributor assigned or licensed it to him.

**Recommended structure, which falls straight out of the above:**

| Package | Licence | Reason |
|---|---|---|
| `packages/types` | **Apache-2.0** | Shared transport-safe domain types. Imports no in-repo package. |
| `packages/protocol` | **Apache-2.0** | Wire protocol and RSP schemas. May import `types`; nothing else in-repo. |
| `packages/core` | **AGPL-3.0-only** | The engine: decomposition, anchoring, review state, angles. |
| `packages/adapters` | AGPL-3.0-only | Node-side port implementations. |
| `packages/instructions` | AGPL-3.0-only | Versioned product instruction layer; never imported by protocol/types/mobile. |
| `packages/ui` | AGPL-3.0-only | Renderer components. |
| `apps/desktop` | AGPL-3.0-only | The open desktop app. |
| `apps/mobile-placeholder` | Proprietary, separate `LICENSE` | Future companion placeholder. Imports published `@rennet/types` and `@rennet/protocol` only. |

⛔ **SUPERSEDED 2026-08-06: this table was never built. Every package is MIT; there is no Apache-2.0/AGPL-3.0-only split.**

[[References/Desktop and Mobile Stack 2026]] section 10 already concluded that the shared surface is "the wire protocol and the domain types, which is maybe 15% of `core/`". Splitting that 15% into its own package makes **the licence boundary and the import boundary the same line**, which means the boundary lint that stops mobile importing the engine is simultaneously the thing that keeps the paid app legally clean. One check, two jobs.

**Contribution policy:** DCO (`Signed-off-by:` on every commit, checked in CI) as the baseline, plus a lightweight CLA granting Rai the right to relicense, required before any outside PR merges. The CLA is not ideology; without it the App Store mitigation in point 3 above is unavailable forever. Documented in `CONTRIBUTING.md`, pointed at from `CLAUDE.md`.

---

## 1. Repo layout

⛔ **SUPERSEDED 2026-08-06: the `(AGPL)` / `(Apache-2.0)` annotations in the tree below are historical — every package is MIT.**

```
rennet/                                   # repo root (name TBD, see branding note)
├── .github/
│   ├── workflows/
│   │   ├── gate.yml                      # the required check
│   │   ├── e2e.yml                       # Playwright _electron, macOS runner
│   │   └── release.yml                   # later: sign, notarize, publish
│   ├── pull_request_template.md          # includes the Definition of Done block
│   └── CODEOWNERS
├── .claude/
│   ├── settings.json                     # shared, committed
│   ├── settings.local.json               # gitignored
│   └── skills/                           # repo-local skills (gate, spike, bead-pr)
├── apps/
│   ├── desktop/                          # @rennet/desktop  (AGPL)
│   │   ├── src/
│   │   │   ├── main/                     # Electron main. The "shell". Thin.
│   │   │   │   ├── index.ts
│   │   │   │   ├── ipc/dispatcher.ts     # the ONE ipcMain.handle
│   │   │   │   ├── windows/
│   │   │   │   └── ports/                # wires adapters into core's ports
│   │   │   ├── preload/index.ts          # contextBridge, exposes invoke only
│   │   │   └── renderer/
│   │   │       ├── main.tsx
│   │   │       ├── ipc/invoke.ts         # typed client for the command map
│   │   │       └── app/                  # routes, layout, glass chrome
│   │   ├── e2e/                          # Playwright _electron specs
│   │   ├── forge.config.ts
│   │   ├── electron-builder.yml
│   │   └── vite.{main,preload,renderer}.config.ts
│   └── mobile/                           # PLACEHOLDER until phase 2
│       ├── README.md                     # what it will be, what it may import
│       ├── LICENSE                       # proprietary
│       └── package.json                  # private: true, no deps, no scripts yet
├── packages/
│   ├── protocol/                         # @rennet/protocol  (Apache-2.0)
│   │   └── src/
│   │       ├── commands.ts               # name -> { input, output } zod map
│   │       ├── events.ts                 # normalized harness event protocol
│   │       ├── pairing.ts                # desktop<->mobile wire messages
│   ├── types/                            # @rennet/types  (Apache-2.0), shared wire-safe types
│   ├── core/                             # @rennet/core  (AGPL) PORTABLE. ZERO platform imports.
│   │   └── src/
│   │       ├── ports/                    # GitPort, FsPort, StorePort, HarnessPort, ClockPort, RandomPort
│   │       ├── workspace/                # repo identity, worktree graph, discovery logic
│   │       ├── changeset/                # immutable occurrences + lineage graph
│   │       ├── angles/                   # spec, sequence, decisions, claims, blast radius, noise
│   │       ├── review/                   # event log, projections, coverage, obligations
│   │       └── index.ts
│   ├── adapters/                         # @rennet/adapters  (AGPL) Node-side port impls
│   │   └── src/
│   │       ├── git/                      # spawn wrapper, NUL parser, AbortSignal
│   │       ├── store/                    # sqlite + kysely
│   │       ├── harness/                  # claude CLI, codex app-server, omp + decoders
│   │       └── github/                   # ForgePort impl, gh token provider, octokit graphql
│   ├── ui/                               # @rennet/ui  (AGPL) React. No node:, no electron.
│   │   └── src/
│   │       ├── tokens/                   # the glass design system, Tailwind v4 @theme
│   │       ├── chrome/                   # glass: sidebar, panels, palette
│   │       ├── code/                     # opaque: diff surface, @pierre/diffs wrapper
│   │       └── paper/                    # the publish sheet
│   ├── instructions/                     # @rennet/instructions (AGPL), versioned base prompts
│   └── tsconfig/                         # @rennet/tsconfig  shared bases, no build
├── spikes/                               # NOT a workspace member. See policy below.
│   └── .gitignore-note.md
├── scripts/
│   ├── check-boundaries.mjs              # the portable-core gate
│   ├── check-state-keying.mjs            # the state-keying smell gate
│   ├── install-hooks.mjs                 # writes .git/hooks/pre-push, no husky
│   └── fixtures/                         # deliberately-failing files for gate calibration
├── docs/
│   ├── architecture.md
│   ├── ports.md                          # the port interfaces, the Tauri contract
│   └── decisions/                        # ADRs, numbered
├── CLAUDE.md
├── AGENTS.md                             # symlink -> CLAUDE.md (Codex reads this)
├── CONTRIBUTING.md                       # DCO + CLA + commit conventions
├── LICENSE                               # AGPL-3.0-only (root default)
├── biome.json
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.json                         # solution file, references only
├── vitest.workspace.ts
├── .nvmrc / .tool-versions
└── justfile                              # optional sugar, pnpm scripts are canonical
```

### The dependency arrows (this is the architecture)

```
types  <-  protocol  <-  core  <-  adapters  <-  desktop
  ^          ^          ^                        ^
  +----------+----------+---------  ui  ----------+
  |
mobile-placeholder   (published types + protocol ONLY)
```

Rules, each mechanically enforced in section 2:

- `types` imports **nothing** in-repo; `protocol` may import `types` and `zod` only.
- `core` imports `protocol` and `zod`. Nothing else. No `node:*`, no `electron`, no DOM.
- `adapters` imports `core`, `protocol`, and Node. It may not import `ui` or `electron`.
- `ui` imports `types`, `protocol`, and React. It may not import `core`, `adapters`, `instructions`, `node:*`, or `electron`.
- `desktop` imports everything. It is the only place `electron` appears.
- `mobile-placeholder` imports published `types` and `protocol` only.

`ui` not importing `core` is deliberate and slightly surprising: the renderer talks to the engine through the IPC command map, never by calling core functions in-process. That is what keeps the renderer honest about the process boundary and what makes the mobile client a peer of the renderer rather than a second-class citizen.

### Why `adapters` is a package and not a folder in `desktop`

Because it makes the portability claim testable. `adapters` runs under plain Node in Vitest with no Electron, so the git wrapper and the store get real tests in milliseconds. And a Tauri port replaces `adapters` plus `desktop/src/main`, leaving `protocol`, `core`, and `ui` untouched. That sentence is the whole reason the shell is a commodity; the package boundary is where you find out whether it is true.

### `spikes/` policy

Spikes are how the highest-risk unknowns get resolved (the `@pierre/diffs` virtualization question is spike #1 and can invalidate the rendering plan). They must not become the codebase.

- `spikes/` is **not** in `pnpm-workspace.yaml`. Turbo never sees it, the gate never runs it, Biome ignores it.
- Each spike gets its own directory with its own throwaway `package.json` and its own `node_modules`. Dependencies installed there are not project dependencies and need no bead.
- A spike has a **tracked question** and closes with a **written verdict under `docs/`**, not with promoted production code. Code from a spike is re-written under the gates or deleted.
- Hard expiry: a spike directory older than 14 days is deleted by the janitor, verdict or no verdict. If it survived 14 days it was not a spike.
- `spikes/**` is in `.gitignore` except for each spike's `VERDICT.md`, so the finding is committed and the scratch is not.

### `apps/mobile` placeholder

Committed from day one as a `private: true` package with no dependencies, a `README.md` stating "this package may import `@rennet/protocol` and nothing else from this repo", and its own proprietary `LICENSE`. It exists early for exactly one reason: the boundary check has something to enforce against before anyone writes mobile code, so the day the first mobile file lands the wrong import already fails.

### Workspace config

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
# spikes/ deliberately absent
```

```jsonc
// .npmrc
strict-peer-dependencies=true      // catch React major mismatches at install
resolution-mode=highest
save-exact=true                    // 0.x libraries dominate this stack; pin everything
engine-strict=true
```

`save-exact=true` is not fussiness. Electron and other 0.x dependencies move quickly. Caret ranges on a 0.x line are a silent breakage generator, and a silent breakage generator in an autonomous-agent repo is a monster door.

---

## 2. TypeScript strategy for TS 7

TS 7.0.2 is the Go-native compiler with **no stable programmatic API until 7.1**, which kills `typescript-eslint` and `ts-morph`. That is why Biome is the linter: it does not need the TS API. Confirmed in [[References/Desktop and Mobile Stack 2026]] section 10.

### `packages/tsconfig/` bases

```jsonc
// packages/tsconfig/base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

```jsonc
// packages/tsconfig/portable.json   <- used by protocol and core
{
  "extends": "./base.json",
  "compilerOptions": {
    "lib": ["ES2022"],   // no DOM: window/document fail to typecheck
    "types": []          // no @types/node: node:fs fails to typecheck
  }
}
```

```jsonc
// packages/tsconfig/node.json       <- adapters, desktop/main, desktop/preload
{ "extends": "./base.json", "compilerOptions": { "lib": ["ES2022"], "types": ["node"] } }

// packages/tsconfig/dom.json        <- ui, desktop/renderer
{ "extends": "./base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": [], "jsx": "react-jsx" } }
```

**`"types": []` plus `"lib": ["ES2022"]` in `portable.json` is the primary portable-core gate.** It is not a lint rule an agent can add an ignore comment to; it is the type checker refusing to resolve the module. `import { readFile } from "node:fs"` in `packages/core` fails `pnpm typecheck` with "Cannot find module". So does `document.querySelector`. The lint rules in section 3 are the second and third layers, there to produce a *good error message* and to catch dynamic `require`, but this line is the one that actually holds.

### Build and resolution

- `protocol`, `core`, `adapters`, `ui` build with **tsdown** (Rolldown) to `dist/`, emitting ESM plus `.d.ts`. `tsup` is in maintenance; tsdown is its designated successor (2026-07-23).
- `exports` conditions on `protocol` put `react-native` **before** `node` and `default`, because Metro takes the first match:

```jsonc
// packages/protocol/package.json
{
  "name": "@rennet/protocol",
  "type": "module",
  "license": "Apache-2.0", // ⛔ SUPERSEDED 2026-08-06: MIT, not Apache-2.0 — see note in section 0
  "exports": {
    ".":          { "types": "./dist/index.d.ts", "react-native": "./dist/index.native.js", "node": "./dist/index.node.js", "default": "./dist/index.js" },
    "./commands": { "types": "./dist/commands.d.ts", "default": "./dist/commands.js" },
    "./events":   { "types": "./dist/events.d.ts", "default": "./dist/events.js" }
  }
}
```

- Consumers resolve to `dist`, so `typecheck` **depends on** `^build` in the turbo graph. That is a real edge, not decoration, and it is what makes `turbo run typecheck` correct rather than lucky.
- Dev ergonomics: `turbo run dev` runs `tsdown --watch` in each library alongside the Electron dev server. If watch-rebuild latency becomes annoying, the refinement is TS project references with `composite: true` so the editor resolves source directly (listed in open questions, not adopted on day one because it doubles the config surface for a four-package repo).

---

## 3. Quality gates

### The local gate

One command, and it is the same command CI runs. Root `package.json`:

```jsonc
{
  "scripts": {
    "gate":       "turbo run lint typecheck boundary test",
    "gate:full":  "pnpm gate && turbo run e2e",
    "lint":       "biome check .",
    "fix":        "biome check --write .",
    "prepare":    "node scripts/install-hooks.mjs"
  }
}
```

Per-package scripts:

```jsonc
// every package
{ "scripts": {
    "build":     "tsdown",
    "typecheck": "tsc --noEmit -p .",
    "test":      "vitest run",
    "lint":      "biome check ."
} }
```

Root-only:

```jsonc
{ "scripts": { "boundary": "node scripts/check-boundaries.mjs && node scripts/check-state-keying.mjs" } }
```

**`vitest run`, never `vitest --changed`.** This is the rule that mirrors the hard-won lesson from the client repos, where `dotnet build` passing locally meant nothing because `dotnet format --verify-no-changes` and IDE0005 only fired in CI, and the fix cycle cost a push each time. The generalisation: **the local gate must be a superset of CI, run in full, every push.** Touched-file test selection is exactly the check that cannot fail, because the breakage you ship is the one in the file you did not touch. Full suite, every push, no exceptions, no `--changed`, no `-t` filter, no `--bail`.

Corollary that matters more as the suite grows: if the full suite gets slow enough that someone wants to skip it, **that is a bead to make the suite fast**, not a licence to run less of it.

### `turbo.json`

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "stream",
  "globalDependencies": ["biome.json", "tsconfig.json", "packages/tsconfig/**", ".nvmrc"],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "package.json", "tsconfig.json", "tsdown.config.ts"],
      "outputs": ["dist/**", "out/**", ".vite/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "e2e/**", "tsconfig.json"],
      "outputs": []
    },
    "lint":     { "dependsOn": [], "outputs": [] },
    "boundary": { "dependsOn": [], "outputs": [] },
    "test": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "test/**", "vitest.config.ts"],
      "outputs": ["coverage/**"]
    },
    "e2e":     { "dependsOn": ["build"], "outputs": ["playwright-report/**", "test-results/**"], "cache": false },
    "package": { "dependsOn": ["build"], "outputs": ["out/**", "release/**"], "cache": false }
  }
}
```

Notes on the graph, since the brief asked for a real one:

- `typecheck` and `test` depend on `^build` (upstream builds), not on their own build, because a package typechecks its own source but consumes its dependencies' emitted `.d.ts`.
- `lint` and `boundary` depend on nothing; they are pure source reads and should run first and fastest.
- `e2e` depends on `build` (own build, not upstream) because Playwright drives the packaged renderer.
- `package` is `cache: false` because signing and notarization are not reproducible and a cached "signed" artifact is a lie.

### Boundary lint: three layers, each calibrated

**Layer 1: the type system.** `"types": []` and `"lib": ["ES2022"]` in `portable.json`, per section 2. Cannot be suppressed by a comment.

**Layer 2: Biome `noRestrictedImports`.** Verified against Biome docs 2026-08-04: the rule lives in the `style` group and the `patterns` option (gitignore-style globs with `!` negation) exists since 2.2.0, so 2.5.6 has it.

```jsonc
// biome.json (overrides section)
{
  "$schema": "https://biomejs.dev/schemas/2.5.6/schema.json",
  "overrides": [
    {
      "includes": ["packages/core/**", "packages/protocol/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["node:*", "electron", "electron/*", "fs", "path", "child_process", "os", "crypto"],
          "message": "core and protocol are portable. Platform capability enters through a port interface implemented in packages/adapters. See CLAUDE.md, portable-core rule." },
        { "group": ["@rennet/adapters", "@rennet/ui", "@rennet/adapters/*", "@rennet/ui/*"],
          "message": "core must not depend on its own implementations. Arrows point inward." }
      ] } } } } }
    },
    {
      "includes": ["packages/ui/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["node:*", "electron", "electron/*", "@rennet/adapters", "@rennet/core"],
          "message": "the renderer reaches the engine through the IPC command map, never in-process." }
      ] } } } } }
    },
    {
      "includes": ["apps/mobile/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@rennet/core", "@rennet/core/*", "@rennet/adapters", "@rennet/adapters/*", "@rennet/ui", "@rennet/ui/*"],
          "message": "mobile imports @rennet/protocol only. This is an AGPL boundary as well as an architectural one. See CLAUDE.md section on licensing." /* ⛔ SUPERSEDED 2026-08-06: no AGPL boundary exists — everything is MIT; the import restriction is architectural only now */ }
      ] } } } } }
    }
  ]
}
```

**Layer 3: `scripts/check-boundaries.mjs`, roughly 80 lines.** Reads each workspace `package.json`, asserts the declared `dependencies` match the allowed arrow set (so nobody adds `electron` to `packages/ui`'s dependencies and only discovers it at runtime), and greps source for dynamic escapes Biome's static rule cannot see: `require(`, `import(` with a non-literal, `globalThis.process`, `eval`. Exits non-zero with the file:line.

**Calibration, mandatory.** `scripts/fixtures/` contains deliberately-violating files (a `core` file importing `node:fs`, a `ui` file importing `@rennet/core`, a `mobile` file importing `@rennet/core`). `scripts/check-boundaries.mjs --self-test` runs itself against the fixtures and **fails if they pass**. That self-test runs inside the `boundary` task on every gate. A check that has never been shown to fail has not passed, and a boundary check that silently stops matching after a rename is exactly the failure mode that produces a clean gate over a broken invariant.

### State-keying gate

The rule: review state keys on **repo identity plus changeset**, never on a directory path. Same PR from any worktree is the same review.

Enforcement, honestly labelled as a smell detector rather than a proof:

1. **Branded types.** `RepoId` and `ChangesetId` are branded strings in `protocol`, constructible only via `repoIdFromCommonDir(commonDir)` and `changesetId(...)`. Every store function takes `ReviewKey = { repoId, changesetId }`. A path cannot be passed where a `RepoId` is expected, because the brand does not typecheck.
2. **`scripts/check-state-keying.mjs`**, roughly 50 lines: fails if any file under `packages/core/src/review/**` or `packages/adapters/src/store/**` mentions `cwd`, `__dirname`, `worktreePath`, `absolutePath`, `resolve(`, or `homedir`. With fixtures and a `--self-test`, same discipline as above.
3. **A behavioural test that is the real proof.** `adapters/test/state-identity.test.ts` creates a temp repo, adds two worktrees of it, records review state through worktree A, reads it through worktree B, and asserts identity. That test failing is the only signal that actually means the invariant broke. Layers 1 and 2 exist to make it fail early and readably.

### CI: GitHub Actions

Two workflows, one required check.

```yaml
# .github/workflows/gate.yml
name: gate
on:
  pull_request:
  push: { branches: [main] }
concurrency: { group: gate-${{ github.ref }}, cancel-in-progress: true }
permissions: { contents: read }

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }          # DCO check needs history
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - uses: actions/cache@v4
        with:
          path: .turbo
          key: turbo-${{ runner.os }}-${{ github.sha }}
          restore-keys: turbo-${{ runner.os }}-
      - run: pnpm gate
      - name: dco
        run: node scripts/check-dco.mjs ${{ github.event.pull_request.base.sha }}

  e2e:
    runs-on: macos-15                      # match the ship target; Electron on Linux CI is a different animal
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm --filter @rennet/desktop build
      - run: pnpm --filter @rennet/desktop e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: apps/desktop/playwright-report }

  package-smoke:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @rennet/desktop package     # unsigned
      - name: assert artifact exists
        run: test -d apps/desktop/out/*/Rennet.app || (echo "no .app produced" && exit 1)

  gate-required:
    if: always()
    needs: [gate, e2e, package-smoke]
    runs-on: ubuntu-latest
    steps:
      - run: |
          [ "${{ needs.gate.result }}" = "success" ] || exit 1
          [ "${{ needs.e2e.result }}" = "success" ] || exit 1
          [ "${{ needs.package-smoke.result }}" = "success" ] || exit 1
```

Design notes:

- **`gate-required` is the single required status check** in branch protection. Adding or renaming jobs never requires touching protection settings, and a skipped job cannot pass silently (`if: always()` plus explicit result comparison; a `needs` job that is skipped reports `skipped`, not `success`, and fails the assertion).
- **`package-smoke` asserts the artifact on disk**, not the exit code of the packager. `&&` chains and zero exit codes are not evidence that a `.app` exists.
- **Matrix is deliberately absent for the gate job.** Node version is pinned by `.nvmrc` and there is exactly one supported version; a matrix over Node versions would test a portability property nobody is buying. The OS split (`ubuntu` for the gate, `macos` for anything Electron) is the only axis that earns its runtime. Windows and Linux desktop matrix entries get added when those platforms are actually targeted, and that is a bead, not a day-one cost.
- **Turbo remote cache is deliberately not used.** It is a hosted service on a repo whose positioning is local-first; the local `.turbo` cache via `actions/cache` gets most of the win for none of the story cost.

### Playwright smoke for the Electron shell

`_electron` is still officially experimental in 2026 but it is what VS Code tests itself with, and it is the only credible option. Two constraints designed for on day one:

1. **Playwright cannot intercept native dialogs** (`showOpenDialog`, `showSaveDialog`, `showMessageBox`), because those go straight to OS APIs from the main process. So every dialog goes behind a `DialogPort` declared in `core/ports` and implemented in `desktop/src/main/ports`. Tests inject a stub. This is the same seam Tauri needs, so it costs nothing extra.
2. **The smoke spec is a round-trip assertion, not a screenshot.** From commit 14 onward the spec launches the app, waits for the window, invokes a real command through the typed IPC bridge from the renderer, and asserts the validated response. A smoke test that only asserts "a window appeared" is a check that cannot fail.

```ts
// apps/desktop/e2e/smoke.spec.ts
import { _electron as electron, expect, test } from "@playwright/test";

test("window opens and the IPC round trip validates", async () => {
  const app = await electron.launch({ args: ["out/main/index.js"] });
  const win = await app.firstWindow();
  await expect(win.locator("[data-testid=app-root]")).toBeVisible();
  const version = await win.evaluate(() => window.rennet.invoke("app.version", {}));
  expect(version).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
  await app.close();
});
```

### The pre-push hook (Brita filter)

The gate is only load-bearing if it cannot be forgotten. `scripts/install-hooks.mjs` runs from the root `prepare` script (so `pnpm install` installs it, no separate step to remember) and writes `.git/hooks/pre-push` running `pnpm gate`. Roughly 30 lines, no husky dependency, consistent with write-it-not-install-it.

The hook prints the bypass (`git push --no-verify`) in its failure message and `CLAUDE.md` states plainly that **agents may never use it**. A human bypassing a hook deliberately is a judgement call; an agent bypassing one is a silent regression with a plausible commit message.

---

## 4. `CLAUDE.md` draft for the new repo

The draft below is **not drop-in as-is**. Regenerate it from the Master Plan and canonical contracts before commit 10; the targeted corrections below remove the highest-risk stale guidance, but the canonical schema names must come from the current contract.

````markdown
# Rennet

An open-source, local-first desktop code review app. It decomposes large changesets into
readable chunks through several concurrent angles, keeps review state that survives a
force-push and a night's sleep, and lands the result as a normal GitHub PR review. The LLM
proposes structure, the human disposes. No auto-approve, ever.

Product thinking lives in this repository under `docs/`, led by `docs/Rennet Master Plan.md` and `docs/Rennet Architecture Contracts.md`.
Stack decisions and version facts: `/workspace/vault/References/Desktop and Mobile Stack 2026.md`.
Design doctrine: `/workspace/vault/Code Review App Design Directions.md`.

Read this file fully before writing code. It is not background, it is the contract.

---

## The three rules that outrank everything

### 1. Portable core

`packages/core` and `packages/protocol` never import a platform API. No `node:*`, no
`electron`, no DOM globals, no `process`, no `fetch` against the filesystem. Every platform
capability enters through a **port interface** declared in `core/ports` and implemented in
`packages/adapters` (Node) or, later, in the Tauri shell or the mobile app.

Ports: `GitPort`, `FsPort`, `StorePort`, `HarnessPort`, `ForgePort`, `ClockPort`,
`RandomPort`, `DialogPort`.

Why: Electron is a commodity shell for v1 only. Tauri or native must stay a **port**, not a
rewrite, and the mobile companion is another client of the same core. The day this rule
bends, that option is gone and nobody notices for six months.

How it is enforced, in the order the errors will reach you:
- `packages/tsconfig/portable.json` sets `"types": []` and `"lib": ["ES2022"]`, so
  `import "node:fs"` and `document.querySelector` fail `pnpm typecheck`. You cannot comment
  your way past this.
- Biome `style/noRestrictedImports` in `biome.json` overrides, with the message explaining
  the port to use instead.
- `scripts/check-boundaries.mjs` checks declared dependencies and greps for dynamic escapes
  (`require(`, non-literal `import()`, `globalThis.process`).

If you need a capability core does not have: **add a port**, implement it in `adapters`,
wire it in `apps/desktop/src/main/ports`. Do not import the thing. Adding a port is a
five-minute change and it is always the right answer.

### 2. State keys on identity, never on a path

Review state keys on **durable repo record plus changeset**. The git common dir
(`git rev-parse --path-format=absolute --git-common-dir`) is a machine-local alias on that
record, never durable identity, never `process.cwd()`, never a worktree path.

The same PR reviewed from any worktree of the repo is **the same review**. Multiple worktrees
of one repo present as one repo with N checkouts, not as N projects. Rai's own setup breaks
every naive assumption here: `/workspace` is a repo, `product-repo` is a repo nested inside it,
and product-repo's worktrees live at `/workspace/wt/*`, outside the repo they belong to. If your
model cannot express that, your model is wrong.

`RepoId` and `ChangesetId` are branded types in `@rennet/protocol`. Construct `RepoId` only
via `repoIdFromCommonDir()`. Every store call takes `ReviewKey = { repoId, changesetId }`.

Related and equally load-bearing: **an occurrence has an immutable ID and continuity is an
explicit lineage edge, not a content hash.** Content, symbol, and path hashes are matcher
evidence. Only exact unambiguous continuity may preserve unaffected state after the precision
gate; changed, similar, or ambiguous matches reopen. Ambiguity always fails closed.

Enforced by: branded types, `scripts/check-state-keying.mjs`, and
`adapters/test/state-identity.test.ts`, which writes state through worktree A and reads it
through worktree B. That test is the real proof; the rest is early warning.

### 3. Write it, do not install it

This repo owns its infrastructure on purpose. Small, boring, ours, and portable, because
every dependency at this layer is a Tauri port tax or an Electron-major tax.

| Thing to write | Budget | Instead of | Why |
|---|---|---|---|
| Typed IPC | ~200 lines | electron-trpc | electron-trpc is stale and does not support tRPC 11; and the IPC boundary is a public API a Rust shell must satisfy |
| Git wrapper | ~250 lines | simple-git | We need plumbing, streaming stdout, and per-call `AbortSignal`. simple-git is porcelain and buffers |
| Command registry | ~300 lines | react-hotkeys-hook | Every shortcut must be a named remappable command feeding both palette and menu bar. That is a registry, not a hook |
| Event store | ~400 lines | any JS event-sourcing framework | All of them are abandoned or built for distributed servers with an outbox and a bus. Neither exists here |
| Harness adapters | ~800 lines | an agent framework | We supervise three external processes and normalise their streams. The normalized event protocol IS the asset and must be ours |
| JSONL reader | ~40 lines | ndjson | ndjson last published 2020 |

Total: roughly 2,000 lines of owned infrastructure. If your implementation is running 3x a
budget, stop and say so in the PR rather than quietly shipping 1,200 lines of git wrapper.
The budget is a design signal: over budget usually means the abstraction is wrong.

---

## Gates

One command, and it is what CI runs:

```
pnpm gate          # lint + typecheck + boundary + FULL test suite
pnpm gate:full     # the above plus Playwright e2e
```

**The full test suite runs before every push. Not the touched files, not `--changed`, not
`-t`.** The breakage you ship is always in the file you did not touch, and selective test
runs are a check that cannot fail. `.git/hooks/pre-push` runs `pnpm gate` and is installed
automatically by `pnpm install`.

**Never `git push --no-verify`.** Not to save time, not "just this once for a docs change",
not because the gate looks unrelated. If the gate is wrong, fix the gate in its own commit.

Before you claim anything passed: run it and read the output. A green claim without a pasted
command output is not a claim, it is a guess. When a check comes back clean, ask whether it
would have caught the problem had the problem been there. If you cannot answer that, the
check is not calibrated and neither is your conclusion.

## Evidence discipline

- **Verify against docs, not memory.** Library versions and APIs in this stack move weekly.
  Use primary documentation or the actual installed types. ~~Never add the proprietary Claude
  Agent SDK~~ ⛔ SUPERSEDED 2026-08-06: the SDK is adopted, see Master Plan R2; `@pierre/diffs` still requires exact pinning and measured verification.
- **Cite `file:line` for every factual claim about this codebase**, and open the file before
  citing it. A `file:line` nobody opened is prose with a colon in it.
- **Never assert a dependency's behaviour that you have not run.** If the question is "does
  `@pierre/diffs` virtualize", the answer comes from a measurement in `spikes/`, not from a
  README's tone of voice.
- **Empty result? Ask whether the search reached the thing before asking what the absence
  means.** A bad locator returns exactly what a true negative returns.
- **Unverified is a valid answer and a respected one.** Say "unverified" and file a bead.
  Saying it confidently instead is the only unacceptable option.

## Commits, branches, PRs

- **Conventional Commits** with the package as scope:
  `feat(core): occurrence lineage graph`, `fix(adapters): abort git diff on changeset switch`,
  `chore(repo): pin electron 43.2.0`.
- **`Signed-off-by:` on every commit** (DCO). CI checks it. See `CONTRIBUTING.md`.
- **No AI attribution trailers.** No `Co-Authored-By: Claude`, no generated-with footers.
  Rai is the sole copyright holder and that has to stay simple and true, because the
  relicensing path for the paid mobile companion depends on it.
- **One bead, one branch, one PR.** Branch name: `<bead-id>-<short-slug>`, e.g.
  `rennet-4f2-git-wrapper`. Short-lived; if it is open more than two days it was too big.
- **Never commit directly to `main`.** Even solo. Even for a typo. `main` is protected and
  requires the `gate-required` check.
- **Squash merge, delete branch.** Linear history; the review product will one day read this
  repo's own history and it should be worth reading.
- Every PR body carries the Definition of Done block from
  `.github/pull_request_template.md`, filled in with real evidence.

## Design doctrine

Glass is the ratified identity. Three lines, absolute:

- **Glass is chrome.** Translucent material for sidebars, panels, overlays, palette.
- **Code is opaque.** The diff surface is never translucent. Legibility beats vibrancy every
  single time, and nothing about this rule is negotiable for a screenshot.
- **Paper is what leaves the machine.** The signable document is the only solid object in a
  translucent product: opaque warm paper, serif voice, hold-to-sign. Serif appears exactly
  where your name does and nowhere else.

Private marks are backlight blue (`#85C4DC`), the system's only inner glow, used for
everything visible to you alone: coverage, pace, chat, dismissals. Amber belongs to blast
radius and disagreement, and there is no fourth hue.

Full system, tokens, and both wordmarks: `/workspace/vault/Code Review App Design Directions.md`
and the mood board at `prototypes/moodboard/index.html`.

Design tokens live in `packages/ui/src/tokens`. Do not hardcode a colour anywhere else.

## Licensing

⛔ **SUPERSEDED 2026-08-06: this whole subsection is historical.** Rennet is MIT throughout, mobile included — there is no Apache-2.0/AGPL-3.0-only split and no AGPL-contamination boundary to enforce.

- `packages/types` and `packages/protocol` are **Apache-2.0**. Everything else open in
  `packages/` and `apps/desktop` is **AGPL-3.0-only**. Mobile is proprietary.
- **Mobile imports published `@rennet/types` and `@rennet/protocol` and nothing else.** This is a
  licence boundary as much as an architectural one: importing AGPL code into the paid
  companion makes the companion AGPL. The boundary check enforces it.
- **Never copy source from an AGPL project into this tree.** Paseo is AGPL-3.0 and is a
  patterns study only. Orca is MIT and is liftable. `paseo-relay` is Apache-2.0 and is
  liftable. Check the LICENSE file before lifting a single line, and record what you lifted
  and from where in the commit body.
- Outside contributions need DCO plus the CLA in `CONTRIBUTING.md`.

## What NOT to do

- **No new runtime dependency without a bead and a written justification.** The bead states
  what it replaces, its last publish date, whether it compiles native code, and what happens
  when it dies. Dev dependencies are lighter but still need a line in the PR body.
- **No native compiled dependencies.** No node-gyp, no node-addon-api, no `@electron/rebuild`.
  Electron ships a major every 8 weeks and supports three, so a compiled module is a
  scheduled breakage forever. Prebuilt N-API and WASM require explicit architectural review.
  No harness binary or proprietary SDK is linked or bundled; the normal stack has zero
  compiled artifacts beyond Electron itself. ⛔ **SUPERSEDED 2026-08-06: the Claude Agent SDK is adopted, so this line's SDK exclusion no longer applies to Claude** (its prebuilt platform binary is now an accepted compiled artifact — see [[References/Desktop and Mobile Stack 2026]] on packaging it). The no-`node-gyp`/no-native-compiled-deps rule for everything else still stands.
- **No `better-sqlite3`.** It is excellent and it is exactly the dependency class the
  constraint exists to exclude. We use `node-sqlite3-wasm` (or `node:sqlite` if the spike
  confirms Electron 43 exposes it). This is settled; do not reopen it in a PR.
- **No second UI framework.** React 19 only. Not because React won an argument but because
  `@pierre/diffs` peer-depends on it and it is the best rendering asset available under
  Apache-2.0. No Solid, no Svelte, no second component library alongside shadcn, no
  CSS-in-JS runtime next to Tailwind.
- **No state library sprawl.** Zustand for UI state. XState only for genuine machines (the
  pairing handshake, the harness session lifecycle). Not both for the same state. No Jotai
  alongside Zustand. `@tanstack/react-query` only for the GitHub API, never for local state.
- **No cloud backend, no telemetry by default.** No analytics, no error reporting that
  phones home, no hosted service in the critical path. Crashes and logs go to disk via
  `electron-log` with a "copy diagnostic bundle" button. Never send diff content, repo paths,
  file names, or prompts anywhere. An open-source local-first review tool that phones home
  is a positioning own-goal before it is a privacy one.
- **No Monaco, no canvas or WebGL diff renderer.** Monaco is an entire editor and the wrong
  shape. Canvas loses text selection, find-in-page, accessibility, and IME, which are the
  whole value of a careful-reading tool. If the DOM cannot hit the bar, that is the argument
  for the native port, not for a canvas.
- **No blocking work on the main process.** Git plumbing, diff parsing, and harness
  supervision go in `utilityProcess`. Highlighting goes in a renderer worker. Nothing that
  can block for more than a frame runs on main.
- **No weakening the Electron security posture.** `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, strict CSP with no `unsafe-inline`, permission handler denying
  by default, `setWindowOpenHandler` denying all, `@electron/fuses` flipping `RunAsNode`,
  `EnableNodeOptionsEnvironmentVariable`, and `EnableNodeCliInspectArguments` off. Validate
  every IPC payload with zod even though the renderer is "ours", because the renderer is the
  process that renders untrusted diff content and untrusted model output.
- **No auto-approve, no auto-comment, no auto-anything that another human sees.** Every LLM
  output is an editable draft. Approval is the one act that is never automated. This is a
  product rule and it is also a rule about how you behave in this repo.
- **No `spikes/` code merged into `packages/`.** A spike produces a verdict. The code gets
  rewritten under the gates or deleted.
- **No skipped or `.only` tests on `main`.** A skipped test is a check that cannot fail.
  Delete it or fix it, and if it is genuinely blocked, file a bead and link it in the skip.
````

---

## 5. Agent workflow fit

### Branching, even solo

**Recommendation: short-lived branches, PR to `main`, self-review gate, always. No direct pushes to `main`, including from Rai.**

Three reasons, in order of weight:

1. **It is the only place the autonomous work becomes reviewable.** Navi working directly on `main` produces a stream of commits nobody ever reads as a unit. A PR is a changeset with a boundary, which is the exact artifact this product exists to make readable.
2. **The product dogfoods itself.** From roughly commit 20, Rennet can open its own repo. From the moment the decomposition engine works, **every Rennet PR gets reviewed in Rennet**, including the ones Navi wrote. That is the shortest feedback loop the product will ever have, and it only exists if there are PRs. This is the strongest argument and it is worth the ceremony before it pays off.
3. **A protected `main` is the only thing standing between an agent and an unrecoverable force-push.** Branch protection is a Brita filter: it does not require anyone to remember.

Concretely:

- `main` protected: require `gate-required`, require linear history, no force-push, no deletions, include administrators. Navi has no bypass.
- Branch: `<bead-id>-<slug>`. Squash merge. Delete on merge.
- **Self-review gate before a PR leaves draft:** the authoring agent runs `pnpm gate:full`, then dispatches an independent review of the diff (Opus plus Codex, the `/wave` pattern) and addresses or explicitly rejects every finding in the PR body. Passing your own gate is not review; a second model reading your diff is the cheapest substitute for the human until the human arrives.
- PR stays **draft** until CI is green and reviews are addressed. Same rule as the client repos, same reason: pushing fixes against a non-draft PR sprays notifications and burns reviewer patience.
- Rai merges. Navi does not merge her own PRs, even when everything is green. That is not distrust, it is the same "approval is the never-automated act" rule the product is built on, applied to its own repo.

### Beads

Navi's beads tracker is the only issue system. No TODO comments, no markdown checklists, no GitHub Issues for internal work (GitHub Issues stay for outside users once the repo is public).

Mapping:

- **One bead, one branch, one PR.** A bead too big for one PR gets split before work starts, not during.
- Bead ID goes in the branch name and the PR title: `rennet-4f2: git wrapper (GitPort)`.
- Bead types: `feat`, `bug`, `chore`, `spike`, `deps`. `deps` exists so that "add a runtime dependency" is a first-class tracked decision with a written justification, per the CLAUDE.md rule.
- **Spike beads have a question as the title** and close with a verdict written to the vault, not with merged code.
- Dependencies modelled in beads (`blocked-by`), so `bd ready` genuinely means "an agent can start this now". That is what makes autonomous work convergent instead of a queue of half-started branches.
- Every bead that changes behaviour carries the DoD block below in its description before work starts. An agent that cannot fill in "how will I know this works" before writing code does not yet understand the bead.

### Definition of Done block

Same block on the bead and in the PR body (`.github/pull_request_template.md`), filled with real evidence, not ticks:

```markdown
## Definition of Done

**Bead:** rennet-4f2
**Budget:** ~250 lines (git wrapper). Actual: 231.

- [ ] `pnpm gate` green. Paste the tail:
      ```
      <actual output>
      ```
- [ ] `pnpm gate:full` green (e2e), or state why e2e is not affected.
- [ ] Boundary self-test ran and the fixtures still fail: `node scripts/check-boundaries.mjs --self-test`
- [ ] New behaviour has a test that has been **seen to fail**. Say how you made it fail:
      <one line: what you broke, what error it gave>
- [ ] Every factual claim in this PR cites `file:line` and I opened each file.
- [ ] No new runtime dependency, OR: dependency `<name>@<version>`, last published `<date>`,
      compiled native code: no, replaces `<what>`, dies gracefully by `<plan>`, bead `<id>`.
- [ ] Portable core intact: nothing new imported into `packages/core` or `packages/protocol`.
- [ ] State keying intact: no new path-derived key.
- [ ] Design tokens used, no hardcoded colours (UI changes only).
- [ ] Independent review dispatched (Opus + Codex). Findings addressed or rejected with reasons:
      <list>

**What I could not verify:** <say it plainly, or "nothing">
```

The last line is the one that matters most. It is the only field that makes "unverified" cheaper to write than to hide.

---

## 6. Bootstrap sequence: the first 20 commits

Each sized for one agent session. Every commit leaves `pnpm gate` green, from commit 6 onward.

| # | Commit | What lands | Done when |
|---|---|---|---|
| 1 | `chore(repo): initialise` | `LICENSE` (AGPL-3.0-only), `README.md`, `.gitignore`, `.editorconfig`, `.nvmrc`, `.tool-versions` | `git log` has one commit; LICENSE is the real AGPL text, not a stub. ⛔ SUPERSEDED 2026-08-06: LICENSE is MIT, not AGPL. |
| 2 | `chore(repo): pnpm workspace and root manifest` | `package.json` (private, packageManager pnpm@10), `pnpm-workspace.yaml`, `.npmrc` with `save-exact` and `strict-peer-dependencies` | `pnpm install` succeeds on an empty workspace |
| 3 | `chore(repo): biome` | `biome.json` with the base config, formatting applied to the tree | `pnpm lint` exits 0 and reformats nothing on a second run |
| 4 | `chore(repo): shared tsconfig bases` | `packages/tsconfig/{base,portable,node,dom}.json` | Each base parses; a scratch file using `node:fs` under `portable.json` fails to compile (do this and paste the error) |
| 5 | `feat(protocol): package skeleton` | `packages/protocol` with tsdown config, `exports` conditions, one exported const, one test | `pnpm --filter @rennet/protocol build test typecheck` green |
| 6 | `chore(repo): turbo and the gate` | `turbo.json` with the real task graph, root `gate` script, `packages/core` and `packages/ui` skeletons | **`pnpm gate` green on empty packages.** The milestone. Paste the output in the PR |
| 7 | `feat(repo): boundary gates` | `scripts/check-boundaries.mjs`, `scripts/fixtures/*`, `--self-test`, Biome `noRestrictedImports` overrides, `boundary` turbo task | Self-test passes; deleting a fixture rule makes it fail (prove both directions) |
| 8 | `feat(repo): state-keying gate and branded ids` | `RepoId`/`ChangesetId` brands in protocol, `scripts/check-state-keying.mjs` with fixtures | Self-test passes; a path passed as `RepoId` fails typecheck |
| 9 | `chore(repo): pre-push hook and contribution policy` | `scripts/install-hooks.mjs`, root `prepare`, `CONTRIBUTING.md` (DCO + CLA + Conventional Commits), `scripts/check-dco.mjs` | Fresh clone plus `pnpm install` installs the hook; a push with a failing gate is blocked |
| 10 | `docs: CLAUDE.md, AGENTS.md, PR template` | The CLAUDE.md from section 4, `AGENTS.md` symlink, `.github/pull_request_template.md` with the DoD block, `CODEOWNERS` | An agent handed only the repo can state the three rules back |
| 11 | `ci: gate workflow and branch protection` | `.github/workflows/gate.yml`, turbo cache, `gate-required` aggregation job; protection configured via `gh api` | A PR with a deliberate lint error is blocked from merging (prove it with a throwaway PR) |
| 12 | `feat(protocol): domain types` | zod schemas for `Repo`, `Worktree`, `Workspace`, `Changeset`, `Hunk`, `ReviewKey`; parse tests including rejection cases | Round-trip and rejection tests pass; `packages/protocol` still imports only zod |
| 13 | `feat(protocol): the command map` | `commands.ts`: name to `{ input, output }` zod map, plus the `Command` type helpers. The typed IPC contract, ~200-line budget | Type-level test asserts an unknown command name is a compile error |
| 14 | `feat(core): ports` | `GitPort`, `FsPort`, `StorePort`, `HarnessPort`, `ForgePort`, `SecretStorePort`, `ClockPort`, `RandomPort`, `DialogPort` as interfaces, plus in-memory fakes for tests | Fakes satisfy the interfaces; `packages/core` has zero platform dependencies |
| 15 | `feat(desktop): electron shell` | Forge + Vite, main/preload/renderer, secure `BrowserWindow` defaults, CSP, `@electron/fuses`, a window rendering `data-testid=app-root` | `pnpm --filter @rennet/desktop dev` opens a window; fuses verified in the packaged app |
| 16 | `feat(desktop): typed IPC end to end` | The single `ipcMain.handle` dispatcher with zod validation, `contextBridge` `invoke`, renderer typed client, `app.version` command, Playwright smoke asserting the round trip | Smoke spec green in CI on macOS; an invalid payload is rejected by zod with a test proving it |
| 17 | `spike: pierre-diffs and node:sqlite` | `spikes/pierre-diffs/` measuring `@pierre/diffs` against a real 5,000-line diff at 120Hz, plus the 30-second `require('node:sqlite')` check in Electron 43. Two `VERDICT.md` files | Both verdicts written to the vault. **This can invalidate the rendering plan, so it happens before any rendering code** |
| 18 | `feat(adapters): GitPort` | The git wrapper: `spawn`, NUL-delimited parser, streamed stdout, per-call `AbortSignal`, ~250-line budget. Tests build a temp repo | Tests green under plain Node, no Electron; cancellation test proves the child process dies |
| 19 | `feat(core): workspace discovery` | `--git-common-dir` repo identity, `worktree list --porcelain`, nested-repo handling, workspace vs project mode detection | Fixture tests pass **and** a manual run against `/workspace` (repo), `product-repo` (nested repo), `/workspace/wt/*` (external worktrees) is pasted into the PR |
| 20 | `feat(desktop): first window that reads a real repo` | Home surface listing repos, worktrees, branches, and PRs for a real workspace. No decomposition yet | Rai opens the app on `/workspace` and sees his actual repos. The first moment it is a thing rather than a plan |

Commit 21 onward, out of scope for this plan but named so the shape is visible: the event store and occurrence-lineage model, the clean-room harness adapter plus JSONL decoder, then the first validated hybrid decomposition and angle slice. There is no embedded harness binary or SDK packaging trap.

---

## Open questions / refinement hooks

> [!IMPORTANT] Current backlog authority
> Use [[Rennet Navi Handoff]] for execution. Rows below mentioning the old package tree, content-hash identity, Claude Agent SDK packaging, or `GithubPort` are superseded.

1. **The name.** Everything here says `rennet` / `@rennet/*`. Digestif vs Rennet is unresolved ([[Code Review App Branding Questions]]). **Do not create the GitHub repo or reserve the npm scope until the name is settled**; renaming a scope after publish is permanent noise. Bootstrap can start on a local repo named `review-harness` and get renamed at commit 11, before CI or any publish. Cost of deferring: near zero. Cost of guessing: a dead npm scope forever.
2. **AGPL vs the paid mobile companion.** ⛔ SUPERSEDED 2026-08-06: moot — Rennet is MIT throughout, no protocol split, no AGPL-contamination question. Section 0 recommends the protocol split plus a CLA. This needs a solicitor's eye before money changes hands, and probably before the repo goes public, because the licence headers are hard to change once contributors exist.
3. **`typecheck` depending on `^build`** costs a build on every typecheck. If that gets slow, the refinement is TS project references with `composite: true`. Not adopted on day one because it doubles the config surface for four packages. Revisit at eight.
4. **`@pierre/diffs` has no locatable public source repository** (npm declares Apache-2.0 with an empty `repository` field). If spike 17 says it works, the fork question becomes urgent: a critical rendering dependency you cannot fork is a single point of failure. Consider vendoring the published artifact and recording its integrity hash.
5. **Windows and Linux CI.** Deliberately absent from day-one CI. The moment the portability claim is public it needs a matrix entry, and Electron on Linux CI needs `xvfb-run`. Bead, not a day-one cost.
6. **Playwright `_electron` remains officially experimental.** If it breaks on an Electron major, the fallback is a main-process test harness driving the app over the IPC surface directly, which is cheaper than it sounds precisely because the IPC boundary is a public API.
7. **`just` is not installed on this machine** (checked 2026-08-04). pnpm scripts are canonical for that reason; a `justfile` is optional sugar to add later if Rai installs it. Do not make the gate depend on a tool that is not there.
8. **Turbo remote caching** stays off for positioning reasons. If CI time becomes painful, self-hosted remote cache is the option that preserves the story.
9. **Renderer worker strategy for Shiki** is unspecified here and interacts with the Vite build config in a way worth designing once rather than discovering. Bead.
10. **`node:sqlite` vs `node-sqlite3-wasm`** is decided by spike 17. If `node:sqlite` is exposed in Electron 43, a dependency disappears and the Kysely dialect changes. Do not write store code before that verdict.
11. **Repo-local skills** (`.claude/skills/`) are sketched but unspecified: a `/gate` skill, a `/spike` skill enforcing the verdict-not-code rule, a `/bead-pr` skill generating the DoD block. Worth building once the workflow has run a few times, not before.

---

## Bead candidates

Priority uses the beads scale in this workspace. Dependencies reference other candidates in this table.

| Title | Description | Priority | Depends on |
|---|---|---|---|
| Settle the name before creating the repo | Digestif vs Rennet. Blocks GitHub repo creation, npm scope, domain purchase. Bootstrap commits 1-10 can run on a local repo named `review-harness`. | P0 | none |
| Legal read on AGPL core plus paid mobile companion | ⛔ SUPERSEDED 2026-08-06: moot, Rennet is MIT throughout, no protocol split. Confirm the protocol-split plus CLA structure in section 0 of this plan. Specifically: does an Apache-2.0 `protocol` package cleanly free `apps/mobile` from AGPL, and does the App Store GPL-incompatibility precedent apply to AGPL as expected. | P0 | name |
| Bootstrap commits 1-6: toolchain to green gate | pnpm workspace, Biome, tsconfig bases, protocol skeleton, turbo graph, `pnpm gate` green on empty packages. | P0 | name |
| Bootstrap commits 7-9: the three gates plus pre-push hook | Boundary check with self-test fixtures, state-keying check with brands, pre-push hook installer, DCO check. Each gate must be proven to fail before it is trusted. | P0 | commits 1-6 |
| Bootstrap commits 10-11: CLAUDE.md and CI | Drop in the CLAUDE.md draft, AGENTS.md symlink, PR template with the DoD block, gate workflow, `gate-required` branch protection. Prove protection works with a throwaway failing PR. | P0 | commits 7-9 |
| SPIKE: does `@pierre/diffs` virtualize a 5,000-line file at 120Hz | Highest information value in the whole plan. Measure a real 5,000-line diff with the Chrome performance panel. If it insists on rendering whole files, the rendering plan changes and we find out in week one. Verdict to the vault. | P0 | commits 1-6 |
| SPIKE: does Electron 43 expose `node:sqlite` | Thirty seconds, potentially deletes a dependency and changes the Kysely dialect. Blocks all store code. | P1 | commits 1-6 |
| SPIKE: workspace discovery against Rai's real setup | `git rev-parse --path-format=absolute --git-common-dir` and `git worktree list --porcelain` across `/workspace` (repo), `product-repo` (nested repo), `/workspace/wt/*` (external worktrees). Cheapest possible test of the hard workspace requirement. | P1 | commits 1-6 |
| Typed IPC contract and dispatcher (~200 lines) | `commands.ts` zod map in protocol, one `ipcMain.handle` with validation, contextBridge bridge, typed renderer client, Playwright round-trip smoke. The public API a Rust shell must satisfy. | P1 | commits 10-11 |
| GitPort wrapper (~250 lines) | `spawn` plumbing, NUL-delimited parser, streamed stdout, per-call `AbortSignal`. Tests against a temp repo under plain Node, including a cancellation test proving the child dies. | P1 | typed IPC |
| Event store and occurrence-lineage model | Append-only events, fail-safe projections, immutable occurrence IDs, explicit lineage edges, and a matcher-precision gate. Similarity never silently carries read state. | P1 | `node:sqlite` spike, GitPort |
| macOS packaging smoke | Package the zero-harness-binary Electron app and prove signing/notarisation only in the public-release phase. | P2 | typed IPC |
| Harness adapter layer and normalized event protocol | `HarnessPort` plus clean-room Claude CLI and codex-app-server implementations, tolerant JSONL decoders, capability conformance, and no credentials in core/state. ⛔ SUPERSEDED 2026-08-06: Claude adapter is SDK-based now, not clean-room CLI — see Master Plan R2. | P1 | direct CLI fidelity spike |
| Command registry (~300 lines) | Named remappable commands feeding both the command palette and the menu bar from one source, `tinykeys` as the sequence matcher, JSON user keymap, conflict detection. | P2 | typed IPC |
| Design tokens package from the ratified glass system | Port the mood board's glass system into `packages/ui/src/tokens` as Tailwind v4 `@theme`, with the compressed density scale applied before any component is copied in. Enforce no hardcoded colours. | P2 | commits 10-11 |
| Windows and Linux CI matrix | Add OS matrix entries plus `xvfb-run` for Electron on Linux. Required before the cross-platform claim goes public. | P2 | commits 10-11 |
| Vendor or mirror `@pierre/diffs` | No locatable public source repository. If the spike says we depend on it, decide between vendoring the published artifact with an integrity hash and accepting an unforkable single point of failure. | P2 | pierre spike |
| Repo-local Claude skills: `/gate`, `/spike`, `/bead-pr` | `/gate` runs and reports the full gate with pasted output; `/spike` scaffolds a spike directory and enforces verdict-not-code; `/bead-pr` generates the DoD block from a bead. Build after the workflow has run a few times. | P3 | commits 10-11 |
| Spike janitor | Launchd or CI job deleting `spikes/*` directories older than 14 days, preserving `VERDICT.md`. Brita filter on the spike policy so it does not depend on anyone remembering. | P3 | commits 7-9 |
| Dogfood: review Rennet PRs in Rennet | The moment decomposition works, every Rennet PR gets reviewed in Rennet, including Navi's. Shortest feedback loop the product will ever have. | P3 | first angle shipped |
