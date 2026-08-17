# Protocol session layer: handshake, envelope, versioning (#376)

## Why

The app server wave (issues #376–#383, plan at `docs/src/content/docs/developing/reference/app-server-plan.md`) turns Rennet's Electron composition root into a daemon that desktop, browser, CLI, and mobile clients all speak to. Today the protocol is a compile-time contract: `commandDefinitions` (49 commands, Zod input/output) and the `RennetBridge` interface, both in `packages/protocol/src/index.ts`, crossed only by Electron IPC inside one process built from one commit. There is no version field anywhere on the wire, no way for a client to learn what a server supports, and no serialized error shape — dispatch throws `Error` and IPC happens to carry it.

The moment the daemon and a client can be built from different commits (phase 2 onward), that compile-time contract silently becomes a wire contract with no compatibility story. Phase 0 writes the compatibility story down **before** any transport exists, so every later phase inherits it instead of retrofitting it:

- **Paseo's two-contract discipline** (append-only wire schemas + feature flags) is the single most valuable idea in the research digest; adopting it now costs a few schemas and a docs page, and buys independent client/daemon shipping forever.
- **Orca's `PROTOCOL_VERSION` + min-compat window** treats mixed versions as the normal state, enforced by a version-window check rather than lockstep upgrades.
- **codex-app-server's `initialize`/`clientInfo`** gives the server per-connection knowledge of who is talking.

## What Changes

Pure `packages/protocol` additions plus one docs page. **No runtime behavior changes anywhere** — no transport, no dispatch changes, no Electron changes. Nothing existing changes shape.

- **Handshake schemas**: `helloFrame` (client → server: `clientId`, `clientType`, `protocolVersion`) and `serverInfoFrame` (server → client: `version`, `protocolVersion`, `minCompatibleProtocolVersion`, `features` record). A `checkProtocolCompatibility` helper implements the version-window rule.
- **Envelope schemas**: `requestFrame` (correlates by `requestId`, carries `command` + `input`), `responseFrame` (result), `rpcErrorFrame` (typed error: `code`, `message`, optional `details`), and typed server-push `eventFrame`s for the two existing push channels — progress keyed by `commandId` (payload: the existing `ProjectProcessEvent`) and ask-stream keyed by `reviewId` (payload: the existing `ReviewAskStreamEvent`). The existing types are reused, never forked.
- **Version constants**: `PROTOCOL_VERSION = 1` and `MIN_COMPATIBLE_PROTOCOL_VERSION = 1`, exported.
- **Tolerant decoding**: every inbound frame schema strips unknown fields by construction (Zod's default object behavior — the schemas deliberately do NOT use `.strict()`), so a newer peer adding an optional field never breaks an older decoder. A test pins this.
- **Docs page** `developing/reference/protocol-compatibility.md`: the versioning discipline as law — append-only wire schemas (new fields optional, never narrow, never remove, never make required), one integer version with an explicit min-compat window, features gated once on `serverInfo.features.*` (no fallback paths, no degraded modes), compat shims tagged `COMPAT(name)` with a removal date, tolerant decoders on inbound frames. Linked from the app server plan page.

**Explicitly out of scope** (later phases, listed so nobody folds them in):

- Any transport (WebSocket, HTTP) — phase 2 (#378).
- Any change to `dispatch.ts`, the Electron IPC path, or `RennetBridge` implementations — phases 1–2.
- The R19 path-scrubbed projection and device tokens — phase 4 (#380).
- Per-connection notification opt-out (codex has it; adopt via a feature flag when a client needs it).

## Capabilities

### New Capabilities

- `protocol-session`: the transport-neutral session layer — handshake frames, request/response/error envelope, typed server-push event frames, protocol version constants with a min-compat window check, unknown-field tolerance on inbound frames, and the written versioning discipline.

### Modified Capabilities

<!-- None. commandDefinitions, RennetBridge, ProjectProcessEvent, ReviewAskStreamEvent are
     referenced and reused, not modified. -->

## Impact

- **`packages/protocol`** — new schemas + constants + helper, same hand-written Zod style as `commandDefinitions`; new unit tests (envelope round-trip, unknown-field tolerance, version-window helper). One new source file is acceptable if `index.ts` (2,739 lines) would become unwieldy; re-export everything from the package root either way.
- **`docs/`** — new page `developing/reference/protocol-compatibility.md`, registered in `docs/astro.config.mjs` sidebar (Reference section — Starlight fails the build on unregistered pages), linked from `app-server-plan.md`.
- **Everything else** — untouched. `pnpm check` must be green with zero changes outside `packages/protocol` and `docs/`.
