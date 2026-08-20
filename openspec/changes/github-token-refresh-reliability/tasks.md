## 1. Log record type and logger seam

- [ ] 1.1 Add a secret-free `RefreshLogRecord` type in `packages/adapters/src/github-auth.ts` (fields: `phase: "attempt" | "persisted" | "declined" | "network"`, optional `githubError`, `httpStatus`, `tokenKind`, `attempt`) — no token/refresh/secret field exists on the type.
- [ ] 1.2 Add an optional `log?: (record: RefreshLogRecord) => void` to `ResolveAuthDeps`, defaulting to a no-op.
- [ ] 1.3 Add a `tokenKind(token)` helper that returns the non-secret prefix (e.g. `ghu_`/`gho_`) for records, never the token body.

## 2. Declined-refresh cause is knowable

- [ ] 2.1 In `refreshGitHubCredential` (`github-device-flow.ts`), ensure a 200-with-`error` throws `GitHubOAuthDeclined` carrying the verbatim `error` code (already partly true — confirm the code is on the error and reachable by the caller).
- [ ] 2.2 In `refreshAndPersist`, on `GitHubOAuthDeclined` emit a `declined` record with `githubError` = the code, then return null (unchanged control flow), so the surface still resolves `token-invalid`.

## 3. Retry-once on transient network error

- [ ] 3.1 In `refreshAndPersist`, wrap the `refresh(...)` call so a first failure that `isGitHubNetworkError` classifies as transient emits a `network` attempt record and retries exactly once (still inside the account-lock section, re-reading is not needed between the two attempts of the same rotation).
- [ ] 3.2 A `GitHubOAuthDeclined` is never retried; a second transient failure propagates so `resolveGitHubAuth` degrades to `network` and leaves the credential untouched.
- [ ] 3.3 On a successful (possibly retried) refresh, emit a `persisted` record after `setGitHubCredential`.

## 4. Wire the logger in the daemon

- [ ] 4.1 In `create-server.ts` `resolveAuth`, pass a `log` that writes each `RefreshLogRecord` as a single `[github-auth]` line to the daemon's stdout (→ `daemon.log`).
- [ ] 4.2 Emit an `attempt` record at the start of a refresh (proactive and reactive branches) so an attempt is always visible even if the process dies mid-exchange.

## 5. Tests

- [ ] 5.1 `github-auth.test.ts`: a declined refresh (200+`error`) emits a `declined` record with the error code and resolves `token-invalid`.
- [ ] 5.2 `github-auth.test.ts`: first attempt throws `UND_ERR_CONNECT_TIMEOUT`, retry succeeds → `persisted` record, resolves `ok`, credential rotated.
- [ ] 5.3 `github-auth.test.ts`: both attempts transient-fail → resolves `network`, stored credential byte-unchanged, no `token-invalid`.
- [ ] 5.4 A secret-safety test: across all emitted records for a full refresh, the access/refresh token strings never appear in any record.
- [ ] 5.5 Full `pnpm check` green (format, architecture, licenses, lint, typecheck, test, build).

## 6. Field proof (lancelot)

- [ ] 6.1 Build the daemon bundle and run it on lancelot against the real account; trigger a `project.detail` that forces a refresh.
- [ ] 6.2 Read `daemon.log` and confirm a `persisted` record (refresh succeeded + rotated) OR capture the `declined` `githubError` code — either is the first field observation of the refresh outcome. Record the result in the change before archiving.
