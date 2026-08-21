---
title: Dependency standard
description: Rules for package selection, exact versions, licence checks, and tool ownership.
---

Rennet uses dependencies for general infrastructure and keeps product policy in
Rennet code. This page owns dependency selection, version policy, licence policy,
and tool ownership. Product and data contracts live in
[architecture contracts](../concepts/architecture-contracts.md).

## Admission test

A dependency must remove a subsystem Rennet would otherwise maintain, have a
healthy primary source, carry a compatible licence, and fit the package boundary
that imports it. A small convenience wrapper does not meet that test.

Use these terms in dependency decisions:

| Term | Meaning |
|---|---|
| **Must** | The current owner for a required capability. |
| **Add when needed** | The selected package for a named capability that has a live caller. |
| **Defer** | A plausible package without a current caller or measurement. |
| **Avoid** | A package that duplicates an owner or crosses an architecture boundary. |
| **Own** | Product policy that a general library cannot define for Rennet. |

## Versions and installation

Every direct dependency uses an exact version or an SDK-controlled compatible
range where the platform requires one. `pnpm-lock.yaml` commits the complete
resolution. pnpm rejects packages published less than seven days ago unless
`pnpm-workspace.yaml` names a specific exception.

The workspace uses `nodeLinker: hoisted` because Electron Forge's native rebuild
chain requires it. Hoisting does not permit undeclared imports. pnpm blocks
dependency build scripts except the three packaging tools named in
`onlyBuiltDependencies`.

Overrides pin known transitive fixes. Remove an override when the ordinary graph
resolves to an equal or newer compatible version and the owning tests pass.

## Licence policy

Rennet packages are MIT licensed. Distributed dependencies may use the
compatible licences allowlisted in `scripts/check-licenses.mjs`; attribution and
notice obligations travel with the packaged artifact.

Self-hosted DM Sans, Fraunces, and Source Serif 4 assets use OFL-1.1. The font
licence applies to the font files, not Rennet's MIT source.

The Anthropic Agent SDK and its platform packages are named exceptions because
pnpm reports their commercial licence as `Unknown`. The gate does not allow the
`Unknown` bucket generally. A generated unknown package is the positive control
that proves the gate can still fail. Packaging strips the SDK's bundled harness
executables because Rennet runs the user's installed `claude`.

## Tool ownership

| Job | Owner |
|---|---|
| Package resolution and lockfile | pnpm |
| Project graph, tasks, and local cache | Nx |
| Formatting and broad lint | Biome |
| Package and import boundaries | ESLint with Nx rules |
| Type checking | TypeScript |
| Renderer builds | Vite |
| Unit and integration tests | Vitest |
| Electron journeys | Playwright |
| Desktop packaging and release | Electron Forge |
| Desktop runtime | Electron |
| Documentation site | Astro and Starlight |
| Native mobile app | Expo and expo-router |

Do not add a second task graph, formatter, general linter, Electron packager,
renderer build system, test runner for the same class of tests, or reactive state
stack for the same state owner.

## Current baseline

These versions come from the current workspace manifests:

| Capability | Package | Version |
|---|---|---:|
| Node host | Node.js | `24.18.0` |
| Package manager | pnpm | `10.32.1` |
| Task graph and official plugins | `nx`, `@nx/*` | `23.1.0` |
| Native compiler | `@typescript/native` | `typescript@7.0.2` |
| Tool API compiler | `typescript` | `@typescript/typescript6@6.0.2` |
| Formatter | `@biomejs/biome` | `2.5.6` |
| Architecture lint | `eslint`, `typescript-eslint` | `10.8.0`, `8.65.0` |
| Renderer build | `vite`, `@vitejs/plugin-react` | `8.1.5`, `6.0.4` |
| Tests | `vitest`, `@playwright/test` | `4.1.10`, `1.62.0` |
| Desktop | `electron`, Electron Forge, `@electron/fuses` | `43.2.0`, `7.11.2`, `2.1.3` |
| Docs | `astro`, `@astrojs/starlight` | `7.1.6`, `0.41.7` |
| Claude | `@anthropic-ai/claude-agent-sdk` | `0.3.223` |
| GitHub | `@octokit/core` | `7.0.7` |
| Runtime schemas | `zod` | `4.4.3` |
| Processes and file watching | `execa`, `chokidar` | `10.0.0`, `5.0.0` |
| Durable IDs | `uuid` | `14.0.1` |
| Browser UI | `react`, `react-dom` | `19.2.8` |
| UI failures and transient state | `react-error-boundary`, `zustand` | `6.1.2`, `5.0.14` |
| Mobile | `expo`, `expo-router`, `react-native` | `~55.0.26`, `~55.0.16`, `0.83.6` |

Update this table with the manifest change that moves a version.

## Nx cache contract

Run repository work through `pnpm nx`. The full gate is:

```sh
pnpm check
```

