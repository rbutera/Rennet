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
- **Token store** — the daemon's owner-only file holding the ONE GitHub token,
  whichever door minted it. `null` is disconnect. The token never reaches the
  renderer.
- **Connect card** — the skippable first-run affordance offering the device
  sign-in. A card, not a wall: working-tree review needs no GitHub, and any
  GitHub-needing surface asks again lazily at its point of need.
- **Not-connected / token-invalid / insufficient-scope** — the three distinct
  renderer-safe failure states of GitHub auth, each with its own copy. Never
  collapsed into one "GitHub unavailable".
