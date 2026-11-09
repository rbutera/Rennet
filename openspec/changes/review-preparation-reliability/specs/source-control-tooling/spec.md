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
