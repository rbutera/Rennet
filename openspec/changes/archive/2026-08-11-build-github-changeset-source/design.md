# Design — GitHub changeset source (issue #20)

## The seam and the split

One engine, one review-state model, two sources. The local source
(`GitCaptureAdapter`) already produces a `Patchset`; this slice produces the
*same* `Patchset` from a GitHub PR so both feed the identical decomposition /
canvas pipeline. The authority split is the whole design:

- **GitHub is authoritative for identity**: which SHAs (`headRefOid`/`baseRefOid`),
  which threads, whose review. Fetched via GraphQL.
- **Local git is authoritative for content**: what changed. Diffed locally from
  the clone once the SHAs are fetched, because the review angles need the whole
  repo, not just the diff.

`ForgePort` (in `core`) is forge-neutral — Rennet nouns only, capability flags,
an opaque `forgeRef` per entity — so GitLab/Gitea are a future *implementation*,
not a future rewrite. All GitHub vocabulary (GraphQL documents, `line`/`side`
translation, degradation) lives in the GitHub adapter.

## Effects are injected; no test touches the network

Following the `harness-discovery` precedent, every side effect is a narrow
injected function: `runGh` (subprocess), `httpFetch` (HTTP), `git` (subprocess),
`secretStore` (token vault). The real composition binds `execa`, Node global
`fetch`, and a host secret store; tests bind fakes and a real temporary git repo.
This also proves, structurally, that the rung-0 token never reaches persistence.

## Auth ladder (rungs 0 and 2)

`gh auth token` via subprocess, NEVER `hosts.yml` — a machine can have an
env-selected credential and a stored credential at once with different scopes, and
`gh` may use the keyring instead of the file. Then validate immediately with `GET
/rate_limit`, reading `X-OAuth-Scopes` (scope check), `Github-Authentication-
Token-Expiration` (expiry warning), `X-RateLimit-Limit` (poll budget). Three
distinct machine states, each carrying its own user-facing copy so the future UI
just displays it:

- `gh-absent` — spawning `gh` fails ENOENT.
- `gh-not-logged-in` — `gh auth token` exits non-zero.
- `insufficient-scope` — a token was obtained but `X-OAuth-Scopes` lacks `repo`.

Rung 2 is a visible pasted-PAT option through the injected secret store, validated
by the same `/rate_limit` path. The rung-0 token is held in adapter memory for the
process lifetime only and never persisted; anything Rennet mints (rung-2 PAT)
would go through `safeStorage` with `isEncryptionAvailable()`/
`getSelectedStorageBackend()` guards in the real host (deferred wiring; the port
is defined and injected here).

## SSO partial-results on EVERY response

`parseGitHubSso` is a pure function of the `X-GitHub-SSO` header. The adapter runs
it on every HTTP response and lifts `partial-results` into a first-class result
field (`SsoState`) carrying the org ids and the (1-hour) authorization URL. A
`partial-results` 200 with a valid-looking list is INCOMPLETE — the result marks
`complete: false` so the surface renders a banner, never an empty/short list as
"you have no PRs".

## Local-diff-first, with a visibly degraded REST fallback

1. Deep-fetch the PR (GraphQL) → `headRefOid`, `baseRefOid`, `nameWithOwner`,
   file list, threads, checks — Rennet nouns.
2. Map the PR's repo onto the local worktree set by repo identity (`owner/name`
   parsed from each worktree's remotes), NEVER a path guess. Worktree identity is
   the git-common-dir, per the workspace model.
3. If matched: fetch (pin) the two OIDs locally, then `git diff base...head`
   locally → `Patchset` (`source: "github-local"`, `degraded: false`). `rawDiff`
   is byte-identical to `git diff base...head` (deterministic normalizer flags
   `--no-ext-diff --no-textconv` only disable machine-specific config; they are
   no-ops on a clean repo).
4. If unmatched or the SHAs are unfetchable: REST diff
   (`Accept: application/vnd.github.diff`) parsed with the same helpers →
   `Patchset` (`source: "github-rest"`, `degraded: true`,
   `degradationReason`) — the visible degraded badge. The whole-repo-context
   angles cannot run on this path, which the badge announces.

## Head pinning and force-push (R28)

At review start `pinObjects` fetches and keeps `headRefOid`/`baseRefOid` locally
(the real impl `git fetch <remote> <oid>` then writes a local `refs/rennet/pins/*`
ref so a remote force-push cannot GC them; the fake asserts reachability). The
source then always diffs the *pinned* OIDs, so:

- Re-rendering the original review reproduces the byte-identical patchset no matter
  what the remote head now is — the reviewed state is unreachable-proof.
- A detected head move mints a NEW patchset for the new head; it never rewrites the
  pinned one (snapshot + auto-reopen, R28). The `Patchset` id is content-addressed,
  so two captures of the same pinned OIDs are the same immutable patchset.

## Why additive `Patchset` fields, not a wrapper

The acceptance requires the GitHub changeset to "feed the same canvases as a local
diff" AND to "show its badge" on the fallback path. Keeping the output a `Patchset`
(the exact type the decomposition floor consumes) is what makes the first true; the
badge is three optional additive fields (`source`, `degraded`, `degradationReason`)
that the existing local path leaves undefined and the identity hash ignores, so the
local capture is byte-for-byte unchanged.

## Extracting the diff helpers

`git-capture.ts`'s pure helpers (`parseChangedPaths`, `parseCounts`, `visible`,
untracked-patch synthesis) move to `git-range-diff.ts` and are reused by both the
working-tree capture (unchanged behaviour, its tests are the regression gate) and
the new range-diff engine, so both sources parse a diff identically.
