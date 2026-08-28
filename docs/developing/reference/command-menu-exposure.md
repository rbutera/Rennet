---
title: Command menu exposure
description: Which of the 96 registered commands the ⌘K menu lists, and the rationale for every row.
---

The command registry in `packages/protocol/src/commands/index.ts` carries an
`exposure` record per row. `exposure.commandMenu` decides whether the ⌘K command
menu lists that command. This page is the row-by-row inventory behind that flag:
every registered command, its verdict, and why.

The flag is decided per command, never derived from a blanket rule. Two other
consumers read the same table and are unaffected by this page:
[surfacing and routing](../concepts/surfacing-and-routing.md) covers the dispatch
map and the `app_*` agent projection (`exposure.agent`, its own inventory).

## What earns a row

The menu invokes a selected command with **no input** and shows **no result** — a
boolean flag has no input channel, and the dialog has no result surface. So a
command earns `commandMenu: true` only when all four hold:

1. **Its schema accepts `{}`.** Nothing required that the menu cannot supply.
   18 of the 96 commands pass this; the rest need a review, session, project,
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

## Exposed

| Command | Rationale |
|---|---|
| `github.disconnect` | Parameterless, a real user action (sign out of GitHub), reversible by reconnecting, and meaningful from anywhere in the app. |

Selecting it dispatches live through the data seam. The menu stays open until the
dispatch settles: it closes on success, and on failure it stays put carrying the
reason. A menu row never reports a success it did not get.

## Not exposed

### app, repository

| Command | Rationale |
|---|---|
| `app.bootstrap` | Boot handshake the client runs itself on mount. |
| `repository.choose` | The path comes from the client's own native picker; an empty input reaches the daemon's fallback chooser, not the user's pick. |

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
| `review.ask` | Needs the review, the ask, and a stream to narrate into. |
| `review.reattach` | Read the chat route drives to re-attach a live run. |
| `review.interrupt` | Needs the run it interrupts; only the surface showing it knows which. |
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

### github

| Command | Rationale |
|---|---|
| `github.status` | Read the connect card drives for itself. |
| `github.connectStart` | Mints a device code that must be displayed; the menu discards output. |
| `github.connectPoll` | Poll wire inside the connect flow. |
| `github.connectCancel` | Only meaningful mid-device-flow, which the connect card owns. |
| `github.setToken` | Needs the pasted token. |

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
| `project.contextMap` | Read the Context Map surface drives for its project. |
| `project.contextAsk` | Needs the project and the question. |
| `project.knowledgeDisposition` | Needs the project and the disposition being recorded. |

### fs, patchset, board

| Command | Rationale |
|---|---|
| `fs.listDir` | Directory-browser read; its listing must be displayed. |
| `patchset.readSpan` | Needs the citation, and its lines must be displayed. |
| `board.read` | Read the board surface drives. |

### flagged, noise, openspec

| Command | Rationale |
|---|---|
| `flagged.review` | Needs the review whose flagged items are being read. |
| `flagged.adjudication` | Needs the flagged item being adjudicated. |
| `noise.review` | Needs the review it scores. |
| `openspec.change` | Needs the change id, and its content must be displayed. |
| `openspec.coverage` | Needs the review and change being compared. |

### settings

| Command | Rationale |
|---|---|
| `settings.get` | Read every surface drives. |
| `settings.guidance` | Read the settings surface drives for a project and repository. |
| `settings.setAppearance` | Needs the scheme being set. |
| `settings.setKeybinding` | Needs the command id and the chord. |
| `settings.setCoachmarks` | Needs the coach-mark state being written. |
| `settings.setRoleAssignment` | Needs the role and its assignment. |
| `settings.setRepoVisibility` | Needs the repository and the visibility. |
| `settings.resetRepoValue` | Needs the repository and the key. |
| `settings.pinRepoValue` | Needs the repository, key, and value. |
| `settings.setProjectValue` | Needs the project, key, and value. |
| `settings.setGuidance` | Needs the guidance text and its scope. |

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
| `ask.read` | Read the review surface drives. |
| `round.dispatch` | Needs the session's staged asks and council picks. |

### session

| Command | Rationale |
|---|---|
| `session.transcript` | Read the chat surface drives. |
| `session.rounds` | Read the rounds surface drives. |
| `session.roundEvents` | Read the run view drives; needs the review it belongs to. |
| `session.list` | Read the sidebar drives. |
| `session.rename` | Needs the session and the new title. |
| `session.setPinned` | Needs the session and the pin state. |
| `session.archive` | Needs the session being archived or restored. |

## Changing the inventory

Edit `MENU_EXPOSED` in `packages/protocol/src/commands/index.ts`, mirror the change
in `MENU_INVENTORY` in `commands.test.ts`, and add the row and its rationale here.
Two protocol tests hold the boundary: menu exposure equals the inventory exactly,
and every exposed row's schema accepts an empty input.
