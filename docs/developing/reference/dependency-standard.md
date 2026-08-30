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

Rennet's own packages are licensed under FSL-1.1-MIT (Functional Source License,
MIT Future License): source-available, free for any non-competing use, with each
release converting to MIT two years after publication. This is Rennet's outbound
licence and is independent of the inbound licences of its dependencies.
Distributed dependencies may use the compatible licences allowlisted in
`scripts/check-licenses.mjs`; attribution and notice obligations travel with the
packaged artifact and are collected in `THIRD-PARTY-LICENSES.md` (regenerate with
`pnpm notices`).

Self-hosted Geist, Geist Mono, Fraunces, and Newsreader assets use OFL-1.1. The
font licence applies to the font files, not Rennet's FSL-1.1-MIT source.

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
| First-party native artifact builds | `@electron/node-gyp` and the platform C toolchain |
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
| Tests | `vitest`, `@playwright/test` | `4.1.10`, `1.62.1` |
| Desktop | `electron`, Electron Forge, `@electron/fuses` | `43.4.1`, `7.11.2`, `2.1.3` |
| Native executable build | `@electron/node-gyp` | `10.2.0-electron.1` at `06b29aafb7708acef8b3669835c8a7857ebc92d2` |
| Docs | `astro`, `@astrojs/starlight` | `7.1.6`, `0.41.7` |
| Claude | `@anthropic-ai/claude-agent-sdk` | `0.3.223` |
| GitHub | `@octokit/core` | `7.0.7` |
| Runtime schemas | `zod` | `4.4.3` |
| Processes and file watching | `execa`, `chokidar` | `10.0.0`, `5.0.0` |
| Durable IDs | `uuid` | `14.0.1` |
| Graph model and community detection | `graphology`, `graphology-communities-louvain` | `0.26.0`, `2.0.2` |
| Browser UI | `react`, `react-dom` | `19.2.8` |
| UI failures and transient state | `react-error-boundary`, `zustand` | `6.1.2`, `5.0.14` |
| Renderer routing | `wouter` | `3.10.0` |
| Renderer animation | `motion` | `13.1.1` |
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

## First-party native artifacts

`@rennet/adapters` owns two small FSL-1.1-MIT C artifacts: an executable that
asks the host filesystem for an exclusive, no-replace namespace move, and a
Node-API addon that supplies descriptor-rooted filesystem operations to the
transactional round landing engine. Its Nx `build` target invokes the
workspace's exact-SHA `@electron/node-gyp` directly and writes both artifacts
under `packages/adapters/dist/native/<platform>-<architecture>/` as
`rennet-exclusive-move` (`.exe` on Windows) and
`rennet-rooted-landing.node`. This is a repository build command, not a
dependency lifecycle script, so it does not belong in pnpm's
`onlyBuiltDependencies` list.

Run `pnpm nx run rennet-adapters:native-test` for the typed adapter contract and
real file, symlink, directory, existing-destination, contention, rooted-path,
and Git snapshot semantics. CI runs that target on Ubuntu, macOS, and Windows
because no one host can compile or execute all platform implementations. The
focused matrix also runs
`rennet-adapters:native-determinism-test`, which rebuilds under two distinct
temporary roots and requires both host artifacts to be byte-identical.

On POSIX hosts, the addon captures repository and worker roots by walking every
absolute-path component without following symlinks, then performs later work
relative to those captured descriptors. Regular-file inspection transfers an
owned, no-follow descriptor to the TypeScript adapter, which streams that one
anchored snapshot through the raw digest and Git attribute-aware object hash
without buffering the file in native or JavaScript memory. The Windows artifact
currently exposes an explicit unsupported constructor. Desktop and CLI builds
stage every available platform directory at
`<server-bundle>/native/<platform>-<architecture>/`; the Windows release bundle
also carries `linux-x64` for its WSL daemon. Those bundle builds remain uncached:
they copy platform- and toolchain-dependent native outputs whose bytes do not
exist when Nx hashes the dependent task graph. `createRennetServer` constructs
this host by default on POSIX daemons and retains one captured host for the
durable operation through planning, per-file landing, and cleanup. Desktop,
CLI, and distro-native WSL execution converge through that server composition.
Native Windows repositories retain the legacy landing path while the Windows
constructor remains explicitly unsupported; WSL uses its staged Linux host.

Native artifacts and their semantic verdicts depend on the operating system,
architecture, compiler, linker, SDK, and generator environment. The adapter's
`build`, `test`, and `native-test` targets therefore remain uncached until Nx
models the complete toolchain identity. The determinism target proves two
fresh builds are byte-identical on one build host; it does not make artifacts
portable across hosts. Windows native CI is fixed to `windows-2022` because the
ruled Electron `node-gyp` revision recognises Visual Studio only through 2022;
the auto-release Windows build uses the same host because desktop builds
traverse to the adapter build.

