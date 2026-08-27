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

The prompts live in `packages/prompts` (`@rennet/prompts`),
one markdown file per lens plus the post-process editor pass, the
reviewer-voice file, and the round-report prompt. The package exports a
typed manifest; the pipeline reads the files and supplies the board schema
separately, so instructions and schema cannot drift apart.

## The drafting flow

The scheduler lives in `packages/server/src/runtime/lens-pipeline.ts`
(`runLensPipeline`); the pure logic it drives — lint, the validation loop,
composition mechanics — lives in `packages/core/src/board/`. The scheduler is
pure over injected seams (the harness ports, a prompt-file reader, and the
whiteboard writer), so the whole path runs in tests against a fake `runTurn`
with no live model call.

`runLensPipeline` is built and exercised end-to-end against a real board
service, but it is not yet invoked on a live review: the consuming turn — the
rounds machinery that runs a generation and threads the round-report seat into
the reveal — is wired by the rounds work (B09), the same seat that consumes the
per-board arrival events this scheduler emits. Until that turn lands the
pipeline is a tested pure projection with no non-test caller, exactly the seat
B09 binds it to.

0. **Round-report first** (on rounds only). When a review re-runs on a new
   patchset generation, the `round-report` drafter runs *before* the lens
   drafters. Its board is both the reviewer's greeting and the lens drafters'
   input — it is threaded into every lens prompt. It funnels through the same
   validation and post-process passes, but it is not a lens: it carries no
   hunk-coverage obligation and is excluded from the coverage assertion.
1. **Draft.** One agent per lens receives the delta context and its lens
   prompt, plus the host board schema derived once from the frozen
   `DraftBoardSchema`, and returns a structured board. The host — never the
   drafter — writes the board ops through `whiteboard-client` (the sole op
   writer); drafters never call whiteboard tools. The Flagged lens runs two
   independent seats (Claude and Codex) on the same instructions.
2. **Reconcile** (Flagged only). The two seats' findings are matched by cited
   location: a matched pair collapses to the clearer finding carrying both
   models' concurrence, a solo finding carries only the raising model's. The
   result is folded into each finding's board-native `concurrence` tally
   (`{ model, agree, total }` per seat). With only one harness available the
   lens degrades to a single seat, stamped with honest single-model
   concurrence.
3. **Validate.** A deterministic loop guarantees every draft before a human
   sees it, through **three gates in order**: **lint** (before post-process),
   then an **immutability check** (typed data is untouched across the editor
   pass), then the cross-lens **every-hunk composition check**. A lint failure
   returns the draft to its seat as ZodError-shaped JSON pointers on one retry
   channel; the seat returns a patch, and passing elements **freeze** — a
   frozen element is never re-linted or re-drafted. An element that will not
   pass escalates through a four-rung ladder to an **honest-omission exit**:
   it is dropped and its hunks move to `skippedHunks` with a reason. The retry
   count is capped at 10 (`RETRY_CAP`); on exhaustion the board ships anyway,
   carrying the unresolved violations as labelled `blemishes` — **visible,
   never blocking**.

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
   - **`skippedHunks` present** and its reasons specific;
   - **decision-grounded** — a decision carries non-empty evidence and
     alternatives;
   - **a process-vocabulary screen** flags structural-field prose that names
     lenses, boards, agents, seats, or drafts.

   Cross-lens every-hunk coverage and the typed-data immutability check are the
   other two gates, run once over the frozen board set rather than per draft.
   The design target is "19 rules"; against the frozen 13-kind board schema the
   faithful per-draft set is 16 — two of the nineteen (cross-lens coverage and
   immutability) belong to the other two gates, and a handful reference fields
   the frozen schema deliberately does not carry (they wait on a schema
   follow-up rather than being enforced against absent data). The reviewer-voice
   authored prose is screened by a separate, narrower register.
4. **Post-process.** Every draft board passes through an editor agent running
   the post-process pass (`src/prompts/post-process.md`): a break-it-down step
   that reshapes dense prose into terse, scannable chunks — bullets for
   enumerable facts, prose kept for genuine narrative — then the unslop
   skill verbatim, then the humanizer additions (patterns from the MIT
   humanizer skill the unslop body does not cover). The editor rewrites
   prose fields only — and enforces the board voice editorially, deleting
   sentences about the review machinery that survive the lint's vocabulary
   screen. Typed data — paths, line numbers, counts, severities, concurrence
   flags — is untouched, and the immutability gate proves it. When no editor
   seat resolves the pass is identity: prose is simply left unpolished, never
   blocked.
5. **Compose.** A frozen draft board *is* the lens board the human reads; there
   is no separate composed surface. Composition is split. The **mechanical**
   part lives in `core/board/`: the coverage assertion (every patchset hunk is
   taught by some lens or listed in some lens's `skippedHunks`), verbatim carry
   on stable element ids (a carried element is byte-identical across
   generations), and `new`/`reworked` delta stamps on sections. The **authored**
   part is the orchestrator's connective review prose, written write-through on
   the versioned reviewer-voice prompt (`src/prompts/review-draft-voice.md`) in
   the reviewer's first-person register; curation feedback from the prior
   generation threads into that authoring turn. The authored prose is screened
   by a narrower register lint (citations plus the machinery screen) — visible,
   never blocking.

As each board freezes and is persisted, the scheduler emits a **per-board
arrival event** over the existing board-event broadcast. The rounds machinery
consumes these to drive the progressive reveal; the pipeline only emits them.

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
environment variable). The bounded dossier is inlined verbatim into every
drafting prompt — the orchestrator, round workers, and the round-report
drafter receive the same dossier — while full raw payloads stay behind a
context tool. Items are structured (id, tracker, title, state, bounded body,
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
- An element the validation loop could not make pass leaves a trace, never a
  silent hole. If it was dropped, its hunks are in `skippedHunks` with a reason
  (the honest-omission exit); if the retry cap was hit, its unresolved
  violations ride along as labelled **blemishes** — shown to the reviewer, never
  blocking the board.
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

The Design lens discovers the change's spec artifacts and renders the whole
set as a structured artifact, never a markdown view. Known formats and their
exact shapes are documented in the
[spec-format survey](../reference/spec-formats/openspec.md) (OpenSpec, Kiro,
BMAD, Superpowers, grill-with-docs). Every discovered artifact gets a named
region with a provenance chip; an absent artifact is honestly absent. The
header carries the artifact set as jump chips, capability rows use an
add-green edge, requirement rows keep normative language verbatim, and each
requirement's coverage chip counts the hunks and tests that claim it — zero
hunks renders as an honest "unimplemented".

## Reading affordances every board shares

- Sections fold to a one-line gist with counts; the gist summarizes, never
  teases.
- Code is cited, never copied: the code block card renders a citation with
  path and line span. In board prose, backticked terms render monospace and
  `path:line` citations are interactive — clicking one reveals the real
  cited lines inline.
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
