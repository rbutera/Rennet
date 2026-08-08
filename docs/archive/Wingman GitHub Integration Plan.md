---
tags: [rennet, github, plans]
categories: [project]
status: active
created: 2026-08-04
updated: 2026-08-05
---

# Rennet GitHub Integration Plan

> [!IMPORTANT] Current implementation authority, 2026-08-05
> Product name is **Rennet** and the forge-neutral boundary is `ForgePort`. [[Rennet Contracts and Rulings]] and [[Rennet Architecture Contracts]] override stale terminology below. Local author-side review produces a PR title/body preview and never pushes. Every GitHub mutation is a separate explicit, idempotent human action. Remote-head movement creates a new immutable patchset; Rennet updates only affected analyses and never mutates the prior synthesis in place. Route handoff is removed, Subtraction is not an angle, and content hashes are lineage evidence rather than identity.

The GitHub layer for [[Code Review Harness App]]. The product name is Rennet; the filename is retained only to preserve existing Obsidian links. Personal product, not the enterprise client work.

North star, verbatim: "install and login with GitHub and then have access to all the pull requests and leverage the Claude code, oh my pi, and/or codex that I already have installed with zero config."

## How this was verified

Every API claim below is backed by one of three things, marked inline:

- **[introspected]** live GitHub GraphQL schema, queried via `gh api graphql` on 2026-08-04. Calibration: a query for a deliberately bogus type name returned null, so a null result means absent rather than "the query silently failed".
- **[historical private calibration]** read-only calls were made against an authorised enterprise repository on 2026-08-04. Repository, pull-request, organisation, token, and response-specific details are intentionally removed from this repository. Treat those observations as hypotheses until replicated against a permitted personal or public fixture.
- **[docs]** current GitHub or Electron documentation, fetched 2026-08-04, with the URL given.

Where a measurement contradicted received wisdom, I re-ran it with a positive control. One did (see the 304 finding), and the first reading was wrong.

Nothing in this plan was published, posted, or written to GitHub. The publish pipeline is specified but untested, and that is called out as the top v1 spike.

---

## 1. Auth ladder

### Decision

Four rungs, tried in order, and the product must degrade gracefully down them rather than treat rung 1 as the only path.

| Rung | Mechanism | When it applies | Verdict |
|---|---|---|---|
| 0 | Shell out to `gh auth token` | User has `gh` installed and logged in | **Primary. The zero-config path.** |
| 1 | GitHub App device flow, public client ID, no secret | No `gh`, personal or small-org repos | Fallback. Works for individuals, blocked at locked-down enterprises. |
| 2 | Paste a personal access token | SSO enterprise where rung 1 is refused | **The escape hatch that actually works at the enterprise client.** Not a wart; ship it deliberately. |
| 3 | Read-only, no GitHub at all | Offline, or user declines | Local git changesets only. The product still works. |

### Rung 0: reuse `gh`, and shell out rather than read the file

**Shell out to `gh auth token`. Never parse `~/.config/gh/hosts.yml` directly.**

This is not a style preference, it is a correctness requirement. A machine may have an environment-selected credential and a separately stored credential at the same time:

```
$ gh auth status
  ✓ environment-selected credential     <- active
  ✓ credential-store entry              <- inactive
```

```
$ gh auth token                                  -> active credential
$ env -u GITHUB_TOKEN -u GH_TOKEN gh auth token  -> stored credential
```

