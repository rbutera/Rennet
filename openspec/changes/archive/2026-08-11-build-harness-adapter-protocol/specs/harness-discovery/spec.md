## ADDED Requirements

### Requirement: Discovery resolves the harness without asking a shell to resolve a binary
Discovery SHALL harvest the login-shell PATH, union it with a curated set of known locations, resolve candidate binaries itself by directory listing plus an executable check, and SHALL NOT use `which` or `command -v` to resolve a binary name.

#### Scenario: The GUI-inherited PATH omits the real location
- **WHEN** the login-shell PATH does not contain the directory holding `claude`, and `claude` is a shell function interactively
- **THEN** discovery still finds the binary via a known location and reports it

### Requirement: Harness health is three-state and version-aware
Discovery SHALL prove a candidate by executing it to read its version, and SHALL report health as `ready`, `degraded` (with a reason, including a version above the tested ceiling), or `unavailable` (with a reason).

#### Scenario: A version beyond the tested ceiling
- **WHEN** the resolved binary reports a version greater than the tested maximum
- **THEN** discovery reports `degraded` with reason `above-tested`

#### Scenario: No binary is present
- **WHEN** no candidate binary is found on PATH or in any known location
- **THEN** discovery reports `unavailable` with reason `not-found` and no chosen binary
