---
tags: [rennet, dependencies, tooling, architecture]
categories: [project]
status: active
created: 2026-08-05
updated: 2026-08-05
related: ["[[Rennet Master Plan]]", "[[Rennet Architecture Contracts]]", "[[Rennet Navi Handoff]]"]
---

# Rennet Dependency Standard

> [!IMPORTANT] Implementation authority, verified 2026-08-05
> This is the authority for dependency selection, package ownership, toolchain integration, and version policy. It supersedes package recommendations in [[References/Desktop and Mobile Stack 2026]], [[Wingman Architecture Plan]], [[Wingman Distribution and Licensing Plan]], and [[Wingman Repo Bootstrap Plan]]. Product and data contracts still come from [[Rennet Master Plan]] and [[Rennet Architecture Contracts]].

Rennet should use mature plumbing and own only the behavior that is its product. A package is not adopted because it is fashionable or saves a small function. It is adopted when it removes a maintained subsystem, has a healthy primary source, has a compatible licence, and can satisfy Rennet's privacy, determinism, and fail-closed contracts.

## 1. Decision vocabulary

| Verdict | Meaning |
|---|---|
| **MUST** | The default dependency for this capability. Do not substitute it without an evidence-backed architecture decision. |
| **SHOULD** | Adopt when the named capability lands or a stated measurement triggers it. |
| **DEFER** | Credible, but blocked by product scope, package maturity, privacy, provenance, or a spike. |
| **AVOID** | Conflicts with a chosen dependency, architecture boundary, licence, privacy promise, or measured verdict. |
| **OWN** | Small load-bearing product logic that no library can define correctly for Rennet. |

All dependency versions are exact pins. The **pin now** column is the highest version eligible under the seven-day registry-age rule on 2026-08-05, or the proven version where a spike is stricter. A newer release may be listed as a candidate but must age in and pass its owning gate before adoption.

## 2. Licence and supply-chain policy

Rennet's planned public split is Apache-2.0 for `packages/types` and `packages/protocol`, AGPL-3.0-only for the open application packages, and proprietary for the future mobile client. MIT, ISC, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, and Apache-2.0 dependencies are acceptable with attribution and NOTICE obligations preserved. MPL-2.0 and Python-2.0 tools are development-only; the current Python-2.0 occurrence is Nx's transitive `argparse`, not a shipped dependency. GPL, LGPL, MPL, EPL, proprietary, source-available, unknown, and missing licences are blocked as shipped runtime dependencies until a written licence decision exists.

`packages/types` has no runtime dependencies. `packages/protocol` may use permissive dependencies only and may import `types`; it must never import an AGPL package. Git and language servers discovered in a reviewed repository are external processes, not bundled or linked parts of Rennet.

The package-manager policy is:

- exact versions and a committed lockfile;
- `minimumReleaseAge: 10080`, strict, with no package-wide exemptions and only reviewed exact-version exceptions;
- no recent trust downgrade and no lockfile trust shortcut; trust checks older than one year are ignored because historical packages commonly lack comparable provenance;
- exotic transitive sources are normally blocked; Electron Forge's native rebuild chain is the documented exception and pins Electron's `node-gyp` fork to commit `06b29aafb7708acef8b3669835c8a7857ebc92d2`;
- `pnpm licenses list --json` plus an SPDX allowlist before distribution;
- OSV Scanner against `pnpm-lock.yaml`, using offline mode where dependency metadata egress is unacceptable;
- CycloneDX or SPDX SBOMs with release artifacts, using native `pnpm sbom` after the pnpm 11 upgrade;
- every scanner has a synthetic positive control so a silent clean result cannot pass.

