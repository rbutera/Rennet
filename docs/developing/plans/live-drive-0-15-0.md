---
title: Live drive plan, v0.13.0 to v0.15.0
description: One sitting with the shipped desktop app and a real harness that exercises every feature and fix released since v0.13.0, with the evidence each step must leave behind.
---

This is the plan for driving the shipped app, not the hermetic e2e. It runs on the
reviewer's own installed `claude` and `codex` through the sidecar, so every model
turn spends the reviewer's subscription. Rai drives it, or gives the go for a seat to
drive it on his behalf. Nothing here touches a client repository: the fixture is
Rennet's own checkout.

## What the drive covers

| Release | Change | Where it shows |
|---|---|---|
| v0.13.1 | Liquid sphere mark in the chrome and the welcome (#931, #933, #934, #937) | Sidebar lockup row, collapsed orb, working state, welcome hero and Ready badge |
| v0.13.2 | Live-generation polish (#939) | Boards while they draft: code blocks, Cancel chip, no Continue mid-draft, Flagged holds its tab |
| v0.13.2 | Marketing captures and platform copy (#938, #940) | rennet.dev, not the app; checked once at the end |
| v0.14.0 | Primary base resolved from the newest ref (#946) | New Chat row counts, branch capture, the PR's base |
| v0.14.0 | Design overview when the branch has no specification (#945) | The Design board of a branch with a PR description, a docs change and a related issue, but no spec |
| v0.14.0 | Marketing lens sections (#943); SDK platform binary stripped at package time (#941) | rennet.dev; the installed app bundle |
| v0.15.0 | The session thread is briefed, tooled and council-routed (#949, #950) | The chat: what it knows, what it can read, what it can stage, after a relaunch |
| after | README first-impression pass (#951) | GitHub, checked once at the end |

## Ground rules

- **The shipped build.** Install or auto-update to v0.15.0. The first launch after
  upgrading from an older daemon must respawn the sidecar once (the old one has no app
  bearer and is refused for adoption); scenario A watches that happen.
- **Real harness, real spend.** No `RENNET_DISABLE_HARNESS`. Both `claude` and `codex`
  installed and signed in. Expect one generation (seven seat threads) per review plus the
  chat turns below; keep the branches small so the boards are quick.
- **Fixture is Rennet itself.** Two drive branches are cut from `main` (setup below). Never a
  client repo, never anyone else's PR.
- **Evidence is what the step leaves behind, never a sentence.** For every scenario: a
  screenshot into `~/rennet-drive-0.15.0/<scenario>-<step>.png`, the relevant
  `~/.rennet/daemon.log` lines, and for chat steps the thread's own transcript (the sidecar
  keeps it). The drive ends with a follow-up PR that ticks task 6.1 of
  `openspec/changes/session-thread-briefing/tasks.md` and attaches the evidence.
- **Every check that can have a positive control gets one.** The control is named in the
  step. A step whose expected outcome is "nothing happened" needs its control most.

## Setup

1. **Branches.** From `main` in a scratch worktree:
   - `drive/0.15.0-nospec`: two commits. One edits `docs/using/guides/getting-started.md` (a
     real sentence, not whitespace), one changes two lines of code with a test. Push it and
     open a **draft PR** whose description states what it does and links #947. No OpenSpec
     change on this branch. This is the Design overview fixture: PR description, a docs
     change, a related issue.
   - `drive/0.15.0-spec`: one commit that edits `openspec/changes/session-thread-briefing/design.md`
     plus a matching line of code. Do not push it. This is the "spec found" fixture and the
     "review a branch you are not standing on" fixture.
2. **Stale primary spelling (for #946).** In the checkout Rennet will review, leave the local
   `main` two commits behind `origin/main` (`git fetch origin` without merging). The New Chat
   row must count against the newest spelling, `origin/main`, not the stale local one.
3. **Two repos on one branch (for the workspace rule).** Optional but cheap: clone any small
   public repo of your own beside the Rennet checkout, give it a `main`, and add both to one
   Rennet project. The chat scenarios then have a same-named branch to get wrong.
4. **Fresh eyes on the welcome.** Do not wipe `~/.rennet`. Use **Settings → Appearance →
   First Run → Replay the first-run welcome**; it exercises the same code with your projects
   intact.
5. **Evidence folder** `~/rennet-drive-0.15.0/` created empty; note the start time so the
   daemon log can be cut to the drive.

## Scenarios

### A. Upgrade, first launch, and what the daemon stands up

1. Launch v0.15.0 with the previous daemon's sidecar still around from v0.14.0.
   **Expect** in `daemon.log`: the stored sidecar refused for adoption (no app bearer), a
   fresh sidecar spawned, the app-tools listener bound at launch with its port remembered
   under the sidecar's base dir. **Control:** quit and relaunch; the second launch adopts the
   sidecar and does not respawn.
2. **Health.** The health report names the sidecar as an owned process with harness-only
   egress and telemetry off. Screenshot.
3. **Packaging (#941).** From a terminal:
   ```sh
   find /Applications/Rennet.app -path '*claude-agent-sdk-*' -print
   ```
   **Expect** no output. **Control:** the same `find` against a v0.13.x bundle, if one is
   still around, prints the platform package.

### B. The mark in the chrome (#931, #933, #934)

1. Expanded sidebar: the lockup sits on its own row under the traffic lights, sphere 44 px,
   wordmark 22 px high, one accessible image named Rennet. Screenshot light and dark.
2. Collapse the sidebar: the floating pill is 36 px and carries the orb at 32 px; the chat
   header carries the orb at 32 px when it owns the corner. Exactly one sphere is on screen
   in either state. Screenshot both.
3. Start a review (scenario D opens one): while boards prepare, the sphere ripples (working
   state), the Continue FAB is absent, and a floating Cancel chip sits top-right clear of the
   session top bar. When a round is in flight later (scenario H) the sphere ripples again.
   **Control:** with nothing running the sphere rests.

### C. The welcome and the orchestrator choice (#937, #949 task 4.4)

1. Replay the welcome. Hero: the sphere between roughly 93 and 145 px across the viewport
   range as you resize; step header sphere 32 px beside the 16 px wordmark; Ready badge
   sphere 72 px with the tick on its corner, two spheres on that screen by design.
   Screenshots.
2. **The choice is real.** With both harnesses detected and Dual Harness on, choose
   **Codex** as the orchestrator and finish. Open any session's chat: the thread's model
   control shows a Codex model, and `daemon.log` shows `orchestrator-chat` resolved to
   `codex`. Replay again, choose **Claude**, open a **new** session: the thread is Claude.
   **Control:** an existing session keeps the thread it already had (instructions and
   model are fixed at create), so only the new session changes. This is the migration rule
   the docs state; confirm the old session's thread is unchanged.
3. Settings → Environments shows the `orchestrator-chat` mapping the welcome wrote.
   Screenshot.

### D. New Chat, the primary base, and capture (#946)

1. New Chat → the Rennet project. The `drive/0.15.0-nospec` row shows ahead/behind and a
   diffstat measured against `origin/main` (the newest spelling), not the stale local
   `main`. **Control:** `git log --oneline main..origin/main` in the checkout shows the two
   commits the local branch lacks; the row's "behind" count matches the newest ref, so it
   does not include those two.
2. Open the review of `drive/0.15.0-spec` **without checking it out** (you are standing on
   another branch). The workspace opens on its boards at once with capture named in the
   header; nothing on disk moves (`git status` unchanged). Screenshot the header mid-capture.
3. Later, at scenario H, the PR that Rennet opens must have `baseRefName` `main`, never
   `origin/main`:
   ```sh
   gh pr view <number> --json baseRefName
   ```

### E. Live generation (#939)

Run this on the `drive/0.15.0-spec` review while its boards draft.

1. Every code block on a board being written renders as code, no schema error in the
   card. Screenshot mid-draft.
2. Open a lens seat's transcript drawer: the Cancel chip does not sit on the drawer's Close.
   Screenshot.
3. While drafting there is no Continue anywhere, not even disabled; it appears bottom-right
   when the boards are ready. Screenshot before and after.
4. Click **Flagged** while it is still drafting: Flagged stays lit and shows its own
   in-progress account; Design's article and any "no spec found" absence do not appear.
   **Control:** click Design; it lights and shows Design.

### F. The Design overview fallback (#945)

1. `drive/0.15.0-spec` review: Design finds the OpenSpec change on the branch and drafts
   from it. Stats say the format is OpenSpec. Screenshot.
2. `drive/0.15.0-nospec` review (a PR review of the draft PR, or the branch): Design settles
   as an **overview**, stats `Format: Overview` and `Specification: none found`, the intro
   naming its sources (the PR description, the docs change, related issue #947), decisions
   only where the PR or a document states one. Screenshot. Open the seat transcript: it read
   `related-context.md` from the session's context directory, never an inlined dossier.
3. **Control (the residual absence keeps its words):** a third throwaway branch with one
   code commit, no PR, no docs change, no linked issue → Design settles `no-spec` with the
   same wording as before.

### G. The session thread is briefed (#949)

Use the `drive/0.15.0-spec` session unless a step says otherwise. Save the thread's
transcript at the end (T3 keeps it under the sidecar's base dir).

1. **Identity.** Ask: *"What are you, and what can you do here?"* **Expect** an answer that
   names Rennet, this review's branch and review id, the five boards, that rounds run on
   their own threads, and the count of `app_*` tools attached (29). It must not describe
   itself as a plain Claude Code agent or cite only the repo's `CLAUDE.md`. Compare with the
   2026-09-12 screenshot that started this work.
2. **Nothing forbidden.** Ask: *"Are you allowed to edit files, commit, or push here?"*
   **Expect** yes, with the steer: staging an ask is the path Rennet tracks. No "I am not
   permitted".
3. **Reads a board on demand.** Ask: *"Read the Flagged board and tell me the highest
   finding."* **Expect** an `app_board_read` call in the transcript and an answer naming the
   finding, its path and lines. Screenshot the tool call and the answer.
4. **Knows which review is meant.** Ask about the *other* session by name: *"On the nospec
   branch, what does the Design overview say its sources were?"* **Expect**
   `app_session_list` → `app_review_load` → `app_board_read` and the right answer. With the
   optional two-repo project from setup, ask about "the `main` branch" and confirm it reads
   the repository this session names, not the other one.
5. **Stages an ask.** Ask: *"Stage a request-changes ask on that highest finding: ask for a
   test that pins the boundary."* **Expect** an `app_ask_stage` call; the ask appears in the
   basket labelled as coming from the chat thread; nothing is sent, dispatched or posted.
   Screenshot the basket row. **Control:** unstage it from the basket; the thread's next
   read of `app_ask_read` no longer lists it.
6. **Explain from a span.** Highlight a Sequence board span and choose **Explain**. The turn
   text starts with an `Anchor:` line naming the board, the lens, the path and the line
   range above the `Code reference:` JSON; the answer cites the lens and lines. Screenshot.
7. **Large results spill, honestly.** Ask: *"Read this session's full transcript and
   summarise it."* **Expect** a result under the inline ceiling that carries a `path` under
   `.rennet/context/<sessionId>/tool-results/`, relative to the checkout, and the thread
   opening that file with its own tools. Confirm the file exists and that it is not staged
   (`git status` clean of `.rennet/`).
8. **Survives a relaunch.** Quit Rennet (the daemon stops the sidecar), relaunch, open the
   same session, ask: *"Which review are you on?"* **Expect** the same identity answer: the
   briefing was persisted on the thread and honoured on recovery.
9. **The Codex leg.** In the session created in scenario C step 2 with Codex chosen, repeat
   steps 1 and 3. **Expect** the same knowledge on Codex (the briefing rides its developer
   instructions every turn).
10. **Cost is visible.** Open T3's usage view for the thread: the first turn's input carries
    the briefing plus the 13 kB tool catalog; note the figure. This is the number the PR
    description promised; write it into the evidence.
11. **Control, dev build only (optional).** In a dev checkout, remove `board.read` from
    `AGENT_EXPOSED`, run `pnpm nx run rennet-desktop:dev`, open a **new** session and ask
    for the tool count: 28, and the thread reports it has no board tool. Restore.

### H. Rounds and exits, regression (unchanged code, changed thread)

1. Stage two asks from the boards yourself, hand off to the coding agent. The round runs on
   its **own** thread (the chat stays a conversation); the round report names the workspace
   and the thread; the sphere ripples while it runs.
2. Continue → open the pull request for `drive/0.15.0-spec`. Check its base per scenario D
   step 3. Close the PR afterwards.
3. Ask the chat: *"Compose the hand-off for the remaining asks and show me the work order."*
   **Expect** `app_review_handoff_compose` and the work order named by path, not pasted.

### I. Outside the app (#938, #940, #943, #951)

1. rennet.dev: the hero is a capture of the app; download copy says macOS or Windows; one
   section per lens plus diff, explain and hand-off, each with a real capture. The chat
   capture's third turn tells the reviewer to stage from Flagged.
2. GitHub README: the three-line hook, the theme-aware Design lens hero, the Quickstart.

## Evidence checklist

Tick each before the follow-up PR:

- [ ] A1 log lines: refused adoption, respawn, app listener port; A3 empty `find`
- [ ] B1–B3 screenshots, both colour schemes for the lockup
- [ ] C2 two daemon log lines (`orchestrator-chat` → codex, → claudeAgent) and the model control screenshots
- [ ] D1 row counts vs `git log`, D2 `git status` unchanged, D3 `baseRefName`
- [ ] E1–E4 screenshots
- [ ] F1–F3 Design stats screenshots and the seat transcript showing `related-context.md`
- [ ] G1–G10 transcript exports, basket screenshot, spill file path, usage figure
- [ ] H1–H3 round report and PR base
- [ ] I1–I2 screenshots

The follow-up PR ticks `openspec/changes/session-thread-briefing/tasks.md` 6.1 with the
evidence folder attached, and files an issue for anything that did not match, quoting the
step. Read the PR body back after creating it.

## Known flakes, out of scope

- Main CI can fail on `claude-usage.test.ts` (#942) or the `workspace-inventory` du budget;
  neither is exercised by this drive.
- WSL-locus sessions cannot reach the loopback tool servers from inside the distro (#947);
  no WSL step here.
- The thread-id control at the real `thread.create` dispatch is bundle-gated (#948).
