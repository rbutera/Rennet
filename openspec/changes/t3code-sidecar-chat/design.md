## Context

See proposal.md for motivation. The facts that shape the approach, verified against T3 Code `origin/main` at aab404964 (2026-09-02):

- T3's server is one Effect RPC WebSocket at `/ws`, contract in `packages/contracts/src/rpc.ts`. Clients dispatch typed commands (`thread.create`, `thread.turn.start`, `thread.approval.respond`) and subscribe to server streams (`orchestration.subscribeThread`). The server is the execution boundary.
- `t3 serve` runs headless. Their desktop spawns the same entry with `--bootstrap-fd 3` and writes a one-time token to that descriptor. The token is exchanged at `POST /oauth/token` (token-exchange grant, subject type `urn:t3:params:oauth:token-type:environment-bootstrap`) for a bearer session, or at `POST /api/auth/browser-session` for a cookie.
- Telemetry is `T3CODE_TELEMETRY_ENABLED`, default on. T3 Connect and the relay activate only with `T3CODE_RELAY_URL` and Clerk keys present.
- Provider defaults are `binaryPath: "claude"` and `"codex"` resolved on the server's PATH, with an empty home path meaning the user's normal login. Per-turn checkpoints are hidden git refs written into the reviewed repository with `update-ref`.
- The reusable packages are `private: true` and export TypeScript source; they are not on npm. Their toolchain is `vp` (vite-plus) for pack and test, `tsgo` for typecheck, pnpm catalogs for versions, and a pnpm patch on `effect@4.0.0-beta.103`. The server imports `effect/unstable/*` throughout.
- Upstream moves at roughly thirty commits a day. Their tree is over 300k lines including a vendored Effect repository, infra, marketing, mobile and native code.
- `ChatView` takes `environmentId`, `threadId`, `routeKind`, and an `onDiffPanelOpen` callback. It reads state through `@effect/atom-react` atoms from a registry, calls TanStack Router's `useNavigate` once, and expects the root toast and dialog hosts. Styling is Tailwind 4 over semantic variables (`--background`, `--foreground`, `--app-theme-*`) and a shadcn-style kit on `@base-ui/react` 1.4. Rennet is on Tailwind 4, Base UI 1.7, wouter, React 19.2.
- Rennet's daemon lifecycle already has claim-as-claim-to-verify, `findHealthyDaemon`, `spawnDaemon`, `waitForHealthy`, `stopOwnedDaemon`, and the tray's health-verified SIGTERM path (ADR 0001). Rennet's harness discovery is shell-free and returns absolute paths.

## Goals / Non-Goals

**Goals:**
- Reuse T3's code, not its architecture: vendored source that Rennet can edit, with a repeatable path to fold upstream in.
- Keep the merge burden legible: pristine vendor branch, three-way merges, a ledger of every local edit, and a digest per fold.
- Prove the wrap end to end on one machine: owned sidecar, authenticated RPC from the daemon, T3 thread in the chat slot, a handoff work order running as a T3 turn.
- Keep Effect out of Rennet-authored modules. It is a dependency of one server module and, for rung two, of the vendored renderer packages.
- Leave every Rennet adapter path untouched. Lens seats, the collector, WSL locus and council routing do not change.

**Non-Goals:**
- Forking the T3 repository or rebasing Rennet into it.
- Running the vendored server in-process. The sidecar is a separate process for this change; the vendored source leaves in-process open.
- Retiring the Rennet orchestrator or `SessionTurnLoop`.
- Moving lens seats onto T3's text generation.
- Mounting T3's right panel, sidebar, command palette, or mobile client.
- Remote or WSL sidecars.

## Decisions

**Vendor a selected snapshot, not the repository.** `vendor/t3code/` holds `packages/{contracts,shared,client-runtime,effect-codex-app-server,effect-acp,tailscale}`, `apps/server`, `apps/web`, upstream's `scripts/lib`, `patches`, root `package.json`, `tsconfig.base.json` and `vite.config.ts` (the two apps import those by relative path, and the root manifest's `"type": "module"` is what makes `scripts/lib` resolve as ESM). Alternatives: `git subtree` of the whole repository (no path selection, drags 300k lines and their vendored Effect repo), a git submodule (pins a commit but cannot carry local edits), or forking (rejected by Rai: starting again in their tree is too large a reset). Path selection keeps the workspace to what the product uses.

**A pristine vendor branch is the merge base.** `t3-vendor` contains only `vendor/t3code/`, assembled by a script with `git read-tree --prefix` from the selected subpaths of an upstream commit, one commit per fold. Main merges the branch. Git's three-way merge then lands upstream changes cleanly except in files Rennet edited, which is the same mechanism `git subtree` relies on with path selection added. Alternative: a patch-queue vendoring tool. Rejected: more machinery, and git already does the merge.

