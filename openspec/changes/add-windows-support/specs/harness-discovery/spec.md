## MODIFIED Requirements

### Requirement: Discovery resolves the harness without asking a shell to resolve a binary
Discovery SHALL harvest the login-shell PATH where a POSIX login shell exists, union it with a curated set of known locations for the current platform, resolve candidate binaries itself by directory listing plus an executable check, and SHALL NOT use `which`, `command -v`, or `where` to resolve a binary name. On Windows, harvesting SHALL use the process environment (no POSIX shell), the PATH delimiter SHALL be the platform's (`;`), candidate matching SHALL recognise directly launchable Windows executable shims (`.exe`, `.cmd`, `.bat`), and curated locations SHALL cover Windows per-user install directories. A `.ps1` file SHALL NOT be reported as executable because the shipped no-shell launcher cannot run it directly.

#### Scenario: The GUI-inherited PATH omits the real location
- **WHEN** the login-shell PATH does not contain the directory holding `claude`, and `claude` is a shell function interactively
- **THEN** discovery still finds the binary via a known location and reports it

#### Scenario: Windows .cmd shim resolves
- **WHEN** on Windows the only `claude` is `claude.cmd` in an npm global directory on a `;`-delimited PATH
- **THEN** discovery resolves it to an absolute path, executes it to prove its version, and reports it

## ADDED Requirements

### Requirement: Discovery operates per execution locus
Discovery SHALL run against the project's execution locus and report which locus each candidate belongs to. For a WSL locus, discovery SHALL harvest the distro's login-shell PATH and curated in-distro locations by executing inside the distro, and SHALL prove candidates by executing them inside the distro. A host-side binary SHALL never satisfy a WSL-locus requirement, nor the reverse.

#### Scenario: claude installed only inside the distro
- **WHEN** a WSL-locus project's `claude` exists at a distro path and no Windows-side `claude` is installed
- **THEN** discovery reports a ready candidate in the distro locus, and the harness runs it there

#### Scenario: Host binary does not mask a missing distro binary
- **WHEN** `claude` is installed on Windows but absent inside the WSL-locus project's distro
- **THEN** discovery reports the WSL locus unavailable with reason naming the distro, not the host binary as chosen
