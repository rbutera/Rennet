---
categories:
  - research
tags:
  - mobile
  - pairing
  - architecture
created: 2026-08-04
---

# Orca and Paseo Pairing

Research for [[Code Review Harness App]], on the open design question: how the desktop app and the mobile remote control find each other, prove identity, and stay connected. Rai's steer was "for pairing we can look at how Orca and Paseo do it as they do it well and just copy them." Both were found, both are in the coding-agent companion space, both are open source, and both solved the same problem in convergent ways. Paseo is the deeper study because we may lift code; Orca is the comparison case.

**Headline for the impatient:** the two products independently landed on the same cryptographic design (Curve25519 ECDH from a QR code, XSalsa20-Poly1305 for everything after, e2ee sitting above the transport so the relay is untrusted). That convergence is the strongest signal in this document. The design is correct and we should copy it. What differs is licence and relay posture, and that is where the decision actually lives.

---

## Verdict up front

| | [[Paseo]] | [[Orca]] |
|---|---|---|
| Licence (client/desktop) | **AGPL-3.0** | **MIT** |
| Licence (relay server) | **Apache-2.0** (separate repo) | Closed, vendor-only |
| Can we lift the code? | **No.** Patterns only. | **Yes**, with attribution |
| Self-hostable relay? | Yes, documented, first-class | No |
| Relay opt-in? | **Yes, off by default, prompts** | No toggle found; docs deny the relay exists |
| Account required? | **No** | Not for LAN; yes for relay |
| Crypto | Curve25519 + XSalsa20-Poly1305 | Curve25519 + XSalsa20-Poly1305 (same) |

The awkward result: **the code we would most want to lift is the code we cannot lift.** Paseo's transport layer is the cleaner and lighter of the two, and it is AGPL. Orca's is MIT and liftable, and it is bigger, more coupled, and drags in a vendor relay we cannot self-host.

Recommendation is a reimplementation of Paseo's design using Orca's licence-safe pieces where they help, detailed in the synthesis at the end. The reimplementation is genuinely small, roughly 400 to 600 lines, which is the reason this recommendation is not painful.

---

## Paseo

### What it is

Paseo orchestrates multiple coding agents (Claude Code, Codex, Copilot, OpenCode, Pi) running on your own machine, and gives you mobile, desktop, web, and CLI clients to drive them. Architecturally it is exactly our shape: a **daemon** holds all state and runs the work, and thin clients attach over WebSocket.

- Repo: `github.com/getpaseo/paseo`, 12.1k stars, 1.2k forks, created 2025-10-13, pushed same-day as this research (2026-08-04). Very active.
- Author: Mohamed Boudra. Single-maintainer project by design, see below.
- Stack: TypeScript monorepo. Electron desktop, Expo mobile, Node daemon.
- Packages: `app` (Expo client), `server` (daemon), `cli`, `client` (SDK), `protocol` (wire types), `relay`, `desktop`, `website`.

Maturity is real. The relay code carries dated compatibility shims with removal targets (`COMPAT(relay-json-ping) ... target: 2026-11-13`), which is a good sign about how they run protocol evolution.

### Licence: AGPL-3.0, and what that means for us

GitHub's API reports `NOASSERTION` for the licence, which triggered a closer look. The `LICENSE` file resolves it:

> Copyright (c) 2025-present Mohamed Boudra
>
> Portions of this software are licensed as follows:
>
> * All third party components incorporated into the Paseo Software are licensed under the original license provided by the owner of the applicable component.
> * All content outside of the above mentioned restrictions is available under the "AGPLv3" license as defined below.

Then the verbatim, unmodified FSF AGPLv3 text. **No Commons Clause, no additional restrictions, no exceptions.** The `NOASSERTION` is purely because of the two-line preamble above the standard text, not because of any custom term. The published npm packages (`@getpaseo/relay@0.2.5`) declare no `license` field at all, which does not grant anything extra; the repo licence governs.

There is **no CLA and no copyright assignment** in `CONTRIBUTING.md`. That is worth noting for a reason that cuts against us: with no CLA, Boudra cannot unilaterally relicense contributed code, so a future permissive relicence of the whole project is unlikely. `CONTRIBUTING.md` is also explicit that "product, design, architecture, and workflow decisions are currently all made by the maintainer" and that feature requests get auto-closed. This is not a project that will accommodate us.

