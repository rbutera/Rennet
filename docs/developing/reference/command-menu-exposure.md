---
title: Command exposure
description: Which of the 113 registered commands the ⌘K menu lists and which the session thread holds as tools, with the rationale for every row.
---

The command registry in `packages/protocol/src/commands/index.ts` carries an
`exposure` record per row. `exposure.commandMenu` decides whether the ⌘K command
menu lists that command; `exposure.agent` decides whether the session thread holds
it as an `app_*` tool. This page is the row-by-row inventory behind both flags:
every registered command, its verdict, and why.

Neither flag is derived from a blanket rule; both are decided per command. The
third consumer of the same table, the dispatch map, is covered by
[surfacing and routing](../concepts/surfacing-and-routing.md).

## What earns a menu row

The menu invokes a selected command with **no input** and shows **no result** — a
boolean flag has no input channel, and the dialog has no result surface. So a
command earns `commandMenu: true` only when all four hold:

1. **Its schema accepts `{}`.** Nothing required that the menu cannot supply.
   19 of the 113 commands pass this; the rest need a review, session, project,
   span, host, or path the menu has no way to name. A protocol test asserts the
   invariant, so an exposed row can never be one that only fails.
2. **It is an action, not a read the UI already drives.** `settings.get`,
   `session.list`, `board.read`, `harness.hosts`, `daemon.status` and friends are
   wire the surfaces fetch for themselves. Running one from the menu changes
   nothing a reader would see.
3. **Its output is not the point.** `github.connectStart` mints a device code and
   `pairing.mint` mints a pairing code; both must be displayed, and the menu would
   throw them away.
4. **It means something outside the surface that owns it.**
   `github.connectCancel` only makes sense mid-device-flow.

Under-exposure is honest. A menu entry that appears to run and visibly does
nothing is a broken row, so a command stays `false` whenever the verdict is
uncertain. Widening the set means giving the menu a way to supply context and show
a result — new UI, deliberately not built.

## Exposed to the menu

No raw protocol command is exposed today — no row carries `commandMenu: true`. Command
mode leads with app actions, settings, projects, and sessions.

One of those app actions dispatches a protocol command directly rather than opening a
dialog: **Replay the first-run welcome** runs `settings.resetWelcome`. It is authored in
`packages/app-ui/src/shell/command-menu-entries.ts` with a readable title, because the
registry's label is the command id (#465) and an id makes a poor menu row. The dispatch
still goes through the one seam; only the label is hand-written.

## Not exposed to the menu

### app, repository

| Command | Rationale |
|---|---|
| `app.bootstrap` | Boot handshake the client runs itself on mount. |
| `repository.choose` | The path comes from the in-app directory browser; an empty input reaches the daemon's fallback chooser, not the user's pick. |

### review

| Command | Rationale |
|---|---|
| `review.capture` | Needs a command id and the repository path, and narrates through a stream surface the menu does not have. |
| `review.openPr` | Needs the PR reference the front door collects. |
| `review.load` | Read the review route drives from its own slug. |
| `review.prWorktree` | Needs the review whose PR branch is being checked out. |
| `review.setDisposition` | Needs the finding and the disposition being recorded. |
| `review.checkFreshness` | Read the board drives for the review it is showing. |
| `review.regenerate` | Needs the review and generation being regenerated. |
| `review.uiEvidence` | Needs the review and the evidence the surface captured. |
| `review.refine` | Needs the review and the refinement instruction. |
| `review.draftPrBody` | Needs the review, and its draft must be displayed. |
| `review.deltaDigest` | Needs the generation pair being compared. |
| `review.symbolLookup` | Needs the symbol and citation being inspected; its result must be displayed. |
| `review.openInEditor` | Needs the file citation to open. |
| `review.reviseSpan` | Needs the span and the revision being applied. |
| `review.handoff.prepare` | Needs the review and the chosen exit. |
| `review.handoff.run` | Needs the prepared handoff bundle. |
| `review.handoff.compose` | Needs the review and disposition it composes from; its draft must be displayed. |

