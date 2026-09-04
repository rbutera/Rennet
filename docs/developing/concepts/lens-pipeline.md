---
title: The lens pipeline
description: How Rennet's five lenses are drafted, linted, edited, and rendered as boards.
---

A lens is one reading of the change — design, sequence, decisions, flagged, or
noise — drafted by a review agent on a fixed prompt and read as its own board.
This page describes how a draft is produced, what guarantees it before a human
sees it, and the rules every board obeys.

## The five lenses

Design, Sequence, Decisions, Flagged, Noise — in that display order, Design
first. Each lens is a board of typed blocks drafted by a review agent on a
fixed prompt.

The client projects the boards present in the selected generation into a
centred rail in the session top bar, in that same order. The session URL owns
the selection. Flagged is the address-free default; another lens uses `?lens=`.
When a completed frozen generation has no Flagged board, the client selects its
first present lens and replaces the URL with that canonical address. A live
generation drafts progressively: it may show the first board that arrives, but
it keeps the requested address so a later Flagged arrival restores that reading.
A typed absence or explicit failure remains selectable and renders its terminal
state. Only a lens with no durable terminal evidence has no segment; that lens
can still be in flight.

New Chat persists a session before it captures the selected target and navigates
to that session immediately. The session's durable preparation snapshot records
capture, then folds the pipeline's real per-lens events into five progress lanes.
It is distinct from round progress: no coding round is fabricated for an initial
generation. Completion clears the snapshot and reveals the review workspace;
failure, cancellation, and daemon interruption remain explicit, retryable session
states.

The prompts live in `packages/prompts` (`@rennet/prompts`), one markdown file
per lens plus the reviewer-voice file, the round-report classifier prompt, and
one shared partial: the "Investigate before you draft" section every lens file
carries at a `{{investigate-before-you-draft}}` marker line, spliced in when
the pipeline reads the prompt so five files cannot drift apart on it.
The package exports a typed manifest. Noise has two instruction sets on
purpose: `noise.md` drives the Noise lens board seat, and the `NOISE_CONTRACT`
prompt contract drives the RSP noise-document runner behind the noise index;
they emit different shapes to different validators. The board schema is never prompt text:
each lens seat's session is bound to it once, as the harness's structured-output
format, and the landed-round report seat is bound to a much smaller
classification schema instead.

## The drafting flow

The scheduler lives in `packages/server/src/runtime/lens-pipeline.ts`
(`runLensPipeline`); the pure logic it drives — lint, the validation loop,
composition mechanics — lives in `packages/core/src/board/`. The scheduler is
pure over injected seams (the harness ports, a prompt-file reader, and the
whiteboard writer), so the whole path runs in tests against a fake `runTurn`
with no live model call.

`runLensPipeline`'s consuming turn is the **rounds runtime**.
`createRoundsRuntime` (`packages/server/src/runtime/rounds.ts`) is the
composition root that supplies the scheduler's open seams — `onBoardArrival` to
the board-event broadcast, `persistBoardMeta` to the durable `BoardMeta` store,
`composeTurn` to the orchestrator's authoring turn, `readPrompt` to the node
prompt reader — and drives a generation visit: the round-report seat settles its
sequencing boundary first, then the five independent lens lanes draft concurrently.
The per-board arrival events this scheduler emits drive the progressive reveal — each
lane publishes its own settlement as it lands, so a slow Design or Noise lane never holds
a finished core board back — and a
`PipelineStartGuard` keyed on the session and
exact generation visit makes a retry of that dispatch reattach rather than
double-start. `create-server` owns the live trigger: the own-branch round loop
dispatches the coding turn, captures its result against the active patchset,
and calls board regeneration through this runtime.

0. **Round-report first** (on landed rounds only). When a coding round returns
   with its exact worker receipt, the `round-report` seat makes one structured
   semantic-classification turn before any lens drafter starts. Its prompt names
   one file, `evidence.json` in the session's context directory, holding only the
   successor patchset id, the durable dispatched asks, the worker's changed paths
   and observed commit range, and the round's **evidence manifest** (see the
   classifier evidence contract below); the seat reads it with its own tools.
   It does not receive the full DeltaPacket or the verbatim diff, nothing rides
   inline, and its session is bound to the narrow classification schema rather
   than the all-kind board schema. Each ask is
   reduced to its durable id, path, instruction, and optional source anchor, so
   stale prior-diff context cannot compete with the coding turn's measured
   evidence. The host sorts the outcomes and builds the document, section,
   outcomes, and code refs deterministically — including every line anchor, which
   it derives from the cited evidence rather than reading from the model. It then
   verifies the whole partition and every derived anchor before persistence.
   Readback also requires the exact ask text and forbids change evidence on an
   `untouched` outcome. There is no model retry or generic post-process turn on
   this path. The resulting board is both the reviewer's greeting and the lens
   drafters' input. Here, **legacy caller** means an injected pipeline caller that
   supplies the older round context without an exact worker receipt. It retains
   the generic drafting path for compatibility. A live durable coding round
   always carries the receipt and never selects that path.