**Inspect and fold are two plain Node scripts.** `scripts/t3-upstream.mjs inspect` fetches upstream from a local clone, lists commits since the recorded base that touch vendored paths, groups by area, flags commits touching ledgered files, and writes `vendor/t3code/digests/<date>.md`. `fold --to <sha>` advances the vendor branch, merges it, updates `UPSTREAM.json`, and stops on conflicts with ledger entries printed. Weekly cadence, run by an agent, landed as a PR with the digest as its body. The digest is itself a diff digest, so a later change can route it through Rennet.

**Pins reproduce upstream's lockfile where resolution changes the code's meaning.** The vendored manifests carry caret ranges; a fresh resolve in Rennet's workspace picked a newer Claude Agent SDK (new message unions, a required `requestId`) and a newer TanStack router plugin (regenerates `routeTree.gen.ts` with a different import order on every build, dirtying a vendored file). Scoped overrides pin both to upstream's lock, and React to Rennet's 19.2.8 so the hoisted store holds one copy (two copies gave the web tests a null hooks dispatcher, the same hazard rung two has to clear). Two vendored projects typecheck through a Rennet-owned `tsconfig.rennet.json` with a narrower include, and four upstream tests that read files outside the vendored paths are excluded by name in their Nx target.

**Vendored code keeps upstream formatting and toolchain.** Biome and ESLint ignore `vendor/`. Reformatting would turn every fold into wall-to-wall conflicts. Their tests run through `vp` behind an Nx target per vendored package with declared inputs, so the gate covers them without Rennet's linters touching them. `vp` and `tsgo` become dev dependencies; T3's catalog entries and its Effect pnpm patch are merged into `pnpm-workspace.yaml`.

**A ledger check enforces the discipline.** `PATCHES.md` lists each edited vendored file with reason, upstreamable flag, and upstream PR link. A check compares the working tree's `vendor/t3code/` against the vendor branch and fails on any differing file without a ledger entry. Prefer extension over edit: Rennet code lives outside `vendor/` and imports their modules. The first two ledger entries are the ones the pipeline needs and upstream lacks: an `outputFormat` option on Claude text generation and an ephemeral session flag, both sent upstream so they leave the ledger.

**Sidecar, private base directory.** The daemon builds the vendored server with `vp pack` and spawns `node <bundle> serve --host 127.0.0.1 --port <free port> --no-browser --base-dir <dataDir>/t3 --bootstrap-fd 3` (T3 validates `--port` as 1 to 65535, so the supervisor binds port 0 on loopback to pick a free port, releases it, and passes that number), token piped into fd 3, `T3CODE_TELEMETRY_ENABLED=false`, and every `T3CODE_RELAY_*` and `T3CODE_CLERK_*` key stripped. The base directory is Rennet's, never `~/.t3`: Rai does not want the user's own T3 install touched. Provider setup and secrets from a standalone install are irrelevant because T3's defaults use the user's normal login, and the only thing Rennet must supply is absolute binary paths.

**Seed provider binaries from Rennet's discovery.** At spawn the supervisor writes the sidecar's provider settings with the absolute `claude` and `codex` paths Rennet resolved. A GUI-launched daemon inherits launchd's minimal PATH, and T3 resolves `"claude"` on the server's PATH.

**The bootstrap envelope is T3's own desktop contract.** T3 reads one JSON line from `--bootstrap-fd` in its `DesktopBackendBootstrap` shape (`mode: "desktop"`, `port`, `host`, `t3Home`, `desktopBootstrapToken`), and seeds that token as an unbounded 24-hour grant. The daemon mints the token itself, so nothing on stdout has to be parsed; readiness is T3's `userdata/server-runtime.json` (written after the listener binds) plus the unauthenticated `/.well-known/t3/environment`. The bearer from `POST /oauth/token` (form-encoded token exchange) lasts 30 days and opens `/ws` directly with an `Authorization: Bearer` header, so the daemon-side client skips the web client's ticket dance. T3 has no SIGTERM handler: a streaming turn is reconciled to an errored session on the next boot, so "persists as interrupted" needs `thread.turn.interrupt` over RPC before the signal, which lands with the daemon-side client (group 3).

**Sidecar claim mirrors the daemon claim.** `t3-sidecar.json` beside `daemon.json` holds pid, port, vendored base commit and the daemon's pid, with the same probe-before-trust rule. `stopOwnedDaemon` gains a sidecar step after the daemon's own turn interruption, serialized through `chainDaemonOp`.

**Contract probed at boot.** After the handshake the supervisor checks the method set it calls and reports `degraded` naming any missing method. This is what protects the daemon across folds.

