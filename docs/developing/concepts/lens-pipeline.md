---
title: The lens pipeline
description: How the redesigned lenses are drafted, edited, and rendered as boards — the decided rules the murder-board rebuild implements.
status: planned
tracking: https://github.com/rbutera/rennet/issues/464
---

This page records the decided shape of the redesigned lens pipeline. It is not
live on `main`: the working prototype is `spikes/board-prototype/`, the design
authority is the murder-board map
([#452](https://github.com/rbutera/rennet/issues/452)) with the ruling log on
[#458](https://github.com/rbutera/rennet/issues/458), and the open
architecture work is tracked in
[#464](https://github.com/rbutera/rennet/issues/464) (drafting agents) and
[#474](https://github.com/rbutera/rennet/issues/474) (the Design lens). The
deterministic review model these boards render is described in
[review lenses](./review-lenses.md).

## The five lenses

Design, Sequence, Decisions, Flagged, Noise — in that display order, Design
first. Design was previously called the spec lens; Sequence was previously
called reading order. Each lens is a board of typed blocks drafted by a review
agent on a fixed prompt.

The prompts live in `packages/prompts` (`@rennet/prompts`),
one markdown file per lens plus the post-process editor pass. The package exports a
typed manifest; the pipeline reads the files and supplies the board schema
separately, so instructions and schema cannot drift apart.

## The drafting flow

1. **Draft.** One agent per lens receives the delta context and its lens
   prompt, and authors a draft board. The Flagged lens runs two independent
   seats (Claude and Codex) on the same instructions.
2. **Reconcile** (Flagged only). Findings that share a root cause merge;
   cross-model concurrence is recorded per finding. Findings a seat rejects
   with reasoning land in a cleared-concerns block, not on the finding list.
3. **Lint.** A deterministic validation pass rejects a draft before any model
   sees it again. The rules the prompts state are also enforced here, because
   a prompt is a request and a validator is a guarantee:
   - kind allowlist per lens — thread and message kinds never come from a
     drafting agent;
   - no code bytes — code on a board is a code ref (path plus line span) the
     surface hydrates, so numbering cannot drift from the file it claims to
     show;
   - every citation resolves against the patchset;
   - a `skippedHunks` list is present, and across all lenses every patchset
     hunk lands in some lens's taught-or-skipped set;
   - structured fields where structure is required: a finding carries its fix
     as a field and its scenario members as subheaded details, never one prose
     wall;
   - a process-vocabulary screen flags prose that names lenses, boards,
     agents, seats, or drafts.
   A lint failure returns the draft to its agent with the violation named.
4. **Post-process.** Every draft board passes through an editor agent running
   the post-process pass (`prompts/post-process.md`): a break-it-down step
   that reshapes dense prose into terse, scannable chunks — bullets for
   enumerable facts, prose kept for genuine narrative — then the unslop
   skill verbatim, then the humanizer additions (patterns from the MIT
   humanizer skill the unslop body does not cover). The editor rewrites
   prose fields only — and enforces the board voice editorially, deleting
   sentences about the review machinery that survive the lint's vocabulary
   screen. Typed data — paths, line numbers, counts, severities, concurrence
   flags — is untouched. The orchestrator applies the same steps
   write-through when authoring the review draft, in the reviewer's
   first-person register (`prompts/review-draft-voice.md`).
5. **Compose.** The orchestrator authors the composition Board from the frozen
   drafts (issue #457's compose-by-authoring model).

## Related context in the delta

The delta context every drafter receives includes the **related-context
dossier** ([#461](https://github.com/rbutera/rennet/issues/461)): the change's
referenced issue-tracker tickets, the PR description and comments, and one-hop
links, retrieved per patchset generation by a light-tier Model Council seat
(`related-context-retrieval`) after a deterministic pass extracts issue refs
from the branch name, commit messages, and PR body. GitHub is first-class via
`gh`; JIRA and Linear work from per-project config (base URL plus a token
environment variable). The bounded dossier is inlined verbatim into every
drafting prompt — the orchestrator, round workers, and the round-report
drafter receive the same dossier — while full raw payloads stay behind a
context tool. Items are structured (id, tracker, title, state, bounded body,
acceptance criteria, URL, provenance, fetched-at) and cited by id, which is
how ticket citations reach boards. Standing tracker knowledge enters the
context map through the knowledge swarm
([#460](https://github.com/rbutera/rennet/issues/460)) instead; cosmetic
project facts (the logo) never enter agent context. When no tracker is
configured, the orchestrator asks in chat and persists the answer to project
settings — the review proceeds meanwhile.

Three layers carry every rule: the schema makes good structure the only
expressible structure (a fix field exists, so a fix sentence buried in prose
is a lint error, not a style preference); the lint makes the mechanical rules
guarantees; the prompts and the post-process editor carry what only judgment can
check. A rule that lives in a prompt alone is a wish.

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
header carries the artifact set as jump chips, capability cards use an
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

## What is still open

The drafting-agent runtime architecture (#464) and lane arbitration edge
cases beyond the scaffold-stamp rule are undecided. The add-project flow that
configures related context is being prototyped (#487). This page updates as
those close.
