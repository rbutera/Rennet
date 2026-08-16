## Purpose

A per-project execution locus lets Rennet run as a Windows app while the project, git, and harness binaries live inside a WSL distro. WSL is a first-class mode: every repo-facing process runs inside the distro with full capability, and the UI discloses the locus honestly.

## ADDED Requirements

### Requirement: A project has an execution locus
Each project SHALL carry an execution locus: the host OS, or a named WSL distro. On Windows, opening a project that resides inside a WSL distro (a `\\wsl$`/`\\wsl.localhost` path) SHALL select that distro as the locus automatically; the user SHALL be able to see and change the locus in project settings. Locus selection is informational configuration, never a confirmation step.

#### Scenario: Opening a WSL-resident project
- **WHEN** the user opens a project at `\\wsl.localhost\Ubuntu\home\user\repo`
- **THEN** the project's locus is the `Ubuntu` distro, and this is visible in the project's settings

#### Scenario: Host-locus project on Windows
- **WHEN** the user opens a project at `C:\dev\repo`
- **THEN** the locus is the host and all execution behaves per the windows-native-runtime capability

### Requirement: Repo-facing processes execute inside the locus
Every process whose correctness depends on the repo's filesystem view — `git`, `gh`, harness binaries (`claude`, `codex`), and any command a review or handoff runs — SHALL execute inside the project's locus. For a WSL locus this means execution inside the named distro with the repo's distro-native path as the working directory, never Windows binaries operating on `\\wsl$` UNC paths.

#### Scenario: Git capture in WSL mode
- **WHEN** a review captures a patchset for a WSL-locus project
- **THEN** git runs inside the distro against the distro-native repo path, and the captured diff is byte-identical to what git inside the distro reports

#### Scenario: Codex utility turn in WSL mode
- **WHEN** the model council assigns a job to Codex for a WSL-locus project
- **THEN** the `codex` binary inside the distro executes the turn, and its session usage is read from the distro's session log location

### Requirement: The Claude harness runs inside the WSL locus
For a WSL-locus project, the Claude harness turn SHALL execute the user's distro-resident `claude` installation inside the distro, authenticated by the distro user's own subscription credentials, with capability identical to the native mode: it SHALL be able to write to the repo, run tests, and push. No credential is ever read by Rennet in either locus.

#### Scenario: Review turn against a WSL project
- **WHEN** a review runs for a WSL-locus project whose `claude` lives in the distro
- **THEN** the turn executes in the distro, streams results to the app, and its acting capabilities (write, run, push) are not reduced relative to native mode

### Requirement: Paths translate between Windows and distro views
Where the Windows-side app must touch a distro file directly (rendering, watching, open-in-editor), paths SHALL translate deterministically between the distro-native form (`/home/user/repo/...`) and the Windows view (`\\wsl.localhost\<distro>\...`), and everything handed to an in-distro process SHALL use the distro-native form.

#### Scenario: Round-trip translation
- **WHEN** a finding anchors to `src/app.ts:42` in a WSL-locus project
- **THEN** the in-distro processes see a distro-native absolute path, the Windows-side file reads use the UNC view, and the repo-relative display path is identical in both

### Requirement: Locus health is disclosed honestly
When a WSL locus is unavailable (WSL not installed, the distro missing or stopped, or a required binary absent inside the distro), the UI SHALL state what is missing and where, as plain status. It SHALL NOT silently fall back to host execution for a WSL-locus project, and SHALL NOT add any confirmation gate to proceed once the locus is healthy.

#### Scenario: Distro stopped
- **WHEN** the project's distro is not running or WSL is absent
- **THEN** harness health reports unavailable with a reason naming the distro/WSL, and no host-side substitute executes against the repo