An app that read `hosts.yml` would silently pick the wrong token, with a different scope set, and would have no way to know. [docs] The precedence is documented: "`GH_TOKEN`, `GITHUB_TOKEN` (in order of precedence) ... takes precedence over previously stored credentials" ([gh manual, environment](https://cli.github.com/manual/gh_help_environment)).

Second reason: **the file is not always the store.** `gh` uses the system keyring when one is available and falls back to configuration storage when it is not. `gh auth token` abstracts both. Reading the file can work on one machine and fail on another, which is the worst possible failure shape for a zero-config claim.

**What to do with the token once you have it:**

1. Never persist it. Re-shell `gh auth token` per session, or cache in memory for the adapter-process lifetime only. It is `gh`'s credential, not Rennet's. Raw bearer tokens never enter core events, logs, settings, project context, or renderer projections.
2. Validate immediately with `GET /rate_limit` and read three headers:
   - `X-OAuth-Scopes` to check for the permissions required by the selected operation.
   - `Github-Authentication-Token-Expiration` to warn ahead of expiry instead of failing mid-review.
   - `X-RateLimit-Limit` to size the polling budget.
3. Handle the `gh`-absent, `gh`-not-logged-in, and `gh`-token-lacks-`repo` cases as three distinct UI states, not one "GitHub unavailable".

**Why this is the right primary and not just convenience:** an open-source desktop binary cannot hold a client secret, and the alternatives all require someone other than the user to say yes (see rung 1). `gh` is the only path where the user has already personally completed every authorization step, including SSO. The stack note ([[References/Desktop and Mobile Stack 2026]] section 8) reached the same conclusion; this plan adds the env-precedence and keyring-vs-file mechanics, which that note does not cover and which are where the implementation actually breaks.

### Rung 1: GitHub App device flow, not OAuth App

Both OAuth Apps and GitHub Apps support device flow, and [docs] "The `client_secret` is not needed for the device flow" ([authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)). Device flow must be explicitly enabled in the app's settings. Endpoints are `POST https://github.com/login/device/code` then `POST https://github.com/login/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`; poll errors are `authorization_pending`, `slow_down` (adds 5s), `expired_token`, `access_denied`, `incorrect_device_code`; device codes expire after 900 seconds.

**Choose GitHub App over OAuth App**, for three reasons:

1. **Scope granularity.** An OAuth App with `repo` gets read/write on every repo the user can touch, including ones Rennet has no business reading. A GitHub App gets per-repository installation and per-permission grants (Pull requests: read and write; Contents: read; Metadata: read). For a tool whose entire pitch is "no Rennet backend", asking for blanket `repo` on install is a positioning own-goal before the first screen.
2. **Token lifetime.** [docs] GitHub App user access tokens "expire after 8 hours" with a refresh token valid for `15897600` seconds (6 months), and expiry is optional but should be left on ([generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)). A stolen 8-hour token is a much smaller incident than a stolen non-expiring OAuth token.
3. **Org policy shape.** OAuth Apps hit organization OAuth app access restrictions, where [docs] "organization members and outside collaborators cannot authorize OAuth app access to organization resources" and apps "need owner approval" ([about OAuth app access restrictions](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions)). GitHub Apps use installation instead, which is a different queue but at least a queue an org admin recognises.

**The honest caveat, and it is the one that matters:** neither fallback works at a locked-down enterprise without someone else's approval. An OAuth App needs an org owner to approve it. A GitHub App needs an org owner to install it. At the enterprise client, rung 1 is dead on arrival for `enterprise-org` repos. This is why rung 2 exists and why rung 0 is not merely the fast path.

### Rung 2: paste a token

Ship a "paste a personal access token" field. Not as a hidden power-user setting, as a visible third option with a short explanation of when to use it.

At some SSO enterprises this is the only rung that clears without a third party, because the user authorizes their own token against the organisation themselves. Verify this only against an authorised fixture.

### Token storage on macOS

For anything Rennet mints (rung 1 refresh tokens, rung 2 pasted tokens), use Electron `safeStorage`. [docs] ([Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)) it backs onto Keychain Access on macOS, DPAPI on Windows, and `kwallet` / `kwallet5` / `kwallet6` / `gnome-libsecret` on Linux.

Three rules the docs make necessary:

1. **Call `isEncryptionAvailable()` and act on `false`.** On Linux with no secret store, safeStorage falls back to `basic_text`, which the docs describe plainly: items "will be unprotected as they are encrypted via hardcoded plaintext password". Detect this via `getSelectedStorageBackend()` and refuse to persist a token, forcing re-auth each launch, rather than writing a token to disk under a fake lock.
2. **Do not call it before `app.ready`.** `isEncryptionAvailable()` only returns true on Linux after ready, and `getSelectedStorageBackend()` returns `unknown` before it.
3. The synchronous API can block on macOS and Linux while collecting user input. Do it once at startup, off the interaction path.

The rung-0 token is never stored at all, so none of this applies to the primary path. That is a feature: the zero-config path also has the smallest secret-handling surface.

---

## 2. Read surfaces

### Home surface: all branches and PRs in one place

The [[Code Review Harness App]] home surface requirement is a single view across the workspace. The instinctive worry is rate-limit budget for refreshing N repos. **That worry is unfounded, and the measurement is unambiguous.**

[measured] One GraphQL query returning 50 PRs across every repo the user can access:

```graphql
query {
  rateLimit { cost limit remaining nodeCount }
  search(query: "is:pr is:open involves:@me archived:false", type: ISSUE, first: 50) {
    issueCount
    nodes { ... on PullRequest {
      number title isDraft updatedAt reviewDecision
      repository { nameWithOwner }
      headRefOid baseRefName headRefName
      additions deletions changedFiles
    } }
  }
}
```

Result: **`cost: 1`, `nodeCount: 50`**, 20 open PRs returned, one round trip, no per-repo enumeration. Against 5000 points/hour that is a full home refresh every 0.72 seconds if you wanted one.

**Do not use REST `/search/issues` for this.** [measured] It lives in a separate bucket with `limit=30` per minute (`X-RateLimit-Resource: search`, remaining dropped 30 to 28 across two calls). GraphQL search draws on the 5000/hour `graphql` bucket instead. Same data, 166x the headroom.

[measured] Rate limit buckets on a real token: `core` 5000/hr, `graphql` 5000/hr, `search` 30/min, `code_search` 10/min, `audit_log` 1750/hr.

**Known ceiling:** GraphQL search returns at most 1000 results. [measured] `repo:cli/cli is:pr` reports `issueCount: 4407`, but paginating past the 1000th node returns `nodes: []` rather than erroring. Silent truncation, so the home surface must either stay within a query that naturally bounds under 1000 (`involves:@me`, `review-requested:@me`, `author:@me`, `org:x is:open`) or show an explicit "more than 1000 matches" state. Never render a truncated list as complete.

**Point cost formula** [docs] ([GraphQL rate and node limits](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api)): sum the requests needed for each connection assuming every `first`/`last` hits its limit, divide by 100, round. Minimum 1. Hard ceilings: 500,000 nodes per call, `first`/`last` within 1-100, no more than 100 concurrent requests, no more than 2,000 points per minute.

### Deep PR fetch

[historical private calibration] One query pulled the files, threads, comments, and checks needed by the review surface. The original repository, pull-request number, and result counts are redacted:

```graphql
repository(owner:"...", name:"...") {
  pullRequest(number: $number) {
    number headRefOid baseRefOid
    files(first: 100) { totalCount nodes { path additions deletions changeType } }
    reviewThreads(first: 100) { totalCount nodes {
      id isResolved isOutdated isCollapsed path line startLine originalLine originalStartLine
      diffSide startDiffSide subjectType viewerCanResolve
      comments(first: 5) { totalCount nodes { id databaseId author{login} body createdAt } }
    } }
    commits(last:1) { nodes { commit { oid statusCheckRollup { state } } } }
  }
}
```

The observed query cost was one point; node count is fixture-dependent. Files, threads, comments, and CI rollup arrived in one query. Replicate this against the personal publication fixture before treating it as a build gate.

### PR diff: prefer the local clone, and here is when

| Source | When it is right | Notes |
|---|---|---|
| **Local `git diff base...head`** | **Default whenever the repo is on disk** | Full context at any `-U<n>`, rename and mode detection, streaming, `AbortSignal`-cancellable, zero rate limit, and it is the same bytes the user sees in their terminal. The [[Code Review Harness App]] thesis (context reach, subtraction against the whole repo, blast-radius fan-in) **requires** the whole repo, not the diff. |
| REST `Accept: application/vnd.github.diff` | Repo not cloned, or head SHA not fetched | GitHub returns `ETag` and `Last-Modified`, so the response is conditionally cacheable; measure payload size on a permitted corpus. |
| GraphQL / REST `files` | File list, per-file stats, `changeType` | [docs] REST "Responses include a maximum of 3000 files" ([pulls](https://docs.github.com/en/rest/pulls/pulls)). Metadata only; do not reconstruct a diff from it. |

The rule: **GitHub is authoritative for identity (which SHAs, which threads, whose review), git is authoritative for content (what changed).** Fetch `headRefOid` and `baseRefOid` from GitHub, `git fetch` those SHAs, and diff locally. If the fetch fails (no remote access, shallow clone), fall back to the REST diff and mark the review as degraded, because the angles that need whole-repo context cannot run.

Note the workspace model consequence from [[Code Review Harness App]]: review state keys on repo identity plus changeset, never on a directory path. So "is this repo on disk" is a lookup from the GitHub repo's clone URLs onto the discovered worktree map, not a path guess.

### Review threads and resolved state

GraphQL only. There is no REST representation of thread resolution. [introspected] `PullRequestReviewThread` exposes: `id`, `isResolved`, `isOutdated`, `isCollapsed`, `resolvedBy`, `path`, `line`, `startLine`, `originalLine`, `originalStartLine`, `diffSide`, `startDiffSide`, `subjectType`, `viewerCanReply`, `viewerCanResolve`, `viewerCanUnresolve`, `comments`, `pullRequest`, `repository`.

### The anchoring finding, and it is load-bearing

[historical private calibration] Outdated threads were observed returning the following shape; identifying values are replaced:

```json
{ "isOutdated": true, "line": null, "startLine": null, "originalLine": 120, "originalStartLine": null }
```

**`line` is null the moment a thread goes outdated.** Only `originalLine` survives, and it points into a diff that no longer exists. GitHub does not re-anchor; it gives up and marks the thread outdated.

A live thread was also observed with `startLine` greater than `line`. GitHub's own remapping can be internally inconsistent even when it does not give up. Replicate both cases on a permitted force-pushed fixture before shipping re-anchoring.

This is direct empirical support for Rennet owning its occurrence/lineage engine, and it upgrades the case from "GitHub's line numbers are inconvenient" to "GitHub's line numbers are null exactly when you need them". Content, path, and symbol hashes feed the matcher; they are not durable identity. Two consequences:

1. Rennet's local occurrence plus lineage graph is the source of truth. GitHub's `line` is a publish-time output, not an input.
2. Re-anchoring an outdated GitHub thread onto the current patchset is something Rennet can do and GitHub cannot, because Rennet has the immutable patchsets and lineage evidence. That is a shippable, demonstrable capability, not just an internal detail.

---

## 3. Publish pipeline

### The correction to carry forward

[[References/Desktop and Mobile Stack 2026]] section 8 recommends `addPullRequestReview` with a `comments` array. **That field is deprecated.** [introspected], verbatim from the live schema on 2026-08-04:

> `comments`: The review line comments. **Upcoming Change on 2023-10-01 UTC** **Description:** `comments` will be removed. use the `threads` argument instead **Reason:** We are deprecating comment fields that use diff-relative positioning

It is three years past its announced removal date and still present, so it works today. Do not build on it. The whole `addPullRequestReviewComment` mutation carries the same notice on every field, pointing at `addPullRequestReviewThread` / `addPullRequestReviewThreadReply`.

The reason matters and it is the same reason as section 2's anchoring finding: **GitHub is deprecating diff-relative positioning across the board.** REST agrees: [docs] on `POST /repos/{o}/{r}/pulls/{n}/comments`, `position` is marked "This parameter is closing down. Use line instead" ([pulls/comments](https://docs.github.com/en/rest/pulls/comments)). Anything Rennet builds should speak `line`/`side`, never `position`.

### The pipeline

All GraphQL. Staying in one client matters because resolution has no REST equivalent, so a REST publish path would need a GraphQL round trip anyway to map comment IDs onto thread IDs.

**Step 1: open the pending review with the batch.**

```graphql
mutation {
  addPullRequestReview(input: {
    pullRequestId: "PR_...",
    commitOID: "39cc0d1b...",       # pin to the exact reviewed SHA
    body: "<review summary: ordered chunks, decisions, what was checked>",
    threads: [ { path, line, side, startLine, startSide, body }, ... ]
    # NO event -> stays PENDING
  }) { pullRequestReview { id state } }
}
```

[introspected] `AddPullRequestReviewInput`: `pullRequestId` (required), `commitOID`, `body`, `event`, `comments` (deprecated), `threads`.
[introspected] `DraftPullRequestReviewThread`: `path`, `line`, `side`, `startLine`, `startSide`, `body`. **Six fields, and that is all.**
[introspected] `DiffSide` enum: `LEFT`, `RIGHT`. `PullRequestReviewThreadSubjectType` enum: `LINE`, `FILE`.

Omitting `event` leaves the review pending. [docs] REST states it explicitly: "By leaving this blank, you set the review action state to PENDING" ([pulls/reviews](https://docs.github.com/en/rest/pulls/reviews)).

**Step 2: file-level and non-anchorable threads, individually.**

[introspected] `DraftPullRequestReviewThread` has **no `subjectType`**. File-level comments cannot go in the batch. But the standalone mutation can, and it accepts a `pullRequestReviewId` so it still lands inside the pending review:

```graphql
mutation {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: "PRR_...",
    path: "src/foo.ts",
    body: "...",
    subjectType: FILE
  }) { thread { id } }
}
```

[introspected] `AddPullRequestReviewThreadInput`: `path`, `body` (required), `pullRequestId`, `pullRequestReviewId`, `line`, `side`, `startLine`, `startSide`, `subjectType`.

**Step 3: submit, once.**

```graphql
mutation {
  submitPullRequestReview(input: {
    pullRequestReviewId: "PRR_...",
    event: COMMENT,        # or APPROVE / REQUEST_CHANGES
    body: "..."
  }) { pullRequestReview { state url } }
}
```

[introspected] `SubmitPullRequestReviewInput`: `pullRequestId`, `pullRequestReviewId`, `event` (required), `body`.
[introspected] `PullRequestReviewEvent` enum: `COMMENT`, `APPROVE`, `REQUEST_CHANGES`, `DISMISS`. (REST documents only the first three for submit; treat `DISMISS` as not part of the submit path.)

**One review event, one notification.** This is what makes a 40-finding decomposed review land as a colleague's normal review rather than 40 separate emails. It is the whole "no walled garden" requirement in one API shape.

**Step 4: recover thread IDs.**

[introspected] `AddPullRequestReviewPayload` returns `pullRequestReview` and `reviewEdge` only. `PullRequestReview` has `comments` but **no `threads` field**. So the batch path does not hand back thread IDs.

Two options, and the trade is real:

| Approach | Mutations | Gets thread IDs | Secondary-limit exposure |
|---|---|---|---|
| Batch `threads:` then one read-back query on `pullRequest.reviewThreads` | 2 | Indirectly, match on `(path, line, side, comment body hash)` | Minimal |
| N x `addPullRequestReviewThread` (each returns `thread { id }`) | N+2 | Directly | [docs] "no more than 80 content-generating requests per minute and no more than 500 content-generating requests per hour" |

**Recommendation: batch, then read back.** A decomposed review of a 3,000-line PR is exactly the case that could produce 60+ threads, and 500 content-generating requests per hour is a ceiling you would hit while dogfooding, not in some hypothetical. Use the individual mutation only for file-level threads and replies, where the batch cannot express the shape.

**Replies and resolution.**

[introspected] `AddPullRequestReviewThreadReplyInput`: `pullRequestReviewThreadId` (required), `body` (required), `pullRequestReviewId` (optional, so replies can also be batched into a pending review).
[introspected] `ResolveReviewThreadInput` / `UnresolveReviewThreadInput`: `threadId` (required). Payload returns `thread`. GraphQL only, no REST equivalent, exactly as [[References/Desktop and Mobile Stack 2026]] states.

**Suggested changes.** No API surface at all; it is markdown in the comment body, using literal ` ```suggestion ` fences. The suggestion replaces exactly the anchored range, so a multi-line suggestion requires `startLine`/`startSide` to be set correctly on the thread. Rennet emits the fence, GitHub renders the Commit suggestion button. Validate the complete round trip on the permitted personal fixture.

### Mapping Rennet's model onto GitHub

| Rennet concept | GitHub representation | Fidelity |
|---|---|---|
| Anchored thread, contiguous range, one file, both endpoints in the diff | `DraftPullRequestReviewThread` with `path` + `startLine`/`startSide` + `line`/`side` | **Lossless** |
| Thread anchored to a whole file | `addPullRequestReviewThread` with `subjectType: FILE` | **Lossless**, but cannot ride the batch |
| Suggested edit | ` ```suggestion ` fence inside the body | **Lossless** within the anchored range |
| Reply to an existing thread | `addPullRequestReviewThreadReply` | **Lossless** |
| Resolve / unresolve | `resolveReviewThread` / `unresolveReviewThread` | **Lossless** |
| Severity (P0-P3) and finding provenance (which harness, which angle) | Body-text convention | **Degraded to a string.** No structured field exists. |
| Thread spanning **non-contiguous hunks in one file** | none | **Does not map.** GitHub ranges are contiguous. |
| Thread spanning **multiple files** | none | **Does not map.** |
| Thread anchored to **unchanged code outside the diff** (the context-reach requirement) | none | **Does not map.** GitHub only accepts lines present in the diff. |
| **Chunk** (the sub-400-LOC review group) | none | **No representation whatsoever.** |
| **Angle** (spec, sequence, decisions, claims and evidence, blast radius, noise) | none | **No representation whatsoever.** |
| Coverage, read-state, obligations, pace | none | **Must never be published.** Ratified private-to-reviewer. |
| Private diff chat, dismissed findings, harness disagreement traces | none | **Must never be published.** |

### Degradation strategy

**The review body is the carrier for everything structural that does not anchor.** This is not a consolation prize; it lets an explicitly published review retain useful structure even though GitHub has no native chunk or angle model.

Concrete rules:

1. **Chunks and angles publish as review-body sections.** Ordered chunk list with file/line links (`https://github.com/{o}/{r}/pull/{n}/files#diff-{sha256(path)}R{line}`), the decision queue as a numbered list, the unclaimed bucket as a list, and propose-deletion findings as a list. The reader gets useful structure without installing anything. This is the "reviews land as normal PR reviews" requirement discharged.
2. **Multi-file threads split.** The first anchor carries the full text; the rest carry a one-line pointer back to it. Rennet keeps the single logical thread locally and re-joins on read, so the split is a publish-time artifact, not a data-model concession.
3. **Non-contiguous same-file threads split** the same way, anchored on each hunk.
4. **Out-of-diff anchors degrade to file-level threads** (`subjectType: FILE`) naming the line, or to the review body when the file is not in the changeset at all. Never silently drop.
5. **Every degradation is visible in the publish sheet before signing.** The [[Code Review Harness App]] design already ratified an ink-vs-blue two-column ledger ("travels with the PR" vs "stays on this Mac"). Degradations belong in a third state on the ink side: published, but flattened. If a reviewer signs without seeing that a multi-file thread became three, the publish ceremony has lied to them, and the ceremony is the product's integrity mechanism.
6. **Round-trip loss is expected and must be modelled.** Re-reading a published review from GitHub will not reconstruct chunks, angles, or multi-file threads. The local event store is the only place the full structure exists. Do not attempt to parse the review body back into structure; keep the local record keyed by the returned thread IDs.

---

## 4. Sync model

### Local-first, with GitHub as a remote

Authority is split, and splitting it cleanly is what makes offline behaviour tractable:

| Owned locally (event store) | Owned by GitHub |
|---|---|
| Read-state per immutable occurrence | Thread existence and IDs |
| Obligations and their discharge | Resolved / unresolved state |
| Chunks, angles, ordering | Comment bodies and authors after publish |
| Occurrences, lineage, and matcher evidence | PR head SHA, base SHA, mergeability |
| Private chat, dismissals, pace | CI check rollup |
| Findings before publish | Review state (pending / submitted) |

Conflict rule: on divergence, GitHub wins for the right-hand column and local wins for the left. There is no case where they contest the same field, which is the point of drawing the line here.

### Force-push and rebase

The ratified model from [[Code Review Harness App]] is snapshot plus auto-reopen. The GitHub mechanics:

1. Detect `headRefOid` change on the cheap poll (below).
2. Snapshot the current patchset before touching anything. `git fetch` the new SHA; the old SHA usually remains reachable via reflog or the PR's `refs/pull/{n}/head` history, but do not rely on it: **fetch and keep the old head SHA locally at review start**, because a force-push can make it unreachable on the remote and GitHub will not serve you a diff you can no longer name.
3. Build lineage from exact and weighted evidence. Only exact, unambiguous unchanged occurrences may retain unaffected state after the precision gate; changed, similar, or ambiguous occurrences reopen.
4. Any published GitHub thread whose occurrence did not survive will independently go `isOutdated: true` with `line: null`. Rennet resolves it through the lineage graph and can offer to post a reply pointing at the new location. It cannot move the GitHub thread; no API allows that.
5. Never auto-resolve a thread because its hunk vanished. Disappearing is not agreement.

### Polling: the measured asymmetry that drives the design

This is the single most useful measurement in the plan.

**REST supports conditional requests and 304s are free.** [measured], with a positive control because the first run misled me:

```
Three conditional requests, same ETag:
  304 Not Modified  X-RateLimit-Remaining: 4990  X-RateLimit-Used: 10
  304 Not Modified  X-RateLimit-Remaining: 4990  X-RateLimit-Used: 10
  304 Not Modified  X-RateLimit-Remaining: 4990  X-RateLimit-Used: 10

Three unconditional requests, same endpoint:
  200 OK            X-RateLimit-Remaining: 4989  X-RateLimit-Used: 11
  200 OK            X-RateLimit-Remaining: 4988  X-RateLimit-Used: 12
  200 OK            X-RateLimit-Remaining: 4987  X-RateLimit-Used: 13
```

Flat across three 304s, decrementing across three 200s. My first attempt appeared to show 304s consuming quota; it was confounded by the unconditional call that fetched the ETag. Re-run with the control, the answer is unambiguous.

**GraphQL has no conditional requests.** [measured] A GraphQL response carries **no `ETag` and no `Cache-Control`**. Every GraphQL poll costs at least 1 point, unconditionally.

So: **poll on REST, fetch on GraphQL.**

```
loop:
  1. GET /notifications?participating=true      with If-None-Match
     [measured] returns ETag + Last-Modified + X-Poll-Interval: 60
     304 -> free, sleep X-Poll-Interval, continue
  2. For each PR with an open review session:
     GET /repos/{o}/{r}/pulls/{n}               with If-None-Match
     304 -> free, nothing changed
     200 -> head SHA / updated_at may have moved
  3. Only on a 200 from step 1 or 2:
     one GraphQL deep fetch (cost 1) for the affected PR
  4. Optional repo-wide comment delta:
     GET /repos/{o}/{r}/pulls/comments?sort=updated&direction=desc&since={cursor}
     [measured] works, returns line/start_line/original_line/side/commit_id per comment
```

[measured] `X-Poll-Interval: 60` on the notifications endpoint; honour it, it is GitHub telling you the floor.

Steady-state cost of a desktop app sitting open all day with nothing happening: **zero rate-limit consumption**. Cost when something changes: 1 point. The naive design (GraphQL poll every 30s across 20 PRs) would burn 2,400 points/hour for the same information. That is a 100% saving on the common case and it comes entirely from choosing the right protocol per job.

Also implement `Retry-After` and `X-RateLimit-Reset` handling, plus exponential backoff on `403` with `secondary rate limit` in the body. [docs] Secondary limits: 100 concurrent requests, 2,000 points/minute on GraphQL, 80 content-generating requests/minute, 500/hour.

### Offline

Everything reads. Nothing publishes.

- **Reads work fully offline** for any repo on disk: the git object store has the diff, the local event store has the review state. This is not a degraded mode, it is the normal mode with the network absent.
- **Reversible writes queue in an outbox**: local findings, chat, read-state, chunk edits. They were never going to GitHub anyway until publish.
- **Publishing is disabled offline, deliberately.** Publish is irreversible and SHA-bound: the review is signed against `commitOID`, and a queued publish that fires against a head that moved while you were offline attaches your name to a review of code you did not read. Same reasoning as the ratified mobile rule that approve is live-only and SHA-bound. Show the publish sheet greyed with the reason, not a spinner.
- **Resolve/unresolve also live-only**, for the same reason: it is a claim about a conversation whose state you cannot currently see.
- On reconnect, re-fetch head SHA first and compare against the snapshot the review was built on. If it moved, run the auto-reopen path before re-enabling publish.

---

## 5. Keeping the forge layer swappable

Do not build a GitLab or Gitea adapter now, but do not let GitHub's vocabulary leak into `core/`. The seam is already implied by the [[Code Review Harness App]] architecture: add a `ForgePort` alongside `GitPort` and `HarnessPort`, expressed entirely in Rennet nouns (patchset, occurrence, thread, publication) with an opaque `forgeRef` string per entity, and let the GitHub implementation own every GraphQL document, every `line`/`side` translation, and every degradation decision. The forge-shaped facts that will differ are knowable in advance and cheap to accommodate now: whether threads have first-class resolution (GitLab does, Gitea does), whether a batch of comments can land as one review event (GitLab's approach differs), and whether anchoring is line-based or position-based. Encode those as capability flags on the port (`supportsThreadResolution`, `supportsBatchedReview`, `supportsMultiLineAnchors`, `supportsFileLevelThreads`) rather than as `if (forge === 'github')` branches, because the degradation logic in section 3 is already written against capabilities and will simply produce a different flattening for a weaker forge. That is roughly a day of discipline during the GitHub build and it converts a future rewrite into a future implementation.

---

## 6. v1 dogfood cut

Target: daily review against personal, public, or otherwise explicitly permitted repositories. Enterprise SAML behaviour remains a compatibility requirement, not a dogfood fixture.

### SSO mechanics, and the one that will bite

No checked-in evidence may assert that a current personal token works against a client organisation. Reproduce the generic SSO states with an authorised fixture or a controlled mock.

The mechanics that matter [docs] ([authorizing a PAT for use with SSO](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/authorizing-a-personal-access-token-for-use-with-single-sign-on)):

- A classic PAT must be **explicitly authorized for the SSO org after creation**. Until then, requests get 404 or 403.
- On a 403, the `X-GitHub-SSO` header carries an authorization URL, **and that URL expires after one hour**.
- **The dangerous case:** across multiple organisations, an unauthorized token does not fail. GitHub can return `X-GitHub-SSO: partial-results` with organisation identifiers. A 200 and a valid-looking list can therefore be incomplete.
- Prerequisite: a linked external identity, which exists once the user has authenticated to the org via the IdP at least once.

**Requirement, not a nice-to-have: Rennet must parse `X-GitHub-SSO` on every response and treat `partial-results` as a first-class error state.** An empty or short home surface must never render as "you have no PRs". This is the exact failure shape that would make you distrust the tool on day three, and it is invisible unless you look for the header. Surface it as a banner naming the org IDs and offering the authorization URL, and re-request it when it expires.

The expected enterprise token ladder:

- Rung 0 (`gh auth token`) works when the user has already authorised the active credential against the organisation.
- Rung 1 (GitHub App device flow) will not work without an org owner installing the app. Assume no.
- Rung 2 (paste a PAT) may work when organisation policy permits self-authorization.

Which is the sharpest strategic point in this document: **at your primary daily use case, the zero-config path is not the convenient path, it is the only path.** Rung 0 has to be genuinely solid, not a fast lane with a fallback behind it.

### v1 scope

**In:**

1. Rung 0 auth, plus rung 2 as a visible field. Scope and expiry validation on connect. `X-GitHub-SSO` parsing everywhere.
2. Home surface: one GraphQL search query, `involves:@me` and `review-requested:@me`, with explicit >1000 truncation state.
3. Deep PR fetch: one GraphQL query per PR (files, threads, comments, checks).
4. Diff from the local clone via `headRefOid`/`baseRefOid`; REST diff fallback with a visible degraded badge.
5. Read and render existing threads with resolved and outdated state, re-anchored locally.
6. Publish: `addPullRequestReview` with `threads:` batch, then `submitPullRequestReview`, with the degradation ledger in the publish sheet.
7. Reply and resolve.
8. Polling loop: notifications ETag + per-PR ETag, GraphQL only on change.
9. Force-push detection with snapshot and auto-reopen.

**Out of v1:**

- GitHub App registration and device flow (rung 1). It does not unblock the dogfood case, and building it first would be optimising for a user who is not you.
- Bot-comment ingestion (Codex, Greptile, gitStream). Read-only and additive; it can land after the publish pipeline is trusted.
- Any write beyond the explicit publish act.
- Webhooks. There is no callback endpoint and there should not be one.

**Non-negotiable during dogfood:** every mutation is behind the human publish gate, and the enterprise client repos are client repos. No auto-anything.

---

## Open questions / refinement hooks

1. **The publish pipeline is specified but never executed.** No mutation was run against any repo while writing this. Every mutation shape here is introspection plus documentation, which is strong evidence about the contract and no evidence at all about behaviour. Specifically unverified: whether a `threads:` batch rejects the whole review if one anchor is invalid or drops just that thread; what error a `line` outside the diff returns; whether `startLine > line` is rejected or silently accepted (real data shows GitHub itself returning inverted pairs). **Test against a throwaway personal repo before anything else.**
2. **Read-back matching after a batch publish.** `AddPullRequestReviewPayload` gives no thread IDs, so mapping local threads onto GitHub threads relies on `(path, line, side, body hash)`. Two identical-bodied threads on the same line and side would be ambiguous. Is that reachable in practice, and is a zero-width marker in the body an acceptable disambiguator or a tooling leak?
3. **The `comments`-to-`threads` deprecation is three years stale.** GitHub announced removal for 2023-10-01 and it is still live in 2026. Does that make the notice noise, or does it mean removal lands without warning? Assume the latter; ship on `threads:` regardless. Worth a calendar check.
4. **Multi-line anchor validity rules are undocumented.** Neither the REST nor GraphQL docs state whether `startLine` and `line` must both be in the diff, whether they may straddle a hunk boundary, or whether they may span context lines. This determines how often the chunk-to-thread mapping degrades, which is a user-visible quality number. Empirical only.
5. **Draft PRs and the review event.** Can `APPROVE` be submitted on a draft PR? Affects whether the publish sheet offers the verb.
6. **`involves:@me` is probably the wrong home query.** It excludes repositories the user can see but is not involved in. Needs a composed query set (`involves`, `review-requested`, optionally configured organisation queries) with dedup, and each has its own 1000 ceiling.
7. **Resolved: token ownership stays outside core.** The host-side GitHub adapter receives a `SecretStorePort`/ephemeral token-provider capability, not a bearer value in a core command. The host owns `gh` subprocess calls, pasted-token storage, and rotation; core, events, project context, and renderer never hold the raw token.
8. **Enterprise Server and `ghe.com`.** Not needed for the enterprise client (github.com), but `GH_ENTERPRISE_TOKEN` and `GH_HOST` exist and the auth ladder should not architecturally exclude them.
9. **Rate limits for a GitHub App installation** are 5,000/hour and can rise to 12,500 based on installation size. Irrelevant at rung 0, relevant if rung 1 ever becomes primary for open-source users.
10. **Does `originalLine` plus the base SHA reconstruct enough** to re-anchor an outdated GitHub thread onto the current patchset with the local object store? If yes, that is a demonstrable capability GitHub does not have and a strong demo moment. Prototype against a real force-pushed PR.

---

## Bead candidates

| # | Title | Description | Priority | Dependencies |
|---|---|---|---|---|
| 1 | Spike: publish a batched review to a throwaway repo | Create a scratch repo with a multi-file PR. Execute `addPullRequestReview` with a `threads:` batch (contiguous, multi-line, invalid-anchor, out-of-diff cases), then `submitPullRequestReview`. Record exact error shapes, partial-failure behaviour, and whether `startLine > line` is rejected. Answers open questions 1, 4, 5. **Highest information value in the whole plan; every publish-path decision is currently unvalidated.** | P0 | none |
| 2 | Spike: thread ID read-back after batch publish | Following bead 1, read `pullRequest.reviewThreads` and attempt to match published threads by `(path, line, side, body hash)`. Determine whether a marker is needed. Answers open question 2. | P0 | 1 |
| 3 | Implement the auth ladder rungs 0 and 2 | `gh auth token` via subprocess (never parse `hosts.yml`), scope and expiry validation from `/rate_limit` headers, PAT paste field, `safeStorage` with `isEncryptionAvailable()` and `getSelectedStorageBackend()` guards, three distinct gh-absent / not-logged-in / insufficient-scope states. | P0 | none |
| 4 | `X-GitHub-SSO` partial-results detection | Parse the header on every response. Treat `partial-results; organizations=...` as a first-class banner state naming the orgs and offering the (1-hour) authorization URL. Never render a truncated home surface as complete. **Silent data loss at the primary dogfood target.** | P0 | 3 |
| 5 | Home surface GraphQL query set | Composed `involves:@me` / `review-requested:@me` / `org:` queries with dedup, explicit >1000 truncation state, `rateLimit { cost remaining }` surfaced in a debug pane. Answers open question 6. | P1 | 3 |
| 6 | REST-first polling loop with conditional requests | Notifications ETag poll honouring `X-Poll-Interval`, per-PR ETag poll, GraphQL deep fetch only on change. Include a rate-limit consumption assertion in tests: N polls with no upstream change must consume zero quota. | P1 | 5 |
| 7 | `ForgePort` capability-flag seam | Define the port in Rennet nouns with `supportsThreadResolution` / `supportsBatchedReview` / `supportsMultiLineAnchors` / `supportsFileLevelThreads`. Write the degradation logic against capabilities, not against `forge === 'github'`. | P1 | 1 |
| 8 | Degradation ledger in the publish sheet | Third visual state on the ink side for "published but flattened": multi-file thread split into N, out-of-diff anchor demoted to file-level, angle flattened to body prose. The publish ceremony must not lie about what it sent. | P1 | 1, 7 |
| 9 | Spike: re-anchor an outdated GitHub thread | Take a real force-pushed PR with `isOutdated: true, line: null` threads. Use `originalLine` plus base SHA plus the local object store to recompute a current anchor. Measure hit rate. Answers open question 10 and is a candidate demo moment. | P1 | none |
| 10 | Local-git-vs-REST-diff source selection | Map GitHub repo clone URLs onto the discovered worktree set (repo identity via `git rev-parse --git-common-dir`, per the workspace model). Fetch `headRefOid`/`baseRefOid`, diff locally, fall back to REST diff with a visible degraded badge when the SHAs are not fetchable. | P1 | 5 |
| 11 | Snapshot the old head SHA at review start | Fetch and pin the reviewed head SHA locally before any review work, so a later force-push cannot make the reviewed state unreachable. Prerequisite for the ratified snapshot plus auto-reopen model. | P1 | 10 |
| 12 | Secondary rate limit backoff | Handle `Retry-After`, `X-RateLimit-Reset`, and 403-with-secondary-limit. Cap content-generating mutations against the 80/min and 500/hr ceilings, which a large decomposed review can approach. | P2 | 1 |
| 13 | GitHub App registration and device flow (rung 1) | Register the app, enable device flow, implement the poll loop with `authorization_pending` / `slow_down` / `expired_token` / `access_denied`, refresh-token rotation at the 8-hour boundary. Deliberately after dogfood: it does not unblock the enterprise client. | P2 | 3 |
| 14 | Calendar check on the `comments` deprecation | The `addPullRequestReview.comments` removal notice has been live and unenforced since 2023-10-01. Re-check the live schema periodically; ship on `threads:` regardless. Answers open question 3. | P3 | none |

---

## Related

- [[Code Review Harness App]] (parent, product shape and ratified decisions)
- [[References/Desktop and Mobile Stack 2026]] (library choices; section 8 GitHub interop, corrected here on the `comments`-vs-`threads` deprecation)
