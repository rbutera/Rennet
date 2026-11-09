# Design

## Context

See proposal.md for the motivation. The facts the approach rests on:

- **Daemon environment.** The desktop main process spawns the daemon detached, with `env: process.env` (`apps/desktop/src/main/daemon-supervisor.ts:513,542`). The daemon outlives the app. Git runs through `execaGitFor` (`packages/adapters/src/git-range-diff.ts:131-144`), which passes no `env`.
- **Existing PATH harvesting.** Login-shell PATH harvesting already exists, but only to resolve single binaries: `harness-discovery.ts:311-323` and `forge-discovery.ts:428-441`. A vetted precedent lives in the vendored T3 Code: `vendor/t3code/apps/server/src/os-jank.ts` and `vendor/t3code/packages/shared/src/shell.ts`. It uses markers, a timeout and a `launchctl` fallback.
- **PR worktree creation.**
  - `ensurePrWorktree` runs `git worktree add --detach` (`packages/adapters/src/pr-worktree.ts:811`).
  - It is attempted at the front door (`create-server.ts:2638`), where errors are only logged.
  - It is attempted again by `bindWorkspaceFor` (`create-server.ts:5228`), which throws while `stage` is still `"capture"`.
- **Preparation state.** `SessionPreparation` (`packages/protocol/src/session/model.ts:1548-1572`) carries the preparation state. The UI shows it through `PreparingWorkspace` with an empty `reviewId`. As a result the board falls to the `missing` copy, and the dock falls to `no-review`.
- **Settings.** Settings resolve through the registry in `packages/core/src/settings-resolver.ts` and `packages/server/src/settings.ts`, using the layers `builtin < detected < global < repo`.

## Goals / Non-Goals

**Goals:**
- One environment for every daemon child.
- One place that classifies git and tool failures.
- One per-project large-file mode, read at checkout.
- One preparation surface that is either animated or actionable, and never idle text.

**Non-Goals:**
- Windows or WSL installers. The install runner reports "manual" there.
- Changing the user's global git config implicitly. Checkouts never write it: skip mode uses per-call overrides. The only change is the one the user asks for: **Install for me** for Git LFS runs `git lfs install`, which sets up the LFS filter in the global config.
- Hydrating LFS files in a checkout that was created in skip mode. Changing the mode applies to the next checkout.
- Reworking the drafting-stage lens presences. They already animate per seat.

## Decisions

### 1. Hydrate PATH once, in the daemon, at startup

- Add `packages/core/src/process-env.ts` (or adapters) exporting `resolveUserPath()`. It runs `$SHELL -ilc` with start and end markers and a 5 s timeout.
  - On failure or timeout it falls back to `launchctl getenv PATH` on macOS.
  - The result is unioned with the inherited PATH plus `/opt/homebrew/bin`, `/opt/homebrew/sbin` and `/usr/local/bin`, keeping order and removing duplicates.
- `daemon-main.ts` assigns `process.env.PATH` before `runDaemon`, so every execa call inherits it with no per-call-site change. This also covers `rennet serve`.
- The existing single-binary harvests in harness and forge discovery reuse this resolver instead of their own unmarked `-ilc` calls.
- **Alternatives considered:**
  - *Supervisor-side hydration.* This misses CLI `rennet serve`, and delays app launch.
  - *Per-call `env`.* This needs dozens of sites to change, and new sites would forget.
- The supervisor test that asserts PATH passthrough changes: the supervisor still passes `process.env`, and the daemon test asserts hydration.

### 2. Version-skewed daemons are restarted

- The supervisor already restarts a daemon on version skew (`index.ts`).
- We verify that a v1.2.1 daemon is replaced by the v1.2.2 app on its first launch. If the skew check compares protocol version only, we add the build version to the handshake comparison.

### 3. Source-control tool probes and the install runner

- **Probes.** Add `git` and `git-lfs` probes beside the forge probes in `forge-discovery.ts`, or in a sibling `source-control-discovery.ts`, reusing the `DetectionRow` states. `git-lfs` health comes from `git lfs version`, run with the hydrated PATH.
- **"Uses LFS".** A project counts as using LFS when the repository's `.gitattributes` (at HEAD of the default branch) contains `filter=lfs`. This is computed when the project's repo map or project detail is read.
- **Install runner.** A new daemon dispatch, `tools.install({tool})`, does the following:
  - It resolves an installer plan per platform. On macOS with `brew` on the hydrated PATH, the plan is `brew install git-lfs` then `git lfs install`. For `git`, it is `brew install git` (or `xcode-select --install`).
  - It streams stdout and stderr over the existing event channel, then re-probes.
  - With no installer it returns `{plan: "manual", command, docsUrl}`.
- No elevation is needed, because Homebrew installs run as the user. Rule Zero applies: there is no confirmation ceremony beyond the user pressing **Install for me**.

### 4. Large-file mode

- **Setting.** A new registry key, `checkout.largeFiles`, with values `"download" | "skip"`, layer `repo`, and no builtin value (unset means "ask").
- **The prompt.** `runSessionPreparation` checks the project's mode before `bindWorkspaceFor`. When the repo uses LFS and the mode is unset, preparation enters a new non-terminal state, `awaiting{kind:"large-file-choice", lfsAvailable}`. The UI renders the modal from that state.
- **The answer.** The answer goes through `session.chooseLargeFileMode({mode, remember:true})`. It writes the repo setting and resumes preparation. This is a protocol addition, not a blocking dialog in the daemon.
- **Checkout flags.**
  - `ensurePrWorktree` and the branch and sibling worktree adds take a `largeFiles` option.
  - In skip mode, git is invoked with `-c filter.lfs.process= -c filter.lfs.smudge= -c filter.lfs.required=false`, plus `GIT_LFS_SKIP_SMUDGE=1`.
  - In download mode, flags are unchanged.
  - The overrides are per invocation, so the user's config is untouched.
