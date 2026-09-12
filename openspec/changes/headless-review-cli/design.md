## Context

Every review the product runs today starts at one of three commands: `review.capture` (the working tree against the resolved base), `review.openPr` (a pull request's pinned OIDs) or `session.mint` (the New Chat front door, C21). Only the third leaves progress anywhere a second client can read: `runSessionPreparation` in `packages/server/src/create-server.ts` writes a `SessionPreparation` record through `sessionStore.setPreparation` at every step (`capturing` with its `step`, `drafting` with the five `LensLane`s, `failed`, `cancelled`, then `undefined` when the boards have settled), and `session.list` projects it onto every row. The desktop's workspace header polls `session.list` every 400 ms (`PREPARATION_POLL_MS` in `packages/app-ui/src/board/workspace-header.tsx`) while a preparation runs; the board surface folds the `lensDraft` push frames (`packages/protocol/src/session/wire.ts`, `lensDraftFrameSchema`) for each accepted board write, with `board.draft` as its catch-up. The other two commands hand the review to `kickBoardDrafting`, which calls `ensureBoardDrafting(review)` with no emit, so their lanes are visible to nobody.

The branch arm of a minted session captures with `captureBranch(commandId, root, target.branch, project?.primaryBranch ?? "HEAD")`, which calls `captureBranchPatchset` in the same file: `merge-base <base> <head>` to `<head>`, `source: "local-branch"`, `headRef: <head>`. The base is always the project's primary branch. The PR arm captures the PR's pinned range through `openPullRequest` / `openProjectPullRequest`. The lens seats, the dual Flagged legs and the compiler, per-finding verification and the round report all run under `runBoardRegeneration` from that point; none of it is touched here.

The CLI's existing wire helper, `cliInvoke` in `packages/server/src/cli.ts`, opens a loopback socket, sends `hello` with `clientType: "rennet-cli"`, waits for `serverInfo`, sends one `request`, resolves the `response` and closes, with a 10 s timer. A review outlives that by an order of magnitude and needs the push frames the helper discards.

The data directory (`defaultDataDir()` in `packages/server/src/daemon.ts`, overridden by `--data-dir` then `RENNET_USER_DATA`) holds one directory per store, keyed by session or review id: `sessions/`, `transcripts/`, `rounds/`, `generations/`, `board-meta/`, `round-operations/`, `asks/`, `publish-receipts/`. The documented tree is in `docs/developing/guides/settings-and-setup.md` under "Local files".

## Decisions

### D1: The CLI is a New Chat row click, not a fourth review path

`rennet review` drives `session.mint` and reads the preparation record, exactly as the desktop does, because that is the one path where progress is durable and readable by a second client, and because a session is what the rest of the product hangs on: the chat thread, the rounds ledger, the archive boundary that purges context files and seat threads. A review the CLI opened is a session the reviewer can open in the app afterwards, by id, with its boards and its transcript where the app expects them.

*Rejected:* `review.capture` + `review.openPr` directly, with the CLI polling `board.read` per lens until each returns a board, absence or failure. It needs no protocol change, but `kickBoardDrafting` emits no lane state, so the CLI could print "wrote 3 elements" from `lensDraft` and never "flagged: codex seat reading x" or "design: absent, no spec". Half the feed, and a review with no session for the app to open.

*Rejected:* a new `review.run` command that captures a range and drafts without a session, streaming its own progress. It is the cleanest headless shape and it is a fourth review path with its own progress vocabulary, which is precisely what #71 ("one narration organ, everywhere") exists to stop.

### D2: `session.mint` gains an optional `base`; nothing else on the wire moves

`base: z.string().min(1).optional()` joins the mint input beside `branch`. It is carried onto `PreparationTarget` and used as the second argument of the merge-base in `captureBranch`; absent, the project's primary branch resolves as today, so every existing caller and every stored session behaves identically. It applies to the branch arm only: a PR arm has its own pinned range, and a `base` supplied with `prNumber` is ignored, stated in the field's doc comment rather than refused (Rule Zero: it is not a mistake worth an error, and the PR's own base is the honest one).

The claim is unchanged: `(repository, branch)`. Two runs of `rennet review main..feat/x` and `rennet review develop..feat/x` reattach to one session, and the second run's base is not applied; the reattach rule below says what happens instead. This is deliberate. A branch and its PR are one claimed thing (`packages/server/src/session/session-entry.ts`), and making the base part of the key would let the CLI mint a second session for a target the reviewer has open in the app.

### D3: `head` may be any rev, and it is the claim's `branch` verbatim

`captureBranchPatchset` resolves `head` with `rev-parse --verify <head>^{commit}`, so a tag or a SHA captures correctly. The CLI passes the literal the user typed as the target `branch`, which is both the claim key and the patchset's `headRef`. `base..` with an empty head means `HEAD`, resolved by the CLI to the current branch name when one is checked out (so the claim matches the row the app would show) and to the literal `HEAD` otherwise. A SHA head names a session nobody will push from; `headRef` on that patchset is a SHA and the strip already handles a review with no branch to submit from (it is the detached-HEAD case `GitCaptureAdapter` documents). Nothing here refuses.

### D4: `--pr <number>` resolves the target through `project.detail`, as the app does

The mint's PR arm needs `branch` (for the claim) and `repository` / `forgeRepository` beside `prNumber`. The desktop gets all three from a `project.detail` row (`pullRequestSchema` in `packages/protocol/src/wire.ts`: `number`, `branch`, `repository`, `forgeRepository`). The CLI does the same: `project.detail` with `prStates: ["open", "merged", "closed"]`, find the row with the given number, mint with its fields. That reattaches to a desktop session for the same PR instead of racing it. A number the detail does not list (a PR the token cannot see, or `authUnavailable`) is reported with the detail's own reason on stderr, exit 1.

*Rejected:* `review.openPr` with an `owner/repo#N` built from `resolveForgeRemote`. It works for a fresh review and leaves the lane state invisible (D1), and it can mint a review beside a desktop session for the same PR.

### D5: A repository that is not a project becomes one

`session.mint` needs a `projectId`. When `projects.list` holds no project whose `path`, `openPath` or `includedRepoPaths` contains the repository's toplevel realpath, the CLI runs `project.discover` (`kind: "repo"`, the toplevel) and `projects.add` with every discovered repo included and the discovery's primary branch, then prints one line saying it did. That is the desktop's add flow with its defaults, including the `project.process` it kicks in the background; the first capture would pin a project snapshot for the base OID regardless (`ensureProjectSnapshotPin`), so nothing runs that a review would not have needed. A workspace project that already contains the repository is matched by `includedRepoPaths` and used as it stands.

*Rejected:* refusing with "add the repository in the app first". It is a gate wearing a usage message. The CLI knows how to add a project because the daemon does.

### D6: Progress is what the daemon already reports, folded to lines

Two sources, both live in the app today:

1. **The preparation record**, read by polling `session.list` at 400 ms (the desktop's cadence, and the record is small). The printer keeps the last seen record and prints only what changed: the capture step (`capturing  resolving repository`, `capturing  capturing change`), and per lane its status transition (`queued` to `waiting` to `running` to `drafted` to `done`/`absent`/`failed`, with the verdict or reason) and each seat's `latest.text` when it changes. A seat's `latest` is the same live line the app's lane widget shows. The Flagged lane's three seats (the Claude leg, the Codex leg, the compiler) print as three lines under one lane, named by `seats[].seat` and `provider`.
2. **`lensDraft` frames** for the review id, over the CLI's own open socket, printed as `<lens>  wrote <n> element(s)`. They are the proof the seat is producing, between `latest` updates.

Each line is prefixed `[+<seconds>s]` from the moment the mint returned, on stdout, unbuffered. Nothing is invented between events: a quiet seat is a quiet terminal, and the last line before it said what the seat was doing. Every line is plain text a `grep` can read; no spinner, no cursor movement, so a CI log keeps it whole.

*Rejected:* subscribing to `roundProgress` for the lanes. The initial drafting path does not emit into `RoundProgressHub`; only rounds do. Forwarding it is the first follow-up in the proposal, and once it lands the printer swaps its lane source without changing a line it prints.

### D7: One document at one path, under the data directory

`reviewDocumentPath(dataDir, reviewId)` is `<data dir>/reviews/<reviewId>.json`. A directory keyed by review id beside `rounds/` and `generations/`, because that is how every other artifact of a review is kept, and one file rather than a tree because a consumer wants one thing to read. `--out <file>` writes elsewhere; the directory is created; an existing file at the path is replaced (a re-run over the same review is the same review, newer). The final stdout line is the absolute path and nothing else.

The document is `{ schemaVersion: 1, reviewId, sessionId, projectId, repositoryRoot, range: { base, head, baseOid, headOid, source }, generation, startedAt, settledAt, outcome: "settled" | "failed" | "cancelled" | "timeout", reason?, lanes: LensLane[], boards: { [lens]: board.read output }, review: review.load output }`. `boards` carries `board.read`'s own answer per lens: `board`, `absence`, `failure`, `failureAccount`, so an absent Design on a branch with no spec is `absence: "no-spec"`, never an empty board. The generation is `currentGenerationId(session.rounds records, review.activePatchsetId)` from `@rennet/protocol`, the same resolver the board route uses.

*Rejected:* writing under the repository's `.rennet/`. It is local and ignored, and a review of a PR the user has no clone of has no `.rennet/` to write to.

### D8: Reattach, reuse, replace

`session.mint` returns `reattached: true` when a live claim already owns the target. Three cases, decided from the returned row and one `review.load`:

- The row has a `reviewId`, no running preparation, and the review's active patchset `headOid` equals the requested head's OID: the boards are already there. Write the document from what is persisted, print one line saying so, exit 0. This is the fast exit for a small or unchanged diff.
- The row has a running preparation (`capturing` or `drafting`): attach to it. Print from its record and frames exactly as if this run had minted it.
- The row's review is at a different OID, or its preparation `failed`/`cancelled` with no review: mint again with `replacesSessionId: <row id>`. The daemon persists the fresh claimant and archives the old session, whose threads and context files are purged on the archive boundary. Printed as one line naming the archived session id, because a reviewer who had it open in the app will see it move to the archive.

A `failed` preparation whose row has a `reviewId` (the boards stage failed) takes `session.retryPreparation` rather than a fresh mint: the capture is sound and only the drafting is retried.

### D9: Exit codes, timeout, and what a failure still writes

`0`: preparation settled to `undefined` and the document was written. `1`: no healthy daemon (`findHealthyDaemon` not `healthy`, message as `pair` prints it), the preparation ended `failed` or `cancelled`, `--timeout <seconds>` elapsed (default 1800), or the document could not be written; the document is still written in the first three cases with `outcome` and `reason` set and every lane as it stood, because a partial review with three settled boards is worth reading and the reason is in the file, not only in a terminal that has scrolled away. `2`: usage, printed the way every other subcommand prints it. A timeout does not cancel the preparation: the daemon keeps drafting, the session is still there, and a second run attaches to it (D8). Cancelling on the reviewer's behalf would be Rennet deciding the review was not wanted.

### D10: The socket helper grows a long-lived form; the one-shot form is unchanged

`openCliSocket(dataDir, deps)` resolves after `serverInfo` with `{ invoke(command, input), onFrame(listener), close() }`, one socket for the whole run so `lensDraft` frames arrive on it. `cliInvoke` becomes `openCliSocket` + one `invoke` + `close`, keeping its 10 s timer and its signature; `pair` and `devices` do not change. The `review` driver's invokes have no timer of their own beyond `--timeout`; `session.mint` returns immediately by design, and the reads are reads.