**What AGPL-3.0 permits, plainly:**

- We **cannot** copy Paseo source into our product unless our entire product is also AGPL-3.0. AGPL's copyleft is file-level viral through linking and derivation; there is no "just this one module" carve-out.
- AGPL is materially worse than GPL for our shape of product. Section 13 means that if any part of the product is ever reached over a network (a hosted relay we run, a web client we serve, a team edition), we must offer complete corresponding source to those users. For a desktop app that is arguably moot, but the moment we run any server component it bites.
- An "open-source-core" model, meaning permissive core plus proprietary or differently-licensed extensions, is **incompatible** with lifting AGPL code. Downstream users adopting our core would inherit AGPL obligations they did not sign up for, and any commercial layer we build on top is contaminated.
- What we **can** do: read it, learn from it, reimplement the design independently, and cite it. Protocols, wire formats, architectural approaches, and the choice of cryptographic primitives are **not** copyrightable. A clean reimplementation of the same handshake is entirely lawful and normal.

So: **this section is a patterns-and-approach study.** We reimplement. Below is the map of what to reimplement, with paths, because knowing exactly where the good ideas live is most of the value.

One genuinely good piece of news, covered in detail later: **the relay server is a separate repo under Apache-2.0**, and that one we can use directly.

### Pairing flow, end to end

**On desktop:** Settings, then your host, then Pair Device. The daemon renders a QR code plus a copyable link. From the CLI it is `paseo daemon pair`, which prints a QR straight into the terminal as ANSI blocks.

**On phone:** open Paseo, tap Scan QR code, allow camera, point at the screen. You land on the main screen. Done.

**What makes it feel good, and each of these is worth copying:**

1. **No account.** No sign-up, no email, no login on either side. This is the single biggest UX difference from Orca and it aligns exactly with our nothing-to-procure constraint.
2. **The QR encodes a URL, not an opaque blob.** Format is `https://app.paseo.sh/#offer=<base64url-json>`. Because it is a real URL, scanning it with the **stock iOS camera** works: the phone offers to open the link, the deep link routes into the app, and if the app is not installed you land on a web page that tells you what to do. No "you must install our app first, then use our in-app scanner" dead end. The payload is a small JSON object (`packages/protocol/src/connection-offer.ts`):
   ```ts
   { v: 2, serverId: string, daemonPublicKeyB64: string, relay: { endpoint, useTls? } }
   ```
3. **The secret rides in the URL fragment.** `#offer=` means the payload is **never sent to app.paseo.sh** in the HTTP request. The web server literally cannot log your daemon's public key. This is a small, cheap, high-quality decision and we should copy it verbatim in spirit.
4. **Relay is off on new installs and the pairing flow asks.** From `public-docs/security.md`: "Relay is off on new installations. When you pair a device from `paseo`, `paseo daemon pair`, or Paseo Desktop, Paseo asks before enabling it." Declining leaves you on direct TCP or VPN and produces no QR. The `--relay` flag opts in non-interactively. Compare Orca below, where this is precisely what is missing.
5. **Manual entry always available.** Add Host accepts a raw `host:port`, so Tailscale and LAN users never touch the relay.

Time to pair: not published as a number, but the flow is three taps and a camera point, so seconds.

### Transport architecture

Two modes, and the daemon's default posture is closed.

**Relay (recommended, and the default answer for cross-network).** The daemon makes an **outbound** WebSocket to the relay and waits there; the phone connects to the same relay and they are spliced together. No inbound ports, no port forwarding, no firewall rules, no NAT traversal, no VPN. The daemon can stay bound to `127.0.0.1` or a Unix socket and still be reachable from cellular. This is the answer to "phone on 5G, laptop on home wifi" and it is the right one.

Rendezvous is by `serverId`, a persistent daemon identifier at `$PASEO_HOME/server-id`, format `srv_<12 base64url chars>` from 9 random bytes (`packages/server/src/server/server-id.ts`). The relay routes purely on that string. It performs no authentication of its own, which is deliberate: it is an untrusted pipe.

