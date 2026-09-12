---
title: Install Rennet
description: Download the Rennet desktop app for macOS or Windows from GitHub Releases, open it once, and set up what it needs.
---

Rennet ships as a desktop app for macOS and Windows. This page gets it onto your
machine and to the first-run welcome; [getting started](./getting-started.md)
takes over from there.

## Before you download

Rennet runs on your machine against tools you already have. Have these ready,
or install them right after the app:

- **Git**, on your `PATH`. Rennet reads branches, diffs, and remotes through it.
- **A coding harness**: Claude Code, Codex, or both. Rennet reviews through your
  installed harness and your own subscription. See
  [install a coding harness](./install-a-coding-harness.md).
- **A GitHub sign-in**, only when you review pull requests or open them. See
  [connect to GitHub](./github-auth.md).

There is no Rennet backend and no account to create. The app talks to GitHub
when you ask it to, and to your harness's model provider when a review runs.

## Download

Every release is published on GitHub:

**[github.com/rbutera/rennet/releases/latest](https://github.com/rbutera/rennet/releases/latest)**

Pick the asset for your machine. `<version>` is the release number, for example
`0.12.0`.

| Machine | Download | Notes |
| --- | --- | --- |
| Mac with Apple silicon | `Rennet-<version>-arm64.dmg` | Signed with a Developer ID and notarized by Apple. |
| Windows 10 or 11, x64 | `Rennet-<version>.Setup.exe` | Unsigned for now, so SmartScreen warns once. See below. |

The other assets on the page serve the app's own updater (`RELEASES`, the
`.nupkg`, the two `.zip` files) and `SHA256SUMS` lists every file's checksum.
You do not need them for a normal install. The Windows `.zip` is a portable copy
that runs without the installer.

Releases do not include an Intel Mac build or a Linux desktop build.

## macOS

1. Open the `.dmg` and drag **Rennet** into **Applications**.
2. Open Rennet from Applications or Spotlight. Gatekeeper accepts it without
   prompts because the app is signed and notarized.
3. The first-run welcome opens. It shows which harnesses it found on this
   machine and walks you to your first project. See
   [first run](./getting-started.md#first-run).

Closing the window leaves Rennet in the menu bar with its daemon running.
Choose **Quit** from the menu bar icon to stop it.

## Windows

1. Run `Rennet-<version>.Setup.exe`.
2. SmartScreen shows **Windows protected your PC** because the installer is not
   yet code-signed. Choose **More info**, then **Run anyway**. Signed installers
   are tracked in [issue #330](https://github.com/rbutera/rennet/issues/330).
3. The installer is per-user, needs no administrator rights, installs under
   `%LOCALAPPDATA%\Rennet`, and launches Rennet when it finishes.
4. The first-run welcome opens. See [first run](./getting-started.md#first-run).

Closing the window leaves Rennet in the system tray with its daemon running.
On Windows you can keep projects on the host or inside a WSL distro; see
[Windows and WSL](./windows-and-wsl.md) for what each needs.

## Verify a download

`SHA256SUMS` on the release page lists the checksum of every asset. Compare it
with the file you downloaded.

macOS:

```sh
shasum -a 256 ~/Downloads/Rennet-0.12.0-arm64.dmg
```

Windows (PowerShell):

```powershell
Get-FileHash "$env:USERPROFILE\Downloads\Rennet-0.12.0.Setup.exe" -Algorithm SHA256
```

## Updates

The installed app checks the same GitHub release feed and offers each new
release with an **Update** control at the sidebar's foot. Nothing installs or
restarts until you choose it. See
[updates and the desktop app](./getting-started.md#updates-and-the-desktop-app).

## Other ways to reach Rennet

The desktop app is the only install today. It runs a local daemon, and that
daemon also serves the same interface to a browser and to paired devices:

- [Rennet in a browser](./browser-rennet.md) opens the running daemon's
  browser client on the same machine.
- [Remote access](./remote-access.md) pairs another machine with a daemon over
  your private network.
- [Rennet on your phone](./mobile.md) is planned, not shipped.

## Uninstall

Remove the app the way your platform removes any app: drag **Rennet** from
Applications to the Trash on macOS, or use **Apps** in Windows Settings.

Rennet keeps its personal state in `~/.rennet` and in the app's per-user data
folder (`~/Library/Application Support/@rennet/desktop` on macOS,
`%APPDATA%\@rennet\desktop` on Windows). Each project you added also holds a `.rennet/` folder that Git ignores
by default. Delete those folders to remove every trace; leave them to pick up
where you left off after a reinstall.

## Next steps

- [Getting started](./getting-started.md) walks the review loop end to end.
- [Install a coding harness](./install-a-coding-harness.md) sets up Claude Code, Codex, or both.
- [Common questions](../concepts/common-questions.md) covers models, credentials, and data.
