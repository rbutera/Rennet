## Purpose

A per-project execution locus lets Rennet run as a Windows app while a project and selected repo-facing tools live inside a WSL distro. This slice routes the explicitly listed operations through the distro and discloses the remaining ceiling honestly; it does not claim that every review-pipeline or Codex path is locus-aware yet.

## ADDED Requirements

### Requirement: A project has an execution locus
Each project SHALL carry an execution locus: the host OS, or a named WSL distro. On Windows, opening a project that resides inside a WSL distro (a `\\wsl$`/`\\wsl.localhost` path) SHALL select that distro as the locus automatically; the user SHALL be able to see and change the locus in project settings. Locus selection is informational configuration, never a confirmation step.

#### Scenario: Opening a WSL-resident project
- **WHEN** the user opens a project at `\\wsl.localhost\Ubuntu\home\user\repo`
- **THEN** the project's locus is the `Ubuntu` distro, and this is visible in the project's settings

#### Scenario: Host-locus project on Windows
- **WHEN** the user opens a project at `C:\dev\repo`
- **THEN** the locus is the host and all execution behaves per the windows-native-runtime capability

### Requirement: Shipped WSL operations execute inside the locus
Git capture, checkpoint, submodule probes, PR-open git, project discovery/detail/worktree cleanup, snapshot generation, settings/visibility git, submit-push, and the Claude handoff write turn SHALL execute inside the project's locus. For a WSL locus, git and Claude execute inside the named distro with distro-native working paths. Windows-side file reads use the matching UNC view. Codex-in-WSL and the remaining review-pipeline locus joins are deferred in this change and SHALL NOT be described as shipped.

#### Scenario: Git capture in WSL mode
- **WHEN** a review captures a patchset for a WSL-locus project
- **THEN** git runs inside the distro against the distro-native repo path, and the captured diff is byte-identical to what git inside the distro reports

#### Scenario: Deferred Codex utility turn is not claimed
- **WHEN** a WSL-locus review would otherwise assign a job to Codex
- **THEN** this slice degrades without a WSL Codex seat and states that Codex execution plus distro session-usage reads are deferred

### Requirement: The Claude handoff harness runs inside the WSL locus
For a WSL-locus project's handoff write turn, the Claude harness SHALL execute the user's distro-resident `claude` installation inside the distro, authenticated by the distro user's own subscription credentials, with capability identical to the native handoff mode: it SHALL be able to write to the repo, run tests, and push. No credential is ever read by Rennet in either locus. Other review-pipeline Claude sites are outside this slice's shipped ceiling.

#### Scenario: Handoff write turn against a WSL project
- **WHEN** a handoff runs for a WSL-locus project whose `claude` lives in the distro
- **THEN** the turn executes in the distro, streams results to the app, and its acting capabilities (write, run, push) are not reduced relative to native mode

### Requirement: Paths translate between Windows and distro views
Where the Windows-side app must touch a distro file directly (rendering, watching, open-in-editor), paths SHALL translate deterministically between the distro-native form (`/home/user/repo/...`) and the Windows view (`\\wsl.localhost\<distro>\...`), and everything handed to an in-distro process SHALL use the distro-native form.

#### Scenario: Round-trip translation
- **WHEN** a finding anchors to `src/app.ts:42` in a WSL-locus project
- **THEN** the in-distro processes see a distro-native absolute path, the Windows-side file reads use the UNC view, and the repo-relative display path is identical in both

#### Scenario: Configured distro differs from the UNC authority
- **WHEN** the execution locus names `Debian` but the project path is under `\\wsl.localhost\Ubuntu\...`
- **THEN** translation stops before execution and reports a plain error naming both `Ubuntu` and `Debian`

### Requirement: Locus health is disclosed honestly
When a WSL locus is unavailable (WSL not installed, the distro missing or stopped, or a required binary absent inside the distro), the UI SHALL state what is missing and where, as plain status. It SHALL NOT silently fall back to host execution for a WSL-locus project, and SHALL NOT add any confirmation gate to proceed once the locus is healthy.

#### Scenario: Distro stopped
- **WHEN** the project's distro is not running or WSL is absent
- **THEN** harness health reports unavailable with a reason naming the distro/WSL, and no host-side substitute executes against the repo
