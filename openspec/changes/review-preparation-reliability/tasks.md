# Tasks

## 1. Wave 1: Daemon environment, tool probes, checkout modes (adapters/core/desktop)

- [x] 1.1 Add a `resolveUserPath()` module.
  - Login shell `-ilc` with start/end markers and a 5 s timeout; fallback to `launchctl getenv PATH` on macOS.
  - Union with the inherited PATH plus `/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin`, keeping order and removing duplicates.
  - Verify with unit tests: banner noise is ignored, timeout falls back, launchctl fallback works, dedupe and order hold.
- [x] 1.2 Call it in `packages/server/src/daemon-main.ts` before `runDaemon`, assigning `process.env.PATH`.
  - Update `apps/desktop/src/main/daemon-supervisor.test.ts:480-502` to the new contract.
  - Verify: a daemon test spawned with `PATH=/usr/bin:/bin` resolves a stub tool placed in a curated directory.
- [x] 1.3 Point the harness and forge discovery login-shell harvests at the shared resolver.
  - Verify: `harness-discovery.test.ts` and `forge-discovery.test.ts` pass.
- [x] 1.4 Confirm the version-skew restart replaces an older daemon (compare build version, not only protocol).
  - Verify: a supervisor test where a running daemon reports an older version is restarted.
- [x] 1.5 Add `git` and `git-lfs` probes (version + health), reusing detection states, plus a `repoUsesLfs(root)` helper that reads `.gitattributes` for `filter=lfs`.
  - Verify with unit tests: present, absent, unaskable, LFS detection true/false.
- [x] 1.6 Add `classifyGitFailure(error)` returning `{kind, tool?, message, action, detail}` for tool-missing, large-file, auth, ref-gone and unknown.
  - Verify with table-driven tests using real stderr samples, including the observed `git-lfs filter-process --skip: git-lfs: command not found`.
- [x] 1.7 Add a `largeFiles: "download" | "skip"` option to `ensurePrWorktree` and the branch/sibling worktree adds.
  - Skip passes `-c filter.lfs.process= -c filter.lfs.smudge= -c filter.lfs.required=false` and `GIT_LFS_SKIP_SMUDGE=1`.
  - Verify with an integration test on a temp repo with an LFS attribute, `filter.lfs.required=true` and no `git-lfs` on PATH: skip succeeds with pointer files; download fails and is classified tool-missing.
- [x] 1.8 Add an install-plan resolver and runner for `git-lfs` and `git`.
  - macOS + brew: `brew install git-lfs` then `git lfs install`.
  - Otherwise: `{plan:"manual", command, docsUrl}`.
  - Streams output and re-probes after.
  - Verify with unit tests using a stub `brew` on PATH (success, failure, absent).

## 2. Wave 2: Server and protocol

- [x] 2.1 Extend `SessionPreparation`:
  - `failed` gains `kind`, `action`, `tool?`, `detail`.
  - Add stage `"workspace"`.
  - Add the non-terminal `awaiting{kind:"large-file-choice", lfsAvailable}`.
  - Verify: protocol schema tests round-trip every new variant, and old payloads still parse.
- [x] 2.2 Register setting `checkout.largeFiles` (repo layer, values download|skip, unset means ask) in the settings registry.
  - Verify: settings resolver tests show unset, repo-set, and a settings view row.
- [x] 2.3 In `runSessionPreparation`, before `bindWorkspaceFor`: if the repo uses LFS and the mode is unset, enter `awaiting`; otherwise pass the mode to the bind.
  - Wrap the bind so failures become classified `failed{stage:"workspace", …}` via `classifyGitFailure`.
  - Verify with server tests: awaiting is entered and resumed, a classified git-lfs failure, stage workspace.
- [x] 2.4 Add dispatch `session.chooseLargeFileMode({sessionId, mode})`: writes the repo setting and resumes preparation.
  - Add dispatch `tools.install({tool, locus})`: streams events, re-probes, returns the result.
  - Verify with dispatch tests: resume after the choice, install success and failure events.
- [x] 2.5 Make the front-door `openPullRequestRef` worktree attempt (`create-server.ts:2638`) record its classified failure for the review instead of only logging it, and make the bind reuse it, with one retry after a mode change or install.
  - Verify: a server test where the front door fails with git-lfs missing and the session fails classified, with no raw text as the reason.
- [x] 2.6 Expose the `git`/`git-lfs` probes and repo `usesLfs` in the environments/settings projection (`settings/data/live-projection.tsx` source rows feed).
  - Verify: projection tests include the Git and Git LFS rows.

## 3. Wave 3: App UI