### publish

| Command | Rationale |
|---|---|
| `publish.review` | Needs the review and the composed body; publishing is a deliberate click on the publish surface. |
| `publish.receipt` | Read the Hand off lane drives for the current composed publication marker. |
| `publish.submitPr` | Needs the review and the PR draft it submits. |
| `publish.compose` | Needs the review it composes for, and its draft must be displayed. |

### harness, forge, daemon

| Command | Rationale |
|---|---|
| `harness.detect` | Read-only disclosure with no mounted reader; a menu run would visibly do nothing. |
| `harness.hosts` | Read the environments surface drives for itself. |
| `harness.setEnabled` | Needs the host, the agent id, and the new state. |
| `forge.detect` | Read-only disclosure with no mounted reader. |
| `forge.hosts` | Read the environments surface drives for itself. |
| `forge.setEnabled` | Needs the host, the forge id, and the new state. |
| `daemon.status` | Read the environments surface drives for itself. |
| `daemon.reconnect` | Needs the host being reconnected. |
| `daemon.update` | Needs the host being updated. |
| `chat.t3Send` | Needs the review and the composed question; the answer appears in the thread, not as command output. |
| `chat.t3Session` | Brokers T3 sidecar access to the chat slot; nothing for a person to pick. |

### github

| Command | Rationale |
|---|---|
| `github.status` | Read the connect card drives for itself. |
| `github.connectStart` | Mints a device code that must be displayed; the menu discards output. |
| `github.connectPoll` | Poll wire inside the connect flow. |
| `github.connectCancel` | Only meaningful mid-device-flow, which the connect card owns. |
| `github.setToken` | Needs the pasted token. |
| `github.disconnect` | Removes only Rennet's fallback credential. Settings → Environments → GitHub account exposes it after proving the live source is the fallback; a context-free command could visibly do nothing while `gh` remains connected. |

### projects and project

| Command | Rationale |
|---|---|
| `projects.list` | Read the sidebar and front door drive. |
| `projects.add` | Needs a discovery result it cannot fabricate. |
| `projects.remove` | Needs the project; removing one from a fuzzy row is destructive without context. |
| `project.discover` | Needs the granted path and project kind. |
| `project.rename` | Needs the project and the new name. |
| `project.process` | Needs the project; the indexing surface narrates the run. |
| `project.detail` | Read the project surface drives. |
| `project.cleanupWorktree` | Needs the project and the worktree it removes. |
| `project.logos` | Read the sidebar's project marks drive. |
| `project.uploadLogo` | Needs the project and the picked file's bytes. |
| `project.detectLogo` | Needs the project; Identity's "Detect again" runs it. |

### fs, patchset, board

| Command | Rationale |
|---|---|
| `fs.listDir` | Directory-browser read; its listing must be displayed. |
| `patchset.readSpan` | Needs the citation, and its lines must be displayed. |
| `patchset.readEvidence` | Needs the citation; its diff hunks, reviewed sources and test counterparts must be displayed. |
| `board.read` | Read the board surface drives. |
| `board.draft` | Read the board surface drives; it catches a mid-draft board up before folding its live frames. |
| `benchmarks.list` | Read the Settings benchmarks panel drives; its runs must be displayed. |

### flagged, noise, openspec

| Command | Rationale |
|---|---|
| `flagged.review` | Needs the review whose flagged items are being read. |
| `flagged.adjudication` | Needs the flagged item being adjudicated. |
| `noise.review` | Needs the review it scores. |
| `openspec.change` | Needs the change id, and its content must be displayed. |

### settings