The native error contract maps only unambiguous platform results. Linux
`EINVAL` remains a typed generic failure because it can mean either unsupported
filesystem flags or invalid path topology; it must not be reported as
unsupported without that distinction.

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
review state stays in the daemon; Zustand owns renderer state only — either genuinely
transient (dialogs, focus, run lanes) or a cache of a daemon projection, as the `review`
slice is for the durable ask log.

`AsyncIterable` carries harness streams. The event store is replayable truth.
Small injected-clock batchers own coalescing. Do not add RxJS or another general
reactive-stream layer.

## Git, GitHub, and harnesses

The user-installed `git` executable is canonical Git truth. Invoke an exact
binary with an argv array through Execa. Rennet owns byte-safe, NUL-delimited
parsing and immutable capture because those details define review correctness.

`@octokit/core` carries GitHub REST and GraphQL requests. The user-installed `gh`
CLI owns the primary credential lifecycle. Rennet owns its fallback OAuth device
flow and refresh, plus request anchoring, idempotency markers, rate-limit
handling, and outcome reconciliation. Do not add the aggregate `octokit` bundle
or global retry plugins around publication mutations.

The Claude adapter uses `@anthropic-ai/claude-agent-sdk` with the user's installed
executable. The Codex adapter drives the user's `codex app-server`. Rennet does
not bundle a harness executable or read a harness credential.

## Browser and mobile UI

React owns rendering, and the desktop UI splits in two (2026-08-20 shadcn/Base UI
port). `@rennet/ui` is a vendored shadcn/ui component kit built on Base UI
(`@base-ui/react`, MIT). It carries Button, Input, Dialog, Sheet, Popover,
DropdownMenu, Select, Switch, Checkbox, Tabs, Tooltip, ScrollArea, Badge,
Skeleton, Separator, Toast, Field, InputGroup, Spinner, and the `cmdk` Command
palette, importing only
`protocol` and `theme`. `@rennet/app-ui` composes the kit into Rennet's screens and
imports only `protocol`, `theme`, `ui`, and browser-safe dependencies.
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

`wouter` owns renderer routing: it removes the route-matching and
history-integration subsystem, its history is host-injected (hash in the Electron
renderer, browser in the served tab, memory in tests), and its layout-wraps-switch
composition keeps persistent chrome outside the swapped outlet. The `@rennet/app-ui`
data seam's command cache is **owned, not `@tanstack/react-query`**: the need is
three hooks over a keyed store (dedupe in-flight, stale-on-invalidate,
stale-on-abandon so a reopened surface re-reads rather than re-showing what it left
with, per-key subscribers), and react-query's surface (refetch-on-focus, garbage
collection,
retries, devtools, infinite queries) far exceeds it and would need configuring-off —
so it fails the admission test at the size that matters. The ~130-line `CommandCache`
is browser-safe and invisible outside `src/data/` (`useCommand`/`useCommandStream`/
`useMutation` are the whole contract), so adopting react-query later stays internal.
Zustand owns interaction state; the command cache owns the server-projection read cache
— distinct owners, no conflict. Where the two meet (the `review` slice mirroring the
durable ask projection) the daemon is the source: the slice is hydrated from `ask.read`
and every mutation writes through an `ask.*` command.

`graphology` and `graphology-communities-louvain` own the graph model and the
Louvain community detection that shapes the knowledge swarm's
[module batches](../concepts/code-intelligence.md#module-batching). Both are MIT.
They meet the admission test at the size that matters: modularity optimisation
with node aggregation is a real algorithm, not a convenience wrapper, and writing
it here would be a subsystem Rennet then maintained and tuned. They live in
`@rennet/core` because batching is deterministic product logic, not IO — the
packages are pure JavaScript with no Node or DOM dependency, so they respect the
package boundary that keeps core runnable anywhere. Louvain is called with its
randomisation disabled and its RNG pinned, because the snapshot's byte
reproducibility extends to everything derived from it.

Motion owns authored React and SVG animation timelines. The first-run welcome
uses its scoped `useAnimate` sequences, stagger, cleanup, and reduced-motion
hook for the code-flight and logo assembly. It is MIT licensed and removes the
timeline and lifecycle subsystem Rennet would otherwise maintain. GSAP is not
used: its custom licence does not fit the workspace's ordinary SPDX licence
gate, and its extra timeline surface is unnecessary for this interaction.

The mobile app uses Expo SDK 55, expo-router, and React Native 0.83.6. It imports
`@rennet/client` and `@rennet/protocol`, not the DOM-bound UI
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
