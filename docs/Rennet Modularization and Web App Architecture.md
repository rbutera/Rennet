---
tags: [rennet, architecture, proposals]
categories: [reference]
status: proposal
created: 2026-08-08
updated: 2026-08-08
related: ["[[Rennet Contracts and Rulings]]", "[[Rennet Architecture Contracts]]", "[[Rennet Dependency Standard]]", "[[Rennet Product and Vision]]", "[[Rennet Doc Architecture]]"]
source: architecture pass by a Navi Tatl (bead workspace-2qlsj), for Rai's review
---

# Rennet Modularization and Web App Architecture

**PROPOSAL — 2026-08-08, for Rai's review. Nothing here is ratified; the forks in §5 are explicitly his call.** Written against `main` at `a13cf82`. If adopted, reconcile the decisions into [[Rennet Contracts and Rulings]] as rulings and update [[Rennet Doc Architecture]]'s map; until then this document has no authority over any existing register.

The ask (Rai, Discord 2026-08-08): modularize so the desktop Electron app **and** a locally-served web app can both be developed, the web app being a way to "keep an eye on the project"; plus any other monorepo / code-quality / agent-experience / developer-experience improvements.

---

## 1. The load-bearing finding: the seam already exists

This refactor is much smaller than it sounds, because the two hardest cuts were already made:

1. **The renderer is already transport-agnostic.** `RennetApp` takes a `bridge: RennetBridge` prop, and `RennetBridge` (defined in `@rennet/protocol`) is one method: `invoke<K extends CommandName>(name, input) → Promise<CommandOutput<K>>`, fully typed by the zod `commandDefinitions`. The Electron preload is eight lines: it implements `RennetBridge` over `ipcRenderer.invoke`. A web client is the same interface implemented over `fetch`. **`RennetBridge` is the platform-adapter boundary on the client side, and it is already named, typed, and enforced.**
2. **The command router is already extracted from Electron.** `createDispatch(deps: DispatchDeps)` in `apps/desktop/src/main/dispatch.ts` is pure routing over `ReviewService` + protocol parsing, with every Electron-side effect injected (`chooseRepository`, `startWatching`, the dirty flag, `settings`, `buildCanvases`). **`DispatchDeps` is the platform-adapter boundary on the host side.**
3. **`@rennet/ui` is already browser-safe by enforcement.** The layer rules (eslint `@nx/enforce-module-boundaries` + `scripts/check-boundaries.mjs` with its positive control) forbid `ui` from importing `core`/`adapters`/Node. The whole canvas model in `ui/src/canvas/` is pure logic over `types`/`protocol`.

What is *not* yet shared is the ~120 lines of **composition** in `apps/desktop/src/main/index.ts`: the lazily-memoized Claude harness, the Codex port + availability probe, the sqlite store, the settings store, `ReviewService`, and `buildCanvasesForReview` (the harness-backed pipeline wiring). That block is Node-only but not Electron-only — nothing in it touches `BrowserWindow`, `dialog`, or IPC. It is the kernel both hosts need, currently trapped inside the Electron shell.

So the work is: **name the kernel, move it, and add a second shell.** Not a rewrite. The event-sourced canvas model and the layer discipline stay exactly as they are.

## 2. Proposed shape

```
                 ┌────────────────────────── shared, platform-free ──────────────────────────┐
                 │  types ── protocol ── instructions ── core ── ui (browser-safe React)     │
                 └───────────────────────────────────────────────────────────────────────────┘
                        ▲                          ▲                      ▲
                        │ Node side                │                      │ client side
                 ┌──────┴───────┐          ┌───────┴────────┐      RennetBridge (protocol)
                 │   adapters   │          │    runtime     │        implementations:
                 │ (Node ports) │◄─────────│  NEW: kernel + │      • IpcBridge  (preload)
                 └──────────────┘          │  createDispatch│      • HttpBridge (web)
                                           └───┬────────┬───┘
                                               │        │
                              ┌────────────────┴─┐    ┌─┴──────────────────┐
                              │  apps/desktop    │    │  local HTTP server │
                              │  Electron shell: │    │  shell: POST /rpc, │
                              │  window, dialog, │    │  GET /events, and  │
                              │  IPC, app://     │    │  serves apps/web   │
                              └──────────────────┘    └────────────────────┘
                                                               ▲
                                                      ┌────────┴────────┐
                                                      │    apps/web     │
                                                      │  monitor UI on  │
                                                      │  @rennet/ui via │
                                                      │  HttpBridge     │
                                                      └─────────────────┘
```

