## MODIFIED Requirements

### Requirement: Open-in-editor spawns an absolute executable

For a line-targeted open, the desktop main process SHALL resolve the ordered `EDITOR_CLIS` family to executable absolute paths before spawning an editor. Resolution SHALL consider inherited PATH directories, the user's harvested login-shell PATH directories where a POSIX shell exists, known macOS `.app` bundle executables under system and user Applications directories, and, on Windows, known per-user and system install locations for the same editor family (including their `.cmd` launcher shims).

The launch SHALL preserve the existing `-g <absolute-file>:<line>` argument shape and editor priority. A failed resolved candidate SHALL fall through to the next candidate, and exhaustion SHALL retain the existing OS-level file-open fallback.

#### Scenario: packaged macOS app discovers Cursor without a GUI PATH

- **WHEN** the desktop process has no editor CLI on its ambient or harvested PATH and Cursor's `.app` bundle executable is installed
- **THEN** `review.openInEditor` spawns Cursor by its absolute bundle executable path
- **AND** passes `-g` followed by the absolute review file and requested line

#### Scenario: development PATH behaviour remains live

- **WHEN** an editor CLI is present in the inherited or harvested shell PATH
- **THEN** the resolver returns that CLI's absolute executable path in `EDITOR_CLIS` priority order
- **AND** the line-targeted open succeeds without requiring an app-bundle hit

#### Scenario: one resolved editor fails and the next succeeds

- **WHEN** the first resolved editor executable fails to launch and a later candidate launches successfully
- **THEN** the desktop tries the later absolute executable and reports the open as successful
- **AND** it does not invoke the OS-level fallback

#### Scenario: no line-targeted editor resolves

- **WHEN** no candidate executable resolves or every resolved candidate fails to launch
- **THEN** the existing OS-level open is attempted for the absolute review file
- **AND** no bare editor command is spawned

#### Scenario: Windows install without a PATH entry

- **WHEN** on Windows VS Code is installed per-user under `%LOCALAPPDATA%` but its CLI is not on the inherited PATH
- **THEN** the resolver finds the installed launcher at its known location and the line-targeted open succeeds

## ADDED Requirements

### Requirement: WSL-locus files open via the editor's WSL remote
For a WSL-locus project, a line-targeted open SHALL launch a WSL-remote-capable editor targeting the distro and the distro-native file path, so the editor session operates inside the distro. When no WSL-remote-capable editor resolves, the OS-level fallback SHALL open the file's Windows UNC view.

#### Scenario: Open a distro file at a line
- **WHEN** the user opens `src/app.ts:42` from a review of a WSL-locus project and VS Code with WSL remote support is installed
- **THEN** the editor opens connected to the distro with the cursor on line 42 of the distro-native path
