# Harness discovery specification

## Purpose
Define how Rennet finds and probes model harnesses in each execution environment without relying on an interactive shell or unverified version claims.
## Requirements
### Requirement: Discovery resolves the harness without asking a shell to resolve a binary
Discovery SHALL harvest the login-shell PATH where a POSIX login shell exists, union it with a curated set of known locations for the current platform, resolve candidate binaries itself by directory listing plus an executable check, and SHALL NOT use `which`, `command -v`, or `where` to resolve a binary name. On Windows, harvesting SHALL use the process environment (no POSIX shell), the PATH delimiter SHALL be the platform's (`;`), candidate matching SHALL recognise directly launchable Windows executable shims (`.exe`, `.cmd`, `.bat`), and curated locations SHALL cover Windows per-user install directories. A `.ps1` file SHALL NOT be reported as executable because the shipped no-shell launcher cannot run it directly.

#### Scenario: The GUI-inherited PATH omits the real location
- **WHEN** the login-shell PATH does not contain the directory holding `claude`, and `claude` is a shell function interactively
- **THEN** discovery still finds the binary via a known location and reports it

#### Scenario: Windows .cmd shim resolves
- **WHEN** on Windows the only `claude` is `claude.cmd` in an npm global directory on a `;`-delimited PATH
- **THEN** discovery resolves it to an absolute path, executes it to prove its version, and reports it

### Requirement: Harness health is three-state and version-aware
Discovery SHALL prove a candidate by executing it to read its version, and SHALL report health as `ready`, `degraded` (with a reason, including a version above the tested ceiling), or `unavailable` (with a reason).

#### Scenario: A version beyond the tested ceiling
- **WHEN** the resolved binary reports a version greater than the tested maximum
- **THEN** discovery reports `degraded` with reason `above-tested`

#### Scenario: No binary is present
- **WHEN** no candidate binary is found on PATH or in any known location
- **THEN** discovery reports `unavailable` with reason `not-found` and no chosen binary

### Requirement: Discovery operates per execution locus
Discovery SHALL run against the project's execution locus and report which locus each candidate belongs to. For a WSL locus, discovery SHALL harvest the distro's login-shell PATH and curated in-distro locations by executing inside the distro, and SHALL prove candidates by executing them inside the distro. A host-side binary SHALL never satisfy a WSL-locus requirement, nor the reverse.

#### Scenario: claude installed only inside the distro
- **WHEN** a WSL-locus project's `claude` exists at a distro path and no Windows-side `claude` is installed
- **THEN** discovery reports a ready candidate in the distro locus, and the harness runs it there

#### Scenario: Host binary does not mask a missing distro binary
- **WHEN** `claude` is installed on Windows but absent inside the WSL-locus project's distro
- **THEN** discovery reports the WSL locus unavailable with reason naming the distro, not the host binary as chosen

### Requirement: A runtime-dependent harness reports its missing runtime as the health reason

For a harness that needs a separate runtime, discovery SHALL resolve and prove that runtime before executing the harness script. It SHALL enforce the runtime's minimum version and carry the proven absolute path into process composition. A missing, below-minimum, or unrunnable runtime SHALL make the slot unavailable with a reason that names the runtime. Candidate ranking SHALL place an asdf harness shim behind a direct install. Windows filename matching SHALL use the candidate environment's `PATHEXT`.

#### Scenario: The harness binary resolves but its runtime does not

- **WHEN** discovery resolves the harness binary but its required runtime is absent from the harvested PATH and curated locations
- **THEN** the slot's health reason names the missing runtime, and the resolved binary path is still reported so the app can say "found omp but not Bun" instead of "no omp found"

#### Scenario: Runtime present, harness proven

- **WHEN** the runtime is runnable and the harness binary answers its version probe
- **THEN** the slot reports `ready` exactly as a runtime-free harness would

### Requirement: The ChatGPT desktop bundled codex binary is a discovery candidate

Codex discovery SHALL include the ChatGPT-desktop-bundled codex binary as a candidate on macOS (`/Applications/ChatGPT.app/Contents/Resources/codex`, and the same relative layout under a user-local ChatGPT.app), probed with the same version/executability evidence as every other candidate, and SHALL prefer a user-installed codex CLI over the bundled binary when both are present and healthy. On Windows the Store package's bundled `codex.exe` is ACL-locked against out-of-package execution, so it SHALL NOT be offered as a candidate; Windows discovery continues through the installed codex CLI, and the health detail for an absent Windows codex SHALL name the CLI install as the remedy rather than pointing at the un-spawnable Store binary.

#### Scenario: ChatGPT desktop only, macOS

- **WHEN** discovery runs on macOS with no codex CLI on the PATH but ChatGPT.app installed with its bundled codex
- **THEN** the bundled binary is discovered, its version probed, and the Codex harness is available through it

#### Scenario: CLI outranks the bundle

- **WHEN** both a healthy codex CLI and the ChatGPT bundled binary are present on macOS
- **THEN** the CLI is chosen and the bundled binary remains listed as a candidate with its evidence

#### Scenario: Windows Store bundle is not offered

- **WHEN** discovery runs on Windows where ChatGPT desktop (the `OpenAI.Codex` Store package) is installed but no codex CLI is on the PATH
- **THEN** codex is unavailable with a detail naming the codex CLI install as the remedy, and the ACL-locked Store binary is not listed as a spawnable candidate

### Requirement: Codex candidates carry app-server capability evidence

A chosen Codex candidate SHALL be probed for app-server capability by sending an `initialize` request to the `app-server` subcommand. A binary that cannot complete this handshake SHALL be `unavailable` with the probe detail. Rennet SHALL NOT switch it to another invocation mode.

#### Scenario: An old binary without app-server

- **WHEN** the only discovered codex binary cannot answer the app-server handshake
- **THEN** codex health is `unavailable` with a detail naming the app-server probe failure and the version found
