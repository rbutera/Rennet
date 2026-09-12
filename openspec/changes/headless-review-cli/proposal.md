## Why

The review engine is fast and it works: a dual-seat Flagged review of a real range finishes in under two minutes and finds things the human reviewer missed. Nobody can run it from a terminal. `packages/server/src/cli.ts` has `serve`, `status`, `stop`, `pair`, `devices`, `map` and `benchmarks`, and no `review`. The only headless route to a review is the env-gated `*.real.test.ts` cost harnesses under `packages/adapters/src`, which drop a findings JSON in a temp scratchpad and print nothing while they run. That is how a working, accurate review looked like it "did nothing" on 2026-08-11: a subagent wrapped the harness, saw no output for twenty minutes, and was killed before it reported. Rai's question that day was *"why did rennet not actually review anything"*, and the honest answer was that it had, invisibly, into a directory nobody would look in.

Since then the daemon owns every review (it survives the app quitting), the New Chat front door captures and drafts behind a durable preparation record, and the desktop watches that record and the board write stream to show the lanes filling in. All of the machinery a terminal needs already runs. What is missing is the one client that speaks it from a shell: the entry a CI job, another tool, a dogfood gate or an agent uses to review a range and read the result from a path it was told.

## What Changes

- **`rennet review <base>..<head> [path]` and `rennet review --pr <number> [path]`.** A new CLI subcommand that opens a review over the running daemon the same way a New Chat row click does: `projects.list` to find the repository's project (adding it with `project.discover` + `projects.add` when the repository is not one yet, exactly as the app's add flow does), `session.mint` with the target, then the preparation record until the boards settle. `path` defaults to the current directory and resolves to the repository's git toplevel.
- **An explicit base for a minted branch session.** `session.mint`'s target gains an additive-optional `base`: a ref the capture takes the merge-base against instead of the project's primary branch. Absent, the mint behaves byte-for-byte as today. This is the one daemon-side change; it is the difference between "review the branch against `main`" and "review `<base>..<head>`".
- **Progress on the terminal as it happens.** One line per change to a lane's status or a seat's live line (`flagged  running  codex: reading packages/server/src/cli.ts`), one line per accepted board write from the `lensDraft` frames, stamped with seconds since start. The lane state comes from the same `session.list` poll the desktop's workspace header runs at 400 ms; the writes come from the same push frames the board surface folds. Nothing is narrated that the daemon did not report.
- **The result at a stable path, printed last.** When preparation settles the CLI reads `review.load` and `board.read` for every lens of the current generation and writes one JSON document to `<data dir>/reviews/<reviewId>.json` (or `--out <file>`), then prints that path as its final stdout line so a consumer can `tail -1`. The document carries the review, the range, the generation id, each lens's board or its typed absence or failure, the settled lanes with their seats, and the timings.
- **Fast when there is nothing new.** A second run over a target whose session already holds a settled review at the same head OID writes the document and exits without minting or drafting. A run whose head has moved mints a successor session (`replacesSessionId`) so the old claim is released and the new range is captured.
- **Exit codes that mean something.** `0` the boards settled and the document was written; `1` the daemon is not running, the preparation failed or was cancelled, or the timeout elapsed (the document is still written with whatever settled, and the reason is on stderr); `2` usage.

## Capabilities

### New Capabilities

- `headless-review-cli`: the `rennet review` subcommand, its argument grammar, the daemon commands it drives, the progress it prints, the document it writes and where, and its exit contract.

### Modified Capabilities

None promoted. No spec under `openspec/specs/` states which base a minted branch session captures against (`new-chat-entry` covers project resolution and the zero-project path; the capture base is code in `captureBranch`). The optional `base` is therefore specified inside the new capability's own delta rather than as a modification of an existing one.

## Impact

- `packages/server/src/cli.ts`: the `review` case in `runCli`, its usage line in `HELP`, `cliInvoke` refactored over a reusable `openCliSocket` that keeps the socket open and surfaces push frames (the one-shot helper keeps its signature and its 10 s timeout for `pair` and `devices`), the `review()` driver, the progress printer, and the document writer.
- `packages/server/src/cli-review.ts` (new): the pure parts, so they are testable without a daemon: range parsing, the lane-diff-to-lines fold, the document shape and `reviewDocumentPath(dataDir, reviewId)`.
- `packages/server/src/cli.test.ts` and `packages/server/src/cli-review.test.ts` (new): the tests in `tasks.md` group 4.
- `packages/protocol/src/commands/index.ts`: `base: z.string().min(1).optional()` on `session.mint`'s input.
- `packages/server/src/dispatch/session.ts`: threads `base` into the preparation target.
- `packages/server/src/create-server.ts`: `PreparationTarget.base`; `captureBranch(commandId, root, target.branch, target.base ?? project?.primaryBranch ?? "HEAD")`.
- `docs/developing/guides/settings-and-setup.md`: the CLI block gains `review`; the local-files tree gains `reviews/`.
- `docs/using/guides/getting-started.md`: one section, "Review from the terminal", after "The review loop".
- Harness cost: **nothing a session sends changes.** The CLI drives the same seats with the same prompts over the same range the desktop would; it adds no prompt, interpolation or tool surface. The one new daemon input is a git ref. Stated here so the reviewer does not look for a measurement.
- Bead: relates to `workspace-k3kyx`. Issues: relates to #71 (narrated progress, the feed this prints) and #379 (the CLI this extends).

## Out of scope, filed as follow-ups rather than folded in

- Forwarding the initial-drafting lens events into `RoundProgressHub` so a late-joining wire client (this CLI included) could subscribe instead of polling `session.list`. Today `runSessionPreparation` writes them only to the session store; the desktop polls too. A push would be better for every client and is its own change.
- A human-readable rendering of the document (markdown, a summary table). This change writes the JSON the boards already are; a renderer reads it.
- Board drafting for a review opened by `review.capture` or `review.openPr` outside a session leaves no lane state anywhere a client can read (`kickBoardDrafting` passes no emit). Not touched: the CLI takes the session path, where the state is durable.
- `rennet review` against a paired remote daemon. The CLI is a loopback client, as `pair` and `devices` are.
