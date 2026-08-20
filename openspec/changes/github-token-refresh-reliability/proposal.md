## Why

On lancelot (WSL, 0.3.14) a `project.detail` PR fetch reported the GitHub token as expired and forced a device-flow re-auth. The refresh path is fully implemented, wired (`resolveGitHubAuth` → `refreshAndPersist` → `refreshGitHubCredential`, with `refresh`+`withLock` bound in `create-server`), and the token store is sound (atomic write-then-rename, fresh reads). Yet the refresh exchange emits **zero logs**, so the failure could only be *inferred*, never observed — and the refresh has never been confirmed to succeed in the field even once. That invisibility is the bug: when a refresh fails during the daemon's boot connect-timeout storm, nothing records whether it was a momentary blip (which the shared GitHub transport already retries, connect-phase and replay-safe) or a genuinely dead token — so a recoverable hiccup and a real re-auth look identical.

The token's *lifetime* is not the bug. The bug is that renewal is unobservable and fragile: we cannot see it work, cannot diagnose it when it doesn't, and let one bad moment force the user through the device flow again.

## What Changes

- **Observability**: the daemon logs the refresh exchange — an `attempt` line, the GitHub `error` code on a 200-with-error decline, whether the rotated pair persisted, and a network-degraded outcome. Token, refresh-token, and any secret value are **never** logged (only a non-secret token-kind prefix, from a closed allowlist).
- **Correct retry ownership**: retry stays where it is already correct — the shared GitHub transport, which retries a CONNECT-PHASE blip exactly once (replay-safe: no request reached GitHub) and never replays a post-send failure. The refresh path adds **no** retry of its own (a second layer would duplicate connect attempts and could burn a rotated refresh token on an ambiguous post-send error); it observes a network failure and propagates, so a genuine network failure still preserves the stored credential and surfaces reason `network` (never `token-invalid`).
- **Honest decline**: when GitHub genuinely declines the `refresh_token` (HTTP 200 with an `error` field), the daemon logs that error code verbatim so the real cause — `bad_refresh_token` / already-rotated / revoked / client mismatch — is knowable, and the surface degrades to a clean reconnect state.
- **Proof**: acceptance includes observing a refresh **succeed** (rotate + persist) at least once in `daemon.log` on lancelot — the first field confirmation the mechanism works.

No behavior on the happy path changes silently: the same credential is resolved, the same rotation persists; this change makes that path *legible* and *durable*.

## Capabilities

### New Capabilities
- `github-token-refresh`: how the daemon renews an expiring GitHub credential — the refresh exchange, the transport-owned connect-phase retry it relies on (and why the refresh layer adds none), the persistence of the rotated pair, the distinct failure outcomes (network vs declined), and the secret-safe log record of each attempt.

### Modified Capabilities
<!-- None: no existing spec owns the GitHub credential/refresh behavior (checked openspec/specs/). -->

## Impact

- `packages/adapters/src/github-device-flow.ts` — `refreshGitHubCredential`: distinguish a declined `refresh_token` (200+error) from a transport failure; expose enough for the caller to log the GitHub error code.
- `packages/adapters/src/github-auth.ts` — `refreshAndPersist` / `resolveGitHubAuth`: observe network failures (emit a secret-safe `network` record and propagate — no adapter-level retry; the transport owns connect-phase retry); emit the log records via an injected logger; preserve the existing `network` vs `token-invalid` classification.
- `packages/server/src/create-server.ts` — bind the daemon logger into `resolveAuth` (the refresh/withLock deps) so refresh records land in `daemon.log`.
- No change to the device-flow mint path, the token file format, or the store. No new dependency. Not the WSL-daemon architecture (separate change, PR #437). No consent gates or read-only postures (Rule Zero) — this is diagnosability and resilience only.