- **Alternatives considered.** We rejected a global default (Rai: "give the user a nice user-friendly modal with the choice"). We rejected skipping only when `git-lfs` is missing, because the user would never learn the choice exists.

### 5. Failure classification

- Add `classifyGitFailure(error) → {kind, tool?, message, action, detail}` in adapters, matching on exit code and stderr patterns:

  | Kind | Matches |
  |---|---|
  | `tool-missing` | `git-lfs: command not found`, `git: command not found`, ENOENT spawning git |
  | `large-file` | smudge errors, or LFS errors other than "not found" |
  | `auth` | `Authentication failed`, `could not read Username`, 401/403 |
  | `ref-gone` | `unknown revision`, `not our ref`, `couldn't find remote ref` |
  | `unknown` | anything else |

- `SessionPreparation.failed` gains `kind`, `action` (`install`, `choose-large-files`, `sign-in` or `retry`), `tool?` and `detail`. `reason` stays as the plain-language message.
- `stage` becomes `"workspace"` for bind failures. A new stage literal is added; consumers that switch on stage default to the capture copy.
- **Front-door agreement.** The front-door failure is recorded on the review's PR worktree slot. `bindWorkspaceFor` reuses that classified error instead of retrying blind, and it does retry once after a mode change or install.

### 6. Preparation surface

- **Waiting state.**
  - `PreparingWorkspace` stops rendering `LensBoardView` with an empty id. It renders a `PreparationPresence`:
    - the lens rail, with each lens tab in a shared `waiting` shimmer;
    - a board-area skeleton with a slow, CSS-only pulse, honouring `prefers-reduced-motion`;
    - Cancel inline in the header.
  - No seat widgets are invented. This keeps the honesty rule in `lens-seats.ts`: the motion is a presence, not five fake readers.
- **Chat dock.**
  - `useChatTrail` falls back to the session row's title (branch or PR) from `session.list`, never "New review".
  - The `no-review` target renders a thread skeleton while preparation is `capturing`, `awaiting` or `drafting`-before-thread.
  - On failure it renders nothing extra; the failure block owns the message.
- **Failure state.** `PreparationFailure` renders the block:
  - the message;
  - the action button for its kind (Install for me with a streaming output drawer, Choose large-file mode, Sign in, or Retry);
  - Retry;
  - a `<details>` element containing the raw detail.
- **Large-file modal.** `LargeFileChoice` is a modal over the presence while preparation is `awaiting` large-file-choice. It has two choices, each with a one-line description. If `lfsAvailable` is false, Download shows Install for me inline.
- **Copy.** All copy follows DESIGN.md: sentence case, no machinery nouns.

### 7. Waves

The tasks are grouped for `/wave`:

- **W1:** environment and adapters.
- **W2:** server and protocol (depends on W1's classifier and checkout option).
- **W3:** app-ui (depends on W2's protocol).

Each wave lands its own tests.

## Risks / Trade-offs

- [Login shell side effects or latency at daemon start] → markers, a 5 s timeout, running once, and a fallback chain. The daemon starts even if every step fails.
- [Pointer files confuse agents running visual or snapshot tests in skip mode] → this is the user's explicit choice in the modal. The modal copy says images are placeholders, and the mode can be changed in Settings.
- [Install for me runs Homebrew for minutes] → the output streams, the action is cancellable, and the rest of the app stays usable.
- [stderr-pattern classification drifts with git versions] → `unknown` still shows plain copy, Retry and the raw detail, so nothing regresses to a dead end.
- [Tests that pinned the old behaviour are rewritten] → each is updated in the wave that changes the behaviour, not deferred.

## Migration Plan

- There is no data migration. `checkout.largeFiles` is absent for existing projects, so the first LFS checkout asks.
- The v1.2.2 app replaces the v1.2.1 daemon through the version-skew restart.
- **Protocol.** v1.2.2 speaks protocol version 4 and still accepts 3. A version-3 client that connects to a v1.2.2 daemon receives `awaiting` as `capturing`, the `workspace` stage as `capture`, and no install output (`preparation-compat.ts`), so it keeps parsing every session row. A v1.2.2 client talking to a v1.2.1 daemon never sees the new states, because that daemon never produces them.
- **Rollback:** revert the release. What an older daemon then finds on disk:
  - **Settings.** `largeFiles` in a project's `config.json` is ignored. Configs are sparse, and the older validator checks only the keys it knows.
  - **Sessions.** The older daemon's session schema has no `awaiting` status and no `workspace` stage. A session persisted in either state fails its parse. The store's read is fail-safe: the session is left out of `session.list`, so it disappears from the sidebar, and its file is left untouched on disk, not deleted or rewritten. Context-file sweeps ask `persistedIds`, which still counts the file, so its context is kept as well. Re-applying v1.2.2 brings the session back exactly as it was: still waiting on the question, or failed or cancelled with its classified reason.
  - **Why that is acceptable.** Only three states are affected: waiting on the question, or failed or cancelled at the workspace stage. In all three nothing was bound and no board was drafted, so no review work is hidden. The review record itself is unaffected and still loads by id, and the reviewer can open the pull request or branch again on the older version. That mints a fresh session for the same target, because the hidden one no longer holds the claim. The optional session fields (`workspaceNotes`, `largeFiles`) are stripped by the older schema, which does not fail on them.
  - **Skip-mode checkouts.** An older daemon does not add the skip-mode index to its children's environment. Later git commands in a checkout created in skip mode then run under the user's own git config, which is the pre-v1.2.2 behaviour. The checkout's pointer files stay as they are.
