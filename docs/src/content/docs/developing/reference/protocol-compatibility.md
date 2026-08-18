---
title: Protocol compatibility
description: The versioning discipline every Rennet wire change obeys — append-only schemas, one protocol version with a min-compat window, feature flags, tolerant decoders, and dated COMPAT shims.
---

Once the daemon and a client can be built from different commits, the protocol
stops being a compile-time contract and becomes a wire contract. This page is the
law for evolving that wire without a flag day: how frames may change, how a client
and daemon negotiate versions, and how a new capability ships without breaking an
old peer. It governs everything in the [`protocol-session`](#the-frame-vocabulary)
layer (`packages/protocol/src/session.ts`) and every wire schema added after it.

## The one rule

**Wire schemas evolve append-only.** A field may be *added* if it is optional. A
field may never be removed, never narrowed (no new `min`, no tighter enum, no
`string` → literal), and never promoted from optional to required. If a peer
built last month must still parse a frame this peer sends today, and vice versa,
the schema is correct. If it must not, the change is breaking and needs a new
protocol version instead.

This holds for the command payloads too. The envelope carries `command` inputs
and outputs from [`commandDefinitions`](/developing/reference/contracts-and-rulings/)
by reference — those schemas are the single authority for payload validation, and
they obey the same append-only rule.
Frame payloads (`request.input`, `response.output`, and `rpcError.details`) must
be JSON-representable, and the command schemas in `commandDefinitions` remain the
single validation authority for command inputs and outputs.

## One protocol version, with a window

There is one integer, `PROTOCOL_VERSION`, exported from `@rennet/protocol`. It
starts at `1`. Bump it only for a change the append-only rule cannot express — a
removed field, a changed meaning, a new required shape.

Alongside it, `MIN_COMPATIBLE_PROTOCOL_VERSION` names the oldest version this
build can still talk to. Two peers are compatible when each side's version is at
or above the other side's minimum. Mixed versions are the normal state, not an
error to design out — a phone on an old build and a freshly-updated daemon must
coexist.

The handshake divides that check according to the information each side has.
The server checks the `hello.protocolVersion` against its own
`MIN_COMPATIBLE_PROTOCOL_VERSION`; `hello` does not carry the client's minimum,
so that is all the server can and needs to check. After `serverInfo` supplies
both server version values, the client runs the full symmetric
`checkProtocolCompatibility` helper.

```ts
import { checkProtocolCompatibility, PROTOCOL_VERSION, MIN_COMPATIBLE_PROTOCOL_VERSION } from "@rennet/protocol";

const result = checkProtocolCompatibility(
  { version: PROTOCOL_VERSION, minCompatible: MIN_COMPATIBLE_PROTOCOL_VERSION },
  { version: serverInfo.protocolVersion, minCompatible: serverInfo.minCompatibleProtocolVersion },
);
if (!result.compatible) {
  // result.reason names which side is too old — surface it, don't guess.
}
```

The helper returns `{ compatible: true }` or `{ compatible: false, reason }`, not
a bare boolean, so the peer that refuses a connection can tell the user *why* and
which side needs to update.

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server
  C->>S: hello { clientId, clientType, protocolVersion }
  S->>S: Check client protocolVersion against server minimum
  S->>C: serverInfo { version, protocolVersion, minCompatibleProtocolVersion, features }
  C->>C: Run checkProtocolCompatibility with both version pairs
  C->>S: request { requestId, command, input }
  S-->>C: response { requestId, output }  ·or·  rpcError { requestId, code, message }
```

## New capabilities are gated on features, once

Anything beyond what the version window already guarantees ships behind a flag in
`serverInfo.features` — an open `Record<string, boolean>`, not an enum (an enum
would make adding a feature a breaking schema change, which is the whole thing we
are avoiding). A client checks `features.x` **once** at handshake and takes one
path. There is no fallback path, no degraded mode, no re-probing mid-session. A
feature the peer does not advertise is simply off. Document each key here as it is
added.

| Feature key | Advertised when | Meaning |
|---|---|---|
| `serverRequests` | always, on current daemons | The daemon can send `serverRequest` frames and understands `serverResponse` (see the [frame vocabulary](#the-frame-vocabulary)). A client that reads this flag as true may register an `onServerRequest` handler; one that does not never sees a server-initiated request. No product flow raises one yet — the flag reserves the capability so a future client negotiates it once, at handshake. |
| `attention` | when the daemon wires the attention system (issue #383 M1) | The daemon consumes client `presence` frames, delivers attention events presence-aware, and accepts `device.registerPush` / `attention.acknowledge`. A client that reads this flag as true transmits its `presence` frame (and re-sends it on every reconnect), registers a push token, and receives `attentionEvent` frames; one that does not (an M0-era daemon never advertises it) sends no presence, registers no token, and its presence seam stays a wire-silent no-op. Checked once at handshake, one path — the standard feature-gate. |

## Inbound decoders are tolerant

Every session frame schema is a default (non-strict) Zod object: it **strips
unknown fields** instead of rejecting them. That is what lets a newer peer add an
optional field without breaking an older decoder — the older decoder never sees
the field, and the frame still parses. This deliberately diverges from the
`.strict()` habit used for intra-process shapes elsewhere in `packages/protocol`;
`.strict()` stays right *there*, tolerance is the rule *on the wire*. A test in
`session.test.ts` pins this by proving a `.strict()` clone of each frame would
reject an unknown field the real schema accepts.

## COMPAT shims carry a removal date

When the window eventually moves and a shim is needed to keep an old peer working
— translating an old field, defaulting a new one — tag it in code with a
`COMPAT(name)` comment and a removal date:

```ts
// COMPAT(hello-no-clientType): clients before v2 omit clientType; default it.
// Remove after 2026-12-01, once MIN_COMPATIBLE_PROTOCOL_VERSION >= 2.
```

The tag makes shims greppable and the date makes them expire on purpose instead
of accreting forever.

## The frame vocabulary

The transport serializes these frames and nothing else. Each is one arm of
the `sessionFrame` discriminated union, keyed on `type`.

| Frame | Direction | Carries |
|---|---|---|
| `hello` | client → server | `clientId`, `clientType`, `protocolVersion`, optional `deviceToken` |
| `serverInfo` | server → client | `version`, `protocolVersion`, `minCompatibleProtocolVersion`, `features` |
| `request` | client → server | `requestId`, `command` (validated against the registry), `input` |
| `response` | server → client | `requestId`, `output` |
| `rpcError` | server → client | `requestId`, `code`, `message`, optional `details` |
| `progressEvent` | server → client | `commandId`, `event` (the existing `ProjectProcessEvent`) |
| `askStreamEvent` | server → client | `reviewId`, `event` (the existing `ReviewAskStreamEvent`) |
| `serverRequest` | server → client | `serverRequestId`, `kind`, `payload` |
| `serverResponse` | client → server | `serverRequestId`, `payload` |
| `serverRequestResolved` | server → client | `serverRequestId` |
| `presence` | client → server | `focused`, `visible`, `deviceClass`, optional `focusedReviewId` |
| `attentionEvent` | server → client | `event` (`raised`/`cleared`), optional `item`, optional `clearedIds` |

The last two frames are the attention layer (issue #383 M1), gated on the `attention`
feature above. `presence` is the client's focus/visibility beacon the delivery planner reads
to decide in-app-vs-push per client; a client sends it only to a daemon that advertised
`attention`, so an M0-era daemon never receives it. `attentionEvent` broadcasts an attention
raise (a `review-finished`, an `ask-pending`, …) or a clear to every authorized socket, so a
focused client gets the live in-app event (its push is suppressed) and, on acknowledgment,
every client's needs-you badge clears together. Both are additive arms of the `sessionFrame`
union — an older peer that never sends or handles them is unaffected. The two commands that
travel with the layer, `device.registerPush` (a paired device registers/replaces/clears its
push token) and `attention.acknowledge` (clear on view, propagated to all clients), are
ordinary additive `commandDefinitions` entries reachable only on a token-bearing connection
while `attention` is advertised.

`hello.deviceToken` is the append-only field a remote client presents to prove it
was paired; a loopback client omits it. It carries the raw device token, which the
daemon checks against its hashed device store. See
[remote access](/using/guide/remote-access/) for pairing.

The last three frames are the server-initiated request pair plus its cleanup
frame. Until now every exchange was client-driven; these let the server ask a
specific connection a question and await an answer:

- `serverRequest` opens the ask — `kind` names what is being asked, `payload`
  carries its data, and `serverRequestId` correlates the reply.
- `serverResponse` is the client's answer, echoing `serverRequestId`.
- `serverRequestResolved` tells the client the ask is settled (answered, timed
  out, or the turn ended) so it never leaves a stale prompt on screen.

They are additive: `serverRequest`/`serverResponse`/`serverRequestResolved` are
three new arms of the `sessionFrame` union, so an older peer that never sends or
handles them is unaffected. **There is no product consumer yet.** The wire
contract and the listener/bridge plumbing (an `askConnection` helper on the
server, an `onServerRequest` seam on the client) exist and are pinned by tests, so
the first client that needs a turn-time question — a mobile client, per the app
server plan — builds against a fixed contract instead of inventing one. A peer
that does not advertise the feature flag below never receives these frames.

`rpcError.code` is a small known set (`invalid_input`, `command_failed`,
`incompatible_protocol`, `unknown_command`) unioned with `string`, so the field
stays append-only: new codes are added by documenting them, never by breaking the
schema. The two push frames reuse their payload types by reference — they are
never forked or copied.

## Where this fits

Phase 0 of the [app server plan](/developing/reference/app-server-plan/) wrote
this discipline down before any transport existed, so every later phase inherited
it instead of retrofitting it. The WebSocket transport now serializes these
frames; every frame added since — including the server-request trio above — obeys
the append-only rule, so a daemon and a client built from different commits still
interoperate.
