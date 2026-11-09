# Proposal

## Why

Opening a pull request for review can stall for minutes and then fail with git's raw stderr. On macOS, a Rennet launched from the Dock starts its detached daemon with launchd's bare `PATH`. Every `git` child inherits that `PATH`. When the user's git config marks the LFS filter as required and `git-lfs` lives in `/opt/homebrew/bin`, `git worktree add` dies with "git-lfs: command not found". Retry can never succeed, because the daemon outlives the app and keeps the bad environment.

While this happens the workspace looks idle and broken. The chat pane says "New review" and "No review is attached to this session, so there is no thread to open". The board says "No board for this generation yet.", and a lone Cancel floats in the corner. Those are internal words and a dead end, against DESIGN.md's "no self-explaining chrome" and PRODUCT.md's "tell the truth about state". Rennet also never checks for `git` or `git-lfs`, so the user is never told what to install.

## What Changes

- **Daemon environment.** The daemon hydrates its `PATH` at startup:
  - from the user's login shell, read with delimiters and a timeout;
  - falling back to `launchctl getenv PATH`;
  - always including the platform's package-manager directories.

  Every git, hook and credential-helper child then sees the same tools as the user's terminal. A daemon started by an older version is replaced on upgrade, as it already is today.
- **Source-control tool readiness.** Rennet detects `git` and `git-lfs` alongside `gh`/`glab`. It shows them in Settings → Environments and in the first-run tools stage. A missing tool offers **Install for me**, which runs the platform installer (Homebrew on macOS: `brew install git-lfs`, then `git lfs install`), streams its output, and re-probes. The command is shown either way. Where no installer exists, manual instructions are shown instead.
- **Large-file checkout choice.**
  - The first time a review checkout is needed for a project whose repository uses Git LFS, Rennet shows a friendly modal. The user chooses to download large files (full fidelity, slower) or skip them (fast, with placeholder pointer files).
  - When `git-lfs` is missing, the modal also offers to install it.
  - The choice is remembered per project and can be changed in settings.
  - Skipping works even when `git-lfs` is not installed, because the LFS filter is disabled for that checkout only.
- **Classified preparation failures.**
  - Workspace binding failures are classified: tool missing, large-file checkout, authentication, reference gone, or unknown.
  - Each carries plain-language copy and a recovery action: Install, Choose large-file mode, Retry, or Sign in.
  - Raw git output is kept as detail.
  - The stage is reported truthfully.
  - The front-door worktree attempt and the bind agree on the outcome.
- **A preparation surface that never looks idle.**
  - From the moment preparation starts, the lens rail and board area animate as one waiting presence. The chat pane shows the session's real title with a skeleton.
  - No step names are shown. This supersedes the "name the step" clause in `board-preparation-surface`.
  - The strings "New review", "No review is attached to this session…" and "No board for this generation yet." no longer appear during preparation or failure.
  - A failure replaces the waiting surface with one failure block: the message, the action, Retry, and a disclosure for the raw detail.

## Capabilities

### New Capabilities
- `daemon-process-environment`: the environment, and above all the `PATH`, that the daemon resolves at startup and hands to every child process it spawns.
- `source-control-tooling`: detecting `git` and `git-lfs` per execution locus, reporting their state, and installing a missing tool on request.
- `large-file-checkout`: how review checkouts treat Git LFS content. This covers the per-project choice, the first-use prompt, and the skip mode that works without `git-lfs`.

### Modified Capabilities
- `board-preparation-surface`: preparation no longer names its step and instead must visibly animate the lens rail and board from the first frame. A failure must render as one actionable block. Internal-state copy is barred from the waiting and failed surfaces.
- `session-bound-workspace`: a failure to create the bound worktree must be reported as a classified, stage-correct preparation failure with a recovery action. The front-door attempt must not disagree with the bind about whether the worktree exists.
- `first-run-welcome`: the tools stage includes `git` and `git-lfs` and offers **Install for me** for a missing one.

## Impact

- **Desktop/daemon:**
  - `apps/desktop/src/main/daemon-supervisor.ts`
  - `packages/server/src/daemon-main.ts`
  - a new shared PATH hydration module, modelled on `vendor/t3code/apps/server/src/os-jank.ts` and `vendor/t3code/packages/shared/src/shell.ts`
  - `daemon-supervisor.test.ts`, whose PATH-passthrough assertion changes
- **Adapters:**
  - `packages/adapters/src/git-range-diff.ts` (git runner env)
  - `pr-worktree.ts` (LFS checkout flags)
  - `forge-discovery.ts`, or a sibling `source-control-discovery.ts` (git/git-lfs probes)
  - a new tool-install runner
- **Server/protocol:**
  - `create-server.ts`: `runSessionPreparation`, `openPullRequestRef`, `bindWorkspaceFor`
  - `bound-workspace.ts`
  - `packages/protocol/src/session/model.ts`: `SessionPreparation.failed` gains `kind` and `action`
  - new dispatch methods for tool install and the LFS choice
  - the settings registry entry for the per-project large-file mode
- **App UI:**
  - `app/preparing-workspace.tsx`
  - `board/workspace-header.tsx`, `board/board-view.tsx`, `board/lens-seats.ts`
  - `chat/t3-chat-dock.tsx`, `chat/chat-data.ts`
  - Settings → Environments source-control rows
  - first-run tools stage
  - a new large-file choice modal and install button
- **Tests to update:**
  - `live-board.dom.test.tsx`
  - `routes/app.dom.test.tsx`
  - `t3-chat-dock.dom.test.tsx`
  - `apps/desktop/e2e/new-chat-start.spec.ts`
  - `board-lenses.spec.ts`
  - `board-drafting-failure.spec.ts`
- **Release:** ships as v1.2.2 through Auto Release.
