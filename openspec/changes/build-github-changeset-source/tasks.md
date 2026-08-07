## 1. Forge-neutral seam + types

- [x] 1.1 Add `packages/core/src/forge-port.ts`: `ForgePort` interface with capability flags (`supportsThreadResolution`, `supportsBatchedReview`, `supportsMultiLineAnchors`, `supportsFileLevelThreads`), Rennet-noun DTOs (`ForgeRepoIdentity`, `ForgePullRequestRef`, `ForgePullRequest`), the `SsoState` union, and the `GitHubAuthState` three-failure union with per-state copy
- [x] 1.2 Re-export the port from `@rennet/core`; add additive optional `source` / `degraded` / `degradationReason` fields to `Patchset` in `packages/types`

## 2. Pure parsers (adapters)

- [x] 2.1 `github-sso.ts`: `parseGitHubSso(headerValue)` → `SsoState` (`none` / `required` / `partial-results` with org ids + authorization URL); handles absent, `required`, and `partial-results; organizations=…` forms
- [x] 2.2 Extract the pure diff helpers from `git-capture.ts` into `git-range-diff.ts` (parse changed paths, numstat counts, visible-limit truncation, untracked-patch synthesis) with byte-identical behaviour; `git-capture.ts` imports them

## 3. Range-diff engine (adapters)

- [x] 3.1 `captureRangePatchset(git, root, baseOid, headOid, baseRef, opts)` → `Patchset` from an explicit commit range; `rawDiff` byte-identical to `git diff base...head`; per-file `PatchFile[]`; `source: "github-local"`
- [x] 3.2 Content-addressed, stable `Patchset.id` for a given `(root, baseOid, headOid)` pair (two captures identical → immutable)

## 4. Auth ladder (adapters)

- [x] 4.1 `github-auth.ts`: rung-0 `gh auth token` via injected subprocess (never `hosts.yml`); rung-2 pasted PAT via injected secret store
- [x] 4.2 Validate via `GET /rate_limit`: read `X-OAuth-Scopes` / `Github-Authentication-Token-Expiration` / `X-RateLimit-Limit`
- [x] 4.3 Three DISTINCT failure states (`gh-absent`, `gh-not-logged-in`, `insufficient-scope`), each with its own copy; rung-0 token never persisted (structurally: no secret-store write on the rung-0 path)

## 5. GitHub forge adapter (adapters)

- [x] 5.1 `github-forge.ts`: `GitHubForgeAdapter implements ForgePort` with GitHub capability flags; GraphQL deep PR fetch into Rennet nouns via injected `httpFetch`
- [x] 5.2 Parse `X-GitHub-SSO` on EVERY response; lift `partial-results` into a first-class `SsoState` on the result, `complete: false`, never an empty list
- [x] 5.3 REST diff fallback (`Accept: application/vnd.github.diff`) parsed into `PatchFile[]`

## 6. Worktree matching (adapters)

- [x] 6.1 `worktree-discovery.ts`: discover local worktrees + their remotes (injected git); `matchWorktree(repoIdentity, worktrees)` maps `owner/name` onto a clone by repo identity, NEVER a path guess

## 7. Changeset source orchestration (adapters)

- [x] 7.1 `github-changeset-source.ts`: authenticate → fetch PR → match worktree → pin head/base → local range diff → immutable `Patchset` (`github-local`)
- [x] 7.2 REST fallback path when unmatched / SHAs unfetchable → `Patchset` (`github-rest`, `degraded: true`, `degradationReason`) — the visible badge
- [x] 7.3 Head pinning: reproduce the pinned patchset byte-identically regardless of remote head movement; a moved remote head mints a NEW patchset, never rewrites the pinned one (R28)

## 8. Tests + gates (acceptance criteria)

- [x] 8.1 A real (fixture) PR opens as a reviewable immutable patchset feeding the same canvases: the GitHub-sourced `Patchset` `decompose()`s to the same chunks as a local patchset of identical content; two captures of the same pinned OIDs are byte-identical (immutable id)
- [x] 8.2 The three auth failure states render distinctly (each a distinct state + distinct copy), asserted
- [x] 8.3 A mocked `X-GitHub-SSO: partial-results` response produces the banner state (org ids + auth URL, `complete: false`), NOT an empty list
- [x] 8.4 Local diff byte-identical to `git diff base...head` (real temp repo); the REST fallback path sets the degraded badge
- [x] 8.5 A simulated force-push (remote head moves) still renders the originally-reviewed patchset from the pinned OIDs; the moved head mints a new, distinct patchset
- [x] 8.6 SSO parser unit fixtures (absent / required / partial-results); worktree matcher unit (match by identity, reject path guess); `git-capture` regression (existing tests green after the helper extraction)
- [x] 8.7 `pnpm check` green across all projects (format, architecture, licenses, lint, typecheck, test, build); verify a zero error count AND the `Successfully ran target` lines