**Two rungs for the UI, decided by the spike.** Rung one embeds the sidecar's served UI at the thread route in an Electron `<webview>` inside the chat slot, authenticated through a brokered browser-session cookie. It is literally an iframe, and it exists only to answer whether the thread view fits the slot and whether approvals and questions round-trip. Rung two mounts `ChatView` natively: T3's atom registry provider, a memory-history TanStack router with the single thread route, their toast and dialog hosts, and `ChatView` with the environment and thread ids. The environment is registered in T3's environments store from the URL and credential the daemon brokers. A Vite alias resolves their `~/` imports into `vendor/t3code/apps/web/src`; one Tailwind build includes their source; a CSS theme bridge defines `--background`, `--foreground` and the `--app-theme-*` set from Rennet's `--rn-*` palette and fonts. One React copy is verified first. If `ChatView` needs their `_chat` layout or route loaders to render, the fallback is their projected thread read model under a Rennet timeline.

**Rung two as built (2026-09-03).** A new package, `@rennet/t3-chat`, rather than code in `app-ui`: `app-ui` typechecks under Rennet's base config, and the vendored source needs upstream's (`exactOptionalPropertyTypes`, its `~/` paths, tsgo), so the mount package extends upstream's `tsconfig.json`, typechecks with tsgo, and publishes a hand-written `public.d.ts` as its `types` export so the desktop's tsc never traverses the vendored tree. The router is a real TanStack router over `createMemoryHistory` with code-defined routes (`/`, `/$environmentId/$threadId`, `/draft/$draftId`, `/settings/connections`), not a shim: `ChatView`'s subtree navigates to all four and `DiffPanel` and the toast viewport read the thread params. The environment is a `BearerConnectionRegistration` through `environmentCatalog.register`, and the renderer defines `VITE_HOSTED_APP_CHANNEL` so T3's platform layer registers no primary environment (Rennet's `app://` origin would otherwise be probed and fail). The theme bridge is a second Tailwind entry without preflight rather than one build: their stylesheet cannot be imported without its own `@import "tailwindcss"` and its `@theme` remapping of the shared names, so the shared names are mirrored from `theme.css` and the T3-only names, utilities and keyframes are copied verbatim (a fold that changes them upstream shows as missing styling). `accent` is the one shared name whose meaning differs (T3's hover surface, Rennet's gold); it is re-bound inside the mount's root element only. `onDiffPanelOpen` is not wired: neither of upstream's route files passes it and `ChatView` hosts `DiffPanel` itself, so 8.3's side-slot wiring has nothing to attach to.

**Server-side RPC through their client.** `packages/server/src/t3/client.ts` imports `@t3tools/client-runtime/rpc`, `@t3tools/contracts` and `effect`, and exposes `createThread`, `startTurn`, `subscribeThread`, `readTurnDiff` as Promises and AsyncIterables. This is the one place Effect appears in Rennet-authored server code.

**Thread binding carries repository identity.** The session-to-thread map is keyed on `repositoryRoot` and session id, never `Project.id` or `openPath`.

**Handoff routing is a second exit on the existing loop.** When the engine is T3, the dispatch step calls `startTurn` on the bound thread instead of `SessionTurnLoop`; the settled turn's diff is read from T3's checkpoint diff query and handed to the existing delta re-review entry.

## Risks / Trade-offs

- [Vendored server does not build under Rennet's workspace] → keep their toolchain for the vendored dirs; the first wave is the build proof, and nothing else starts until it passes.
- [Fold conflicts pile up] → the ledger check, extension over edit, and upstreaming the two seeds keep the ledger short; the digest shows risk before the fold runs.
- [Effect 4 beta and `effect/unstable` churn] → confined to `vendor/` and one Rennet module; folds carry Effect bumps with the snapshot.
- [Two React runtimes or two Base UI copies in the renderer] → dedupe verified in rung two; their kit tested on Base UI 1.7 before shipping two copies.
- [`<webview>` shows a second app with its own theme] → rung one is proof only.
- [Two WebSockets and two state runtimes in one renderer] → kill criterion, measured in rung two; failure reopens the fork question with evidence.
- [T3 threads persist to harness history; hidden refs land in the repo] → disclosed beside the engine setting; seats stay ephemeral.
- [T3 usage view cannot see seat turns; Rennet's collector cannot see T3 turns] → accepted; stated in copy and docs.
- [Sidecar survives a daemon crash] → verified claim adopted on next start; stale claims reaped.

## Migration Plan

Additive. The engine setting defaults to Rennet, so nothing changes for an existing install until the user selects T3. Rollback is selecting Rennet again; the sidecar stops on the next daemon stop and `<dataDir>/t3` can be deleted by hand. Removing the vendoring entirely is deleting `vendor/`, the scripts, the vendor branch and the workspace entries.

## Open Questions

- Whether rung two ships as a `ChatView` mount or as the read-model fallback. Answered by the spike, does not change the specs.