The protocol is versioned (`v1` and `v2` live side by side). In `v2` the daemon holds one long-lived **control socket** per `serverId` and opens a **separate data socket per client connection** on demand, told to do so by `{type:"connected", connectionId}` control messages. Sensible: one idle socket at rest, fan-out only when someone actually connects.

**Direct.** Daemon listens on `127.0.0.1:6767` by default. Can be rebound to a LAN or Tailscale address, or to a **Unix socket** for maximum isolation (CLI only; mobile and web need a network socket). Direct mode adds optional bcrypt password auth (`packages/server/src/server/auth.ts`) and **DNS rebinding protection** via a `daemon.hostnames` Host-header allowlist. That last one is a detail most projects forget and we should not.

**Desktop asleep or offline:** the connection drops and the phone shows the host as unreachable. There is no store-and-forward; the daemon is the only thing that can answer. The relay does buffer frames for a disconnected daemon, but with a hard cap of 200 and an explicit comment that this exists to "prevent unbounded memory growth if a daemon never connects." It is reconnect smoothing, not offline delivery. Same fundamental ceiling as Orca. **Push notifications go through Expo's hosted service** (`https://exp.host/--/api/v2/push/send`, in `packages/server/src/server/push/push-service.ts`), which is a vendor dependency in the notification path even though it is not in the data path.

Reconnect handling is mature: control ping every 10s, stale timeout at 30s, and a half-open detection routine that watches for whether the daemon actually reacts to a `connected` message before force-closing the control socket to trigger a fresh dial.

### Auth and trust model

**The credential established at pairing is the daemon's long-lived Curve25519 public key.** That is it. The QR is the trust anchor.

Mechanics (`packages/relay/src/crypto.ts`, `encrypted-channel.ts`):

1. Daemon generates a persistent ECDH keypair on first run, stored at `$PASEO_HOME/daemon-keypair.json`, written via `writePrivateFileAtomicSync` and re-checked with `ensurePrivateFile` on every load, so permissions stay `0600`.
2. Phone gets the daemon public key from the QR, generates its own ephemeral keypair, derives the shared key with `nacl.box.before()`, and sends `{type:"e2ee_hello", key:<its pubkey>, capabilities:{binaryCiphertext:true}}` in plaintext.
3. Daemon derives the same shared key, replies `{type:"e2ee_ready"}`, and only then processes commands.
4. Everything after is `nacl.box.after()`, XSalsa20-Poly1305, wire format `[24-byte random nonce][ciphertext]`. Crypto is byte-oriented specifically so that "frame kind is never inferred from plaintext contents."

**Secrets never leave the desktop.** Provider credentials (Anthropic, OpenAI keys, agent sessions) are held by the agent CLIs on the daemon machine and are never touched by Paseo's transport. The phone is a viewer and a command source.

**Revocation is the weak spot, and this is the one thing in Paseo we should not copy.**

The daemon derives a shared key from *whatever* public key arrives in `e2ee_hello`. There is **no allowlist of authorized client keys, no per-device identity, no paired-device list, and no per-device revoke.** I checked for this specifically and it does not exist. The consequences:

- The pairing offer is a **bearer credential with no expiry**. Anyone who obtains that URL or QR image (screen share, a screenshot in Slack, someone photographing your monitor, a stale terminal scrollback) gets permanent, full control of your daemon. The docs do say "Treat it like a password, don't share it publicly," which is honest but is doing a lot of work.
- The docs' claim that a compromised relay cannot send commands because "without your phone's private key, it cannot complete the handshake" is **misleading**. No specific private key is needed. Any key completes the handshake. What actually protects you is that the relay never sees the daemon public key, since it only ever routes on `serverId` and the pubkey travels in the QR. That is a real protection, but it is a different one from the one claimed.
- Revocation is all-or-nothing: delete `daemon-keypair.json` and re-pair every device.
- The docs' stated remedy is wrong: "restart the daemon to generate a new session ID and rotate the relay pairing." The session ID *is* the `serverId`, and `server-id.ts` persists it to disk precisely so it survives restarts. **Restarting rotates nothing.** This looks like documentation left behind by a refactor.

