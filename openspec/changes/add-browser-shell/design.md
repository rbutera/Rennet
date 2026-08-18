# Design — add-browser-shell (#381)

## Context

Recon facts (verified on main post-phase-3; phase 4 adds tokens/projection — re-verify seams):

- `packages/ui` has NO bundle target (tsc type-check only); the only ui bundling is the desktop renderer vite build (`vite.renderer.config.ts`: base "./", root src/renderer, react plugin, outDir dist/renderer, target chrome142). Renderer `index.html` CSP line 7 includes `connect-src 'self' ws://127.0.0.1:*`.
- Renderer composition (renderer/index.tsx): preload `{platform, wsPort, updateMenu, onMenuRun, chooseDirectory}`; `new WsRennetBridge({url: ws://127.0.0.1:${wsPort}})`; invoke wrapper intercepts `repository.choose` → `chooseDirectory()`; final bridge merges WS methods + preload residue; `<RennetApp bridge={bridge}/>`.
- `RennetApp` takes only `{bridge}`. ui uses `bridge.updateMenu?/onMenuRun?` optional-chained (app.tsx:2296,2302 — silent no-op absent); mac chord detection via navigator (command/commands.ts:352-360), NOT bridge.platform. ui has zero Electron/window.rennet references; CSS is fully self-contained (system font stacks, no url()/@font-face) — a standalone build needs no asset pipeline.
- Daemon HTTP handler (ws-listener.ts:93-108): /healthz JSON else 404; WSS shares the port. Static routes slot before the 404. The desktop app-protocol handler (main/index.ts:93-104) has the path-traversal guard to port (resolve + startsWith(root+sep) else 404, /→index.html).
- ui deps: react 19.2.8, react-dom, react-error-boundary, zustand, protocol, types — all browser-safe.
- wsPort flows main → `additionalArguments: [--rennet-ws-port=N]` → preload argv parse → renderer. Host is hardcoded loopback in renderer today.
- localStorage precedent in ui: nav history (app.tsx:398-412, optional-chained `globalThis.localStorage?`).
- Command catalogues are TWO non-1:1 things: wire `commandDefinitions` (protocol:1868, enumeration precedent index.test.ts:190) vs ui `COMMAND_CATALOGUE` (commands.ts:115+, palette/menu titles+chords). Parity axis = wire.
- open-in-editor: daemon discovers editor CLIs itself (create-server.ts:224-268, PATH+login-shell), spawns `<cli> -g file:line` on the DAEMON host; `openPath` OS-open fallback is a no-op in the daemon; absent handler → `{ok:false}` (dispatch.ts:1534-1540).
- Playwright: single config, no projects array, Electron-launch specs; `@playwright/test 1.62.0` root devDep (chromium available).
- Marketing: Astro, single landing `apps/marketing/src/pages/index.astro`.
- Phase 4 (assume merged): hello.deviceToken, connection classes (loopback=private; non-loopback token=projected), pairing commands, `daemon.listen` config, bridge takes deviceToken + exposes serverInfo.

## Goals / Non-Goals

**Goals:**

- A browser tab is a peer: full private contract on loopback, full-capability projection remotely. No read-only mode, no feature that exists only in the "real" app.
- One connections surface, shared by both shells, owning "which daemon am I attached to" — visible, switchable, persistent.
- Zero ui forks: the browser shell is a composition file, not a second UI.

**Non-Goals:**