| Command | Rationale |
|---|---|
| `settings.get` | Read every surface drives. |
| `settings.guidance` | Read the settings surface drives for a project and repository. |
| `settings.setAppearance` | Needs the scheme being set. |
| `settings.setKeybinding` | Needs the command id and the chord. |
| `settings.setCoachmarks` | Needs the coach-mark state being written. |
| `settings.setBenchmarkRecording` | Needs the on/off state being written; the toggle owns it. |
| `settings.setRoleAssignment` | Needs the role and its assignment. |
| `settings.setRepoVisibility` | Needs the repository and the visibility. |
| `settings.resetRepoValue` | Needs the repository and the key. |
| `settings.pinRepoValue` | Needs the repository, key, and value. |
| `settings.setProjectValue` | Needs the project, key, and value. |
| `settings.setGuidance` | Needs the guidance text and its scope. |
| `settings.setThemePack` | Needs the pack being selected. |
| `settings.setLastProject` | Needs the project being remembered; the app writes it as you navigate. |
| `settings.completeWelcome` | Only means something inside the welcome wizard, whose Ready step runs it. |
| `settings.resetWelcome` | Reachable from the menu, but as the **Replay the first-run welcome** action row, not a raw registry row: the registry label is the command id, and `settings.resetWelcome` is not a thing to read in a menu. |

### pairing, device, attention

| Command | Rationale |
|---|---|
| `pairing.mint` | Mints a pairing code that must be displayed; the menu discards output. |
| `pairing.exchange` | Needs the minted code the device presents. |
| `pairing.listDevices` | Read the pairing surface drives. |
| `pairing.revokeDevice` | Needs the device being revoked. |
| `device.registerPush` | Needs the push token; paired-device wire, not a user action. |
| `attention.acknowledge` | Needs the attention event being acknowledged. |

### ask and round

| Command | Rationale |
|---|---|
| `ask.stage` | Needs the ask being staged onto a session. |
| `ask.unstage` | Needs the staged ask being removed. |
| `ask.edit` | Needs the ask and the edited text. |
| `ask.retire` | Needs the ask being retired. |
| `ask.restore` | Needs the retired ask being restored. |
| `ask.quoteOpen` | Needs the quoted span the thread opens on. |
| `ask.quoteReply` | Needs the thread and the reply. |
| `ask.quoteClose` | Needs the thread being closed. |
| `ask.setVerdictOverride` | Needs the ask and the override verdict. |
| `ask.setLineComment` | Needs the line citation and the comment. |
| `ask.clearLineComment` | Needs the line citation being cleared. |
| `ask.dismissFinding` | Needs the active session and finding reference. |
| `ask.restoreFinding` | Needs the active session and finding reference. |
| `ask.read` | Read the review surface drives. |
| `round.dispatch` | Needs the session's staged asks and council picks. |
| `round.retry` | Needs the retained failed operation and its exact durable checkpoint. |

### session

| Command | Rationale |
|---|---|
| `session.transcript` | Read the chat surface drives. |
| `session.rounds` | Read the rounds surface drives. |
| `session.roundEvents` | Read the run view drives; needs the review it belongs to. |
| `session.list` | Read the sidebar drives. |
| `session.mint` | Needs the project, and the branch or pull request being claimed — New Chat's picker is where a reviewer names them. A parameterless mint could only guess a target, and guessing one would claim it. |
| `session.cancelPreparation` | Needs the session whose active capture or board generation should stop. |
| `session.retryPreparation` | Needs the failed or cancelled session and a fresh command id. |
| `session.rename` | Needs the session and the new title. |
| `session.setPinned` | Needs the session and the pin state. |
| `session.archive` | Needs the session being archived or restored. |
| `session.landWorkBranch` | Needs the session whose work branch is being landed; the action is offered on that session's round card, beside the branch it fast-forwards. |
| `session.workBranchState` | Read the review workspace drives beside the session's branch; needs the session whose work branch is being measured. It answers how far the sibling is ahead of the branch, how far the branch is behind the remote-tracking ref a push updated, and whether the branch already contains the work — all read from git at request time, so running it from the menu would change nothing a reader would see. |