**Fix for us:** record the client's public key at first handshake, keep an allowlist with a label and a `lastSeenAt`, expire un-redeemed offers after a few minutes, and ship a paired-devices screen with a revoke button. That is a small addition to an otherwise correct design, and it closes the only serious gap.

### Module map: what a lift would have touched

Recorded so we know what the reimplementation surface actually is. Licence blocks copying, so read this as a **specification of what to build**.

**Crypto and channel (the core, this is the bit worth mirroring closely):**

| Path | Lines | What |
|---|---|---|
| `packages/relay/src/crypto.ts` | 156 | Keygen, base64 import/export with length validation, ECDH derive, encrypt/decrypt, PRNG bootstrap |
| `packages/relay/src/encrypted-channel.ts` | 585 | Handshake both sides, retry, send queue, re-handshake, binary/base64 negotiation |
| `packages/relay/src/base64.ts` | 19 | Trivial |
| `packages/relay/src/e2ee.ts` | 11 | Barrel export |
| `packages/relay/src/types.ts` | 28 | Roles, session attachment |

**Pairing offer:**

| Path | Lines | What |
|---|---|---|
| `packages/protocol/src/connection-offer.ts` | 59 | Zod schema for the offer, `#offer=` fragment parse |
| `packages/server/src/server/connection-offer.ts` | 79 | Build offer, encode to fragment URL, LAN IP discovery |
| `packages/server/src/server/pairing-offer.ts` | 68 | Orchestration: server-id, keypair, offer, QR |
| `packages/server/src/server/daemon-keypair.ts` | 69 | Load-or-create with `0600` enforcement |
| `packages/server/src/server/server-id.ts` | ~90 | Stable daemon id |
| `packages/server/src/server/pairing-qr.ts` | 18 | Terminal QR via `qrcode` |

**Transport plumbing:**

| Path | Lines | What |
|---|---|---|
| `packages/server/src/server/relay-transport.ts` | 553 | Daemon relay client: control socket, per-connection data sockets, keepalive, half-open detection |
| `packages/server/src/server/relay-runtime.ts` | 78 | Wiring |
| `packages/server/src/server/websocket/encrypted-relay-socket.ts` | 91 | Adapts encrypted channel to the socket interface the WS server expects |
| `packages/client/src/daemon-client-relay-e2ee-transport.ts` | 196 | Client side of the same |
| `packages/relay/src/cloudflare-adapter.ts` | 614 | Relay server as a Cloudflare Durable Object |

**Mobile presentation:** `packages/app/src/app/pair-scan.tsx` (274), `pair-link-modal.tsx`, `add-host-modal.tsx`, `add-host-method-modal.tsx`, `welcome-screen.tsx`, `desktop/components/pair-device-section.tsx`. Expo Router, `expo-camera` for scanning.

**Core reimplementation surface: about 1,300 lines** across crypto, channel, offer, and client transport. Of that, the genuinely subtle part is `encrypted-channel.ts`, and most of its 585 lines are robustness (handshake retry every 1s, a 200-message pending-send queue, re-handshake with key-mismatch detection closing at code 1008) rather than crypto. The crypto itself is under 60 meaningful lines.

### Code quality and dependency weight

**Quality is high.** Specifically:

- Type-safe throughout with no assertion escapes; they use `Reflect.get` and explicit type guards rather than `as any` even when poking at Cloudflare globals.
- Every parse is validated. Zod on the offer, hand-written guards on handshake messages, explicit key-length checks on every import.
- Error messages are built for debugging without leaking secrets: `buildInvalidHelloError` reports the received type, whether a key field was present, and a 160-char preview.
- Comments explain *why*, not what. The buffering-during-async-keyderive comment and the half-open-socket comment both document real bugs they hit.
- Test coverage on the relay package is heavier than the source: `encrypted-channel.test.ts` (534), `e2e.test.ts` (508), `cloudflare-adapter.test.ts` (283), `crypto.test.ts` (170), plus a `live-relay.e2e.test.ts` against the real service and a `dist-handshake-parity.test.ts` that guards built output against source.

**Dependency weight is excellent**, and this is the number that matters most for a reimplementation, because it tells us what we would need to pull in:

