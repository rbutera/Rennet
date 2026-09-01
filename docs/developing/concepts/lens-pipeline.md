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
per lens plus the reviewer-voice file and the round-report classifier prompt.
The package exports a typed manifest. Lens
drafters receive the board schema separately; the landed-round report seat
receives a much smaller classification schema instead.

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
The per-board arrival events this scheduler emits order the progressive reveal, and a
`PipelineStartGuard` keyed on the session and
exact generation visit makes a retry of that dispatch reattach rather than
double-start. `create-server` owns the live trigger: the own-branch round loop
dispatches the coding turn, captures its result against the active patchset,
and calls board regeneration through this runtime.

0. **Round-report first** (on landed rounds only). When a coding round returns
   with its exact worker receipt, the `round-report` seat makes one structured
   semantic-classification turn before any lens drafter starts. Its context is
   only the successor patchset id, the durable dispatched asks, and the exact
   coding-turn receipt: diff, changed paths, and observed commit range. It does
   not receive the full DeltaPacket or the all-kind board schema. Each ask is
   reduced to its durable id, path, instruction, and optional source anchor, so
   stale prior-diff context cannot compete with the coding turn's measured diff.
   The host sorts the outcomes and builds the document, section,
   outcomes, and code refs deterministically, then verifies every claimed anchor
   against an exact changed line on the durable ask's path (including a measured
   rename alias) before persistence. Readback also requires the exact ask text and
   forbids change evidence on an `untouched` outcome. There is no model retry or
   generic post-process turn on this path. The resulting board is both the
   reviewer's greeting and the lens drafters' input. Here, **legacy caller** means
   an injected pipeline caller that supplies the older round context without an
   exact worker receipt. It retains the generic drafting path for compatibility.
   A live durable coding round always carries the receipt and never selects that
   path.
1. **Draft.** One agent per lens receives the delta context and its lens
   prompt, plus the host board schema derived once from the frozen
   `DraftBoardSchema`, and returns a structured board. Each drafting instruction
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
   The five board-pipeline Council jobs run with job-scoped harness isolation:
   Claude receives `ambientConfig: "isolated"` and Codex receives an explicit
   empty MCP-server table. These seats use the inlined board context and native
   repository tools, so they do not start ambient MCP, plugin, or hook
   extensions. Unrelated Council work, including `project-scout`, keeps its
   inherited harness configuration.
   A clean generation makes one drafting turn for Design, Sequence, Decisions,
   and Noise, plus the two parallel Flagged seats. It does not run a separate
   board editor after those turns. Design may make one additional grounded
   coverage call when the board contains requirements, eligible hunks exist,
   and the caller supplied a coverage mapper.
2. **Reconcile** (Flagged only). The two seats' findings are matched by cited
   location: a matched pair collapses to the clearer finding carrying both
   models' concurrence, a solo finding carries only the raising model's. The
   result is folded into each finding's board-native `concurrence` tally
   (`{ model, agree, total }` per seat), alongside an `accord` stamp naming how
   the seats landed: `concur`, `split` (one seat answered "no concern"), or
   `conflict` (both raised it at materially different severities). The stamp is
   load-bearing, because a concurrence and a conflict fold to the identical
   tally pair — without it a reader cannot tell agreement from disagreement.
   With only one harness available the lens degrades to a single seat, stamped
   with honest single-model concurrence and no accord: one seat has no
   agreement to report.