### worktrees

| Command | Rationale |
|---|---|
| `worktrees.list` | Read the Settings → Projects → Worktrees card drives; needs the repository path whose workspaces it lists. |
| `worktrees.remove` | Needs the repository and the opaque id of the row being removed, which only a `worktrees.list` answer carries. A parameterless removal could only pick a workspace for the reviewer. |

## Agent exposure

`exposure.agent` decides whether a command reaches the review's session thread as an
`app_*` tool. The daemon stands up one loopback MCP listener, `rennet_app`, whose
tool list is `buildAppTools(dispatch)` — a projection of this flag and never a
hand-kept list, so flipping a row here adds or removes a tool with no other edit.

### What earns an agent row

The thread is the reviewer's conversation inside Rennet. It already has everything
the harness has: the checkout, a shell, the file tools. What it does not have is the
**review** — which patchset, what the boards concluded, what is staged, what rounds
ran. So a row earns `agent: true` when it answers one of two questions:

1. **What is the reviewer looking at?** The reads below turn a sentence like "the
   Decisions board on the auth branch" into the session, the review and the board it
   names. A workspace maps many repositories onto one identity and that mapping is
   not invertible, so the thread lists sessions and loads one rather than assuming
   the session it is bound to.
2. **Which path does Rennet track?** A staged ask carries a receipt, lands in the
   reviewer's composer, and goes out through the exits the reviewer clicks. The acts
   below are those paths. The briefing steers the thread toward them; it forbids the
   thread nothing (Rule Zero), and an unexposed row is a tool the thread does not
   have, never a capability it is denied — it keeps its shell either way.

A row stays out when the act belongs to the reviewer's own hand. Every `publish.*`
row is out because nothing another human can see gets published without Rai clicking
post. `review.regenerate` and `review.refine` are out because they are model spend the
reviewer commissions. `ask.retire`, `ask.restore` and `ask.dismissFinding` are out
because they are the reviewer's verdict on a finding, not the thread's.

### Exposed — reads

| Command | Rationale |
|---|---|
| `session.list` | Which reviews exist. The thread resolves "the auth branch" to a session id from this list instead of guessing from the one it is bound to. |
| `review.load` | The review behind a session id: its patchset, branch, generations and repository presence. A pure read that appends no event. |
| `board.read` | What a lens concluded. The boards on disk are event logs; this is the readable projection, and it is how the thread answers a question about a finding instead of re-deriving one from the diff. |
| `patchset.readSpan` | The cited lines of a board span, served from the captured patchset — so an answer quotes what was reviewed, never a working tree that has moved on. |
| `patchset.readEvidence` | The hunks, reviewed source and test counterparts behind a citation, for a question the span alone cannot answer. |
| `ask.read` | What is already staged, retired and commented. Without it the thread re-raises an ask the reviewer already has. |
| `session.rounds` | Which coding rounds ran on this review and what they landed. |
| `session.transcript` | The rounds' own turns, for a question about what a round actually did. |
| `review.deltaDigest` | What moved between generations, in the successor account's own words. |
| `review.symbolLookup` | An identifier's definition and reference sites from the review's model-free symbolic surface. Deterministic, no model spend. |

### Exposed — acts

