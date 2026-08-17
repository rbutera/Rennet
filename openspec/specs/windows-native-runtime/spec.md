# windows-native-runtime Specification

## Purpose
Rennet's desktop app runs natively on Windows: binaries resolve under Windows PATH semantics, no POSIX shell is required, shortcut labels match the platform, and paths survive drive letters and backslashes.
## Requirements
### Requirement: The desktop app runs on win32
The desktop app SHALL start in development mode and package into an unsigned distributable on `win32`. Windows release engineering (code signing, installer UX, auto-update) is explicitly out of scope for this capability and SHALL be tracked as its own slice.

#### Scenario: Dev run on Windows
- **WHEN** a developer runs the desktop start target on a Windows machine
- **THEN** the app launches, opens a project, and reaches the review surface

#### Scenario: Unsigned package on Windows
- **WHEN** the desktop package target runs on `win32`
- **THEN** a launchable unsigned artifact is produced with the harness SDK's vendored executables stripped, matching the existing packaging rule

### Requirement: Binary resolution understands Windows PATH semantics
On Windows, resolving any external binary (`claude`, `codex`, `git`, `gh`, editor CLIs) SHALL split PATH on the platform delimiter (`;`), SHALL recognise directly launchable Windows executable shims (`.exe`, `.cmd`, `.bat`), and SHALL include curated Windows install locations (per-user npm/bun/scoop installs, `%LOCALAPPDATA%` program directories) alongside PATH entries. PowerShell scripts are not a resolved executable form in this slice.

#### Scenario: claude installed as a .cmd shim
- **WHEN** the user's `claude` is an npm-installed `claude.cmd` on a `;`-delimited PATH
- **THEN** discovery resolves it to an absolute path and proves it by executing it for a version

#### Scenario: gh installed but not on the GUI-inherited PATH
- **WHEN** `gh.exe` exists in a curated Windows install location but the Electron-inherited PATH omits it
- **THEN** the forge detection still finds and reports it

### Requirement: No POSIX login shell is required
On Windows, PATH harvesting and binary probing SHALL NOT depend on `$SHELL`, zsh, or any POSIX shell. Probing SHALL execute candidates directly (or via the platform's native launcher for script shims), never via `sh -c`.

#### Scenario: No POSIX shell present
- **WHEN** the app starts on a Windows machine with no WSL and no POSIX shell installed
- **THEN** discovery completes using the process environment and curated locations, without attempting to spawn a POSIX shell

### Requirement: Shortcut labels are platform-aware
Displayed keybinding labels SHALL show `Ctrl`-based labels on Windows and `⌘`-based labels on macOS. A `mod+` chord SHALL require the platform-primary modifier: `ctrlKey` on Windows/Linux and `metaKey` on macOS.

#### Scenario: Command palette label on Windows
- **WHEN** the command palette is shown on Windows
- **THEN** its keybinding renders as `Ctrl+K`, and pressing Ctrl+K opens it

#### Scenario: Control is not Command on macOS
- **WHEN** the command palette binding is `mod+k` on macOS
- **THEN** Command+K opens it and Control+K does not match it

### Requirement: Path handling survives Windows absolute paths
Repo-relative paths SHALL remain `/`-normalised everywhere they cross package boundaries (the existing convention). Absolute-path handling — project keys, worktree discovery, escape-to-filesystem mapping, within-root containment checks — SHALL be correct for drive-letter and UNC absolute paths, including case-insensitive drive letters.

#### Scenario: Project under a drive letter
- **WHEN** a project lives at `C:\dev\repo`
- **THEN** its `.rennet` project key, worktree matching, and open-in-editor containment checks behave identically to a POSIX absolute path, and all repo-relative paths shown or stored use `/`