1. **Draft.** One agent per lens receives the delta context and its lens
   prompt and returns a structured board. The host board schema, derived once
   from the frozen `DraftBoardSchema`, binds the seat's session as its
   structured-output format and is not repeated in the prompt. Each drafting instruction
   requires a document envelope with an authored title, a short Markdown
   introduction, and a measure. The target owns the final measure: Design is
   `structured`; Sequence, Decisions, Flagged, and Noise are `reading`. The host
   constructs the landed-round report document with the `reading` measure.
   The host, never the drafter, writes the board ops through
   `whiteboard-client` (the sole op writer); drafters never call whiteboard
   tools. The Flagged lens runs two independent seats (Claude and Codex) on the
   same instructions. A verified report arrives before any lens turn starts and
   opens that boundary, after which all five lens lanes run
   independently rather than waiting for the preceding display-order lens. A
   required report that fails or proves unavailable ends the round at report
   drafting with its exact reason; no lens turn starts behind an unusable
   greeting. Report arrival is an awaited handoff. The durable consumer must
   verify, read back, and record the report before the pipeline starts any lens
   seat; a rejected handoff ends the round with zero lens turns.
   Every Council seat inherits the user's own harness configuration. Claude
   seats always load the user's filesystem settings — authentication routing,
   such as a settings-env `ANTHROPIC_BASE_URL` credential proxy, lives there,
   and a seat that skipped user settings would reach the API on the wrong
   credential. That inheritance includes the user's hooks, plugins, and
   configured MCP servers, which start per seat. The one narrowing is on the
   Codex side: the five board-pipeline jobs hand Codex an explicit empty
   MCP-server table (which also disables Codex plugins), because Codex starts
   configured MCP servers eagerly and these one-shot seats use only their
   session context directory and native repository tools.
   A clean generation makes one drafting turn for Design, Sequence, Decisions,
   and Noise, plus the two parallel Flagged seats. It does not run a separate
   board editor after those turns, and no lens spends a second turn accounting
   for what it did not cite.
2. **Reconcile** (Flagged only). The two seats' findings are matched by cited
   location: a matched pair collapses to ONE row carrying both models'
   concurrence — the clearer of the two summaries when the seats concur, seat
   A's when they conflict, with both seats' verbatim answers riding along in the
   agreement — and a solo finding carries only the raising model's. Whichever id
   the surviving row keeps, the consumed one is gone from the board, so the merge
   repoints its citers rather than leaving them naming an element the write no
   longer holds. The result is folded into each finding's board-native
   `concurrence` tally (`{ model, agree, total }` per seat), alongside an
   `accord` stamp naming how the seats landed: `concur`, `split` (one seat
   answered "no concern"), or `conflict` (both raised it at materially different
   severities). The stamp is load-bearing, because a concurrence and a conflict
   fold to the identical tally pair — without it a reader cannot tell agreement
   from disagreement.
   With only one harness available the lens degrades to a single seat, stamped
   with honest single-model concurrence and no accord: one seat has no
   agreement to report.
3. **Validate.** A deterministic loop guarantees every lens draft before a human
   sees it. It parses the frozen schema and runs the per-lens lint rules. A lint
   failure returns the draft to its seat as ZodError-shaped JSON pointers on one
   retry channel; the seat returns a patch, and passing elements **freeze** — a
   frozen element is never re-linted or re-drafted. The repair turn is
   pointer-only on every leg: it carries the pointers (each naming the element it
   is about), the frozen ids as a list so references stay valid, and the
   instruction — never the lens prompt, the previous draft, or anything of the
   change. That only means something to a session that already holds the draft —
   and every board seat is one, because a board job runs on a sidecar seat thread
   and nowhere else. A generation with no sidecar drafts no board at all: each
   lane settles as a typed failure naming the missing sidecar, so there is no leg
   left that could be handed pointers it cannot resolve. The host merges the
   frozen bodies back itself. After a turn that emitted nothing, the re-ask is for
   the whole board — that one carries no reference to a draft the session must
   remember. Validation spends at most
   one model repair turn after the initial draft. An element that remains
   invalid takes an **honest-omission exit**: it is dropped and the drop is
   recorded as an omission naming the element and the reason. Unresolved
   board-level or schema violations ship as labelled `blemishes` —
   **visible, never blocking**.

   After validation, the host checks the material the served board actually
   needs. Sequence requires a reachable `order_step`. Decisions and Flagged
   require a reachable `decision` or `finding`, unless the provider returned a
   parsed zero-element board that supports typed `no-decisions` or `no-findings`
   absence. Noise has the equivalent `no-noise` absence, and its prompt asks for exactly
   that empty board when nothing in the change is skip-safe, rather than a board of
   "this must be read" verdicts. Missing core material
   becomes that honest absence or a precise failure; it never starts a second
   full drafting session and never lands as an empty successful board.

   The kind palette is enforced *structurally at parse time*: the frozen
   `DraftBoardSchema` has no `thread`, `message`, or `code` kind, so an
   out-of-palette kind is rejected with ZodError issues before any lint rule
   runs. The lint rules the seat runs then enforce what parse cannot:
   - **kind allowlist per lens** — each lens admits only its own element kinds;
   - **no code bytes** — code inside legal prose is a lint error; code on a
     board is a `code_ref` (path plus line span) the surface hydrates, so
     numbering cannot drift from the file it claims to show (backticked
     identifiers and patchset ids are exempt);
   - **citation resolves** — every citation is a repository path plus a 1-based
     line range on the new or the old side, and the daemon resolves it against
     the changed regions of the captured patchset with the same predicate the
     citation reader uses: every cited line must sit inside a captured region on
     the named side, so a range one line past a hunk, or spanning the gap between
     two, comes back to the seat as an unresolvable-citation pointer carrying the
     path, the range and the nearest changed range (a rename's base side answers
     to either name; a truncated capture's tail counts as changed rather than
     being claimed outside; a range past the end of the file is the
     citation-resolves overrun pointer alone; a citation naming a side that is
     neither `base` nor `head` is the board schema's own pointer, and lint
     answers nothing about it rather than checking it against head);
   - **element references resolve** — every schema-declared element reference
     names an element in that exact board, and the reference graph is acyclic so
     the host can create each target before its citer;
   - **decision-grounded** — a decision carries non-empty evidence and
     alternatives;
   - **a process-vocabulary screen** flags structural-field prose that names
     lenses, boards, agents, seats, or drafts.

   The core validator retains its typed-data immutability result for
   callers that provide a deterministic transform; the production lens scheduler
   supplies no model-backed post-process transform. Immutability is its own
   gate rather than a lint rule, and a handful of designed rules reference fields
   the frozen schema deliberately does not carry (they wait on a schema
   follow-up rather than being enforced against absent data). The reviewer-voice
   authored prose is screened by a separate, narrower register.
   A drafting turn that emits **no board at all** is not a settlement. It seeds
   the same retry ladder an unparseable first return does, so the seat is
   re-asked rather than the lane failing at attempt zero. Only a ladder that ran
   out without any turn emitting settles a failure, and that failure names both
   facts: the original non-emission and the re-asks it spent.