It runs `format`, `architecture`, `licenses`, `lint`, `typecheck`, `test`, and
`build`. Every cacheable target declares all files and environment values that
can change its result, plus every generated output directory.

Do not include credentials, timestamps, absolute machine paths, harness state,
user repositories, or undeclared ambient state in cache inputs or outputs.
Long-running development servers, watch processes, interactive Electron tasks,
and end-to-end tests remain uncached. Local Nx caching is the default; the
workspace does not use Nx Cloud.

## Runtime and persistence

Electron built-ins own native desktop facilities such as `utilityProcess`,
`MessageChannelMain`, `safeStorage`, `nativeTheme`, notifications, deep links,
external links, and crash dumps. Vite builds the renderer. Forge owns package,
make, signing, notarization, and publishing targets.

The public RSP contract is JSON-Schema-first. Private commands, events, and IPC
use Zod. Do not define the same public wire shape independently in JSON Schema
and Zod.

Rennet owns event semantics, upcasts, projections, receipts, physical purge, and
publication reconciliation. Do not add an event-sourcing framework, SQLite ORM,
Redis queue, or general state-machine library around those contracts. Durable
review state stays in the daemon; Zustand owns transient renderer state only.

`AsyncIterable` carries harness streams. The event store is replayable truth.
Small injected-clock batchers own coalescing. Do not add RxJS or another general
reactive-stream layer.

## Git, GitHub, and harnesses

The user-installed `git` executable is canonical Git truth. Invoke an exact
binary with an argv array through Execa. Rennet owns byte-safe, NUL-delimited
parsing and immutable capture because those details define review correctness.

`@octokit/core` carries GitHub REST and GraphQL requests. Rennet owns OAuth device
flow, token refresh, request anchoring, idempotency markers, rate-limit handling,
and outcome reconciliation. Do not add the aggregate `octokit` bundle or global
retry plugins around publication mutations.

The Claude adapter uses `@anthropic-ai/claude-agent-sdk` with the user's installed
executable. The Codex adapter drives the user's `codex app-server`. Rennet does
not bundle a harness executable or read a harness credential.

## Browser and mobile UI

React owns rendering, and the desktop UI splits in two (2026-08-20 shadcn/Base UI
port). `@rennet/ui` is a vendored shadcn/ui component kit built on Base UI
(`@base-ui/react`, MIT). It carries Button, Input, Dialog, Sheet, Popover,
DropdownMenu, Select, Switch, Checkbox, Tabs, Tooltip, ScrollArea, Badge,
Skeleton, Separator, Toast, and the `cmdk` Command palette, importing only
`types` and `theme`. `@rennet/app-ui` composes the kit into Rennet's screens and
imports only `types`, `protocol`, `theme`, `ui`, and browser-safe dependencies.
Neither imports `core`, adapters, Node, or Electron.

Base UI is the primary primitive family. Radix is not banned: a Radix
dependency is fine where a shadcn component brings it (`cmdk` pulls Radix Dialog).
The soft rule is to not run two *different* families for the *same* primitive
without reason. Vendored components are re-themed onto the `--rn-*` palette (no
hardcoded hex; `hex-lint`/`design-ramp` enforce the type/radius ramp). Other
registries are admitted per component and license-verified at pull time; the
license blocklist (mixed-licence Origin UI, proprietary Aceternity, Commons-Clause
animate-ui) is checked then. Syntax highlighting uses `shiki`; icons use
`lucide-react`; prose uses `react-markdown`.

The mobile app uses Expo SDK 55, expo-router, and React Native 0.83.6. It imports
`@rennet/client`, `@rennet/protocol`, and `@rennet/types`, not the DOM-bound UI
packages (`@rennet/ui`, `@rennet/app-ui`). Expo modules own camera, secure storage, notifications, linking, and
background tasks. AsyncStorage owns the replica cache, daemon list, and
notification preferences.

`expo-share-intent` handles Android text shares. iOS enters reviews through paste
and `rennet://kickoff`. The app uses explicit Nx lint, typecheck, and test targets.
Native distribution is separate from the JavaScript build gate.

## Product code Rennet owns

1. Typed command dispatch, streaming, and recipient-specific projections.
2. Git invocation, byte parsing, immutable capture, and ingestion limits.
3. Patchset occurrence lineage, ambiguity, split and merge, and read carry.
4. Event schemas, upcasts, projections, receipts, purge, and publication recovery.
5. Repo Map identity, freshness, incremental rebuild, promotion, and knowledge.
6. Harness conformance, context assembly, routing, budgets, cancellation, and run ledgers.
7. Code-intelligence lifecycle, readiness, degradation, and evidence tiers.
8. GitHub anchor mapping, batch publication, idempotency, and reconciliation.
9. Dependency-boundary checks and their positive controls.

Review an added package against this ownership list, its importing package's
boundary, its licence, its release age, and a test that exercises the capability
it owns.