### 2.1 The one new package: `@rennet/runtime`

`packages/runtime` — the **host kernel**. Node-only, no Electron. Tag `layer:runtime`; may depend on `types`, `protocol`, `instructions`, `core`, `adapters` (top of the Node stack, below the app shells).

It absorbs, verbatim, from `apps/desktop/src/main/`:

- the lazy memoized composition: `getClaudeHarness()`, `getCodexPort()`, `getCodexAvailability()`;
- `buildCanvasesForReview()` (including the documented §7 deviation comment — it moves with the code);
- `dispatch.ts` (`createDispatch` + `DispatchDeps`) and its tests;
- store/settings/service construction, behind one factory.

The new named interface:

```ts
export interface RennetRuntimeOptions {
  /** Where rennet.sqlite + settings.json live (Electron userData, or a server data dir). */
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** The pieces that genuinely differ per host — the platform port. */
  readonly platform: RuntimePlatform;
}

export interface RuntimePlatform {
  /** Resolve a repository to review. Electron: the directory dialog. Server: explicit path or "unsupported". */
  chooseRepository(): Promise<string | null>;
}

export function createRennetRuntime(options: RennetRuntimeOptions): {
  dispatch: (name: CommandName, input: unknown) => Promise<unknown>;
  close(): void; // watcher + sqlite teardown
};
```

`DispatchDeps` stays as-is internally; `RuntimePlatform` is the *subset* a host must actually supply (today, only the repository picker — everything else in `DispatchDeps` is kernel-owned: watcher, dirty flag, settings, canvas builder). The desktop main shrinks to: Electron boilerplate + `createRennetRuntime` + the IPC handler forwarding to `runtime.dispatch`. Its behavior does not change; its tests move to `runtime` and keep passing.

**Why a package and not "copy the wiring into the server":** the composition root maintains real invariants (the Codex `installed`-iff-port-passed invariant, lazy discovery so login-shell spawn happens on first use, settings resolution from the persisted store). Two hand-maintained copies of that block is exactly the class of drift the boundary system exists to prevent.

### 2.2 The transports

- **Desktop keeps IPC.** It is built and tested; nothing about the web app requires touching it.
- **The web transport is one endpoint mirroring the IPC envelope:** `POST /rpc` with body `{ name, input }`, response = the parsed command output. `HttpBridge` implements `RennetBridge` over `fetch` in ~15 lines and lives in `apps/web/src/` initially (extract to a package only when a second consumer appears — no speculative packages).
- **No framework.** Given the [[Rennet Dependency Standard]] posture (7-day release floor, strict peers, licence gate), the server should be `node:http` + a hand-rolled route for `/rpc`, `/events`, and static files for the built web app. It is genuinely one screen of code; a framework buys nothing here and costs a dependency review. (If Rai prefers a framework anyway, Hono is the one to evaluate — but the recommendation is stdlib.)

### 2.3 Live updates ("keep an eye on")

MVP: the web monitor reuses the exact polling the desktop renderer already does (`review.checkFreshness` on a `setInterval` — `ui/app.tsx:266`). Zero new machinery; the shared `RennetApp`/monitor component works unchanged over `HttpBridge`.

Post-MVP: add `GET /events` (SSE) fed by the change signals that already exist in core (`canvas-change-feed`, `context-update-stream`) and the `RepoWatcher` dirty flag. **Keep `RennetBridge` request/response** — push is an additive second channel (`RennetEvents`: `subscribe(listener): unsubscribe`), not a change to the bridge contract, so the desktop renderer can adopt the same channel later over IPC without a protocol fork. SSE over WebSocket because the flow is strictly server→client and SSE needs no dependency and auto-reconnects.

### 2.4 The local server binds loopback

The listener binds `127.0.0.1`, never `0.0.0.0` — a local tool serves the local machine. The web shell then gets the same command surface the desktop shell has, through the same `runtime.dispatch`.

