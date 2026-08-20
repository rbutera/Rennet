# Rennet — ubiquitous language

A glossary only: the canonical meaning of terms the product and codebase share.
No implementation detail lives here; decisions go to `docs/` and ADRs.

## GitHub account

- **Device sign-in** — the one-time GitHub OAuth device flow: Rennet shows a
  short user code, the user enters it at github.com/login/device, GitHub mints
  a token scoped to `repo` and `workflow`. Rennet's only first-party GitHub
  auth; there is no gh-CLI dependency and no client secret.
- **Side door** — pasting a personal access token in Settings instead of the
  device sign-in. Feeds the same token store; validated before it is kept.
- **Token store** — the daemon's owner-only file holding the ONE GitHub
  credential (access token, plus the rotating refresh half when the app mints
  expiring tokens), whichever door minted it. `null` is disconnect. The token
  never reaches the renderer.
- **Connect card** — the skippable first-run affordance offering the device
  sign-in. A card, not a wall: working-tree review needs no GitHub, and any
  GitHub-needing surface asks again lazily at its point of need.
- **Not-connected / token-invalid / insufficient-scope** — the three distinct
  renderer-safe failure states of GitHub auth, each with its own copy. Never
  collapsed into one "GitHub unavailable".
- **GitHub egress** — the daemon's single bounded path for every github.com
  request (device sign-in, PR reads, release checks). Each request carries one
  aggregate deadline and absorbs a momentary connect blip; a bounded failure is
  named a network problem, never a credential one, so a fine token is never
  blamed for an unreachable host.

## Reviewing pull requests

- **Retrospective review** — a read-only review of an already-merged (or any)
  pull request: same engine, same frozen diff, but nothing can ever be posted
  back. The mode for reading history rather than reviewing live work.
- **Managed clone** — a repository clone Rennet made for itself (blobless, full
  history) because no matching local clone was known when a PR was opened.
  Lives in Rennet's own data directory; the user's own clone always wins when
  one matches.
- **PR worktree** — the detached checkout at the exact reviewed commit that
  every PR review opened from a clone gets: an executable copy of the change,
  retrospective included. Replaced when the PR's head moves.
- **Setup file** — `.rennet/setup`: one shell command per line, run
  automatically in a fresh PR worktree to make it runnable (install deps,
  bootstrap). Failure is honest status on the review, never a block.

## Desktop presence

- **Logo menu** — the top-left Rennet mark as a button: it opens an anchored
  panel of app-level destinations (Settings, Back to projects, Documentation)
  plus, when an update is staged, a highlighted restart row and the version at
  its foot. The window's one always-present menu, since the native menu bar
  carries no Rennet commands of its own.

- **Owned daemon** — the local review daemon this app is responsible for: the
  one claimed by the discovery file in the app's own data directory, regardless
  of who spawned it (the app or the CLI). The only daemon the app's complete
  exit is allowed to stop.
- **Attached daemon** — a daemon the app is merely a client of, running
  somewhere the app does not own (e.g. another machine). The app never stops
  it; that daemon belongs to its own host.
- **Tray-resident** — the state of the desktop shell when it has no open window
  but is still present and reachable from the tray (macOS menu bar, Windows
  tray), daemon and streams untouched. Closing the last window enters it;
  quitting completely is the only way out.
- **Update-ready** — an update has been downloaded and staged, ready to apply
  on restart. A single state surfaced in two places at once: the in-app badge
  and the tray (its icon dot and restart line).
