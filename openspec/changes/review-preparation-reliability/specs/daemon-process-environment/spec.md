# Spec Delta

## Purpose

Defines the process environment the Rennet daemon resolves at startup and hands to every child it spawns, so tools resolve the same way they do in the user's terminal, however the app was launched.

## ADDED Requirements

### Requirement: The daemon resolves the user's tool PATH at startup

On a POSIX host the daemon SHALL resolve PATH before serving: the user's login-shell PATH (read with delimiters, bounded by a timeout), else the session-manager PATH (`launchctl getenv PATH` on macOS), unioned with the inherited PATH and the platform's package-manager directories (`/opt/homebrew/bin`, `/usr/local/bin` on macOS). Order SHALL be preserved and duplicates removed.

#### Scenario: Launched from the Dock
- **WHEN** the desktop app is launched from Finder with PATH `/usr/bin:/bin:/usr/sbin:/sbin` and the user's login shell exports `/opt/homebrew/bin`
- **THEN** the daemon's PATH contains `/opt/homebrew/bin` before it serves its first request

#### Scenario: Login shell is slow or noisy
- **WHEN** the login shell prints banner text or does not answer within the timeout
- **THEN** the daemon ignores the banner text, falls back to the session-manager PATH and the curated directories, and still starts

### Requirement: Every child process inherits the resolved environment

Every process the daemon spawns, including git and anything git runs (filters, hooks, credential helpers), SHALL inherit the resolved PATH. No spawn site SHALL substitute a narrower PATH.

#### Scenario: Git runs a configured LFS filter
- **WHEN** the user's git config requires the LFS filter and `git-lfs` is installed in a package-manager directory
- **THEN** a worktree checkout started by the daemon finds `git-lfs` and the filter runs

### Requirement: A daemon from an older environment is not reused

A daemon that predates the running app version SHALL be replaced on the next app start, so a fix to environment resolution reaches the user without them quitting Rennet by hand.

#### Scenario: Upgrade with a daemon still running
- **WHEN** the user updates Rennet while the previous version's daemon is still running
- **THEN** the next app start replaces that daemon and the new one resolves PATH as specified
