---
title: Connect to GitHub
description: Rennet authenticates as you through the GitHub CLI, with an OAuth device-flow fallback, and everything GitHub-shaped goes straight from your machine to github.com.
status: planned
tracking: https://github.com/rbutera/rennet/issues/483
---

Rennet talks to GitHub directly from your machine, as you. Its first choice of
credential is the one your terminal already uses: the GitHub CLI. If `gh pr view`
works for you, Rennet works — including on enterprise and SSO organizations.
There is no Rennet backend in the path.

You only need GitHub access to review pull requests or post a review. Reviewing
your own local working tree needs no GitHub account.

## The GitHub CLI is the front door

When a command needs GitHub, Rennet asks the installed `gh` for its token
(`gh auth token`) and uses it for that request. This piggybacks your own
authorization, including SSO: an organization that has approved the GitHub CLI
has already approved the path Rennet rides.

This matters because the alternative structurally cannot reach those
repositories. An OAuth app's token only sees an organization's repos if the app
is authorized on that organization, and enterprise policies usually forbid
members from granting that. Your `gh` token carries your own access instead.

A `gh`-sourced credential has no Rennet-side lifecycle: `gh` owns sign-in,
refresh, and revocation. If `gh` is signed out, run `gh auth login` in a
terminal; Rennet picks the credential up on the next GitHub request.

## Device sign-in, the fallback

Without `gh` installed, Rennet offers its own sign-in through GitHub's OAuth
device flow. It stores one credential in a private file on disk and uses it the
same way.

1. Choose Connect GitHub. Rennet asks GitHub for a device code and shows you a
   short one-time user code.
2. Open `github.com/login/device`, enter the code, and authorize the Rennet
   OAuth app for your account.
3. Rennet polls GitHub in the background until you authorize, then stores the
   token.

The user code expires after about fifteen minutes; if it lapses, start again.
The Rennet OAuth app uses a public client id and no client secret, and every
request in the exchange goes from your machine to `github.com`.

Know the fallback's limit: a device-flow token cannot see an organization's
repositories unless that organization has authorized the Rennet OAuth app, which
enterprise app policies commonly prevent. If an organization repo works in your
terminal but not in Rennet, install `gh` — the front door exists precisely for
this case.

## What the token can do

The device sign-in requests two scopes:

- `repo` reads and writes the repositories your account can already reach, so
  Rennet can read a pull request and post your review. Classic OAuth `repo`
  access is account-wide, not a per-repository pick.
- `workflow` is requested alongside `repo` so a token-authenticated request that
  touches files under `.github/workflows/` is not rejected. Your coding agent's
  branch push uses git's own credentials, not this token.

Whatever its source, the token acts as you: it can do only what your GitHub
account can already do.

## Where the fallback token lives

A `gh` credential stays wherever `gh` keeps it; Rennet stores nothing. The
device-flow fallback stores one credential as a single file named
`github-token` in the daemon's data directory, with owner-only (`0600`)
permissions. Anyone who can read that file can act as you on GitHub until you
disconnect.

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Application Support/Rennet/github-token` |
| Windows | `%APPDATA%\Rennet\github-token` |
| Linux | `~/.config/Rennet/github-token` |

On Windows with a WSL project, the daemon runs inside the distro and keeps the
token there. See [Windows and WSL](./windows-and-wsl.md).

The token stays on the host. It never enters your project files, never gets
staged or committed, and is never sent to the desktop, browser, or mobile client
that shows your review. Rennet stores no other GitHub secret.

## Refresh and expiry

`gh`-sourced tokens have no Rennet refresh story — `gh` handles its own.

For the device-flow fallback: if the OAuth app is configured for expiring user
tokens, GitHub mints an eight-hour access token plus a longer-lived refresh
token, and Rennet rotates the pair for you shortly before expiry or right after
GitHub rejects a call as expired. When GitHub declines a refresh because the
refresh token expired, rotated, or was revoked, Rennet reports that you need to
sign in again.

## Use a personal access token instead

Settings also accepts a personal access token as a side door. Paste one and
Rennet validates it against GitHub before storing it, so a bad paste saves
nothing. A personal access token has no refresh half; Rennet uses it as-is until
you replace or disconnect it. Give it the `repo` and `workflow` scopes.

## Disconnect

Disconnecting deletes the fallback token file; Rennet keeps no copy. A `gh`
credential is disconnected with `gh auth logout`, since it was never Rennet's.
Reviewing your local working tree keeps working; anything that needs GitHub
prompts for a credential again.

## When something is wrong

Rennet separates the failure states so you know what to fix:

- Not connected: no credential available from `gh` or the fallback store. Sign
  in with `gh auth login`, or use the device sign-in.
- Token invalid: the credential was revoked or rejected. Sign in again.
- Insufficient scope: the token lacks a permission the request needs. For `gh`,
  `gh auth refresh -s repo,workflow`; for the fallback, reconnect and approve.
- Network: Rennet could not reach `github.com`. This is never reported as a bad
  token, because an unreachable GitHub says nothing about the token. Check your
  connection and retry.
