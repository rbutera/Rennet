# Tasks — add-remote-surface (#380)

## 1. Protocol: frames + pairing commands + config key

- [x] 1.1 `hello` gains optional `deviceToken` (append-only; tolerant decoders make this safe).
- [x] 1.2 New session frames per design D7: `serverRequest` / `serverResponse` / `serverRequestResolved`; union extension; round-trip + tolerance tests extended.
- [x] 1.3 `pairing.mint`, `pairing.exchange`, `pairing.listDevices`, `pairing.revokeDevice` in `commandDefinitions` (Zod, same style).
- [x] 1.4 `globalConfigSchema` gains optional `daemon.listen {host, port?}`.
- [x] 1.5 Public projection types + repo-reference shape (`{repoKey, displayName, relativePath?}`) in a browser-safe protocol sub-export.

## 2. Server: projection codec

- [ ] 2.1 `packages/server/src/projection.ts` per design D2/D3: outbound `projectFrame` (structural table from the design Context list) + `scrubRoots` free-text substitution; inbound `resolveInputs` (repoKey → host path via project store; unresolvable → rpcError invalid_input).
- [ ] 2.2 The path-field table is generator-checked: a command/frame field typed as a host path that lacks a table entry fails a test loudly (allowlist maintained beside the table).
- [ ] 2.3 Unit tests: every listed outbound field projected (fixture review/patchset/project shapes); inbound resolution round-trip; free-text root substitution; unresolvable-ref error.

## 3. Server: pairing + connection classes + bind

- [ ] 3.1 Pairing store per design D5 (`~/.rennet/devices.json`, hashed tokens, sliding 30-day, atomic writes); mint codes in-memory (5-min TTL, single-use).
- [ ] 3.2 Listener: classify connections at hello (loopback→private, else token→projected, else pairing-only); the projected class routes all frames through the projection codec; `features` gains `serverRequests: true`.
- [ ] 3.3 Bind from `daemon.listen` config (default unchanged); host-header allowlist (403 pre-upgrade on mismatch) for non-loopback binds; `daemon.json` + `rennet status` reflect host+port.
- [ ] 3.4 `askConnection()` + resolved-cleanup per D7, with disconnect rejection; tests.
- [ ] 3.5 CLI: `rennet pair` (mint, print code + QR-as-ASCII or text), `rennet devices [--revoke <id>]`.

## 4. Client bridge

- [ ] 4.1 Capture serverInfo (version, features) and expose it; constructor accepts `deviceToken`; `onServerRequest(handler)` seam replying `serverResponse`; tests (token sent in hello; features exposed; serverRequest round-trip; resolved clears pending handler state).

## 5. Desktop settings pairing panel

- [ ] 5.1 `packages/ui` Settings gains a Pairing section: mint button → code (+ QR per design D8 — state the dependency call), paired-device list with revoke. Bridge commands only; DOM test alongside existing settings tests.

## 6. Remote e2e + positive control

- [ ] 6.1 Node-level contract test per design D10: non-loopback bind (env-permitting, else skip-with-message), pair, exchange, token-bearing client drives capture→canvases→disposition on a fixture repo, frame sweep for homedir + fixture-root absolutes.
- [ ] 6.2 Positive control: injected leak makes the sweep fail (prove red).
- [ ] 6.3 `NX_DAEMON=false pnpm check` green; Playwright e2e untouched, failure set per baseline.

## 7. Docs (same change)

- [ ] 7.1 New `using/guide/remote-access.md`: pairing walkthrough, Tailscale setup, what a remote client sees, revocation. Registered in the sidebar (Starlight fails on unregistered pages).
- [ ] 7.2 `contracts-and-rulings.md`: R19 marked implemented; "still open" remote item closed. `architecture-contracts.md` remote row updated.
- [ ] 7.3 "No *hosted* backend" copy sweep: `using/guide/getting-started.md`, `using/guide/reviewing-a-github-pr.md`, `developing/concepts/collation-and-signing.md`, `developing/reference/dependency-standard.md`.
- [ ] 7.4 `protocol-compatibility.md`: new frames + `features.serverRequests` + `hello.deviceToken` documented.
- [ ] 7.5 QR dependency (if added) recorded in the Dependency Standard.