### 2.5 Boundary rules after the change

`scripts/check-boundaries.mjs` map gains one row; eslint tags gain one layer and one platform:

| Project | Tags | May depend on (layers) |
|---|---|---|
| `packages/runtime` (new) | `layer:runtime` | types, protocol, instructions, core, adapters |
| `apps/desktop` | `layer:app`, `platform:desktop` | + runtime |
| `apps/web` (new) | `layer:app`, `platform:web` | **types, protocol, ui only** (browser rule — never core/adapters/runtime) |

The positive control in `check-boundaries.mjs` should gain a second control for the new browser rule (a fabricated `apps/web` import of `@rennet/runtime` must fail), so the new arrow is born with a check that can go red.

## 3. Web app scope — what "monitor" means concretely

The first slice is a monitor page because it is the smallest thing that answers the stated want ("keep an eye on the project"), not because the browser is held back from acting. Built from existing `@rennet/ui` exports (no new canvas logic): the active review + patchset summary, freshness/dirty state, the disposition batch and staging state (`batchViewModel`, `stagedItems`), coverage (`CoverageMosaicView`), the publish/degradation ledger (`bucketLedgerEntries`), and the last-built canvases if present. A small `MonitorApp` entry in `ui` (a composition of existing components) rather than reusing `RennetApp` with flags scattered through it; the components underneath are shared either way, so growing the page toward full parity is adding components, not unlocking a posture.

## 4. Migration path (each step lands green on `main`, in order)

1. **Extract `@rennet/runtime`.** Move dispatch + composition out of `apps/desktop/src/main/`; desktop main becomes a shell. Pure move — no behavior change, tests move with it. This step alone pays for itself even if the web app never ships (main-process logic becomes unit-testable without Electron).
2. **Boundary bookkeeping.** New tags, `check-boundaries.mjs` rows, the new positive control.
3. **The server shell** inside `packages/runtime` or a thin `apps/server`: `/rpc` and static serving on loopback. (Whether it is embedded or standalone is fork F2 — the code is the same either way; only who starts it differs.)
4. **`apps/web`**: vite React app, `HttpBridge`, `MonitorApp`. Playwright e2e against it (cheap, no Electron).
5. **Post-MVP**: SSE events channel; then the rest of the surface (fork F1).