- [x] 3.1 Replace `PreparingWorkspace`'s empty-id `LensBoardView` with `PreparationPresence`:
  - the lens rail in a shared waiting shimmer;
  - a board skeleton pulse that respects `prefers-reduced-motion`;
  - Cancel inline;
  - no step labels and no invented seats.
  - Update `live-board.dom.test.tsx:202-238,550-576` and `apps/desktop/e2e/new-chat-start.spec.ts:150-216`.
  - Verify: the tests assert the animated presence and that "No board for this generation yet." is absent.
- [x] 3.2 Dock: `useChatTrail` falls back to the session's title from `session.list`, and `no-review` during preparation renders a thread skeleton.
  - Update `t3-chat-dock.dom.test.tsx:366-385`.
  - Verify: the test asserts the branch title and skeleton, and that "New review" and "No review is attached" are absent.
- [x] 3.3 Add `PreparationFailure`:
  - plain message;
  - the action button by kind (Install for me with a streaming output drawer, Choose large-file mode, Sign in, Retry);
  - Retry;
  - a details disclosure with the raw output.
  - Use it for `failed` and `cancelled` in `workspace-header.tsx`/`PreparingWorkspace`.
  - Update `routes/app.dom.test.tsx:309-380`, `live-board.dom.test.tsx:516-548`, `board-drafting-failure.spec.ts`, `board-lenses.spec.ts`.
  - Verify: tests for each kind's action, and the raw text visible only after expanding details.
- [x] 3.4 Add the `LargeFileChoice` modal, rendered while preparation is `awaiting` large-file-choice:
  - Download / Skip, each with a one-line description;
  - Install for me inline when `lfsAvailable` is false;
  - calls `session.chooseLargeFileMode`.
  - Verify: dom tests for both choices and the missing-lfs path.
- [x] 3.5 Settings → Environments source-control: add Git and Git LFS `DetectionRow`s with Install for me (or the manual command); add a per-project "Large files in review checkouts" control for `checkout.largeFiles`.
  - Verify: `source-control.dom.test.tsx` and the settings tests.
  - Deviation: the large-files control is not under Environments. It lives under Settings → Projects → Worktrees, as the "Large Files in Review Checkouts" row on each repository that uses Git LFS (or already has a recorded choice), because `checkout.largeFiles` is a repository-rung setting and that is where the other per-repository checkout settings sit. The Git and Git LFS rows are under Environments as planned.
- [x] 3.6 First-run welcome tools stage: show Git and Git LFS rows from the same probes with Install for me.
  - Verify: the welcome dom test covers git-lfs absent with an install action.
- [x] 3.8 Deviation (after review round 3): Install for me sends nothing when it lands.
  - The automatic follow-ups (answering Download from the large-file dialog, retrying from the failure block) are removed, with their Cancel-side withdrawal and session re-read. Their races survived three review rounds; the brief asked only that the install stream its result and let the reviewer Retry.
  - The dialog returns to its choices with Download available and "Git LFS is installed"; the failure block shows the verdict with Retry as the primary action.
  - Reconnect asks with `tools.install` `rejoin: true`, which never starts an installer; a daemon that knows nothing of the id answers `unknown` and the button says Rennet lost track, with Check again and Install for me.
  - The replay keeps exactly the client's 64,000-character tail; `session.chooseLargeFileMode` never resumes a cancelled preparation; an install whose steps succeed but whose re-probe fails is a failure.
  - Verify: tests assert no action is sent when an install lands (including Install, Escape, Cancel, install lands), the next step works when clicked, a rejoin of an unknown id runs the installer 0 times, and a reconnect answered `unknown` shows the lost-track state and dispatches no non-rejoin install.
- [x] 3.7 Copy pass against DESIGN.md (sentence case, no machinery nouns); update `packages/app-ui/DESIGN.md`'s preparation section to describe the animated presence and the failure block.
  - Verify: grep shows no remaining "No board for this generation yet." or "No review is attached" in the preparation paths.

## 4. Integration and release

- [ ] 4.1 Run the full `pnpm check` (nx format, architecture, licenses, lint, typecheck, test, build) and the desktop e2e suites touched above.
  - Verify: all green locally and in CI on the PR.
- [ ] 4.2 Manual smoke on macOS, launched from Finder:
  - open an LFS repo's PR with `git-lfs` hidden from PATH;
  - see the modal;
  - choose Skip: the review drafts;
  - change to Download in Settings, then Install for me on the failure block: Retry succeeds.
  - Verify: screenshots attached to the PR.
- [ ] 4.3 Merge to main and dispatch Auto Release with a patch bump.
  - Verify: release v1.2.2 is published with all jobs green.
