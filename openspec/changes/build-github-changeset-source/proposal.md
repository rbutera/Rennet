## Why

Rennet has two v1 review modes and one engine (Product & Vision §1): the local
working-tree changeset already ships (`GitCaptureAdapter`), and the GitHub
changeset is the second source that must feed the *same* patchset/review model
and therefore the same canvases. GitHub is authoritative for *identity* (which
SHAs, which threads, whose review); local git is authoritative for *content*
(what changed). The design (GitHub Integration Plan §1/§2/§4) turns that split
into a build with four load-bearing correctness requirements the naive version
gets wrong: (1) auth must reuse `gh auth token` via subprocess and never parse
`hosts.yml` (env-token precedence and keyring-vs-file both silently pick the
wrong token); (2) `X-GitHub-SSO: partial-results` must be a first-class banner on
every response so a truncated surface never renders as complete — the invisible
data-loss failure at the primary dogfood target; (3) the PR diff must come from
the local clone (mapped by repo identity, never a path guess), diffing the
GitHub-supplied `headRefOid`/`baseRefOid` so the whole-repo-context angles can
run, with a visibly-degraded REST fallback; (4) the reviewed head must be pinned
locally at review start so a force-push can never make the reviewed state
unreachable (R28: a remote head update mints a NEW patchset, never rewrites the
active one).

## What Changes

- Add the forge-neutral `ForgePort` seam to `packages/core` (R24): expressed in
  Rennet nouns with capability flags (`supportsThreadResolution`,
  `supportsBatchedReview`, `supportsMultiLineAnchors`, `supportsFileLevelThreads`),
  so degradation is written against capabilities, never `if (forge === 'github')`.
  Add the SSO state, auth-state, and PR-ref/PR value types alongside it.
- Add the GitHub adapter to `packages/adapters`, every effect injected (subprocess,
  HTTP `fetch`, secret store, git) so the whole thing is testable with fakes and
  no test touches the network:
  - `github-sso.ts`: pure `X-GitHub-SSO` header parser → SSO state.
  - `github-auth.ts`: rung-0 `gh auth token` (subprocess, never `hosts.yml`) and
    rung-2 pasted PAT, validated via `GET /rate_limit` headers (`X-OAuth-Scopes`,
    `Github-Authentication-Token-Expiration`, `X-RateLimit-Limit`); three DISTINCT
    failure states (gh-absent / not-logged-in / insufficient-scope), each with its
    own copy; rung-0 token never persisted.
  - `github-forge.ts`: `GitHubForgeAdapter implements ForgePort` — GraphQL deep PR
    fetch into Rennet nouns and REST diff fallback, with `X-GitHub-SSO` parsed on
    EVERY response and surfaced as a first-class result field.
  - `worktree-discovery.ts`: map a GitHub repo's clone URLs onto the discovered
    local worktree set by repo identity (`owner/name` from remotes), never a path
    guess.
  - `git-range-diff.ts`: extract the pure diff-parsing helpers out of
    `git-capture.ts` (byte-identical behaviour preserved) and add a
    range-diff engine that produces a `Patchset` from an explicit `(baseOid,
    headOid)` pair — `rawDiff` byte-identical to `git diff base...head`.
  - `github-changeset-source.ts`: orchestrates authenticate → fetch PR → resolve
    local clone → pin head/base locally → local range diff (or REST fallback with a
    visible degraded badge) → immutable `Patchset`. A pinned head reproduces the
    same patchset regardless of remote movement; a moved remote head mints a new
    patchset (snapshot + auto-reopen, R28).
- Add additive optional fields to `Patchset` (`source`, `degraded`,
  `degradationReason`) so a GitHub-sourced changeset carries its provenance and
  the fallback badge without changing the existing local-capture identity or the
  canvases that consume it.

## Capabilities

### New Capabilities

- `github-changeset-source`: the second v1 review source — authenticate against
  GitHub (rung 0 `gh`, rung 2 PAT), deep-fetch a PR into an immutable patchset via
  the local clone (REST fallback, visibly degraded), detect `X-GitHub-SSO`
  partial-results as a first-class banner, and pin the reviewed head so a
  force-push cannot lose the reviewed state — all behind a forge-neutral port.

### Modified Capabilities

None. `Patchset` gains additive optional provenance fields; the local-capture
path and its identity are unchanged.

## Impact

- Adds `packages/core/src/forge-port.ts` (re-exported from `@rennet/core`) and, in
  `packages/adapters`, `github-sso.ts`, `github-auth.ts`, `github-forge.ts`,
  `worktree-discovery.ts`, `git-range-diff.ts`, and `github-changeset-source.ts`
  plus colocated tests. `git-capture.ts` is refactored to reuse the extracted
  helpers with byte-identical output (its existing tests are the regression gate).
  No new production dependency (subprocess via the existing `execa`; HTTP via
  Node's global `fetch`, injected so tests never hit the network).
- Deferred to follow-up beads (issue #20 is a slice; GitHub plan beads 1-2, 5-9,
  12-14): the publish/mutation pipeline, GitHub App device flow (rung 1), the
  ETag-conditional polling loop, real Electron `safeStorage` wiring, the home
  surface GraphQL query set with the >1000 truncation state, review-thread
  re-anchoring, and the composition-root wiring of a `review.captureGithub`
  command into the desktop IPC map.