3. **Validate.** A deterministic loop guarantees every lens draft before a human
   sees it. It parses the frozen schema, runs the per-lens lint rules, and then
   runs the cross-lens **every-hunk composition check**. A lint failure
   returns the draft to its seat as ZodError-shaped JSON pointers on one retry
   channel; the seat returns a patch, and passing elements **freeze** — a
   frozen element is never re-linted or re-drafted. Validation spends at most
   one model repair turn after the initial draft. An element that remains
   invalid takes an **honest-omission exit**: it is dropped and its hunks move
   to `skippedHunks` with a reason. Unresolved board-level or schema violations
   ship as labelled `blemishes` — **visible, never blocking**.

   After validation, the host checks the material the served board actually
   needs. Sequence requires a reachable `order_step`. Decisions and Flagged
   require a reachable `decision` or `finding`, unless the provider returned a
   parsed zero-element board that supports typed `no-decisions` or `no-findings`
   absence. Noise has the equivalent `no-noise` absence. Missing core material
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
   - **citation resolves** — every citation is well-formed and resolves against
     the correct side of the patchset;
   - **element references resolve** — every schema-declared element reference
     names an element in that exact board, and the reference graph is acyclic so
     the host can create each target before its citer;
   - **`skippedHunks` present** and its reasons specific;
   - **decision-grounded** — a decision carries non-empty evidence and
     alternatives;
   - **a process-vocabulary screen** flags structural-field prose that names
     lenses, boards, agents, seats, or drafts.

   Cross-lens every-hunk coverage runs once over the frozen board set rather than
   per draft. The core validator retains its typed-data immutability result for
   callers that provide a deterministic transform; the production lens scheduler
   supplies no model-backed post-process transform.
   The design target is "19 rules"; against the frozen 13-kind board schema the
   faithful per-draft set is 16 — two of the nineteen (cross-lens coverage and
   immutability) belong to the other two gates, and a handful reference fields
   the frozen schema deliberately does not carry (they wait on a schema
   follow-up rather than being enforced against absent data). The reviewer-voice
   authored prose is screened by a separate, narrower register.
4. **Freeze.** The validated structured draft becomes the lens board without a
   second model rewrite. Host-owned Design projections, Flagged reconciliation,
   round composition, delta stamps, and metadata persistence remain deterministic.