4. **Freeze.** The validated structured draft becomes the lens board without a
   second model rewrite. Host-owned Design projections, Flagged reconciliation,
   round composition, delta stamps, and metadata persistence remain deterministic.

   Those host-owned passes run *after* lint, so the board that gets written is
   not the board lint last saw. A **reference-admission pass** at the write
   boundary checks every element reference against the exact document being
   written, because the board service validates references in batch order and
   rejects the whole write as `bad-ref` when one names an element the document
   does not contain. An inadmissible reference is repaired only when its unique
   intended target is provable: exactly one element of that document shares the
   reference's identity, it is not the citing element itself, and it is the kind
   the field is declared to hold — an `order_step.span` may only land on a
   `code_ref`. Identity folds case and the separator set (`-_./\` and space) and
   nothing else; two ids that differ in a letter, ASCII or not, are two ids. A
   `code_ref` must cite the captured patchset this generation reads, and that test
   applies to a reference spelled exactly as much as to a repaired one, because an
   id that happens to exist is not a licence to cite another patchset's code. The
   one exception is host-carried round history: a prior round's addressed chapter
   is *about* an earlier generation, so its orchestrator-authored anchors keep that
   generation's patchset. Every repair is recorded on the board's durable metadata.
   An ambiguous or absent target is not proof: the lane settles a typed failure
   instead. An element is **never** dropped to
   make the rest of a board acceptable — an accepted board that silently sheds
   produced material is the quiet lie the complete-coverage ruling forbids. The
   board service stays authoritative and keeps rejecting; repairs happen
   producer-side. The Flagged dual-seat merge repoints its own collapsed
   findings' citers at the surviving partner for the same reason.
5. **Compose.** A frozen draft board *is* the lens board the human reads; there
   is no separate composed surface. Composition is split. The **mechanical**
   part lives in `core/board/`: verbatim carry on stable element ids (a carried
   element is byte-identical across generations), `new`/`reworked` delta stamps on sections, and the host-owned
   finding lifecycle for a returned round. That lifecycle matches each
   generation-and-board-scoped finding against the prior and freshly drafted
   Flagged boards. It removes only a stable-id or unique semantic match for an
   addressed ask or durable dismissal. It leaves an ambiguous match or a
   reference to an abandoned draft attempt visible and returns a detached
   resolution instead of applying the old disposition. A uniquely reattached
   dismissal is cloned onto the successor board before Flagged persists, while
   the frozen predecessor keeps its own disposition. On Sequence,
   the same pass preserves earlier host chapters and appends
   **Round N · Addressed** from the report's exact dispatched-ask ids. The pass
   is pure and produces the successor boards without changing either input
   board or any frozen generation.

   The **authored** part is the orchestrator's connective review prose, written
   write-through on the versioned reviewer-voice prompt
   (`src/prompts/review-draft-voice.md`) in the reviewer's first-person
   register. The authoring prompt carries path references only: the voice rules
   are written to `review-draft-voice.md` in the session's context directory,
   each frozen board to `boards/<lens>.json`, and any curation feedback from the
   prior generation to `curation-feedback.md`; the seat reads them there. The
   authored prose is screened by a narrower register lint (citations plus the
   machinery screen) — visible, never blocking.

Each successful board persists its metadata as soon as its lane settles, so live
progress follows completion order. Successful typed absences, **per-board arrival
events**, and **lens failures** are all published in that same settlement order
through one serialized callback, which keeps cumulative generation snapshots
monotonic. A lane's arrival is emitted the moment its board is written — no global
barrier over the five lanes — and a lane whose attempts are exhausted is emitted the
moment they are, for the same reason: a failure only visible in the returned outcomes
is a failure the surface cannot show until the slowest sibling finishes, which is how
a seat that died at 33 s went on reading "quiet for 320 s" until the reveal. The
returned
outcomes still use the canonical Design, Sequence, Decisions, Flagged, Noise
order regardless of which drafter finished first, because that array is
completion bookkeeping rather than the reveal. The rounds machinery consumes the
arrival events to drive the reveal; the pipeline only emits them.

**Coverage is a projection, never a gate.** No step checks that every changed
region was taught or accounted for: a board carries no skip list, composition
runs no coverage assertion, and no reveal is blocked, failed, or annotated on
coverage. Which regions the boards cite is derivable on the daemon from the
citations themselves, so a coverage view is a read over what was cited rather
than an obligation on a seat.

**Per-phase timings are durable and versioned.** One record per phase —
`report` (the whole report gate) and `report-classification` (the provider turn
inside it), each lane's `lens-draft` / `lens-repair` / `lens-post-process`, plus
`reveal` and `first-core-board` — carries the wall-clock start and the measured
duration. They live on the generation under a versioned `timings`
record, so no label can absorb another phase's time and the
[benchmark archive](../reference/benchmarks.md) reads this one spine rather than
measuring anything a second time. `lens` is discriminated on the record: the four
lane-scoped phases require it, the generation-wide ones forbid it.

**Spend is durable beside the timings.** Every seat turn the pipeline runs
(board, report, repair, on either harness) records one metric into the
generation's collector: tokens and, when the provider gave one, its price. The orchestrator's compose turn is not yet
counted. The sum rides the lens progress frame while the generation drafts and
lands on the generation as `usage` when it settles; a repeat drafting attempt
adds to the prior attempt's total rather than replacing it. The round shows it
as one line under the lane rows, naming any turns that produced no usage record
so a partial sum is never read as the whole. A price appears only when every
turn was metered and priced; a subscription session shows tokens and no invented
dollar figure. Retries are counted like any other turn, and a repair is always a
further turn on the seat's own thread.

Two of those records are measured from a boundary the pipeline does not own.
`first-core-board` starts from the moment the **reviewer's** wait began — the
captured input becoming ready on an initial generation, the round landing and
its report verifying on a returned one — which the caller supplies, because
measuring from the drafting runtime's own entry would silently exclude board
minting, partial-state cleanup and provider resolution. `reveal` ends at the
last lane that actually revealed something; a lane that failed revealed nothing
and does not extend the window.

**Every stage record names what ran it, one record per seat.** A single-seat
lane emits one `lens-draft` record carrying that seat's harness and model. The
Flagged lane runs two seats, so it emits **two** — each with its own provenance
and its own wall-clock span, and the lane's aggregate span is min-start to
max-end across them. That is what makes "this run was dual-model" derivable from
the stages rather than assumed from settings; one merged record could name no
harness at all, which answered the question with silence.

**Repair budgets are per lane and per whole-board attempt.** The first drafting
run over a generation spends the lane's full ladder; every repeat whole-board
attempt — the redraft a restart's partial-state recovery starts — draws the same
repeat entry, so one restart costs one draft plus that budget rather than a
silently refreshed ladder. The repeat entry is reduced but never zero: a zero
budget ends a lane on one malformed output, and the restart recovery that exists
to re-draft a retryable lens could then never produce a board for it.

The classified report path also emits content-free diagnostics. Its fixed
milestones distinguish provider time from session cleanup, schema parsing,
evidence verification, and board persistence. Each milestone carries only enums
and a nonnegative integer `elapsedMs`; the first also names the resolved harness,
model, and effort. Prompts, provider prose, model output, diffs, paths, evidence,
and classification notes never enter these events. Legacy report drafting and
the five lens seats emit none.

A retry after process loss reserves the same board identities. The runtime
reconstructs an exact landed-round report only when its metadata and element log
agree, then re-runs the same changed-line verification before reuse. That path
makes no second classifier call. It replaces every other partial board as one
attempt: remove its metadata first, clear its board state second, then draft. The
order is repeatable after a crash and prevents stale metadata from presenting a
partially cleared board as complete. A malformed or semantically invalid report
is scrubbed the same way before one fresh classification turn.

## The classifier evidence contract

The round-report classification turn is bounded on both sides, locally, with the
limits declared once in `@rennet/protocol`'s `round-evidence` module. The numbers
below are those constants; if they disagree with the code, the code is right and
this page is a bug.

**What goes in.** The host parses the coding turn's measured diff into a
canonically ordered **evidence manifest**. Each unit carries a content-derived id
(`ev-` plus 16 hex characters of a SHA-256 over the unit's kind, path, and identity
— hunk text, mode pair, previous path, or change status). The order is path
(compared by code unit, never a locale-dependent comparator — one shared comparator
serves the manifest, the report builder, and the report verifier), then kind
(`rename`, `mode-change`, `binary`, `text-hunk`), then position within the file.

Read the id's stability precisely, because the contract is narrower than "stable":

- **Rebuilding the same measured diff yields the same ids.** That is the recovery
  path — a report recovered after a crash is re-verified against ids rebuilt from
  the same diff — and it is the property the system relies on.
- **A change in an unrelated file never renumbers a surviving unit,** the way an
  ordinal position would.
- **An unrelated change in the same file, above a hunk, re-keys that hunk.** A text
  hunk's identity includes its `@@` header, which carries line numbers. Dropping the
  header would remove that shift and collide two byte-identical hunks in one file
  onto a single id — ids must be unique within a manifest before stability across
  manifests means anything. Uniqueness is enforced: a repeated id (a shared identity
  or a 16-hex collision) is a typed local failure, not a silently merged bucket.

Evidence is a discriminated union, and **no variant invents a line anchor**:

| Variant | Carries | Anchor |
| --- | --- | --- |
| `text-hunk` | The verbatim `@@` header and body | The hunk's first added line, or its first deleted line when it only removes |
| `rename` | The head path and the previous path | None |
| `mode-change` | The old and new file modes | None |
| `binary` | The path and the change status | None |

A file that both moved and changed contributes a `rename` unit *and* its
`text-hunk` units, so a mixed change stays lossless across variants.

**The input budget.** The complete serialized manifest is measured in UTF-8 bytes
by one serializer: at or under **262,144 bytes** and **400 entries** it is sent
intact; over either limit produces a typed local failure with **zero provider
calls**, routed to the durable round-failure path. Nothing is truncated, split, or
summarized to fit — a manifest that fits by omission would classify a change that
did not happen.

**What comes back.** The classifier returns outcomes and `beyond` entries that cite
manifest ids in `evidenceIds`; it never writes a path, a side, or a line number.
The provider's raw response is capped at **131,072 UTF-8 bytes**, enforced at the
harness transport boundary in both the Claude and the Codex adapter *before*
structured-output decoding — core only ever sees decoded values, so a core-side
check would already be too late. On the Claude leg the SDK hands the structured
output back already decoded, so both carriers (the result text and the decoded
object) are measured and the larger governs. Decoded cardinality limits then apply
before persistence: at most **100** `beyond` entries, and exactly one outcome per
dispatched ask.

The turn also asks the provider for at most **32,768 output tokens**, so an
over-long classification stops at the source rather than being paid for and then
rejected. That cap is **asymmetric by transport, and honestly so**: the Claude
harness takes it through its child environment, while `codex` exposes no
model-output-token parameter or config override at all, so a Codex classification is
bounded by the byte cap alone. The byte cap is the enforced backstop on both legs.

**The partition.** Every manifest id appears in exactly one ask outcome or the
`beyond asks` bucket. Unknown, duplicated, and omitted ids are all rejected before
anything is persisted, and the accepted ids are stored on the board's
`round_outcome` elements, so a recovered report is re-verified against the measured
diff rather than trusted.

**When it fails.** Every limit above fails typed to the durable round-failure path
and spawns no further turn — a cap failure never becomes another classification
attempt. Because the classifier is side-effect-free before durable projection,
recovery after a crash MAY repeat the provider call; what is guaranteed is exactly
one durable report projection per round, not exactly-once remote invocation.

## Reading a board back

A drafted board lands in two durable places. Its elements go to the whiteboard
event log. Its document envelope, blemishes, omissions, and immutability result
go to the board-meta store before the board arrival is announced. The client
reads both halves through `board.read`, keyed by review, generation, and lens. The handler resolves the review's session, finds that
triple's board-meta record, projects the element state, and assembles one
`LensBoard` with the persisted document, the element pool in creation order,
and one fold line per top-level section.

Fold counts are reader-facing domain objects, not raw element-kind tallies. The
projection emits findings, decisions, requirements, steps, outcomes, groups,
files, and comments from each section's direct children. Repeated code refs for
one path count as one file, and structural prose does not inflate the count. A
pair with no persisted board answers `null`. A successful empty result is typed
instead of persisted as a zero-element board: Design uses `no-spec`,
Decisions uses `no-decisions`, Flagged uses `no-findings`, and Noise uses
`no-noise`. An empty Design board is never an absence — only the seat's own
`no-spec` return is. For the three core review lenses, material follows the topology the
client serves, not the flat element pool. Sequence needs a reachable
`order_step`, Decisions a reachable `decision`, and Flagged a reachable `finding`.
Prose-only boards, empty sections, and detached typed elements do not satisfy
those core lenses. Flagged persists any round finding-resolution migration before settling
that typed absence. The client treats the absence as settled, keeps its segment
selectable with explicit empty-state copy, and stops polling. Sequence requires
a reading result; a semantically empty return gets one explicit retry, then
becomes a retryable lens failure rather than an arrival.

Which absence each lens may settle with is the protocol's `LENS_ADMISSIBLE_ABSENCES`
table, and it is enforced where an outcome becomes durable rather than merely
advised: a lens settling an absence its own row does not admit is a producer
defect that persists as a typed failure, never as a clean result. That failure is
`retryable` at attempt zero — nothing has been retried, and another drafting
attempt is exactly what answers it. The durable
`GenerationSchema` stays permissive on purpose — sessions written before a field
existed must keep parsing — so the boundary that refuses a wrong pairing is the
write, never the read.

A failure persists as the drafter's own words **plus a typed account**: which
attempt failed, and whether another attempt could plausibly succeed
(`retryable` / `terminal`). The account is durable beside the message, survives a
daemon restart, and rides `board.read` to the client, so a lens whose seat simply
did not draw is not presented as beyond another attempt. A failure with no
account means the classification is unknown — which is not the same as terminal.
For a multi-seat lens the account aggregates: retryable if **any** seat is, since
the lens needs only one seat to draw a board. The account also decides what a
RESTART does with the failure: a retryable one is not complete evidence for its
lens, so a fresh runtime over that durable state redrafts the generation instead
of reconstructing the same failure forever. A terminal one is settled, and its
generation reconstructs without a model. A landed-round report
gets exactly one classification turn and fails honestly when that classification
omits an ask, cites evidence outside the measured coding-turn diff, or fails to
partition that evidence exactly once. A plain
`null` remains missing because the board may still be in flight. No board is
assembled from another generation's elements.

The client addresses a frozen board with `?generation=<id>` and treats an
absent generation parameter as the live generation. Both the generation and
lens selections come from the session URL rather than component-local state,
so reload and direct navigation resolve the same `(generation, lens)` pair. An
absent lens parameter resolves Flagged when it is present, then the first board
present in canonical order.

The client overlays reviewer-owned finding state instead of editing the board
bytes it reads. Request and Dismiss bind to `(generation, Flagged board id,
finding id)` in the durable ask projection; Undo applies the inverse event. A
failed draft attempt therefore cannot leak its action onto a retry that reuses
the same model-authored finding id. Discuss stores a quote
thread at the same generation anchor and sends one live anchored ask through
the existing chat dock. The Flagged segment derives its open count from the
board's finding statuses, staged finding asks, and dispositions, so reload
reconstructs the same number without a stored counter.

## Related context in the delta

The drafting scheduler seeds every seat with its lens prompt, the reviewed
range and the exact diff command for this capture, and a path reference to the
session's context directory. Nothing derived from the change rides in the
prompt: the seat's working directory is the reviewed checkout, it runs the diff
itself, and it opens the files the directory's `README.md` indexes. The
**DeltaPacket** stays on the daemon, where lint, persistence and the delta
renderer read it. The pipeline consumes the **related-context dossier**
described below, it does not build the retrieval.

The related-context dossier holds the change's referenced issue-tracker
tickets, the PR description and comments, and one-hop links, retrieved per
patchset generation by a light-tier Model Council seat
(`related-context-retrieval`) after a deterministic pass extracts issue refs
from the branch name, commit messages, and PR body. GitHub is first-class via
`gh`; JIRA and Linear work from per-project config (base URL plus a token
environment variable). The bounded dossier is persisted and referenced by
path, and the round workers can reach it too.
The landed-round report classifier intentionally receives only the successor
patchset id, durable asks, the worker's identity, and the round's evidence
manifest; full raw payloads stay behind a context tool. Items are structured (id, tracker, title, state, bounded body,
acceptance criteria, URL, provenance, fetched-at) and cited by id, which is
how ticket citations reach boards. Like every other input, it reaches a seat as
a file the prompt names, never as an interpolation. Standing project background is not fetched
for the drafter: a drafter that wants it reads the repository it is standing in.
Cosmetic project facts (the logo) never enter agent context. When no tracker is
configured, the dossier carries what the forge itself supplies and the review
proceeds; the tracker is named in project settings, and nothing blocks on it.

### Bounding an anchored turn

A turn grounded on an anchor gets the hunk containing that span, under an
8,000-byte ceiling. A path-only note gets a bounded diff of its file instead.
When the file or span cannot be found, the model works from the note and its
metadata and says so — it never substitutes a different code location that
looks close enough.

Every other interpolation into a seat prompt declares its bound at the call
site too: the round-report evidence manifest is measured against its 256 KiB
ceiling before any seat runs and then written to `evidence.json` rather than
sent. The RSP noise seat's hunk payload is gone: the offer is written to
`noise-offer.json` — one entry per changed region, each a path, a side and a
1-based line range, with no line bodies and no hunk ids — and the seat reads
the lines from `git diff`, so a re-ask re-sends nothing of the change. The seat
cites a region back the same way; the daemon resolves that citation against the
offered regions and mints the `rennet:hunk/<id>` anchor the stored document
carries, so no hunk id travels in either direction. Unbounded interpolation is
a bug.

A tripwire keeps the drafter prompt itself honest. The `lens-pipeline`
prompt-budget test assembles every lens's drafter prompt against the real
capture fixture and asserts its UTF-8 size under a per-lens budget: the size
measured when the test was pinned, plus ten percent. There is no per-file or
per-hunk term any more, and the test says so by rendering the same prompt
against a synthetic 74-file, 292-hunk packet and asserting the bytes are
IDENTICAL — an inventory creeping back into any layer reddens every lens at
once. A prompt that grows on purpose raises its budget in the same change and
says so in the pull request; one that grows by accident reddens the test
instead of waiting for the next audit.

## Three layers carry every rule

The schema makes good structure the only expressible structure (a finding's
kind, severity, cited code, and concurrence are typed fields, so a claim in the
wrong shape fails to parse, not merely reads badly); the lint makes the
mechanical rules guarantees; the prompts carry what only judgment can check. A
rule that lives in a prompt alone is a wish.

## Honest states

A board says what it does not know as plainly as what it does.

- A drafting seat that fails renders as **failed**, never as empty. The
  surface distinguishes a lens that ran and found nothing from a lens that did
  not run.
- A Design seat that looked for this branch's specification and found none returns
  `no-spec`. That is a successful **absent** lane, not a failed drafter and not an
  empty board; the other four lenses continue normally, and the finished board views
  carry no Design tab.
- An element the validation loop could not make pass leaves a trace, never a
  silent hole. If it was dropped, the omission names it with a reason (the
  honest-omission exit); unresolved board-level or schema violations ride
  along as labelled **blemishes** — shown to the reviewer, never blocking the
  board.
- Capture limits stay visible. Truncated files, binary files, and submodule
  blocking states keep their state on the board, so a review never implies it
  inspected bytes no runner ever saw.
- CI signals are informational evidence shown beside findings. They are never
  presented as model-authored findings, and a green pipeline never hides unread
  code.
- Rationale the Decisions lens reconstructs is labelled model analysis. It is
  never presented as an author's quote or as a fact read out of the repository.

## The UI-verification pass

When a change touches the interface and the Claude adapter is available, one
separate verification turn runs after the first Flagged result. It mounts the
changed surface using whatever the project already provides — its tests,
Storybook, dev server, or browser tools — takes bounded screenshots into the
review evidence store, runs the project's own accessibility tooling, and
compares what it sees against the pull-request title and body and the captured
spec artifacts.

Its observations return as ordinary anchored findings, with no privileged
status. The pass reports `completed`, `non-UI`, `pending`, or `unavailable`; a
mount failure is **inconclusive** and never an all-clear.

## Lane discipline

Each lens owns a lane, and material in another lens's lane is omitted, never
narrated. The branch's specification and its requirements belong to Design; the
reading walk to Sequence; judgment calls to Decisions; defects to Flagged;
skip-safe mechanical hunks to Noise. Generated scaffold stamps (OpenSpec's
`.openspec.yaml` and the like) are noise, not specification documents.

A lens accounts for what it cites and for nothing else. There is no skip list
to fill and no remainder to declare: material another lens owns is simply
absent from this board. Boards never carry remainder essays about what is not
on them.

## Voice rules

- Boards narrate in third person about the change, never as its author.
- Board prose never names lenses, boards, agents, or the review process;
  cross-lens connection happens through anchors and composition.
- Threads and messages are records of real exchanges. A drafting agent runs
  before any exchange exists, so a draft board can never contain one. A real
  question from the change's history renders as an annotation or callout
  citing its source.
- A decision stated in a specification renders on both the Design board (as source
  content) and the Decisions board (as a call citing that document). Each board
  stands alone.

## The Design lens

The Design seat finds the specification itself. Nothing is discovered for it and no
artifact bundle rides in its prompt: it stands in the reviewed checkout and looks
where specifications live — `openspec/changes/**` and `openspec/specs/**`, `.kiro/**`,
`.bmad/**`, `docs/superpowers/specs/**` and `docs/superpowers/plans/**`, `docs/adr/**`
and `docs/decisions/**`, grill-me documents and `CONTEXT.md` context maps. Their
exact shapes are surveyed in the [spec-format reference](../reference/spec-formats/openspec.md).
The clue is the change's own history: the commit messages of the reviewed range and
the pull request body name the change directory, the story, or the ADR.

The board must cite the evidence that ties the specification to the branch — the
commit message, pull request text, or task line that connects them — so a reader can
check the link instead of trusting it. One specification per board; a neighbouring
change that merely sorts first is not this branch's.

When the repository holds no specification for this branch, the seat returns
`{ "absence": "no-spec" }` and drafts nothing. The lane settles **absent**, not
failed: a branch without a spec workflow is an ordinary branch. The bench reader
says "No spec found for this branch." and the finished board views carry no Design
tab at all, because an empty Design board would be a lie about what the repository
holds. Design's older `no-material` absence stays readable for generations recorded
before this change; nothing settles it now.

The resulting board is a structured composition, not a Markdown viewer. Its header
names the source set, displays the format, and reports capability, requirement, and
task counts read from those files. Each stat appears once. Header source chips list
every rendered file exactly once in reading order, and their first named source
regions preserve that order. Header chips jump to their rendered regions; section and
requirement source chips open the repo-relative file in the project editor. A proposal
renders source-grounded Why, tagged What Changes rows, and Impact; capabilities render
as counted jump cards, and task groups keep their source's own `- [x]` / `- [ ]` marks.
Requirements preserve their normative text and source order, and every scenario and
task remains its own canonical element so later dispositions can address it. A scenario
is owned only through its requirement's `scenarios` list, never repeated in section
children.

Format-specific display fields are authored by the seat from the source text it read,
on the element that owns them: Kiro `requirement_refs` on task prose; BMAD `status` on
a story requirement and `acceptance_criteria` on task prose; Superpowers `task_manifest`
file, interface, and verification arrays on a task-group section; `task_progress` on the
top-level source section; `source_cells` on a matched tech-stack or architecture
decision; grill `glossary_term` on the glossary-entry prose; and `scenario_clauses`
split from a scenario's own WHEN/THEN words. Every array preserves source order, and the
surface renders each projection once at its owner. A field whose shape does not match is
not rendered, so a guess buys nothing. Stated decisions continue to use their canonical
statement, rationale, alternatives, and evidence fields.

A requirement cites the code that implements it through `trace` — `code_ref` elements
by path and line range — and names implementing paths in `related_files`. Those
citations resolve against the patchset like any other; a requirement with no
implementing code in the change carries an empty `trace` rather than a guess. There is
no met/partial/gap coverage chip: nothing derives one, and no lens accounts for
requirements it did not cite.

`spec_delta` and the round `delta` marker are independent: the first records the
specification's added, modified, removed, or renamed state; the second records whether
the rendered section changed since the prior review generation. A capability file has
one source-linked capability root. When it contains several delta headers, exact
operation sections sit beneath that root in source order, and each requirement row and
its nearest operation section carry the source `spec_delta`. The capability card rolls
those operations up as ordered unique badges without duplicating the capability.

For Superpowers, the seat leaves plan checkbox bytes untouched and reports task
completion from a progress ledger only when its exact first line binds the selected
plan path. Only `Task N: complete (...)` completes a group. Fix-round, minor, and
ruling lines remain visible in the progress region but never count as completion.

## Reading affordances every board shares

- The authored title and introduction open the document. A `reading` measure
  keeps prose narrow; `structured` gives artifact-heavy content a wider column.
- Sections fold to a one-line gist with domain counts; the gist summarizes,
  never teases.
- Code is cited, never copied: the code block card renders a citation with
  path and line span. In board prose, backticked terms render monospace and
  `path:line` citations are interactive — clicking one reveals the real
  cited lines inline.
- A code-card filename opens `?view=diff&file=<path>` only when the path belongs
  to the active captured patchset. The same active-path set resolves reversible
  JavaScript and TypeScript counterparts (`foo.ts` with `foo.test.ts` or
  `foo.spec.ts`). **View test** or **View implementation** appears only when
  both paths were captured as changed; the client never guesses from the
  working tree.
- A revealed citation is served from the **captured patchset's own patch
  text** (`patchset.readSpan`), never from the working tree. Two consequences
  follow. A review whose repository has since moved or been deleted still
  reveals every citation, because the content was captured. And a patchset
  carries only its hunks, so a citation into a region the diff never showed
  cannot be served — the surface says which absence it hit ("outside the diff
  this patchset captured") rather than rendering an empty block.
- The one span the reader goes outside the patch text for is a **truncated
  capture's tail**, because lint accepts a citation there on purpose: the tail
  region is open-ended, so the daemon never calls a seat's citation wrong over
  lines it chose not to keep. Those lines come from the immutable object the
  patchset recorded (`git show <reviewedTreeOid|baseOid>:<path>`) — the same
  reviewed content, not the checkout as it stands today. With no repository to
  read, the card shows an honest caption saying the diff was cut short, never a
  refusal: a citation the board accepted must not read as a bad citation.
- Multi-site evidence (a decision's excerpts) renders as one tabbed code
  viewer: quiet pill tabs, one visible code block card.
- A finding is document flow, not a boxed card: severity and claim title,
  a short body, one subheaded part per member of the failure, the proposed
  remedy as its own actionable callout, and the anchor.
- Prose citations use full repo-relative paths so every citation resolves.
- Blast radius is an explainable overlay: it names the dependency, reference,
  or ownership evidence behind every reachable site it marks. It annotates the
  substrate the reviewer is already reading — it never reorders or duplicates
  it.

## Where to go next

- [Hand off and the exits](./handoff-and-exits.md) — what the reviewer does
  with a board once it is drafted, and how a round mints the next generation.
- [Delta and generations](./delta-rereview-and-lineage.md) — what carries from
  one generation of boards to the next.
- [The Model Council](./model-council.md) — how seats are assigned to the
  drafting, reconciliation, and classification jobs.
