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

### Requirement: A connect-phase blip is absorbed replay-safely by the shared transport

GitHub egress — including the refresh exchange — runs through the shared GitHub transport, which retries a CONNECT-PHASE failure (e.g. `UND_ERR_CONNECT_TIMEOUT`) exactly once. That retry is provably replay-safe: no request reached GitHub, so nothing could have rotated. The transport deliberately does NOT replay a post-send failure (a timeout/reset after the request was sent), which could double a rotation. The refresh path SHALL NOT add its own retry — a second retry would duplicate connect attempts and could burn a rotated refresh token on an ambiguous post-send error.

#### Scenario: A connect-phase blip is retried once, without duplicating a request

- **WHEN** a refresh's request fails with a connect-phase code and the retry would succeed
- **THEN** the shared transport retries once, the refresh persists the rotated pair, and resolution is `ok` — no request was duplicated and no rotation was doubled

#### Scenario: The refresh layer adds no retry of its own

- **WHEN** a refresh fails with a network error
- **THEN** the refresh path makes exactly one `refresh` call, emits a `network` record, and propagates — it does not itself retry (retry ownership lives in the shared transport)

### Requirement: A network failure never invalidates the stored credential

A refresh that fails for a network reason (after the shared transport's connect-phase retry) SHALL leave the stored credential exactly as it was and surface reason `network`. GitHub rotates the refresh token only on a successful exchange, so an unreached GitHub says nothing about the credential's validity.

#### Scenario: Network-degraded refresh preserves the credential

- **WHEN** a refresh degrades to `network`
- **THEN** the stored credential file is byte-identical to before the attempt, and a later attempt (once GitHub is reachable) can still refresh it
