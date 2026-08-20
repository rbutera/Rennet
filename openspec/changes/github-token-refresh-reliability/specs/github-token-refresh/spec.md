## ADDED Requirements

### Requirement: The refresh exchange is observable

The daemon SHALL record every GitHub credential refresh attempt to `daemon.log` through an injected logger, so a field failure is observed rather than inferred. The record MUST NEVER contain a token, refresh token, client secret, or any other credential value; it MAY contain non-secret shape (a token-kind prefix such as `ghu_`/`gho_`, a length, or an expiry timestamp).

#### Scenario: An attempted refresh is logged with its outcome

- **WHEN** the daemon resolves an expiring credential that is near or past expiry and attempts a refresh
- **THEN** it logs an attempt record, and on completion logs the outcome — `persisted` (the rotated pair was stored), `declined` (GitHub returned an error), or `network` (the exchange could not reach GitHub)

#### Scenario: A refresh log record carries no secret

- **WHEN** any refresh record is written
- **THEN** the record contains no access token, refresh token, or secret value, and the credential values do not appear anywhere in `daemon.log`

### Requirement: A declined refresh names its cause

When GitHub answers the `refresh_token` grant with HTTP 200 and an `error` field, the daemon SHALL treat the refresh as declined, log the returned `error` code verbatim, and resolve to the `token-invalid` state so the surface degrades to a clean reconnect. It SHALL NOT classify a decline as a network failure.

#### Scenario: GitHub declines the stored refresh token

- **WHEN** the refresh exchange receives HTTP 200 with `{ "error": "bad_refresh_token" }`
- **THEN** the daemon logs the `error` code, does not overwrite the stored credential with a partial value, and reports `token-invalid`

### Requirement: A transient network failure at refresh time is retried once

The refresh exchange SHALL retry exactly once when the first attempt fails with a transient transport error (an `undici` `UND_ERR_*` code, a timeout, or an abort), before degrading. This prevents a boot-time connectivity storm from dropping a live session over a momentary blip.

#### Scenario: The first refresh attempt times out, the retry succeeds

- **WHEN** the first refresh attempt fails with `UND_ERR_CONNECT_TIMEOUT` and a second attempt would succeed
- **THEN** the daemon retries once, persists the rotated pair, and resolves `ok` — the session is not dropped

#### Scenario: Both attempts fail on the network

- **WHEN** both the first attempt and its single retry fail with a transient transport error
- **THEN** the daemon resolves reason `network`, leaves the stored credential untouched, and does NOT report `token-invalid`

### Requirement: A network failure never invalidates the stored credential

A refresh that fails for a network reason (after its single retry) SHALL leave the stored credential exactly as it was and surface reason `network`. GitHub rotates the refresh token only on a successful exchange, so an unreached GitHub says nothing about the credential's validity.

#### Scenario: Network-degraded refresh preserves the credential

- **WHEN** a refresh degrades to `network`
- **THEN** the stored credential file is byte-identical to before the attempt, and a later attempt (once GitHub is reachable) can still refresh it