Current security overrides additionally converge Electron's pinned `node-gyp` fork on `tar@7.5.22`, Forge's prompt chain on `tmp@0.2.7`, and Nx's schema chain on `fast-uri@3.1.5`. They remove the critical/high advisories exposed by the full development-graph audit. `fast-uri@3.1.5` was five days old when adopted, so it has a reviewed exact-version maturity exception. Other current convergence overrides are `axios@1.18.0`, `brace-expansion@5.0.9`, `unicorn-magic@0.4.0`, and the two `@emnapi/*@2.0.0-alpha.3` WASI peers required by Vite 8's Rolldown graph. `brace-expansion@5.0.9` also has an exact-version maturity exception. Remove an override when the owning upstream graph resolves to an equal or newer compatible version and the audit, build, and package gates stay clean.

Electron Forge requires pnpm's hoisted node linker for packaging. Rennet uses `nodeLinker: hoisted`; this is a packaging constraint, not permission for undeclared imports. Nx/ESLint boundaries and manifest checks remain authoritative.

Primary sources: [pnpm settings](https://pnpm.io/settings), [pnpm SBOM](https://pnpm.io/cli/sbom), [OSV lockfile support](https://google.github.io/osv-scanner/supported-languages-and-lockfiles/).

## 3. Foundation, monorepo, and build chain

| Capability | Package / API | Pin now | Licence | Verdict and boundary |
|---|---|---:|---|---|
| Runtime | Node.js | `24.18.0` | MIT plus bundled notices | **MUST.** LTS host baseline and close to Electron 43.2's embedded Node. |
| Package manager | `pnpm` | `10.32.1` | MIT | **MUST.** Move to pnpm 11 only after an eligible release so native SBOM replaces provisional tooling. |
| Task graph and cache | `nx` | `23.1.0` | MIT | **MUST.** Local project graph, affected selection, deterministic cache, generators, migrations, and release orchestration. |
| Nx TypeScript | `@nx/workspace`, `@nx/js` | `23.1.0` | MIT | **MUST with production packages.** Workspace migrations, project references, build and typecheck inference. |
| Nx web and tests | `@nx/vite`, `@nx/vitest`, `@nx/playwright` | `23.1.0` | MIT | **MUST with the owning project.** Exact version lockstep with `nx`; Vitest is no longer owned by `@nx/vite`. |
| Nx React | `@nx/react` | `23.1.0` | MIT | **SHOULD with `ui` and desktop renderer.** Generators and React configuration, not an Electron abstraction. |
| Compiler | `@typescript/native` alias to `typescript` | `7.0.2` | Apache-2.0 | **MUST.** Nx invokes the stable native compiler binary. |
| Tool API compatibility | `typescript` alias to `@typescript/typescript6` | `6.0.2` | Apache-2.0 | **MUST temporarily.** Nx and lint tools still require the JavaScript compiler API that TS7 does not ship. |
| Renderer build | `vite` | `8.1.5` | MIT | **MUST.** Vite 8 owns Rolldown and Oxc internally; never install Rolldown directly. |
| React transform | `@vitejs/plugin-react` | `6.0.4` | MIT | **MUST.** Official Vite integration. Do not add a parallel SWC build path. |
| Public package build | `tsdown` | `0.22.14` | MIT | **SHOULD** for publishable protocol/types bundles only. Plain TS emit is enough elsewhere. |
| Format and general lint | `@biomejs/biome` | `2.5.6` | MIT OR Apache-2.0 | **MUST.** Stable formatter and broad lint without depending on the TS7 programmatic API. |
| Architecture lint | `eslint`, `typescript-eslint`, `@nx/eslint`, `@nx/eslint-plugin` | `10.8.0`, `8.65.0`, `23.1.0` | MIT | **MUST, narrow use.** Only Nx module boundaries, dependency checks, and rules Biome cannot express. ESLint never owns style. |
| Dead-code graph | `knip` | `6.31.0` | ISC | **SHOULD** once production packages exist. |
| Package contract | `publint`, `@arethetypeswrong/cli` | `0.3.23`, `0.18.5` | MIT | **MUST before npm publication.** |
| Bundle budgets | `size-limit` | `13.0.3` | MIT | **SHOULD** when the renderer and public packages have measured budgets. |

The TypeScript alias arrangement follows the [official Nx TypeScript 7 recipe](https://nx.dev/docs/kb/typescript-7). Nx and every official `@nx/*` package move together through `nx migrate`; do not use a caret range. [Nx Vite integration](https://nx.dev/docs/technologies/build-tools/vite/introduction) supports Vite 8.

```json
{
  "devDependencies": {
    "@typescript/native": "npm:typescript@7.0.2",
    "typescript": "npm:@typescript/typescript6@6.0.2"
  }
}
```

**DEFER `vite-plus@0.2.8`.** Vite+ is promising, but its beta task runner, cache, package manager, test, lint, and format surface overlaps responsibilities already assigned to Nx, pnpm, Vitest, and Biome. Reassess at 1.0 or when it has a first-class Nx integration. [Vite+](https://viteplus.dev/), [Nx comparison](https://nx.dev/docs/guides/comparisons/nx-vs-vite-plus).

**DEFER Oxlint and Oxfmt.** Oxlint duplicates Biome today and Oxfmt is still beta. Reassess Oxfmt at 1.0, then migrate formatter ownership in one change or not at all.

There is no official `@nx/electron`. **AVOID `nx-electron`**, which targets an older Nx major and brings Webpack plus electron-builder. Electron is an explicit Nx project whose targets call the selected Vite and Forge commands.

### Nx cache contract

Cache `format:check`, `lint`, `architecture`, `typecheck`, `test`, `build`, `licenses`, `sbom`, and `knip` when their inputs are deterministic. Do not cache `dev`, `serve`, `e2e`, `package`, `make`, `sign`, `notarize`, `publish`, or registry-backed audits until hermeticity is proven.

Global inputs include the lockfile, workspace manifest, Nx config, root package manifest, tsconfig bases, and the owning tool configs. Desktop build inputs additionally include OS and architecture. Never include `.rennet/`, home-directory configuration, harness state, credentials, signing material, user codebases, timestamps, or absolute machine paths.

Local `.nx/cache` is the default. Nx Cloud and any other remote cache are **DEFERRED pending an explicit privacy, retention, fork-trust, and secret-boundary decision**. A pre-push gate is full `run-many`; affected checks are an iteration and CI optimization, not release proof.

## 4. Electron runtime, packaging, updates, and security

| Capability | Package / API | Pin now | Licence | Verdict and boundary |
|---|---|---:|---|---|
| Desktop runtime | `electron` | `43.2.0` | MIT | **MUST.** Proven by the `node:sqlite` spike. `43.3.0` is held by the age gate. |
| Package and make | `@electron-forge/cli` | `7.11.2` | MIT | **MUST.** One packaging architecture. |
| Hardened fuses | `@electron/fuses` | `2.1.3` | MIT | **MUST.** Run from Forge's post-package hook. Forge's plugin still peers on fuse v1 and cannot name Electron 43's complete fuse wire. Disable RunAsNode, NODE_OPTIONS, CLI inspect, and file-protocol privilege; load production only from ASAR. |
| macOS artifacts | `@electron-forge/maker-dmg`, `@electron-forge/maker-zip` | `7.11.2` | MIT | **MUST for public macOS release.** ZIP is required by the update path; DMG is the user installer. |
| Public release updater | Electron `autoUpdater` through `update-electron-app` | `3.3.0` | MIT | **DEFER, then SHOULD.** Enable only for signed public GitHub releases. Private releases do not justify a Rennet backend. |
| GitHub release publishing | `@electron-forge/publisher-github` | `7.11.2` | MIT | **DEFER.** Add only when publishing is explicitly authorized. |
| Windows maker | `@electron-forge/maker-squirrel` | `7.11.2` | MIT | **DEFER** until Windows is a supported target. |

Use plain Vite 8 configs for the renderer and ordinary Node-target builds for main and preload. `@electron-forge/plugin-vite` is still experimental and Forge 7 is not the place to force its Vite 8 roadmap. `vite-plugin-electron` may get a dev-loop spike after its release clears the age gate, but is not foundational.

**AVOID electron-builder, electron-updater, and electron-vite.** Builder and updater duplicate Forge's package/release ownership; electron-vite's peer range does not include Vite 8. Do not install `@electron/notarize` or `@electron/osx-sign` directly while Forge's configuration surface owns them.

Use Electron built-ins for `utilityProcess`, `MessageChannelMain`, `safeStorage`, `nativeTheme`, `globalShortcut`, notifications, deep links, `shell.openExternal`, and local-only `crashReporter`. Follow Electron's current [security checklist](https://www.electronjs.org/docs/latest/tutorial/security): sandbox, context isolation, strict CSP, custom protocol instead of `file://`, sender validation, denied navigation/window creation, and denied permissions by default. Refuse Linux secret persistence when `safeStorage` reports `basic_text`. Keep crash upload off and include local dumps in diagnostic export and physical purge.

## 5. Domain, persistence, configuration, and process plumbing

| Capability | Package / API | Pin now | Licence | Verdict and boundary |
|---|---|---:|---|---|
| Internal runtime schemas | `zod` | `4.4.3` | MIT | **MUST.** Private commands, events, settings, IPC, and tolerant adapter decoders. |
| Public RSP validation | `ajv`, `ajv-formats` | `8.20.0`, `3.0.1` | MIT | **MUST.** Strict validation of normative JSON Schemas with JSON Pointer failures. Add only used formats. |
| Public RSP types | `json-schema-to-typescript` | `15.0.4` | MIT | **MUST, dev-only.** JSON Schema generates TypeScript one way; CI checks generated drift. |
| Canonical JSON | `canonicalize` | `3.0.0` | Apache-2.0 | **MUST.** RFC 8785 before SHA-256 for document, config, and provenance digests. |
| JSONC config | `jsonc-parser` | `3.3.1` | MIT | **MUST.** Parse and edit `.rennet/project.jsonc` while preserving human comments. |
| Atomic config replacement | `write-file-atomic` | `8.0.0` | ISC | **SHOULD.** Non-SQLite durable config writes only. |
| Child processes | `execa` | `10.0.0` | MIT | **MUST.** `10.0.1` was held by the seven-day age gate. Resolved executable plus argv, `shell: false`, binary streams, AbortSignal, bounded output, and graceful termination. GitPort still owns exact command and output contracts. |
| Change hints | `chokidar` | `5.0.0` | MIT | **MUST.** Debounced recapture trigger only; Git decides patchset truth. |
| Context exclusions | `ignore` | `7.0.6` | MIT | **MUST.** `.rennetignore` semantics only; Git decides tracked and ignored source state. |
| Async scheduling | `p-queue` | `9.3.3` | MIT | **MUST.** Bounded harness, LSP, Forge, and I/O queues. Native AbortSignal owns cancellation. |
| CPU work | `piscina` | `5.3.0` | MIT | **SHOULD when measured.** Matcher, parser, or snapshot CPU pools only; never another RPC architecture. |
| Durable IDs | `uuid` | `14.0.1` | MIT | **MUST.** UUIDv7 behind the injected Id/Random port. Node's built-in UUID is v4 and does not satisfy the frozen RepoRecord contract. |
| Event store | Electron/Node `node:sqlite` | built in | Node MIT; SQLite public domain | **MUST.** Single writer in the engine utility process, transactions, WAL, foreign keys, busy timeout, and defensive limits. |
| Rate-safe read retry | `p-retry` | `8.0.0` | MIT | **SHOULD for idempotent reads only.** Never wrap publish mutations; unknown outcomes reconcile first. |

The public RSP is JSON-Schema-first. Internal application protocols remain Zod-first. Never define the same wire shape independently in both systems.

**AVOID Kysely and SQLite wrappers.** The Electron 43 spike explicitly retired the Kysely bridge. Rennet's event store has a deliberately small prepared-statement surface; Kysely would restore a bridge and a second migration abstraction without removing product-owned event/upcast/saga logic.

**AVOID generic event-sourcing frameworks, XState, Immer, BullMQ, and Redis.** They duplicate or obscure the event log, projections, idempotency, and outcome-unknown publication contract.

## 6. Git, diff, code intelligence, and LSP

| Capability | Package / API | Pin now | Licence | Verdict and boundary |
|---|---|---:|---|---|
| Git truth | User-installed `git` through Execa | discovered | external GPL process | **MUST.** Never bundle or link Git; never use shell strings. |
| Tier-0 parsing | `web-tree-sitter` | `0.26.11` | MIT | **MUST.** WASM parser avoids Electron native ABI rebuilds. Parse once, dispose aggressively. |
| LSP framing | `vscode-jsonrpc`, `vscode-languageserver-protocol` | `9.0.1`, `3.18.2` | MIT | **MUST.** Own server lifecycle and product degradation, not Content-Length framing, request IDs, cancellation, or protocol unions. |
| TS7 LSP | Reviewed repo's exact `typescript@7.x` | repo-selected | Apache-2.0 external process | **MUST when present.** Invoke its `tsc --lsp --stdio`; never substitute a different compiler major. |
| TS6 and earlier LSP | `typescript-language-server` | `5.3.0` | Apache-2.0 | **SHOULD as the managed fallback**, pointed at the reviewed repo's exact TypeScript. Never select it for TS7. |
| Mini-diffs and similarity | `diff` | `9.0.0` | BSD-3-Clause | **MUST.** Token/text similarity only; never canonical Git patch ingestion. |
| Classifier patterns | `picomatch` | `4.0.5` | MIT | **SHOULD.** Generated, vendor, test, and config classification only. |
| Untracked binary detection | `isbinaryfile` | `6.0.0` | MIT | **SHOULD.** Captured untracked bytes only; Git metadata is canonical for tracked content. |
| Derived graphs | `@dagrejs/graphlib` | `4.0.5` | MIT | **SHOULD.** Cycle checks and traversal only; persist Rennet data, not mutable library state. |
| Disposable memory cache | `lru-cache` | `11.5.2` | BlueOak-1.0.0 | **SHOULD.** Sized memory cache with disposal; SQLite owns persistent cache metadata. |
| One-to-one assignment | `munkres` | `2.1.1` | MIT | **DEFER until the matcher spike passes.** It may solve assignment, never scoring, ties, split/merge, ambiguity, or read-state policy. |

Tree-sitter grammar assets are a separate licence gate. `@vscode/tree-sitter-wasm` is **DEFERRED** until ABI compatibility and a per-grammar source, version, licence, and NOTICE manifest are proven. A package-level MIT or Unlicense declaration is not proof for every embedded grammar. Prefer selected pinned official grammar WASMs plus their matching `queries/tags.scm`.

System `rg` may be detected as an accelerator, but `@vscode/ripgrep` is **DEFERRED** because it would add a bundled platform binary beyond Electron itself. Git grep and bounded JS traversal are the fallback. `vscode-languageclient` is **AVOID** because it assumes the VS Code extension host. `simple-git`, NodeGit/libgit2 bindings, and string-first diff parsers are **AVOID** because they hide or cannot preserve Rennet's byte-exact, NUL-delimited truth model.

## 7. GitHub integration

| Capability | Package / API | Pin now | Licence | Verdict and boundary |
|---|---|---:|---|---|
| REST and GraphQL transport | `@octokit/core` | `7.0.7` | MIT | **MUST.** Minimal client for both transports without Apps, OAuth, webhooks, or aggregate retry behavior. |
| Schema gate | `@octokit/graphql-schema` | `15.26.1` | MIT | **MUST, dev-only.** Validate pinned GraphQL documents and catch field removals in CI. |
| Authentication | User-installed `gh` | discovered | external MIT process | **MUST for initial auth.** Rennet never logs or persists the token it obtains for the host-owned client. |
| Scheduling/retry | `p-queue`, optional `p-retry` | above | MIT | **MUST/SHOULD by operation class.** Reads may retry; mutations enter outcome-unknown and reconcile. |

**AVOID aggregate `octokit`, global retry/throttling plugins, and a GraphQL code-generation stack in v1.** They add unrelated Apps/OAuth/webhook machinery or unsafe mutation retries. Octokit transports; Rennet owns auth precedence, anchoring, degradation, idempotency, read-back markers, and publish reconciliation.

## 8. Renderer and interaction stack

| Capability | Package | Target | Licence | Verdict and boundary |
|---|---|---:|---|---|
| UI runtime | `react`, `react-dom` | `19.2.8` | MIT | **MUST.** |
| Accessible primitives | `react-aria-components` | `1.19.0` | Apache-2.0 | **MUST.** Dialogs, menus, list boxes, autocomplete, command-palette behavior, tooltips, and toast behavior share one accessibility system. `1.20.0` is held by the age gate. |
| Error boundaries | `react-error-boundary` | `6.1.2` | MIT | **MUST.** Renderer fault containment and retry affordance. |
| Router | `@tanstack/react-router` | `1.170.18` | MIT | **MUST.** Type-safe desktop navigation. Newer 1.170.x releases are held by the age gate. |
| Async read models | `@tanstack/react-query` | `5.101.4` | MIT | **MUST.** IPC query lifecycle and invalidation, not event-store ownership. |
| Ephemeral view state | `zustand` | `5.0.14` | MIT | **MUST, renderer only.** Selection, panel, and transient interaction state; never durable review truth. |
| Keyboard shortcuts | `tinykeys` | `4.0.0` | MIT | **MUST.** Command registry invokes; tinykeys only binds. |
| Non-diff virtualization | `@tanstack/react-virtual` | `3.14.9` | MIT | **MUST for large rails and queues only.** Never wrap Pierre's diff surface. |
| Diff rendering | `@pierre/diffs`, `@pierre/theme` | proven `1.3.0-rc.1`; theme `2.0.0` | Apache-2.0 | **MUST after rerun.** Keep the proven version until an eligible stable 1.3.x passes the existing DOM, frame, annotation, and accessibility spike. Always use `CodeView`. |
| Markdown | `react-markdown`, `remark-gfm`, `rehype-sanitize` | `10.1.0`, `4.0.1`, `6.0.0` | MIT | **MUST.** Raw HTML off; sanitize after any unsafe transform. |
| Icons | `lucide-react` | `1.28.0` | ISC | **SHOULD.** One icon family. |

React Aria owns interaction primitives. **AVOID parallel Radix, cmdk, Sonner, and headless dialog/menu stacks.** Pierre owns syntax highlighting, so do not add direct Shiki for the diff surface. **AVOID Monaco, CodeMirror, and xterm** because Rennet is a reader and review surface, not an editor or terminal.

Motion is **DEFERRED** until CSS cannot express a measured interaction. React Hook Form is **DEFERRED** until settings forms become complex. `node-pty` is **DEFERRED** until a harness conformance test proves a real TTY is required.

## 9. Logging, diagnostics, testing, and quality

| Capability | Package / API | Pin now | Licence | Verdict and boundary |
|---|---|---:|---|---|
| Structured local logs | `pino`, `pino-roll` | `10.3.1`, `4.0.0` | MIT | **MUST in the Node/Electron host.** JSON structure, path redaction, bounded rotation, no network transport. Renderer logs cross rate- and size-limited typed IPC. |
| Crash dumps | Electron `crashReporter` | built in | Electron | **SHOULD, local-only.** `uploadToServer: false`; diagnostics and purge include dumps. |
| Unit and integration tests | `vitest` | `4.1.10` | MIT | **MUST.** |
| Coverage | `@vitest/coverage-v8` | `4.1.10` | MIT | **SHOULD.** Coverage finds gaps; a percentage is never behavior proof. |
| Real-browser components | `@vitest/browser-playwright`, `vitest-browser-react` | `4.1.10`, `2.2.0` | MIT | **MUST for renderer interaction.** |
| Electron journeys | `@playwright/test` | `1.62.0` | Apache-2.0 | **MUST.** E2E is uncached initially; native dialogs are replaced through injected ports. |
| Accessibility | `@axe-core/playwright` | `4.12.1` | MPL-2.0 | **MUST, dev-only.** |
| Property testing | `fast-check` | `4.9.0` | MIT | **MUST.** Lineage, event replay/upcasts, privacy noninterference, parser fuzzing, and canonicalization. |
| Secret scanning | `@secretlint/quick-start` | `13.0.4` | MIT | **SHOULD.** Calibrated with a synthetic secret fixture. |
| Vulnerabilities | OSV Scanner | `2.3.8` | Apache-2.0 tool | **MUST in CI/release gates.** No runtime link. |

Pino wins over `electron-log` because Rennet's privacy boundary needs explicit structured fields and redact paths, not renderer-friendly convenience. The LogPort, allowed event schema, redaction rules, local path selection, diagnostic export, and physical purge remain owned.

Hosted telemetry, hosted traces, Percy, Chromatic, and Sentry are **DEFERRED** behind an explicit opt-in privacy decision. Default builds have no telemetry backend. MSW is deferred until the renderer owns a genuine HTTP integration. Prefer real temporary directories and Git repositories; use `memfs` only for narrow filesystem fault injection.

## 10. Intentionally owned product code

These are not gaps in the package list:

1. The typed IPC command map, validating dispatcher, streaming protocol, recipient-specific projections, and preload surface.
2. `GitPort`, exact executable/argv allowlist, byte and NUL parsers, immutable materialisation, source caps, and source-checkout non-mutation policy.
3. Immutable patchset capture, occurrence lineage, scoring, ambiguity, split/merge semantics, and read-state carry policy.
4. The event store schema, upcasts, projections, command receipts, physical purge, and publish outcome-unknown saga.
5. Project snapshot provenance, freshness, incremental invalidation, and full-build byte equivalence.
6. Harness adapters, capability conformance, prompt assembly, budgets, cancellation, provider egress disclosure, and context authority manifest.
7. LSP host lifecycle, materialisation selection, readiness positive control, degraded-result detector, position refusal, and tier disclosure.
8. GitHub anchor mapping, degradation ledger, immutable commit check, batch review publication, read-back marker, and reconciliation.
9. Logging field policy, source-content exclusion, redaction, diagnostics export, and purge.
10. Licence boundary enforcement, selected grammar provenance, pathological fixtures, and positive controls.

## 11. Explicit blockers and review triggers

- A stable `@pierre/diffs` 1.3.x must pass the existing performance, DOM, annotation-recycling, and accessibility spike after its release clears the age gate.
- Every shipped tree-sitter grammar requires its own source, version, licence, query, and NOTICE provenance before packaging.
- Vite+ is reconsidered at 1.0, Oxfmt at 1.0, pnpm 11 after the age gate, and Nx Cloud only after a privacy decision.
- `vite-plugin-electron` gets a bounded dev-loop comparison with plain Vite after it clears the age gate; the result may change dev orchestration, not Forge ownership.
- Updaters, signing, notarization, publishers, and release makers land only in the explicitly authorized public-release phase.

## 12. Research provenance

This standard was synthesized from three independent research lanes on 2026-08-05: monorepo/build/release tooling; code intelligence, Git, persistence, schemas, and Forge transport; and Electron/UI/logging/testing/security. Registry versions and licences were checked against npm, and load-bearing recommendations were checked against primary project or vendor documentation. Where a research recommendation conflicted with an existing measured Rennet spike, the spike won.
