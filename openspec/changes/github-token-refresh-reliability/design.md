## Context

The daemon holds one GitHub credential in a `0600` file (`github-token`). For an expiring-token app configuration it is an access token plus a rotating refresh token. `resolveGitHubAuth` (`packages/adapters/src/github-auth.ts`) refreshes it proactively (near expiry) or reactively (on a 401), through `refreshAndPersist` → `refreshGitHubCredential` (`packages/adapters/src/github-device-flow.ts`), under the daemon's account lock, persisting the rotated pair via the `SecretStore`. `create-server.ts` binds the concrete `refresh` and `withLock` into `resolveAuth`.

The path is correct on paper but **silent**: nothing is logged, so a field failure is only inferable. On lancelot a refresh failed and surfaced as `token-invalid`; we could not tell decline from network from not-attempted. `refreshGitHubCredential` already maps a 200-with-`error` to `GitHubOAuthDeclined` and lets transport errors propagate (which `resolveGitHubAuth` classifies as `network`), but nothing records which happened, and a single transient transport error at refresh time drops the session with no retry.

## Goals / Non-Goals

**Goals:**
- Make every refresh attempt observable in `daemon.log`, secret-safe.
- Survive a transient network blip at refresh time (retry once).
- Name a genuine decline's GitHub `error` code so the real cause is knowable.
- Prove a refresh actually succeeds once, live on lancelot.

**Non-Goals:**
- Disabling token expiry in the GitHub App (dodges the fix).
- Changing the device-flow mint path, the token file format, or the store.
- The WSL-daemon architecture (separate change, PR #437).
- Any consent gate, approval, or read-only posture (Rule Zero).

## Decisions

**1. Inject a logger, don't `console.log` in the adapter.** `resolveGitHubAuth`/`refreshAndPersist` take an optional `log?: (record: RefreshLogRecord) => void`. `create-server` binds one that writes a single-line record to the daemon's existing stdout→`daemon.log` sink. Rationale: `adapters` stays testable and side-effect-free; tests assert on captured records; production formatting lives at the composition boundary. Alternative (a bare `console.error` in the adapter) rejected — it couples the adapter to a sink and makes the secret-safety guarantee untestable.

**2. `RefreshLogRecord` is a typed, secret-free shape.** Fields: `phase` (`attempt` | `persisted` | `declined` | `network`), optional `githubError` (the verbatim `error` code on a decline), optional `httpStatus`, optional `tokenKind` (a prefix like `ghu_`/`gho_`) and `attempt` number. No token/refresh/secret field exists on the type, so a secret cannot be logged by construction. Rationale: make the safety a type-level property, not a review promise.

**3. Retry ownership stays in the shared transport; `refreshAndPersist` only observes.** The GitHub transport (`withConnectResilience`, composed in `create-server`) already retries a CONNECT-PHASE failure exactly once and deliberately never replays a post-send failure — precisely because replaying a sent request could double a rotation. The refresh POST rides that transport, so the boot-storm `UND_ERR_CONNECT_TIMEOUT` case is already covered, replay-safely. `refreshAndPersist` therefore adds NO retry of its own; on a network error it emits a `network` record and propagates, and `resolveGitHubAuth` classifies it `network` with the credential untouched. Rationale (review finding): a retry here would be a redundant second layer (up to four connect attempts) AND less safe than the transport, because `isGitHubNetworkError` also matches post-send errors that may have already rotated the pair. Alternative (retry inside `refreshAndPersist`) rejected for exactly that double-attempt / rotation-burn risk.

**4. Persistence and classification are unchanged.** A success still writes the rotated pair via the atomic store; a decline still returns `token-invalid`; a network failure still leaves the credential untouched and returns `network`. This change only *observes* and *retries* — it does not move the state machine. Rationale: minimal blast radius; the existing tests keep their meaning.

## Risks / Trade-offs

- **A retry doubles the worst-case latency of a refresh** → bounded to exactly one extra attempt, and only on a transient transport error (not on a decline); each request already carries the 15s egress deadline.
- **Logging could leak a secret if a field is added carelessly** → the `RefreshLogRecord` type has no secret-carrying field; a test asserts the credential value never appears in any emitted record.
- **The lancelot proof consumes (rotates) the live refresh token** → that is the point (rotation is normal); the rotated pair persists, so the session continues. If the stored token is a stale pre-migration `gho_`, the proof will instead capture the *decline code*, which is itself the diagnostic we lack today.

## Migration Plan

No data migration. Ship the daemon change; the next natural refresh (or a forced one on lancelot) writes the first records. Rollback is reverting the change — the refresh state machine is unchanged, so an older daemon interoperates with the same token file.

## Open Questions

- Should a persistent decline (stored refresh token dead) proactively CLEAR the credential so `status` reads `not-connected` instead of re-attempting a dead refresh each resolve? Deferred: current behavior (surface `token-invalid`, keep the file) is acceptable and the log now makes the loop visible; revisit if the field shows churn.
