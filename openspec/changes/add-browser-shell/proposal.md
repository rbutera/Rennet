# Browser Rennet: one UI, two shells, any daemon (#381)

## Why

Rai's directive (2026-08-17): "rennet supports desktop app or locally served browser client, both of which are full fat and full featured, both of which can speak to local app server or a remote one." Everything hard is already done: `packages/ui` is browser-only and bridge-shaped (recon: zero Electron references, `RennetApp` takes one `bridge` prop, menu members optional-chained no-ops when absent, mac detection via `navigator`), `WsRennetBridge` exists, the daemon owns an HTTP server, and phase 4 gives remote attach its tokens and projection. This phase is build/serve plumbing plus a connections surface — opencode's model: the server serves its own web UI.

## What Changes

- **Browser shell**: a `src/browser/` entry in `apps/desktop` (own `index.html` + `entry.tsx`) built by a new vite config to `dist/browser/`. Composition mirrors the renderer minus preload: bridge = `WsRennetBridge` at the serving origin (`ws(s)://location.host`, token from the connections store when remote), `platform` omitted (navigator covers chords), menu members absent (no-op by contract), `repository.choose` intercepted with a plain path prompt (a loopback browser tab is the same machine; honest, minimal — a server-side directory browser is future UX, not parity). Kept inside `apps/desktop` because it is the same app in a second shell: same vite conventions, same packaged artifact set, no new workspace package or gate edges.
- **The daemon serves it**: static handler on the existing `node:http` server (before the 404), serving a configured `uiDist` directory with the desktop app-protocol handler's path-traversal guard ported over, `/` → `index.html`, correct content types. `rennet serve` gains it by default (resolves `dist/browser` next to the server bundle — packaged: asarUnpacked sibling; dev: the built output). A loopback tab is a trusted client on the full private contract; a remote tab pairs per phase 4.
- **Connections surface** (shared, in `packages/ui`): a `ConnectionHost` component both shells mount — renders the server picker (localhost default, saved remote daemons: host + device token, pairing-code entry per phase 4 when adding one), persists the list client-side (localStorage, the nav-history pattern — a connection list is client-local knowledge), shows which daemon the window is attached to, and remounts `RennetApp` keyed on the active connection. **Desktop remote attach is exactly this same component**: the renderer swaps its bridge to a remote `WsRennetBridge` — no supervisor changes, the local daemon spawn stays the default. (The desktop CSP widens `connect-src` to `ws: wss:` to allow non-loopback sockets.)
- **Locus-keyed affordances**: `open-in-editor` already resolves on the server (editor CLIs discovered daemon-side; opens on the daemon's machine — correct for loopback, documented for remote; absent → `{ok:false}` not broken). No client-type gating anywhere.
- **Parity test (the honest inventory)**: enumerate `commandDefinitions` (the wire axis — the ui `COMMAND_CATALOGUE` is a different, non-1:1 catalogue) and assert every command is reachable through the browser shell's bridge path against a real listener; shell-intercepted commands (`repository.choose`) are an explicit allowlist whose justification is asserted, not skipped silently.
- **e2e**: a Playwright `browser` project (chromium ships with `@playwright/test`) + one new spec: daemon serves the ui, tab loads it, drives the local-review happy path. Existing Electron specs untouched.
- **Docs + marketing same-change**: new `using/guide/browser-rennet.md` (`rennet serve`, opening the client, the picker, remote attach); `architecture-overview.md` two-shells diagram; `apps/marketing` index gains the browser-client story (it ships now, so the story ships now).

**Explicitly out of scope**: native mobile (#383, gated on #382), a server-side directory browser, serving over TLS (Tailscale provides transport crypto), any client-runtime extraction (phase 6's first step, justified at the second *codebase* — the browser shell shares the renderer's composition pattern, not a new codebase).

## Capabilities

### New Capabilities

- `browser-shell`: the served browser client (build, static serving with traversal guard, browser composition), the shared connections surface (picker, saved daemons, pairing entry, active-daemon indicator, bridge remount), the wire-axis parity inventory, and the browser Playwright journey.

### Modified Capabilities

- `ws-transport` / `detached-daemon`: the daemon's HTTP server serves `uiDist`; `rennet serve` wires it by default; packaged app ships `dist/browser` unpacked beside the server bundle.
- `remote-surface`: the connections surface is the first consumer of phase-4 pairing (token entry + storage client-side).

## Impact

- **`apps/desktop`** — browser entry + vite config; renderer swaps its own composition to mount `ConnectionHost` (local daemon as default connection); CSP widening; forge asarUnpack extended to `dist/browser`; packaged smoke asserts the served page loads.
- **`packages/ui`** — `ConnectionHost` + picker components (bridge factory injected by the shell; ui stays transport-agnostic and imports no client package).
- **`packages/server`** — static handler + `uiDist` option + `rennet serve` default resolution; parity inventory test.
- **`packages/client`** — unchanged (already carries token + serverInfo from phase 4).
- **e2e** — new browser project + spec; Electron specs and harness untouched.