5. **Compose.** A frozen draft board *is* the lens board the human reads; there
   is no separate composed surface. Composition is split. The **mechanical**
   part lives in `core/board/`: the coverage assertion (every patchset hunk is
   taught by some lens or listed in some lens's `skippedHunks`), verbatim carry
   on stable element ids (a carried element is byte-identical across
   generations), `new`/`reworked` delta stamps on sections, and the host-owned
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
   register; curation feedback from the prior generation threads into that
   authoring turn. The authored prose is screened by a narrower register lint
   (citations plus the machinery screen) — visible, never blocking.

Each successful board persists its metadata as soon as its lane settles, so live
progress follows completion order. Successful typed absences are reported in
that same settlement order through a serialized callback, which keeps cumulative
generation snapshots monotonic. Once every lane has settled, the scheduler runs
the cross-lens coverage assertion and emits **per-board arrival events** in
canonical Design, Sequence, Decisions, Flagged, Noise order. The returned
outcomes use that same deterministic order regardless of which drafter finished
first. The rounds machinery consumes these events to drive the reveal; the
pipeline only emits them.

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

## Reading a board back

A drafted board lands in two durable places. Its elements go to the whiteboard
event log. Its document envelope, skipped-hunk coverage, blemishes, omissions,
and immutability result go to the board-meta store before the board arrival is
announced. The client reads both halves through `board.read`, keyed by review,
generation, and lens. The handler resolves the review's session, finds that
triple's board-meta record, projects the element state, and assembles one
`LensBoard` with the persisted document, the element pool in creation order,
and one fold line per top-level section.

Fold counts are reader-facing domain objects, not raw element-kind tallies. The
projection emits findings, decisions, requirements, steps, outcomes, groups,
files, and comments from each section's direct children. Repeated code refs for
one path count as one file, and structural prose does not inflate the count. A
pair with no persisted board answers `null`. A successful empty result is typed
instead of persisted as a zero-element board: Design uses `no-material`,
Decisions uses `no-decisions`, Flagged uses `no-findings`, and Noise uses
`no-noise`. For the three core review lenses, material follows the topology the
client serves, not the flat element pool. Sequence needs a reachable
`order_step`, Decisions a reachable `decision`, and Flagged a reachable `finding`.
Prose-only boards, empty sections, and detached typed elements do not satisfy
those core lenses. Flagged persists any round finding-resolution migration before settling
that typed absence. The client treats the absence as settled, keeps its segment
selectable with explicit empty-state copy, and stops polling. Sequence requires
a reading result; a semantically empty return gets one explicit retry, then
becomes a retryable lens failure rather than an arrival. A landed-round report
gets exactly one classification turn and fails honestly when that classification
omits an ask or cites evidence outside the measured coding-turn diff. A plain
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

The drafting scheduler seeds every seat with the inlined **DeltaPacket** — the
lens drafters' entire input. When the related-context retrieval work has landed,
that packet also carries the **related-context dossier** described below; until
then the drafters run on the DeltaPacket alone and degrade gracefully. The
pipeline consumes the dossier, it does not build the retrieval.

The related-context dossier holds the change's referenced issue-tracker
tickets, the PR description and comments, and one-hop links, retrieved per
patchset generation by a light-tier Model Council seat
(`related-context-retrieval`) after a deterministic pass extracts issue refs
from the branch name, commit messages, and PR body. GitHub is first-class via
`gh`; JIRA and Linear work from per-project config (base URL plus a token
environment variable). The bounded dossier is inlined verbatim into lens
drafting prompts, and the orchestrator and round workers can receive it too.
The landed-round report classifier intentionally receives only the successor
patchset id, durable asks, and exact worker receipt; full raw payloads stay
behind a context tool. Items are structured (id, tracker, title, state, bounded body,
acceptance criteria, URL, provenance, fetched-at) and cited by id, which is
how ticket citations reach boards. Standing tracker knowledge enters the
context map through the knowledge swarm instead; cosmetic
project facts (the logo) never enter agent context. When no tracker is
configured, the orchestrator asks in chat and persists the answer to project
settings — the review proceeds meanwhile.

### Bounding an anchored turn

A turn grounded on an anchor gets the hunk containing that span, under an
8,000-byte ceiling. A path-only note gets a bounded diff of its file instead.
When the file or span cannot be found, the model works from the note and its
metadata and says so — it never substitutes a different code location that
looks close enough.

## Three layers carry every rule

The schema makes good structure the only expressible structure (a finding's
kind, severity, cited code, and concurrence are typed fields, so a claim in the
wrong shape fails to parse, not merely reads badly); the lint makes the
mechanical rules guarantees; the prompts and the post-process editor carry what
only judgment can check. A rule that lives in a prompt alone is a wish.

## Honest states

A board says what it does not know as plainly as what it does.

- A drafting seat that fails renders as **failed**, never as empty. The
  surface distinguishes a lens that ran and found nothing from a lens that did
  not run.
- Design discovery that completes and finds no supported spec artifacts is a
  successful **absent** lane, not a failed drafter and not an empty board. The
  other four lenses continue normally.
- Design discovery that cannot read the pinned reviewed tree settles Design as a
  failed lane while the other four lenses continue. It never falls back to mutable
  repository reads and never records `no-material` for evidence it could not inspect.
- An element the validation loop could not make pass leaves a trace, never a
  silent hole. If it was dropped, its hunks are in `skippedHunks` with a reason
  (the honest-omission exit); unresolved board-level or schema violations ride
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
narrated. Spec artifacts and requirement coverage belong to Design; the
reading walk to Sequence; judgment calls to Decisions; defects to Flagged;
skip-safe mechanical hunks to Noise. Generated scaffold stamps (OpenSpec's
`.openspec.yaml` and the like) are noise, not spec artifacts.

Coverage is data, not prose. Each draft board carries a `skippedHunks` list —
hunks the lens consciously left to other lenses, with reasons — and the
composition step checks that every patchset hunk lands in at least one lens's
taught-or-skipped set. Boards never carry remainder essays about what is not
on them.

## Voice rules

- Boards narrate in third person about the change, never as its author.
- Board prose never names lenses, boards, agents, or the review process;
  cross-lens connection happens through anchors and composition.
- Threads and messages are records of real exchanges. A drafting agent runs
  before any exchange exists, so a draft board can never contain one. A real
  question from the change's history renders as an annotation or callout
  citing its source.
- A decision stated in a spec artifact renders on both the Design board (as
  artifact content) and the Decisions board (as a call citing the artifact).
  Each board stands alone.

## The Design lens

Before drafting, the host discovers spec artifacts deterministically at the
reviewed state. It recognises OpenSpec, Kiro, BMAD, Superpowers, and
grill-with-docs; their exact shapes are documented in the
[spec-format survey](../reference/spec-formats/openspec.md). BMAD discovery
honours its configured paths before conventional locations and scopes a
candidate to one story or unmatched epic. In a single-context grill-with-docs
repository, one candidate contains the root glossary and every root ADR. In a
multi-context repository, each linked context gets one candidate with its local
ADRs, while each system-wide root ADR remains a separate candidate beside the
context map. Candidates carry stable ids derived from their format and complete
path set, then rank by changed artifacts and references to
changed paths. That deterministic rank orders the evidence; the drafter still
makes the semantic selection, so a genuinely relevant repository-only companion
is not forbidden and a nearby decoy does not win merely by sorting first. One
Design document selects exactly one candidate and its complete artifact set; it
never combines neighbouring candidates. If no
candidate applies, the drafter must account for each id and relevance class in a
grounded `no-material` answer. The drafter
receives source bytes from the patchset's pinned reviewed tree and never reads
mutable working-tree replacements. If that pinned read fails, the Design lane
reports the discovery failure instead of asking the drafter to rediscover the
material from the repository; the sibling lenses continue.

Discovery is bounded: it retains at most 48 candidates, 64 artifacts per
candidate, 192 KiB of source content in total, and 512 KiB for the complete
serialized bundle. Every retained artifact records its full byte count and
whether its supplied text was shortened; candidates and the set record omission
counts and the applied limits. Relevant candidates get the larger share of the
budget. A shortened bundle renders an explicit incompleteness account and a
source link rather than presenting the preview as the whole specification.

The resulting board is a structured composition, not a Markdown viewer. Its
header names the source set, displays the selected format, and reports derived
capability, requirement, and task counts. Each supported stat appears once.
Header artifact chips list every selected artifact exactly once in discovered
order, and their first named source regions preserve that order; labels do not
change identity. Header chips jump to their rendered regions; section and
requirement source chips open the repo-relative file in the project editor. A
proposal renders source-grounded Why, tagged What Changes rows, and Impact; capabilities
render as counted jump cards, and task groups show their own completed/total
progress. Each artifact gets a source-linked region; requirements preserve their
normative text and source order, and every scenario and task remains its own
canonical element so later dispositions can address it. A scenario is owned only
through its requirement's `scenarios` list, never repeated in section children.
The host splits exact OpenSpec and Kiro scenario text into condition and response
fields so the surface can distinguish trigger from outcome without replacing the
source wording. The drafter supplies exact source text and canonical ownership,
but format-specific metadata is host-owned. Before lint and rendering, the host
strips any drafter-supplied claims for those fields and stamps exact parser values:
Kiro `requirement_refs: string[]` on task prose; BMAD `status: string` on a story
requirement and `acceptance_criteria: string[]` on task prose; Superpowers
`task_manifest` file, interface, and verification arrays on a uniquely mapped
task-group section; `source_cells: string[]` on matched BMAD Tech Stack row and
Superpowers Architecture or Tech Stack header decisions; and grill `glossary_term`
term, definition, and avoided-synonym values on the exact glossary-entry prose.
Every array preserves source order. The surface renders each visible projection once
at that owner; `source_cells` remains exact source-shape validation metadata because
the decision already renders its parsed choice. Stated decisions continue to use
their canonical statement, rationale, alternatives, and evidence fields. The
rendered content still comes from the immutable discovery bundle.

Requirement coverage is host-owned. After drafting, the host discards any
coverage fields the drafter supplied, offers only non-artifact patchset hunks
to a dedicated mapping turn, grounds its answer against those exact hunk ids,
and mints immutable `code_ref` anchors from the patchset geometry. A completed
mapping shows met, partial, or gap with a grounded test count. A failed mapping
shows no chip. Proposal-only work has no implementation relation to map, so it
shows task progress such as `0/N` without fabricated coverage.

`spec_delta` and the round `delta` marker are independent: the first records
the artifact's added, modified, removed, or renamed state; the second records
whether the rendered section changed since the prior review generation. A spec
artifact has one source-linked capability root. When it contains several delta
headers, exact operation sections sit beneath that root in source order, and each
requirement row and its nearest operation section carry the source `spec_delta`.
The capability card rolls those operations up as ordered unique badges without
duplicating the capability.
Source-indexed lint checks each requirement only against its named artifact and
tracks source order independently per file. Once the drafter selects a
candidate, lint requires every retained artifact in that candidate in both the
header roll-up and a named region without forcing nearby candidates into the
board. Reverse checks require every source requirement, scenario, and task once
and in source order, verify proposal anatomy and derived header values, and make
bounded discovery visible. The prose post-process cannot drop or rewrite a
source-linked subtree. Source lines resolve against the reviewed file or the
retained artifact text, and requirement scenario refs resolve only to narrative
scenario regions.

For Superpowers, the host leaves plan checkbox bytes untouched and overlays task
completion from a selected progress artifact only when its exact first line binds
the selected plan path. Only `Task N: complete (...)` completes a group. Fix-round,
minor, and ruling lines remain visible in the progress region but never count as
completion, and an unbound or absent ledger leaves the plan's static marks in charge.

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
  drafting, reconciliation, and post-process jobs.
