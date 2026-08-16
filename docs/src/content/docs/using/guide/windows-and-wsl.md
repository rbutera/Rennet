---
title: Windows and WSL
description: Run Rennet natively on Windows, or drive a project that lives inside a WSL distro, with the execution locus chosen per project.
---

Rennet runs on Windows two ways. A project on a Windows drive uses the host. A
project that lives inside a [WSL](https://learn.microsoft.com/windows/wsl/)
distro can route the supported git and Claude handoff operations into that
distro while the Windows app keeps its filesystem view through UNC. Which one a
project uses is its **execution locus**, and Rennet picks it automatically from
the project's path.

## The execution locus

Every project carries an execution locus: the **host**, or a named **WSL distro**.

- Open a project at a Windows path like `C:\dev\repo` and its locus is the host.
- Open a project that resides in a distro — a `\\wsl.localhost\Ubuntu\home\you\repo`
  path — and its locus is that distro (`Ubuntu` here). The operations listed in
  [What runs in the distro](#what-runs-in-the-distro) use its distro-native path.

The locus is a plain setting, not a prompt. You can see it and change it under a
project's settings (**Execution locus**): force the host, name a different WSL
distro, or reset to the auto-detected value. There is no confirmation step — the
setting simply takes effect.

The row also shows **where the value came from** (Explain): `detected` when it is
auto-detected from the path, `repo` when you have set an explicit override. When the
locus is auto-detected, a **Pin** control writes the currently detected distro as an
explicit override, so a later path or detection change no longer moves it — useful
for freezing a distro you have committed to. When it is overridden, a **Reset**
control clears the override and returns the row to auto-detection. Both are plain
config writes with no confirmation.

Rennet never silently substitutes one locus for another. If a WSL locus is
unavailable — WSL not installed, the distro stopped, or a required binary missing
inside it — the harness status says so plainly and names the distro. It does not
fall back to a host binary for a WSL project.

## Native Windows

```mermaid
flowchart LR
  app[Rennet on Windows] --> git[git / gh on the host]
  app --> claude[claude / codex on the host]
  app --> repo[C:\\dev\\repo]
```

**Requirements**

- Windows 10/11 (x64).
- `git` on the host, and `gh` if you review or submit GitHub pull requests.
- A coding harness on the host — `claude` (and optionally `codex`) — installed any
  usual way. Rennet finds `.cmd`/`.exe` shims on your `PATH` and in the common
  per-user install locations (`%APPDATA%\npm`, `%LOCALAPPDATA%\Programs`, scoop,
  bun, volta), so it works even when the GUI-inherited `PATH` is missing an entry.
  No POSIX shell (zsh/bash) is required.
- An editor for line-targeted open — VS Code, Cursor, VSCodium, or Sublime — is
  found at its per-user or system install location as well as on `PATH`.

Keyboard shortcuts show Windows labels: the command palette is `Ctrl+K`, history
is `Ctrl+[` / `Ctrl+]`.

## WSL

```mermaid
flowchart LR
  app[Rennet on Windows] -->|wsl.exe| distro[Ubuntu distro]
  distro --> git[shipped git operations]
  distro --> claude[Claude handoff turn]
  distro --> repo[/home/you/repo]
```

Keep your project, toolchain, and harness inside the distro exactly as you already
do. Rennet drives them there.

**Requirements**

- WSL 2 with your distro installed and running.
- Inside the distro: `git` and `claude`, authenticated with your own subscription
  as usual. Rennet reads no credential — the distro's own `claude` login is used.
- Open the project by its distro path (`\\wsl.localhost\<distro>\home\you\repo`),
  or open it from inside the distro; the locus is detected from the path.

### What runs in the distro

This slice routes these operations through the configured WSL distro:

- git capture, checkpoint, submodule probes, and submit-push;
- local PR-open git, project discovery/detail, and worktree cleanup;
- snapshot generation and settings/visibility git operations;
- the write-enabled Claude handoff turn, including tests or pushes the harness runs.

Open-in-editor uses the editor's WSL remote so `path:line` lands on the distro
file. Rennet watches the repo by polling on WSL because inotify events do not
cross the WSL filesystem boundary reliably. Windows-side untracked/spec reads,
snapshot identity, watching, and editor launch use the matching UNC path.

### Current ceiling

Codex execution inside WSL is deferred: its executor still owns host-side scratch
and session paths. A WSL workflow therefore degrades to the Claude seat where that
seat is wired; it does not substitute a Windows Codex binary. The remaining
review-pipeline Claude/locus joins are also deferred, so this slice does not claim
that every read or model turn in a full review runs in the distro.

## What Rennet never does

- It never reads a credential, on either locus. The harness authenticates with
  your own subscription.
- It never publishes anything a person can see until you sign it. Pushing a review
  branch is not publishing — the coding-agent loop pushes freely, because
  submitting a pull request requires a push.
- It never silently changes a WSL path to a differently configured distro. The
  status names both distros and stops the wrong-target operation.

## Next steps

- [Getting started](/using/guide/getting-started/) — the shortest tour of a review.
- Packaging (for developers) is documented in `apps/desktop/PACKAGING.md`.