- `@getpaseo/relay`: `tweetnacl`, `base64-js`, `ws`. Three deps, all tiny, all mature, all permissive (tweetnacl is public domain / Unlicense, base64-js is MIT, ws is MIT).
- `@getpaseo/protocol`: `zod` only.
- `@getpaseo/client`: protocol + relay + zod.

**We can use all of those directly.** They are not Paseo's code. So the dependency story for our reimplementation is: `tweetnacl` (or `@noble/curves` + `@noble/ciphers`, which is the more modern audited choice and what I would pick for new code), a QR library, and a WebSocket library. That is it.

### Coupling

**The crypto and channel layer is essentially uncoupled.** `packages/relay/src` imports nothing from any other Paseo package. It defines its own minimal `Transport` interface (`send`, `close`, `onmessage`, `onclose`, `onerror`) and is agnostic about what implements it. It is published as a standalone npm package with its own version. This is a well-drawn boundary and it is the reason a reimplementation is cheap: the design is already factored into a portable shape, so we are copying an idea that was built to be portable.

**Coupling increases as you move outward.** `pairing-offer.ts` reaches into `server-id`, `daemon-keypair`, `connection-offer`, `pairing-qr` and takes a `pino` logger. `relay-transport.ts` is bound to Paseo's `websocket-server` and `ExternalSocketMetadata`. The mobile screens are bound to Expo Router, Paseo's i18n, and its host-runtime store. So: the parts worth mirroring are the loosely coupled parts, and the tightly coupled parts are the ones we would want to write ourselves anyway because they encode our product's shape.

### The relay server: Apache-2.0, and this changes the calculus

`public-docs/community.md` points at a second repo:

> **getpaseo/paseo-relay** is Paseo's official distributed relay server, written in Elixir. It powers hosted remote access and can also be self-hosted.

`github.com/getpaseo/paseo-relay`, Elixir, **Apache-2.0**, actively pushed (2026-08-01). Apache-2.0 is fully compatible with a permissive open-source core and includes an express patent grant, which is strictly better than MIT for this purpose.

So the split is:

- Paseo's **client-side** crypto and pairing code: AGPL, reimplement.
- Paseo's **relay server**: Apache-2.0, **usable as-is**, self-hostable, and in a language whose concurrency model (BEAM) suits holding tens of thousands of idle WebSockets.

The in-repo `cloudflare-adapter.ts` Durable Object relay is AGPL and is the older or alternate implementation. `wrangler.toml` shows `relay.paseo.sh` on Cloudflare fronting `paseo-relay-next.fly.dev`, so they appear mid-migration from the Durable Object version to the Elixir one.

