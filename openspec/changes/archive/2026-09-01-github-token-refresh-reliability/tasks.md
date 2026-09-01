## 1. Log record type and logger seam

- [x] 1.1 Add a secret-free `RefreshLogRecord` type in `packages/adapters/src/github-auth.ts` (fields: `phase: "attempt" | "persisted" | "declined" | "network"`, optional `githubError`, optional `tokenKind`) — no token/refresh/secret field exists on the type.
- [x] 1.2 Add an optional `log?: (record: RefreshLogRecord) => void` to `ResolveAuthDeps`, defaulting to a no-op.
- [x] 1.3 Add a `tokenKind(token)` helper that returns the non-secret prefix (e.g. `ghu_`/`gho_`) for records, never the token body.

## 2. Declined-refresh cause is knowable

- [x] 2.1 In `refreshGitHubCredential` (`github-device-flow.ts`), ensure a 200-with-`error` throws `GitHubOAuthDeclined` carrying the verbatim `error` code (already partly true — confirm the code is on the error and reachable by the caller).
- [x] 2.2 In `refreshAndPersist`, on `GitHubOAuthDeclined` emit a `declined` record with `githubError` = the code, then return null (unchanged control flow), so the surface still resolves `token-invalid`.

## 3. Observe network failures; retry stays in the shared transport

- [x] 3.1 In `refreshAndPersist`, on a `refresh(...)` failure that `isGitHubNetworkError` classifies as a network error, emit a `network` record and propagate — do NOT add a retry. Retry ownership lives in the shared `withConnectResilience` transport (connect-phase, replay-safe); a second retry here would duplicate connect attempts and risk burning a rotated refresh token on a post-send error.
- [x] 3.2 A `GitHubOAuthDeclined` emits a `declined` record with its verbatim code and resolves `token-invalid`; a propagated network error leaves `resolveGitHubAuth` to classify `network` with the credential untouched.
- [x] 3.3 On a successful refresh, emit a `persisted` record (with the new token's `tokenKind`, never the token) after `setGitHubCredential`.

## 4. Wire the logger in the daemon

- [x] 4.1 In `create-server.ts` `resolveAuth`, pass a `log` that writes each `RefreshLogRecord` as a single `[github-auth]` line to the daemon's stdout (→ `daemon.log`).
- [x] 4.2 Emit an `attempt` record at the start of a refresh (proactive and reactive branches) so an attempt is always visible even if the process dies mid-exchange.

## 5. Tests

- [x] 5.1 `github-auth.test.ts`: a declined refresh (200+`error`) emits a `declined` record with the error code and resolves `token-invalid`.
- [x] 5.2 `github-auth.test.ts`: a network-failing refresh emits `attempt` then `network`, resolves `network`, leaves the stored credential byte-unchanged, and calls `refresh()` EXACTLY ONCE (asserts no adapter-level retry — the transport owns retry).
- [x] 5.3 `github-auth.test.ts`: a successful refresh emits a `persisted` record whose `tokenKind` is an allowlisted label; and a `tokenKind()` unit test — `ghu_…`/`gho_…` map to their prefix, an unknown value like `customerSecret_body` maps to the fixed `"token"` (never a slice).
- [x] 5.4 A secret-safety test: across all emitted records for a full refresh, the access/refresh token strings never appear in any record.
- [x] 5.5 Full `pnpm check` green (format, architecture, licenses, lint, typecheck, test, build).

## 6. Field proof (lancelot)

- [ ] 6.1 Build the daemon bundle and run it on lancelot against the real account; trigger a `project.detail` that forces a refresh. [archive 2026-09-01: field observation not run; refresh-outcome logging residual owned by open #478]
- [ ] 6.2 Read `daemon.log` and confirm a `persisted` record (refresh succeeded + rotated) OR capture the `declined` `githubError` code — either is the first field observation of the refresh outcome. Record the result in the change before archiving. [archive 2026-09-01: field observation not run; refresh-outcome logging residual owned by open #478]