- No client-runtime package extraction (phase 6's first step; two compositions sharing ~40 lines don't justify it yet).
- No server-side directory browser; the browser shell's repository.choose is a path prompt this phase.
- No TLS (Tailscale carries transport crypto). No service worker/offline. No mobile viewport work (#382/#383 own mobile).

## Decisions

**D1 — Browser shell lives in `apps/desktop/src/browser/`** (`index.html` + `entry.tsx`), built by `vite.browser.config.ts` → `dist/browser/`, added to the desktop build chain + `verify-desktop-main-chunks`-equivalent not needed (pure browser bundle). Rationale: same app second shell — reuses vite/react versions, ships in the same packaged artifact, adds no workspace package or architecture edges. The entry's own CSP meta mirrors the renderer's with `connect-src 'self' ws: wss:`.

**D2 — Static serving: `uiDist` option on the listener/daemon.** Handler order: /healthz → static (GET/HEAD only, resolve against uiDist root, traversal guard ported from the app-protocol handler, `/`→index.html, content-type map for html/js/css/map/svg/json, no caching headers beyond `no-cache` on index.html) → 404. `rennet serve` resolves uiDist by convention: `dirname(serverBundle)/../browser` (packaged + dev both produce dist/server + dist/browser siblings); `--ui-dist` overrides; absent dir = daemon runs headless (serving is a capability, not a requirement). Desktop-spawned daemons get the same resolution — a loopback tab works against the app's own daemon too.

**D3 — `ConnectionHost` in `packages/ui`**: props `{ createBridge(target: ConnectionTarget): RennetBridge & {close?}, defaultTarget, storageKey? }`. Renders the picker chrome (compact indicator + switcher; localhost default first, saved remotes below, "add daemon" flow: host[:port] + pairing-code entry that drives the phase-4 `pairing.exchange` through a temporary bridge and stores the device token), persists `{daemons: [{id, label, host, port, deviceToken}]}` in localStorage (nav-history pattern; optional-chained so SSR/tests no-op), and mounts `<RennetApp key={activeId} bridge={activeBridge}/>` — a switch is a clean remount, no mid-session bridge mutation. ui stays transport-agnostic: the bridge FACTORY is injected by the shell; ui never imports `@rennet/client`.

**D4 — Both shells mount ConnectionHost.** Renderer: `createBridge` builds a `WsRennetBridge` for the target (local target = the preload wsPort + loopback + repository.choose→chooseDirectory wrapper; remote target = host/port/token, no chooseDirectory — remote path entry falls back to D5's prompt) and merges preload residue (menu members only on the LOCAL target — menus drive the attached daemon's commands; on a remote attach the menu still operates the UI, which now points at the remote, so residue stays harmless either way). Browser entry: `createBridge` from `location.host` (default target = serving origin) or saved remotes. Desktop's local daemon spawn/supervision is untouched — remote attach is purely a renderer-level bridge choice.

**D5 — Browser repository.choose = prompt for an absolute path on the daemon's machine** (window.prompt, labeled honestly), wired in the browser entry's invoke wrapper exactly like the renderer's chooseDirectory wrapper. Parity holds (the command works everywhere); UX polish is future work, stated in docs.

**D6 — Parity inventory test** (packages/server, beside the listener contract tests): `Object.keys(commandDefinitions)` — for each command, assert the WS request path accepts it (dispatch stub records the name; the point is no transport/allowlist filter drops a command), PLUS assert the browser-shell intercept allowlist is exactly `["repository.choose"]` with its justification string — a new interception without a justification fails the test. (Transport-level parity is the truthful axis: both shells share `WsRennetBridge`; a per-command UI-driving test would test the ui, which is shell-independent.)

**D7 — Playwright grows a `browser` project** (chromium, `testDir` shared): new spec `browser-review.spec.ts` — start daemon via the CLI with an isolated dataDir + a fixture repo (reuse harness env conventions: RENNET_TEST_REPO, model-free env), navigate to `http://127.0.0.1:<port>/`, drive the local-review happy path with the same role-based selectors the Electron spec uses. Electron specs/harness untouched; teardown stops the daemon (phase-3 pattern).

**D8 — Packaging**: `dist/browser/**` joins the asarUnpack list (the daemon serves real files); package-smoke extends: GET `/` on the spawned daemon returns the index page.

**D9 — Marketing/docs land with the feature** (same change): `browser-rennet.md` guide (sidebar-registered), architecture-overview two-shells mermaid, marketing index section. The marketing story states loopback-tab + Tailscale-remote honestly (no hosted anything).

## Risks / Trade-offs

- **Risk: CSP widening (`ws: wss:`) in the desktop renderer** loosens the connect surface to arbitrary hosts. That IS the feature (attach to any daemon you name); the socket still authenticates via device token for non-loopback daemons. Not a gate question.
- **Risk: remount-on-switch drops in-memory UI state** (open panels, drafts). Accepted: switching daemons is switching worlds; persisted state (reviews, threads) lives daemon-side by design. Honest and simple beats a multiplexed bridge.
- **Trade-off: path-prompt repository.choose in the browser** is clunky for remote daemons (typing a server-side path). Accepted this phase; the projection's repo references make most flows never need a raw path (choose-repository is first-contact only).
- **Trade-off: open-in-editor on a remote daemon opens on the daemon's machine.** Correct per locus-keying; documented so nobody files it as a bug.