**Conflict check against nothing-to-procure:** none, if we do it right. Relay stays **off by default** (Paseo's own posture), direct and VPN paths need no server at all, and when a user does want cross-network access they can either self-host the Apache-2.0 relay or point at one we run as a convenience. Because the relay is a dumb untrusted pipe that routes on an opaque id and holds no accounts, running one costs us almost nothing and, critically, **learns almost nothing**: no user records, no keys, no plaintext. That is a defensible thing to operate and an easy thing to let users replace.

---

## Orca

Lighter treatment per the steer, but one finding here is significant enough to carry into our own doc-writing practice.

### What it is

An "ADE" (agent development environment) running many CLI coding agents in parallel, each in its own git worktree, on your own agent subscriptions. Electron desktop for macOS, Linux, Windows, plus a mobile companion.

- Repo `github.com/stablyai/orca`, **37.1k stars**. Legal entity is **Lovecast Inc.** (LICENSE, docs footer, App Store seller "Lovecast LLC"). YC-backed, San Francisco.
- **Licence: MIT**, desktop and mobile both. Mobile source is in-repo at `mobile/`, React Native plus Expo. (A widely-cited third-party review says Apache 2.0; that is wrong.)
- Maturity is lopsided: desktop `v1.4.168` shipping daily, iOS app at **0.0.39** with 15 ratings, and the docs label the mobile companion beta.

### Pairing

Three entry points, which is why sources appear to contradict each other:

- **Desktop app (main path): a one-time typed code**, not a QR. Account or status menu shows the code; on the phone you choose Pair and paste it. A desktop deep link into the mobile pairing screen also exists. Codes expire after a few minutes, which is a good default Paseo lacks.
- **Headless/server path: a QR.** `orca serve --pairing-address <ip> --mobile-pairing` prints a mobile-scoped QR and link, intended to be scanned over a shared tailnet.
- **Older/dev path:** Settings, then Mobile, shows a QR. The App Store copy still describes the QR flow.

**Account requirement is documented contradictorily.** The mobile troubleshooting page says pairing needs both devices "signed into the same Orca account"; the telemetry page says "Orca has no account system." The source settles it: `src/main/orca-profiles/profile-cloud-auth-config.ts` calls `/v1/desktop/auth/relay-token` and `/v1/desktop/auth/logout`. An account exists and gates the relay. Direct LAN pairing appears not to need one.

### Transport

- WebSocket RPC on port **6768**. Phone accepts an IP, `host:port`, or a `ws://`/`wss://` URL.
- **Documented** cross-network answer is **Tailscale**, plus an explicit warning not to port-forward Orca to the public internet.
- **Undocumented but shipping: a vendor relay.** The mobile docs state flatly "there is no cloud relay." The product contradicts this. `mobile/src/transport/` contains roughly 30 `mobile-relay-*` modules. Hardcoded endpoints: `https://relay.onorca.dev` acts as a director, `POST /v1/assign` with a bearer relay token returns a cell (`relay-c1.onorca.dev`, `relay-c2.onorca.dev`), dialled as `wss://<cell>/v1/connect/<relayHostId>`, with a `relay-moved` message to migrate cells. App Store release notes say "Orca relay support" and later "stronger relay reconnection."
- **Selection races both paths concurrently** and prefers direct on a tie (`pairing-candidate-race.ts` picks `successes.find(p => p.path === 'direct') ?? successes[0]`). Avoids the slow-timeout-then-fallback feel. But **even when direct wins it then calls `pairing.provisionRelay`** to install relay credentials for later, so relay enrolment happens for users who never needed it.
- **Desktop asleep:** connection drops, phone goes dark. Open issue #10426 requests headless/SSH so the desktop can power down. Same ceiling as Paseo.

### Auth and trust

Cryptographically **the same design as Paseo**: TweetNaCl `box`, Curve25519 ECDH via `nacl.box.before()`, XSalsa20-Poly1305 via `nacl.box.after()`, wire format `[24-byte nonce][ciphertext]`. This convergence is the strongest evidence that this is simply the right answer.

Where Orca is **better** than Paseo:

- A **per-phone device token** in addition to the keypair, so devices have identity.
- Tokens stored in the **iOS Keychain / SecureStore**, with a durable retry queue so a failed keychain delete gets retried.
- **Credential rotation** with fresh 32-byte tokens, credential versions, and `resumeExpiresAt` / `graceExpiresAt` lease windows.
- A **journal** so a retry over a flaky connection does not double-spend a pairing.
- **Documented revocation for remote servers**: "Orca creates a separate, revocable token for each paired client. The server lists these under Shared Server Access."
- **Versioned protocol with a block screen** pointing at the right app store, preventing silent cross-version corruption.
- **Editable host address without re-pairing**, which solves LAN-versus-Tailscale roaming cleanly.
- **Mobile WS listener bound to loopback until pairing**, so no LAN-visible socket exists before there is anything to authenticate.

Where Orca is **worse**: mobile-side revocation is only mentioned obliquely in troubleshooting and there is no documented paired-device management screen, so the good server-side revocation story does not clearly reach the phone.

Secrets stay on the desktop. The phone is a viewer; switching agent accounts from the phone issues an RPC executed on the desktop. iOS app declares "Data Not Collected," no analytics or third-party SDKs. Desktop telemetry is PostHog, anonymous, opt-out via `DO_NOT_TRACK=1`.

### Copyability

- **All client code is MIT (Lovecast Inc.).** The entire `mobile/src/transport` layer is liftable with attribution: e2ee, pairing race, credential rotation, endpoint supervisor, reconnect controller.
- **The relay is not.** Only the clients are open. The director and cell services are closed vendor infrastructure gated on an Orca cloud token. `ORCA_RELAY_URL` and `ORCA_CLOUD_RELAY_TOKEN_URL` env overrides exist, so you could point at your own, but you would be reimplementing an undocumented protocol.
- **Conflict with no-cloud-backend: yes, for the relay path.** Relay requires an Orca account and Orca-run servers. The direct path (LAN, Tailscale, WebSocket, NaCl box) has zero vendor dependency and is fully copyable.

### The thing to actively avoid

**Orca ships a vendor relay while its own documentation says "there is no cloud relay."** Whatever the intent, a security-conscious user reading the docs forms a materially wrong model of where their traffic goes. I could find no relay opt-in or opt-out anywhere in the settings docs or the source; the de facto gate is cloud sign-in, which is an accident of architecture rather than a control.

This matters to us beyond gossip, because it is the exact mistake we are structurally positioned to make: adding a relay later, as a convenience, without going back to update the "everything stays local" claim we will have been making. **Paseo's posture is the corrective**: relay off by default, an explicit interactive prompt at pairing, a documented `--relay` flag, and the relay's hostnames and threat model written down in `security.md`. Note that the e2ee-above-transport design means Orca's relay cannot read traffic, so the technical harm is limited to metadata. The reputational harm is not.

---

## Synthesis: what to build

### The design

**Pairing.**

1. On first run the desktop generates a persistent X25519 keypair and stores it `0600` in the app support directory, written atomically, permissions re-verified on load. (Paseo's `daemon-keypair.ts` pattern, reimplemented.)
2. Desktop also generates a stable random `hostId`, roughly 12 base64url chars, persisted alongside.
3. Pair Device renders a QR encoding `https://<our-domain>/pair#offer=<base64url-json>` where the payload is `{ v: 1, hostId, hostPublicKey, endpoints: [...], relay?: {...} }`. Secret in the **fragment** so our own web server never receives it. Show a copyable link and, for headless, an ANSI QR in the terminal.
4. Stock camera scans it. Deep link into the app if installed; a plain explanatory install page if not.
5. **Offers expire.** Five minutes, single redemption. (Orca's expiry, which Paseo lacks.)
6. Phone generates its own keypair, derives the shared secret, sends `hello` with its public key.
7. **Desktop records the client public key in an allowlist** with a device label, `pairedAt`, and `lastSeenAt`, and only accepts `hello` from an allowlisted key **or** from a valid unexpired offer. This is our fix for Paseo's biggest gap.
8. Desktop shows a **Paired Devices** list with per-device revoke. Revoke drops one key, not all of them.

**Transport.**

- WebSocket everywhere. E2EE **above** the transport, so every path is sealed identically and the transport can never be trusted. Both products do this and it is the load-bearing structural decision.
- **Three paths, offered in this order:**
  1. **Direct LAN**, zero infrastructure, host bound to a LAN address, useful at a desk.
  2. **Tailscale or any VPN**, documented as first-class with the do-not-port-forward warning. Costs us nothing to support because it is just direct with a different address.
  3. **Relay**, **off by default**, prompted at pairing, for cellular and cross-network.
- **Race direct and relay concurrently, prefer direct on tie** (Orca's `pairing-candidate-race`), but **do not** provision relay credentials when direct wins. Take the good half of Orca's idea and drop the bad half.
- **Host address is editable without re-pairing.** The pairing establishes trust in a key, not in an address. Roaming between home LAN and tailnet must never trigger a re-pair.
- Relay: outbound-only from desktop, rendezvous on `hostId`, no inbound ports.
- Desktop asleep means the phone shows the host offline. Do not fake offline capability. Both competitors have this ceiling and both are honest about it. If we later want push, note that both routes lead to a vendor: Paseo uses Expo's hosted push service. Anything beyond "your desktop is unreachable" needs a design conversation we have not had.

**Auth.**

- X25519 ECDH, XSalsa20-Poly1305 (NaCl `box`), `[24-byte random nonce][ciphertext]`. Both products, independently, same choice.
- **For new code prefer `@noble/curves` + `@noble/ciphers` over `tweetnacl`.** Same primitives, audited, actively maintained, tree-shakeable, MIT. `tweetnacl` is fine and battle-tested but is effectively frozen.
- Optional bcrypt password on direct connections. Host-header allowlist for DNS-rebinding protection. Both from Paseo, both cheap, both easy to forget.
- Client tokens and keys in the **iOS Keychain** via `expo-secure-store`, never `AsyncStorage`. (Orca.)
- **LLM API keys never leave the desktop.** The phone proxies chat through the desktop, which holds the credentials, which is our architecture already and matches both products exactly.
- **Versioned protocol from v1**, with a friendly "update your app" screen on mismatch. (Orca.) Cheap now, painful to retrofit.

### Build versus reuse

**Reuse directly:**

| Thing | Licence | Note |
|---|---|---|
| `@noble/curves`, `@noble/ciphers` | MIT | X25519 + XSalsa20-Poly1305 |
| `ws` (desktop), native WebSocket (phone) | MIT | |
| `qrcode` | MIT | Includes the terminal ANSI renderer Paseo uses |
| `expo-camera`, `expo-secure-store` | MIT | Scanning and keychain |
| `zod` | MIT | Offer schema validation |
| **`getpaseo/paseo-relay`** | **Apache-2.0** | The relay server, self-hostable. Only if we adopt its wire protocol. |
| Orca's `mobile/src/transport/*` | **MIT** | Liftable with attribution. Reference for reconnect and rotation. |

**Build ourselves (roughly 400 to 600 lines):**

- Keypair persistence with `0600` enforcement and atomic write (~70 lines).
- Offer schema, fragment URL encode and decode (~120 lines).
- Encrypted channel: handshake both sides, retry, send queue, reconnect (~250 lines, the only genuinely subtle piece).
- **Client allowlist and revocation** (~100 lines). Neither product has this properly, so there is nothing to copy and it is the part that most needs to exist.
- Pairing UI on both sides.
- Relay client, only if we ship relay in v1.

**Defer:** the relay entirely. Ship v1 with direct plus Tailscale, which is zero infrastructure and no cloud backend of any kind, and which covers the desk and the tailnet user completely. Add relay when someone actually asks for cellular. Because e2ee sits above the transport, **adding the relay later changes nothing about the trust model**, and that is precisely why deferring it is safe rather than a decision we would have to unwind.

### No-cloud-backend constraint

**No conflict, with three conditions.**

1. Relay stays **off by default** and the pairing flow asks before enabling it. Paseo's exact posture, and the thing Orca got wrong.
2. If we run a relay, it is the **Apache-2.0 `paseo-relay`** or our own equivalent, and self-hosting is documented and first-class. Users can point at their own with an env var or a settings field.
3. We **never** claim "nothing leaves your machine" while a relay is reachable. We describe the relay, name its hostnames, and describe its threat model in our security docs on the day we ship it. This is the Orca lesson and it is the cheapest one to learn secondhand.

Nothing here requires an account system, a user database, billing, or any stateful service. The relay is a stateless untrusted pipe that routes on an opaque id and could be a few hundred lines behind a load balancer. **Everything valuable stays on the desktop, which is the whole thesis of the product.**

---

## Sources

- [getpaseo/paseo](https://github.com/getpaseo/paseo), source read from a shallow clone at `main`, 2026-08-04
- [Paseo security docs](https://paseo.sh/docs/security), [Paseo getting started](https://paseo.sh/docs)
- [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) (Apache-2.0)
- [Orca mobile companion docs](https://www.onorca.dev/docs/mobile), [remote servers](https://www.onorca.dev/docs/remote-servers), [telemetry and privacy](https://www.onorca.dev/docs/telemetry)
- [stablyai/orca](https://github.com/stablyai/orca), [LICENSE](https://github.com/stablyai/orca/blob/main/LICENSE), [issue #10425](https://github.com/stablyai/orca/issues/10425), [issue #10426](https://github.com/stablyai/orca/issues/10426)
- [Orca IDE on the App Store](https://apps.apple.com/us/app/orca-ide/id6766130217), [Paseo on the App Store](https://apps.apple.com/us/app/paseo-claude-code-codex/id6758887924)
- [andrew.ooo Orca review](https://andrew.ooo/posts/orca-stablyai-parallel-coding-agents-ide-review/) (third party, contains a licence error)

> [!warning] Not legal advice
> The AGPL-3.0 reading here is an engineer's reading. If we ever get close to shipping something that touches Paseo code rather than Paseo ideas, that needs a real lawyer. The recommendation in this note avoids the question entirely by reimplementing.
