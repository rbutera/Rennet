# Design — add-protocol-session-layer (#376)

## Context

Load-bearing facts (verified against `main` @ e2462e2):

- `commandDefinitions` (`packages/protocol/src/index.ts:1867`) already IS a serializable RPC surface: 49 commands, each `{ input: ZodSchema, output: ZodSchema }`. `isCommandName` / `parseCommandInput` / `parseCommandOutput` helpers exist beside it.
- `RennetBridge` (`packages/protocol/src/index.ts:2675`) defines the full client contract: `invoke`, optional `onProgress(commandId, listener)` → `ProjectProcessEvent`, optional `onAskStream(reviewId, listener)` → `ReviewAskStreamEvent`, plus Electron-only menu methods (`updateMenu`/`onMenuRun`) that stay desktop-local and are NOT part of the wire session layer.
- Errors today are bare `throw new Error(message)` in `dispatch.ts`; there is no serialized error type on any channel.
- The protocol has no version field anywhere. This change introduces the first one.
- Repo Zod convention: hand-written schemas; required cross-IPC fields protected by `z.ZodType<T>` annotations (`objectSchemaFor<T>()` pattern); many wire schemas use `.strict()`.

## Goals / Non-Goals

**Goals:**

- A complete, transport-neutral session vocabulary: any future transport (WS in phase 2) serializes these frames and nothing else.
- Mixed client/daemon versions are the normal state: one integer version, explicit min-compat window, feature flags for anything beyond the window's guarantee.
- Discipline written as a docs page that later phases cite, not tribal knowledge.

**Non-Goals:**

- No transport, no server, no dispatch changes, no bridge implementation. Nothing executes these frames yet.
- No re-modeling of the 49 commands. The envelope wraps `commandDefinitions` as-is.
- No auth/pairing shapes (phase 4) — the handshake carries identity (`clientId`, `clientType`), not credentials.

## Decisions

**D1 — Frames are tolerant (non-strict) objects; this diverges from the repo's `.strict()` habit deliberately.** The wire schemas' whole job is to survive a newer peer. Zod's default object behavior (strip unknown keys) is the tolerant decoder the discipline requires. The docs page records this as the rule for wire frames specifically; `.strict()` remains right for intra-process shapes. *Alternative considered:* `.passthrough()` — rejected; stripping is safer than forwarding unvetted keys.

**D2 — One discriminated union `sessionFrame` over `type`.** Frame types: `"hello"`, `"serverInfo"`, `"request"`, `"response"`, `"rpcError"`, `"progressEvent"`, `"askStreamEvent"`. A single `parseSessionFrame(value)` entry point mirrors `parseCommandInput`'s style. The discriminant field is `type` (string literal), matching the discriminated-union-by-`kind` precedent in the progress events — `type` chosen over `kind` to avoid colliding with event payloads that already carry `kind`.

**D3 — `request.input` and `response.output` are `z.unknown()` in the envelope.** The envelope correlates and routes; `commandDefinitions[command].input/.output` remain the authority for payload validation, applied by whoever executes the command (today dispatch; later the daemon). Duplicating 49 payload schemas into the union would create a second authority. `request.command` is validated against `isCommandName` via `.refine`.

**D4 — Version window semantics (Orca's model):** a client and server are compatible iff `client.protocolVersion >= server.minCompatibleProtocolVersion && server.protocolVersion >= client's own min` — expressed as a symmetric helper `checkProtocolCompatibility(mine: {version, minCompatible}, theirs: {version, minCompatible})` returning a discriminated result (`{ compatible: true } | { compatible: false, reason }`), not a boolean, so callers can surface an honest message. Constants start at `PROTOCOL_VERSION = 1`, `MIN_COMPATIBLE_PROTOCOL_VERSION = 1`.

**D5 — `serverInfo.features` is `z.record(z.string(), z.boolean())`.** Feature keys are free strings documented on the docs page as they are added; gating a feature ONCE on `features.x` (no fallback path) is the discipline. No enum — an enum would make adding a feature a breaking schema change, defeating the point.

**D6 — Push events reuse existing payload types by reference.** `progressEvent` wraps `{ commandId, event: projectProcessEventSchema }`; `askStreamEvent` wraps `{ reviewId, event: reviewAskStreamEventSchema }`. The existing schemas are imported, never copied. If they are `.strict()` today they stay `.strict()` — tolerance applies to the frame wrapper; payload evolution is governed by the append-only rule like everything else.

**D7 — New source file `packages/protocol/src/session.ts`, re-exported from `index.ts`.** `index.ts` is 2,739 lines; the session layer is a coherent new unit with its own test file (`session.test.ts`). Everything remains importable from `@rennet/protocol` root — no deep imports.

**D8 — `rpcError` codes are a small closed set with an open escape hatch:** `z.enum(["invalid_input", "command_failed", "incompatible_protocol", "unknown_command"])` unioned with `z.string()` — the enum documents the known codes, the union keeps the field append-only. `message` is human-readable; optional `details: z.unknown()`.

## Risks / Trade-offs

- **Risk: the frames rot unexercised until phase 2.** Mitigation: the round-trip tests exercise serialize→parse for every frame type now; phase 2's transport consumes them unchanged or amends them append-only.
- **Trade-off: `z.unknown()` payloads (D3) mean the envelope alone cannot fully validate a frame.** Accepted: single-authority validation beats double validation that can disagree.
