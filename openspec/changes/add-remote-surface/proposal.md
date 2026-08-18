# Remote surface: R19 projection, pairing, Tailscale-first (#380)

## Why

Phases 0-3 made the daemon real; every client still has to sit on the same machine. This phase implements **R19** — "Public protocol is transport-neutral and JSON-Schema-first; private commands and events are Zod-first. Remote clients receive recipient-specific projections, never raw host paths or event envelopes" — and closes the contracts' standing open item ("the product shape and transport work for a future remote/mobile client"). It is the one genuinely NEW subsystem in the wave.

**Full-fat reconciliation (Rai's requirement):** the projection shapes *representation* — host-absolute paths become repo-scoped references, event envelopes become recipient-specific frames — it never removes capability. Every command available on loopback is available to a paired remote client.

## What Changes

### 1. The R19 projection (the core)

- **Path codec, both directions.** Recon mapped the complete host-path surface (proposal companion: design.md Context). Outbound: every structural host-absolute field (`repositoryProvenance.root/commonDir`, `review.repositoryRoot`, `project.path/openPath/includedRepoPaths`, `discoveredRepo.path`, `processedRepoSummary.path`, `repository.choose` output, …) is projected to `{repoKey, displayName}` references or repo-relative form for token-bearing connections. Inbound: commands whose inputs carry `repoPath`/`path` host paths (`review.capture`, `review.openPr`, `settings.*`, `project.discover`, …) accept the projected reference from remote connections; the listener resolves it back to the host path via the project store before dispatch. Loopback connections keep the private contract byte-for-byte.
- **Free-text honesty:** narration `note`/`detail` and any string field pass through a root-substitution scrub (known repo roots + home dir → display tokens). Model-authored text (ask-stream deltas) is the model's; the docs say so plainly rather than pretending to sanitize prose (R31/R32 honesty).
- **JSON-Schema-first:** the public projection's schemas are generated from the private Zod contract with `z.toJSONSchema` (zod 4.4.3, already used in `bodies.ts`), **checked in as fixtures** under `packages/protocol/public-schema/`, with a drift test that fails on any silent change (codex-app-server's codegen discipline). The public sub-export lives in `packages/protocol` (browser-safe types + schemas); the scrub/resolve runtime lives in `packages/server` (it needs the project store).

### 2. Device pairing (connection bootstrap, not ceremony)

- `pairing.mint` (private-contract command, invoked from desktop Settings or `rennet pair`): returns a one-time code + expiry; desktop shows it as QR + text.
- A token-less connection on a non-loopback bind may do exactly one thing: exchange a valid code (`pairing.exchange {code, deviceName}`) for a long-lived device token (T3's shape; 30-day sliding default). Tokens stored hashed (SHA-256) in `~/.rennet/devices.json`; `hello` gains an optional `deviceToken` field (append-only). A paired device just works — no per-action ceremony, ever (Rule Zero).
- Loopback connections need no token, full stop (Rai-ratified: no auth ceremony on loopback).
- `rennet devices` lists paired devices; `rennet pair` mints from the terminal. Revocation = delete the row (CLI + settings list).

### 3. Opt-in bind beyond loopback

- Global config gains `daemon.listen` (append-only key in `~/.rennet/config.json`): host (default stays `127.0.0.1`), optional fixed port. The listener binds accordingly; `daemon.json` reflects it.
- Host-header allowlist against DNS rebinding on the HTTP side (Paseo does this; cheap and honest).
- **Tailscale is the documented remote path** — zero Rennet infrastructure, zero open ports, WireGuard encryption. Docs walk through binding to the tailnet address.
- **No relay** (Rai-ratified out of scope). Architecturally a relay is one more way a daemon meets a client; deferral costs nothing.

### 4. Server-initiated request frames — wire support only (scoped deviation from the issue)

The issue expected the publish action and Agent-SDK `canUseTool` to become server→client requests. Recon shows **neither has a live need today**: publish consent is already client-driven (`publish.requestConsent` → authorization → `publish.review`, works identically over any connection), and `canUseTool` is a deterministic in-process predicate (orchestrator allows exactly the canvas-ops MCP; harness runs use `bypassPermissions`; codex auto-grants). Inventing a consumer would be scaffolding. **Scope here:** add the three session frames (`serverRequest`, `serverResponse`, `serverRequestResolved`) to the protocol with tests and a listener-side `askConnection()` helper + resolved-cleanup, gated on `serverInfo.features.serverRequests` — the wire contract the mobile phase's turn-asks will consume. First real consumer arrives with the client that needs it (#382/#383 name it). Flagged for Rai in the PR; the retrofit cost if he wants a consumer now is one dispatch-side call.

### 5. Proof

- Cross-version + remote e2e (node-level, not Playwright): daemon bound beyond loopback → pair → token-bearing client drives a real review flow end to end → a frame sweep asserts no host-absolute path (home dir / repo root prefixes) crosses the boundary. **Positive control:** a deliberately-leaked path makes the sweep fail (calibrated test, per repo discipline).

### 6. Docs (same change)

- New `using/guide/remote-access.md`: pairing, Tailscale setup, what a remote client sees (projection), revocation.
- `contracts-and-rulings.md` + `architecture-contracts.md`: R19 implemented; "still open" item closed.
- "No *hosted* backend" copy sweep finishes: `using/guide/getting-started.md`, `reviewing-a-github-pr.md`, `collation-and-signing.md`, `dependency-standard.md`.
- `protocol-compatibility.md`: the new frames + `features.serverRequests` flag documented.

## Capabilities

### New Capabilities

- `remote-surface`: the R19 public projection (path codec both directions, JSON-Schema fixtures + drift test, free-text root scrub), device pairing (mint/exchange/list/revoke, hashed token store, hello bearer), opt-in non-loopback bind with host allowlist, the server-request wire frames behind a feature flag, and the leak-proof remote e2e with positive control.

### Modified Capabilities

- `ws-transport`: hello gains optional `deviceToken`; connection class (loopback-private vs token-projected) decided at handshake; serverInfo features gains `serverRequests`.
- `protocol-session`: three new frame types (append-only union extension).
- `detached-daemon`: `daemon.listen` config; `rennet pair` / `rennet devices` subcommands.

## Impact

- **`packages/protocol`** — public sub-export (projection types + generated JSON-Schema fixtures + drift test), new session frames, `hello.deviceToken`, `pairing.*` commands, `daemon.listen` config key.
- **`packages/server`** — projection codec + inbound resolver, pairing store + exchange path, listener bind config + host allowlist + connection classes, `askConnection` helper, CLI subcommands.
- **`packages/client`** — bridge captures `serverInfo` (version/features), sends `deviceToken`, exposes the server-request handler seam (no consumer yet).
- **`packages/ui`** — Settings gains a Pairing panel (mint + device list; one more `settings-panel` section). This is the phase's only UI surface.
- **`apps/desktop`** — passes through unchanged (renderer composition may hand the pairing panel its commands — verify; ui talks through the bridge as always).
- **QR**: smallest viable dependency for QR rendering per the Dependency Standard (candidate: a zero-dep qr encoder; exact pick recorded in design D8) — or text-code-only if the standard's test isn't met (state the call).
