# Spec Delta

## Purpose

Detects the source-control command-line tools Rennet depends on (`git`, `git-lfs`) for each execution locus, reports their state honestly, and installs a missing one when the user asks.

## ADDED Requirements

### Requirement: Git and Git LFS are detected per execution locus

Rennet SHALL probe `git` and `git-lfs` for each execution locus with the same resolved environment the daemon uses for git work. Each SHALL report available (with proven version), absent (with reason), or unaskable. `git-lfs` SHALL be reported as not required when no project on that locus uses Git LFS.

#### Scenario: git-lfs is installed but outside the launch PATH
- **WHEN** `git-lfs` exists only in `/opt/homebrew/bin` and the app was launched from Finder
- **THEN** Settings → Environments shows Git LFS as available with its version

#### Scenario: git-lfs is missing
- **WHEN** no `git-lfs` binary resolves on the locus
- **THEN** the Git LFS row reads as not installed and offers Install for me

### Requirement: A missing tool can be installed on request

A missing `git` or `git-lfs` SHALL offer **Install for me** wherever Rennet reports it (Settings, first-run tools stage, the preparation failure block, the large-file prompt). Activating it SHALL run the platform installer, stream its output, re-probe, and report the result. The command SHALL be shown alongside. Where no installer is available, Rennet SHALL show manual instructions instead.

#### Scenario: Install git-lfs with Homebrew
- **WHEN** the user activates Install for me for Git LFS on macOS with Homebrew present
- **THEN** Rennet runs `brew install git-lfs` then `git lfs install`, shows the output as it streams, and the row turns available when the re-probe succeeds

#### Scenario: No installer available
- **WHEN** Homebrew is not installed
- **THEN** Rennet shows the manual install command and a link to the Git LFS install instructions instead of the button

#### Scenario: Install fails
- **WHEN** the installer exits non-zero
- **THEN** Rennet shows a plain-language failure with the installer's output available as detail, and the tool stays reported as not installed

#### Scenario: Steps succeed but the tool still is not found
- **WHEN** every install step exits zero and the re-probe still reports the tool missing
- **THEN** Rennet reports a plain-language failure, not installed

### Requirement: An install acts for nobody when it lands

When an install finishes, Rennet SHALL show its result and SHALL NOT send any action on the user's behalf (no large-file answer, no retry). The surface SHALL make the user's next step available and obvious.

#### Scenario: Install lands after the user cancelled
- **WHEN** the user starts Install for me, dismisses the dialog, cancels the preparation, and the install then finishes
- **THEN** no large-file answer and no retry is sent

### Requirement: A reconnect never runs an installer again

After a dropped connection the client SHALL ask about its install again under the same command id as a rejoin. A rejoin SHALL join a run still going or return its retained verdict, and SHALL NOT start an installer. When the daemon knows neither, it SHALL answer that the outcome is unknown, and the client SHALL say plainly that Rennet lost track of the install and offer Check again (display only) and Install for me (a fresh request). Only a rejoin request SHALL receive the unknown outcome.

#### Scenario: Daemon restarted during the install
- **WHEN** the connection drops mid-install and the daemon that answers afterwards has no record of the command
- **THEN** the installer does not run again, and the button says Rennet lost track of the install with Check again and Install for me

#### Scenario: Re-joined output
- **WHEN** the client re-joins a running install after more than 64,000 characters of output
- **THEN** the snapshot it receives is exactly the last 64,000 characters, never shorter than what the client already shows