| Command | Rationale |
|---|---|
| `ask.stage` | The mechanism Rennet tracks: the ask lands in the reviewer's composer with the thread as author, and the reviewer sends it. Staging does not send. |
| `ask.edit` | Correct an ask's body — the thread's own, or one the reviewer asks it to sharpen. The receipt is the undo. |
| `ask.unstage` | Withdraw an ask. Same receipt, same undo. |
| `ask.quoteReply` | Answer on a quote thread the reviewer opened on a span. The author is stamped from the thread's identity, never taken from the model's input. |
| `review.handoff.compose` | Fold the addressed asks into one work order. Composes a bundle; runs nothing. |
| `review.draftPrBody` | Draft the pull-request body from the review's own facts. Drafting posts nothing; submitting is a separate click. |
| `round.dispatch` | Hand the staged asks to a coding round. The round runs on its own thread and reports back through the review. |
| `review.capture` | Start a review of a branch the reviewer names. |
| `review.openPr` | Open a review of a pull request the reviewer names. |
| `repository.choose` | Grant a path. One of the two `projects.add` prerequisites — without it the add-project tool is uncompletable. |
| `project.discover` | Read-only discovery over a granted path, producing the `DiscoveryResult` `projects.add` cannot fabricate. |
| `projects.add` | Add the discovered project. |
| `projects.list` | The projects the reviewer has. |
| `settings.get` | The settings every answer about configuration is read from. |
| `settings.setAppearance` | Set the colour scheme when asked. |
| `settings.setKeybinding` | Set a command's chord when asked. |
| `settings.setRepoVisibility` | Set a repository's visibility when asked. |
| `settings.pinRepoValue` | Pin a repository-scoped setting when asked. |
| `settings.resetRepoValue` | Clear a repository-scoped setting when asked. |

### What a capped result carries

A tool result is billed like a prompt and re-read on every remaining round trip of
the turn, so every result that carries a collection declares a cap, an honest marker
naming how many were elided, and a cursor to ask for the next page:
`board.read` at 200 elements, `session.list` at 50 sessions, `session.transcript` at
100 rows, and `patchset.readEvidence` at 16 kB of patch text. These four caps run
first, when they apply.

Behind them, every one of the 29 exposed commands answers to one further, universal
ceiling: the COMPLETE serialised result of any `app_*` call — paged or not — is
bounded to `APP_TOOL_RESULT_MAX_BYTES` (8 kB). Under it, a result rides unchanged;
over it, the full result (its page and marker included, when it has them) is
written to a file and the reply becomes an honest envelope naming what happened:

```json
{ "truncated": true, "bytes": 79190, "path": "…/tool-results/app_ask_read-….json",
  "head": "…", "note": "Result exceeded the inline ceiling; read the file at `path` with your own tools." }
```

The file lands under the calling session's own context directory
(`.rennet/context/<sessionId>/tool-results/`) when the thread's session and bound
workspace root both resolve — the same directory a turn's prompt already names, so
it is swept the same way when the session archives. When neither resolves yet (a
call before any session is bound, or a bare test harness), the file falls back to a
plain `tool-results/` directory under the daemon's state dir, swept by age (24
hours) at daemon start instead, since it carries no session lifecycle to piggyback
on.

The per-command caps exist because paging a large collection into several
readable pages is more useful to a model than one opaque spill file would be; the
universal ceiling exists because a per-command cap is easy to add to four commands
and easy to forget on the other twenty-five — `ask.read` on a 400-ask projection
reproduced at 144,611 B with no cap of its own before this ceiling existed. Both
are executable — `packages/server/src/board/board-tool-surface.measure.test.ts`
iterates every exposed command against large fixtures, asserts each per-call result
is at or under the universal ceiling, and asserts the spilled file (when a result
spills) holds the complete, untruncated result.

## Changing the inventory

Edit `MENU_EXPOSED` or `AGENT_EXPOSED` in
`packages/protocol/src/commands/index.ts`, mirror the change in `MENU_INVENTORY` or
`AGENT_INVENTORY` in `commands.test.ts`, and add the row and its rationale here.
Three protocol tests hold the boundary: menu exposure equals the menu inventory
exactly, agent exposure equals the agent inventory exactly, and every menu-exposed
row's schema accepts an empty input. A new agent row that carries a collection in
its result and would benefit from its own page-and-cursor shape earns one, plus a
row in the measurement test above — but every row, capped or not, already answers to
the universal ceiling with no further wiring needed.