Steps 1–2 are safe refactors with existing coverage; 3–4 are additive. Nothing here blocks or conflicts with the in-flight destination-wave issues (#21/#22 publish path) — the publish pipeline lives in core/adapters and is untouched.

## 5. The forks — Rai's decisions, not mine

**F1 — Web scope: monitor first, or full parity?**
- *Monitor-first (recommended):* ships in days once the kernel is extracted and matches the stated want ("keep an eye on"). Parity is then incremental — more components over the same bridge.
- *Full parity now:* one client codebase to rule them all, and desktop could eventually become "web app in an Electron frame". Costs more up front (the repository picker and harness runs need browser-side UX) for a capability nobody has asked for yet.
- **Recommendation: monitor-first**, on schedule grounds only. The transport-typed bridge makes parity a later addition, not a rebuild.

**F2 — Who runs the server: embedded in the desktop app, or a standalone process?**
- *Embedded (recommended for MVP):* Electron main starts the HTTP listener alongside IPC, both forwarding into the **same** `runtime.dispatch`. One process owns `rennet.sqlite` (no cross-process sqlite locking question) and one settings store. Monitor is live whenever the desktop app runs — and the data only changes while it runs anyway.
- *Standalone server:* monitoring without the desktop app open, and the long-term "local-first server, desktop is just a client" shape. But two processes on one `node:sqlite` DB needs WAL-mode care today, and it duplicates harness/runtime state for no MVP gain.
- **Recommendation: embedded now.** The kernel extraction (step 1) is precisely what makes flipping to standalone later a shell swap rather than a refactor, so nothing is foreclosed.

## 6. Monorepo / quality / agent-DX / dev-DX improvements (prioritized)

Effort: **S** ≤ half a day · **M** ≈ a day · **L** = multi-day.

| # | Problem | Proposed fix | Effort |
|---|---|---|---|
| 1 | **No CI exists.** `.github/workflows/` is absent; `pnpm check` runs only on agents' machines, so "keep `main` releasable" is enforced purely by discipline, and a skipped local gate is invisible. | GitHub Actions on PR + `main`: pnpm install (cached), `pnpm check`; `nx affected` on PRs, full `run-many` on `main`. No Nx Cloud (the privacy stance in AGENTS.md stands) — local cache per runner is fine. Add `package-smoke` on `main` only, macOS runner. | **M** |
| 2 | **The composition kernel is trapped in the Electron main** (duplication-in-waiting for any second host; main-process wiring untestable without Electron). | §2.1 / migration step 1 — extract `@rennet/runtime`. Dual-purpose: it is also the first web-app step. | **M** |
| 3 | **Worktree/daemon teardown is prose, not a command.** The mandatory post-merge ritual in AGENTS.md (nx reset → cd out → worktree remove) failed often enough to produce the ~7.8 GB swap incident; every agent re-derives it. | `scripts/worktree-done.mjs` (+ root script `pnpm worktree:done <path>`): runs `nx reset` in the worktree, removes it from the main checkout, then **verifies** no `nx` daemon process remains rooted there (the check that can go red). Also `pnpm worktrees:audit` listing worktrees + live daemons for the orchestrator. Consider `NX_DAEMON=false` in agent worktree env: short-lived single-run workspaces mostly pay the daemon's cost without its benefit — measure one build both ways before deciding. | **S** |
| 4 | **`build` and `typecheck` are the identical `tsc -p` command** on every package (noEmit; source-exports workspace), so the full gate type-checks everything twice under two target names, and the toolchain is quietly unusual (`typescript` aliased to `@typescript/typescript6@6.0.2`, `@typescript/native` = tsgo 7 also present) — the exact terrain of past tsgo-vs-tsc confusion. | Make package `build` a no-op alias or drop it from packages (keep `typecheck`; keep real `build` only where artifacts exist: desktop). Add a short `docs/` toolchain note: which compiler is authoritative for the gate, what the alias is for, when tsgo may be consulted (editor speed) and when it may not (the gate). | **S** |
| 5 | **Vitest runs configless** (`vitest run <path>` per project; environment via per-file `happy-dom` pragma). It works, but there is no single place declaring test conventions, no coverage wiring despite `@vitest/coverage-v8` being installed, and root-level `vitest` runs nothing intentionally. | Add a root vitest workspace config (projects per package) preserving the node-default + per-file-pragma discipline (it is good — keep it), wire `--coverage` as an opt-in target, and state the pragma convention in the config comment so it stops living only in `ui/src/test/dom.ts` lore. | **S** |
| 6 | **Agent environment traps are documented but not executable** (RTK garbling → `sh -c` wrapping, `-i` aliases, `noclobber`, zsh `$pipestatus` — all prose in AGENTS.md that each agent must remember under pressure). | `scripts/preflight.mjs` (`pnpm preflight`): asserts node/pnpm versions, warns on stale worktrees/daemons, prints the five environment traps in ten lines. Cheap insurance that runs at the top of every agent brief instead of hoping the prose was read. | **S** |
| 7 | **UI verification requires driving Electron** (Playwright-against-Electron e2e is the heaviest loop in the repo; screenshot-verification of UI slices is correspondingly expensive for agents). | Falls out of the web app: once `apps/web` serves the shared components over HTTP, agents verify UI slices with plain browser Playwright against a vite dev server — no Electron launch, no packaged app. Worth naming as an explicit benefit when weighing F1/F2. | free with §2 |

**Deliberately not proposed:** splitting `ui` (its internal canvas/-components/ split is healthy); adopting an HTTP framework (§2.2); Nx Cloud/remote cache (privacy stance stands); any change to the event-sourced canvas model or the protocol envelope — those are the good bones this proposal builds on.

---

*Written 2026-08-08 by a Navi research Tatl against `main` @ `a13cf82`, read-only pass (bead workspace-2qlsj). Uncommitted on purpose: Rai reviews first. If adopted: F1/F2 become rulings in [[Rennet Contracts and Rulings]], the §2.5 rows land in `scripts/check-boundaries.mjs` + eslint tags, and this document gets added to [[Rennet Doc Architecture]]'s map as a deep spec (or archived as historical if declined).*
