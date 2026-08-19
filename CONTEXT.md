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

## Desktop presence

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
