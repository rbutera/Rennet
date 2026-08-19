---
title: Mobile ideation
description: What mobile Rennet is — prior-art survey, command classification, jobs, notification taxonomy, and the connection model for the native app.
---

This is deliverable 1 of the
[phase 6 gate](/developing/reference/app-server-plan/#the-phase-6-gate-the-mobile-design-pass)
([#382](https://github.com/rbutera/rennet/issues/382)): what mobile Rennet
is, grounded in a prior-art survey, an honest walk of every protocol
command, the jobs the phone does, the notification taxonomy, and the
connection model. It feeds the wireframe pass (deliverable 2) and the
impeccable planning pass (deliverable 3).

## Prior art: what the field converged on

Surveyed 2026-08-18: the ChatGPT mobile app's Codex surface (the May 2026
cross-platform preview and the 2025 iOS integration), the Paseo mobile app
(Expo/React Native client of a local daemon — AGPL, so every observation here
is a pattern description, never code), plus GitHub Mobile's PR review flow,
the Claude app's Code tab, and Cursor's web/Slack agents as secondary
references.

### Where every serious player agrees

**The phone is a remote control, not an IDE.** Codex mobile loads live state
from a machine where the agent runs; files and credentials never leave it
([openai.com](https://openai.com/index/work-with-codex-from-anywhere/)).
Paseo's client is a thin peer of a local daemon. Nobody ships code editing on
a phone. This is exactly Rennet's daemon model, so the mapping is direct: the
app consumes the R19 projection and steers, it never hosts work.

**QR pairing is the solved bootstrap.** Codex pairs by scanning a QR from the
desktop app; Claude Code's `/mobile` prints one; Paseo's welcome screen offers
scan-QR, paste-pairing-link, and manual host entry, decoding a connection
offer and probing before saving. Rennet's Phase 4 pairing is already this
shape — the phone screen is a camera view plus a paste-link fallback.

**Structured timeline, not a terminal.** Both apps render a typed event
timeline — user message, assistant message, reasoning, tool call, activity —
with tool calls collapsed to summaries. Paseo opens large tool output in a
bottom sheet so the user inspects detail without losing chat position, and
keeps a "return to tail" anchor when the user scrolls up during streaming.
Codex streams "the artifacts that matter for the decision" — the failed test,
the diff, a screenshot — not raw stdout.

**Diff digest first, raw diff on demand.** Codex curates the
decision-relevant subset for the small screen. GitHub Mobile shows real
per-line diffs but is triage-grade by its own positioning; complex multi-file
diffs push users to desktop. Paseo has a full diff viewer (unified and split)
but reaches it through summaries. Rennet's canvas digest read path is the
validated instinct: lead with the delta digest and the load-bearing hunks,
expand to full canvas on demand, never paginate a 40-file raw diff.

**Replies steer, not just approve.** Codex approvals carry context: the user
can redirect the approach, pick between two proposed paths, or switch models
from the phone mid-run. Paseo's composer makes send-while-running an explicit
setting — interrupt mode (send lands immediately, interrupting the turn) or
queue mode (send queues for after the turn) — and persists drafts across
navigation; what it lacks is a distinct one-tap abort. For Rennet's ask/turn
interaction, the reply control is free text that carries both the decision and
any new instruction — an answer chip row plus a text field, not a bare
approve/deny pair — with explicit interrupt-vs-queue semantics and a visible
stop control Paseo never shipped.

**Status-first session list.** Paseo's agent list aggregates every connected
daemon into one list, pins running agents to the top, groups the rest by
recency (Today / Yesterday / This Week), and badges rows that are blocked on
permissions or errored. Tap navigates, long-press archives, pull-to-refresh
resyncs. This is the review list screen: reviews across projects and daemons,
running and needs-you states pinned, disposition at a glance.

### The failure to avoid: notifications

Push is Codex mobile's loudest complaint. As of the May 2026 preview,
blocked approvals do not reliably push; the approve control is small and low
on the screen; users keep the app foregrounded or bolt on third-party
watchers to get lock-screen prompts
([community.openai.com](https://community.openai.com/t/codex-approval-requests-should-trigger-mobile-push-notifications/1381134)).
The community's framing is the design rule: *approval requests are not
passive updates — they are user-blocking events.*

Paseo shows the correct machinery: the daemon tracks each client's presence
(device type, focus, visibility) and computes a notification plan per event —
a live in-app event when the client is focused on that agent, a push when it
is not. Attention is raised on turn completion, turn failure, and pending
permission; viewing the conversation clears it; high-priority events bypass
the bandwidth filters that drop unfocused agents' events on mobile.

Paseo's users then raised the bar further: their loudest open request
([getpaseo/paseo#306](https://github.com/getpaseo/paseo/issues/306), asking
for an Apple Watch approve/deny surface) says that even push-plus-deep-link
still "defeats the purpose of remote agent management" when answering
requires opening the app and finding the agent. Paseo's own trajectory points
the way: question notifications summarize the requested input and finish
notifications carry the result, so the user can often decide from the
notification shade.

For Rennet: "review finished" and "turn needs you" are high-priority pushes
that deep-link straight to the decision surface, shipped in the first cut,
with delivery decided daemon-side by client presence. The push carries the
substance — the ask's question and its answer options, the finished review's
disposition — and where the platform allows, the answer is an action on the
notification itself. Deferring push the way OpenAI did is the one mistake
this survey exists to prevent.

### Reconnect and offline, from the phone's seat

Paseo's model survives the realities of a phone: the server holds a session
alive through a ~90-second reconnection grace window; the client keeps two
timeline buffers (persisted tail plus ephemeral streaming head) reconciled by
sequence-number pagination, so re-hydrating after backgrounding is a cheap
tail fetch rather than a replay; hidden clients stop receiving updates after
a grace period, and reconnect triggers a directory resync. Codex's host-side
relay reconnects on machine wake. The Rennet translation: paint the last
replica instantly on open, reconcile by cursor, and rebind live ask-streams
on reconnect —
[#389](https://github.com/rbutera/rennet/issues/389) is exactly this gap.

### Where Rennet deliberately differs

**Transport.** Paseo's remote path is an E2E-encrypted relay — hosted by
default (`relay.paseo.sh`, a Cloudflare Worker in their account) but
self-hostable and opt-in (off by default on modern daemons); Codex runs
through OpenAI's secure relay. Notably, Paseo also documents Tailscale
direct as a first-class connection path (phone joins the tailnet, add host
by Tailscale IP and port). Rennet's standing decision is Tailscale-first
with no relay (any future relay must be E2E ciphertext-only and
self-hostable — a bar Paseo's relay happens to meet). The lesson transfers —
the phone must reach the daemon without exposing the laptop to the internet
— but the mechanism is the user's tailnet, not our server.

**Posting is the headline, not an afterthought.** No surveyed product treats
"post the review under my name" as its central mobile moment; GitHub Mobile
comes closest with its PR-approve flow. Rennet's publish flow — preview,
then one tap posts, from the sofa — is the differentiating screen. There is
no extra step and no confirmation ceremony (Rai's call, 2026-08-18): the
preview already shows exactly what posts, and the post button is the click.

### Open gaps Rennet can own

- **Share-sheet kickoff.** No surveyed app starts work from a shared PR
  link — confirmed absent in both Codex mobile and Paseo. iOS/Android share
  sheet on a GitHub PR URL → new Rennet review is a natural headline and
  cheap to build on Expo.
- **Blocking-event push done right** (above) — day-one, deep-linked,
  presence-aware.
- **Voice dictation to steer** is open field (Paseo ships full dictation and
  voice mode; Codex mobile has none confirmed). Not first-cut, but the
  composer should not preclude it.

### Mobile form-factor patterns worth stealing outright

From Paseo (patterns, not code): overlay panels with pan-to-close instead of
a persistent tab bar; bottom sheets for tool detail and for agent controls;
routes scoped by server id so multiple daemons coexist in one navigation
tree; drafts persisted per agent; presence-based event filtering to save
phone bandwidth; a too-large-diff placeholder instead of attempting the
render. From GitHub Mobile: mark-as-viewed progress tracking across files,
as prior art on consequential mobile actions (their biometric gate is
their branch-protection requirement, not a pattern Rennet adopts — posting
stays one un-ceremonied tap).

One cost their changelog documents at length: React Native streaming plus
large diffs is where the app breaks — a long tail of freeze, blank-screen,
and dropped-session fixes when switching workspaces mid-stream or rendering
big diffs. Budget list virtualization and lazy hunk mounting from the first
cut, not as a retrofit — the whole review must stay readable on the phone,
so performance is an engineering constraint, never a scope cut.

## Command classification

The honest scope statement: every command in `commandDefinitions`
(`packages/protocol/src/index.ts`), classified. The gate issue said 49; the
registry holds **53** today because Phase 4 added the four `pairing.*`
commands after the gate was written. All 53 are walked here.

The classes:

- **Mobile-primary** — the phone is designed around it; it appears on a
  first-cut screen.
- **Mobile-secondary** — works over the R19 projection and is reachable on
  the phone, but no screen is optimized for it; it rides along in later
  cuts or behind detail surfaces.
- **Absent-by-locus** — meaningless where the phone is, with the reason
  stated. Absence is about *place*, never permission: the phone is a full
  peer within its locus (Rule Zero), and nothing here is a capability gate.

### Mobile-primary (24)

| Command | Why the phone is designed around it |
| --- | --- |
| `app.bootstrap` | Every client's first call; paints the replica. |
| `projects.list` | Home surface: reviews across projects at a glance. |
| `project.detail` | The project row expanded; entry to its reviews. |
| `review.load` | Opening a review is the core read path. |
| `review.canvases` | The canvas digest read path — a headline phone job. |
| `review.deltaDigest` | The delta digest: triage a re-review at a glance. |
| `review.checkFreshness` | Freshness/staleness is a list-row fact on the phone. |
| `review.setDisposition` | Triage verdicts from the sofa. |
| `canvas.disposition` | Per-finding verdicts — the unit act of triage. |
| `canvas.select` | Navigating findings on the review detail screen. |
| `canvas.adjudicateProposal` | Accepting/rejecting a proposal is a one-tap decision. |
| `flagged.review` | The flagged queue is a purpose-built triage list. |
| `flagged.adjudication` | Answering the flagged queue's asks. |
| `review.ask` | Answer a turn's ask — the push-driven job. |
| `review.reattach` | Rejoin an in-flight turn after backgrounding/reconnect — the phone's lifecycle makes this constant, not exceptional. |
| `review.openPr` | Kick off a review from a PR link — the share-sheet headline. |
| `review.capture` | Kick off a review of your own branch from the sofa — the pre-submit loop's entry. |
| `review.regenerate` | Re-run the review; part of the end-to-end loop, not a desk act. |
| `review.refine` | Refinement turns are how a review converges; the loop is incomplete without them. |
| `review.draftPrBody` | Drafting the PR title/body is a leg of the own-branch submit flow. |
| `publish.requestConsent` | First leg of posting. |
| `publish.review` | Post a team-PR review: the product's human act, phone-sized. |
| `publish.submitPr` | Post the own-branch PR: same act, other destination. |
| `pairing.exchange` | The phone's side of pairing: scan the QR, trade the code for a device token. |

### Mobile-secondary (25)

| Command | Standing on the phone |
| --- | --- |
| `review.uiEvidence` | Evidence renders; dense evidence reading favors the desk. |
| `review.symbolLookup` | Symbol inspector works in a bottom sheet; not a first-cut screen. |
| `review.handoff.prepare` / `.compose` / `.run` | Kick off and watch a prepared handoff from the phone; composing bundles is desk-shaped. Its completion push is first-cut even though its screens are not. |
| `noise.review` | Noise-lens inspection works; group pull-back is a detail surface. |
| `canvas.setCohortExpansion` | Expansion state follows canvas reading; not designed-for. |
| `canvas.pinAnnotation` / `.clearAnnotation` | Annotation pinning works; precision pointing favors the desk. |
| `openspec.change` / `.coverage` | Spec angle reads fine; a later-cut surface. |
| `project.discover` / `projects.add` | Adding a host-side repo from the phone works via the discovered list; the flow is desk-shaped. |
| `project.process` | Trigger and watch processing via `onProgress`; the narration screen is secondary. |
| `project.cleanupWorktree` | Housekeeping tap; no dedicated screen. |
| `harness.detect` | Harness disclosure line on the connection screen; read-mostly. |
| `settings.get` / `.guidance` / `.setAppearance` | Settings read + appearance toggle; thin phone settings surface. |
| `settings.setRepoVisibility` / `.setRepoLocus` / `.resetRepoValue` / `.pinRepoValue` | Repo-scoped settings rows work; management is desk-shaped. |
| `pairing.listDevices` / `.revokeDevice` | Seeing and revoking devices from the phone is useful; a settings row, not a screen. |

### Absent-by-locus (4)

| Command | Why it is meaningless at the phone's seat |
| --- | --- |
| `repository.choose` | Opens the host's native directory picker; there is no phone-side browser for the host filesystem. Project adding on the phone goes through `project.discover` instead. |
| `review.openInEditor` | Opens a file in the editor on the host machine; the person holding the phone is, by definition, not in front of that editor. |
| `settings.setKeybinding` | Binds desktop keyboard chords; the phone locus has no hardware keyboard or chord surface. |
| `pairing.mint` | Minting a pairing offer is the trusted seat's act — the desk prints the QR the phone scans. The phone consumes offers via `pairing.exchange`. |

The macOS application menu is a static platform-role menu installed in Electron
main (app/Edit/Window, no commands; Windows and Linux have none) — Electron
plumbing, not a command surface, and desktop-only by the same locus logic with
no renderer bridge involved.

## Jobs

What the phone does:

1. **Triage a finished review.** Open from a push or the list; read the
   delta digest and canvases; set dispositions and adjudicate findings.
2. **Answer a turn's ask.** The ask arrives as a content-carrying push;
   the reply carries a decision and, when wanted, redirection — answer
   chips plus free text, with explicit interrupt-vs-queue semantics and a
   visible stop.
3. **Steer or interrupt a running review.** Watch the live turn via
   `onAskStream`, send mid-turn, stop it.
4. **Read the whole review** at phone width: the delta digest leads, and
   the full sequence canvas renders complete — every finding and hunk,
   virtualized, in reading order. The digest is the entry point, never a
   boundary.
5. **Post.** Preview, then one tap posts — from anywhere. The product's
   one human act, now sofa-shaped — a headline feature, not an
   afterthought. No extra step, no confirmation ceremony: the preview
   already showed exactly what posts.
6. **Kick off a review from a PR link** — share sheet or paste into
   `review.openPr`.

What it explicitly does not do: write or edit code, compose handoff
bundles, manage the host filesystem, or replace the desk for dense
multi-file reading. Not because it is forbidden — because the locus makes
those desk work.

## Notification taxonomy

Which daemon events become pushes, and where each lands. Every push
carries its substance (the ask's question, the review's disposition
counts), deep-links to the decision surface, and — where the platform
allows — offers the answer as a notification action. Delivery is decided
daemon-side by client presence, the Paseo pattern: a client focused on
that review gets the live in-app event only; everyone else gets the push.
Opening the linked surface clears the attention flag.

| Event | Protocol anchor | Push | Deep-links to |
| --- | --- | --- | --- |
| Turn needs you (ask pending) | `onAskStream` ask event; pending `review.ask` turn | **High priority.** Summarizes the question; answer options as notification actions where possible | The ask thread in review detail |
| Review finished | Review pipeline completion (`review.capture` / `review.openPr` / `review.regenerate` outcome) | High priority: repo, branch, finding counts | Review detail, delta digest first |
| Turn failed or interrupted | Turn outcome (`failed` / `interrupted`) | High priority: what stopped and why, truthfully | Review detail in its error state |
| Handoff run completed | `review.handoff.run` outcome | Normal: outcome + delta summary | The handoff outcome / delta carry surface |
| Publish-ready | Composed draft awaiting your post | Normal: destination + title | The publish preview screen |
| Processing finished | `project.process` terminal `onProgress` event | Low / silent update | Project detail |

Flagged-queue arrivals fold into "turn needs you" — a flagged ask is an
ask. Nothing else pushes; a taxonomy that pushes everything is a muted
app within a week.

## Session and connection model

**Multiple daemons, one list.** A phone pairs with any number of daemons
(home desktop, work machine). Navigation is scoped by server identity, and
the home list aggregates reviews across all connected daemons — the Paseo
shape. Each daemon row shows reachability plainly.

**Pairing is bootstrap, not ceremony.** The desk mints (`pairing.mint`,
shown as QR + copyable link); the phone scans or pastes and calls
`pairing.exchange`; the device token lands in Keychain/Keystore. After
that the phone just works — pairing is connection bootstrap, not a
consent gate (Rule Zero).

**Transport is the tailnet.** Tailscale-first, no relay, per the standing
decision. The phone joins the user's tailnet and reaches the daemon
directly; nothing is exposed to the public internet and no Rennet server
sits in the path.

**Reconnect is the normal case.** A phone backgrounds, switches from
Wi-Fi to cellular, and comes back — constantly. The model, adopted from
the survey: paint the last replica instantly on open; reconcile by cursor
against the daemon; `review.reattach` rejoins any in-flight turn
(interrupted turns land in thread messages, never a hung spinner); the
live ask-stream rebinds to the new socket
([#389](https://github.com/rbutera/rennet/issues/389) is this exact
liveness gap). The daemon holds subscriptions through a short grace
window so a network blip never loses turn state.

**Offline shows the last replica, never a blank.** Disconnected, the app
remains a readable record of every synced review, with an unmissable
staleness banner and reconnect state. Read-only history beats an empty
screen; a lie about liveness is a bug.

**Bandwidth respects the phone.** Presence-aware event filtering
daemon-side: an unfocused review's high-frequency stream events are
dropped for that client, and hidden clients stop receiving updates after
a grace period — but attention-class events (asks, completions, failures)
always bypass the filter.
