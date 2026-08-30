---
title: Windows and WSL
description: Run a project on the Windows host, or inside the WSL distro that owns it, where Rennet runs a daemon natively.
---

Rennet supports projects on Windows drives and projects stored inside WSL. It
records where each project's Git and coding-harness commands should run, and for
a WSL project it runs its daemon inside the distro rather than reaching across the
`\\wsl.localhost\…` bridge from Windows.

Public signed Windows installers and auto-update are tracked in
[GitHub issue #330](https://github.com/rbutera/rennet/issues/330).

## Choose where commands run

A project uses either the Windows host or a named WSL distro.

- A path such as `C:\dev\repo` selects the host.
- A path such as `\\wsl.localhost\Ubuntu\home\you\repo` selects the `Ubuntu`
  distro and converts operations to its native `/home/you/repo` path.

Rennet detects this value from the project path. **Settings > Repo > Execution
locus** shows the resolved value and its source. You can choose the host, select
a different distro, or return to automatic detection.

**Pin** stores the detected value as a repository override. **Reset** removes the
override and returns to detection.

Rennet does not substitute a host command when the selected WSL distro is
unavailable. Harness status identifies the distro and reports whether WSL, the
distro, or a required binary is missing.

## Native Windows requirements

```mermaid
flowchart LR
  app[Rennet on Windows] --> git[Git on Windows]
  app --> harness[Claude or Codex on Windows]
  app --> repo[C:\\dev\\repo]
```

- Windows 10 or 11 on x64.
- Git installed on the host.
- Claude Code or Codex installed on the host. Install both for Dual Harness.
- A supported editor for line-targeted file opening.

Rennet finds `.cmd` and `.exe` shims on `PATH` and in common per-user locations,
including `%APPDATA%\npm`, `%LOCALAPPDATA%\Programs`, Scoop, Bun, and Volta. A
POSIX shell is not required.

On Windows, Codex must be installed as the Codex CLI. The binary inside the
Microsoft Store ChatGPT package cannot be executed by another application.

See [Install a coding harness](./install-a-coding-harness.md) for both supported
harnesses and their verification commands.

Rennet searches for Visual Studio Code, Cursor, VSCodium, and Sublime Text on
`PATH` and in their standard per-user and system install locations.

The command menu opens with `Ctrl+P` (search-first) or `Ctrl+K` (command-first).

## WSL requirements

For a WSL project, Rennet runs a Rennet daemon inside the distro. The Windows
shell reaches that daemon over the loopback address, which a WSL 2 listener on
`127.0.0.1` exposes to Windows over `localhost` with no configuration.

```mermaid
flowchart LR
  shell[Rennet shell on Windows] -->|spawns via wsl.exe| daemon[Rennet daemon in the distro]
  shell -->|localhost WebSocket| daemon
  daemon --> git[Git]
  daemon --> harness[Claude or Codex]
  daemon --> repo[/home/you/repo native fs/]
```

- WSL 2 with the selected distro installed.
- Node.js available inside the distro. Rennet runs the daemon on the distro's own
  Node and finds a version-managed install (nvm, asdf, fnm) through your login
  shell. A distro with no Node reports that plainly instead of falling back to the
  host.
- Git and Claude Code or Codex installed inside that distro. Install both for
  Dual Harness.
- The project added by picking the distro as the **source** in [Add a
  project](./getting-started.md#add-a-project): Rennet lists every installed
  distro automatically, then browses its native filesystem directly — no
  `\\wsl.localhost\...` path to type.

Claude Code and Codex use their own authenticated sessions inside the distro.
Rennet invokes those harnesses but does not read their credentials.

## How a WSL project runs

Rennet delivers its daemon into the distro's native filesystem, copied once per
version to `~/.rennet/server/<version>/`, and runs it there. The shell keeps its
host daemon for host-locus projects and spawns one daemon per WSL distro for
WSL-locus projects, routing each project to the daemon for its execution locus.
Opening a WSL folder connects the app to that distro's daemon.

Because the daemon runs inside the distro, everything happens on native Linux:

- Git capture, checkpoint, submodule probes, branch push, pull request setup, and
  worktree cleanup.
- Project discovery, project detail, snapshot generation, and Git-backed
  visibility settings.
- Claude coding-agent turns, including commands that edit, test, or push.
- Review model turns for lens board drafting, findings, knowledge enrichment,
  symbol lookup, pull request drafting, round reports, and board composition.
- Codex app-server turns when Codex is installed inside the distro. An agentic
  Codex turn connects to Rennet over the distro's own loopback, so no
  cross-boundary networking is involved.

## Filesystem and editor access

The distro daemon reads the repository through the distro's native filesystem and
watches it with native `inotify`. It does not poll across the `\\wsl.localhost\…`
bridge, so a Windows daemon's 9P costs do not apply.

**Open in editor** uses the editor's WSL remote support so a `path:line` target
opens inside the distro.

## Credential and publish boundaries

Rennet does not read Claude Code or Codex credentials on either host. GitHub
credentials from `gh` remain owned by the CLI in that environment. OAuth
fallback and paired-device tokens remain separate Rennet credentials.

A WSL daemon asks the distro's own `gh` for its primary GitHub credential. When
that is unavailable, the daemon keeps Rennet's fallback credential in its own
distro-native data directory.

GitHub receives a review or pull request only through the corresponding outbound
operation. A coding-agent turn can push its working branch because opening a pull
request requires that branch to exist on the remote.

Rennet does not redirect a WSL project into a different distro. If the configured
and detected distros disagree, status reports both and the command stops.

## Next steps

- [Getting started](./getting-started.md) covers the main review loop.
- [Remote access](./remote-access.md) covers paired devices and daemon binding.
- [Desktop packaging](https://github.com/rbutera/rennet/blob/main/apps/desktop/PACKAGING.md) documents developer packaging work.
