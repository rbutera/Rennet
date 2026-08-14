# wire-context-knowledge-layer Specification

## Purpose

Wire the already-built context/knowledge layer into the running app as two
surfaces: `context.ask` — one schema-constrained tool that answers questions
about the project with evidence or honestly declines with a reason — and the
context pipeline + ContextManifest — deterministic, byte-budgeted assembly of
what each fleet agent is told, inspectable by the reviewer down to the exact
bytes sent. No consent, trust, or access gates anywhere in this capability;
budgets meter and report, never refuse.

## ADDED Requirements

### Requirement: context.ask is one canvasOps@2 tool with a stable contract

The system SHALL expose `context.ask` as a single `canvasOps@2` tool
(registered in `CANVAS_OPS_TOOLS`, backed by a `CanvasOpsBackend.ask` method),
taking `{question, scope?, budgetHint: 'quick' | 'thorough'}` and returning the
answer-document shape the orchestrator primer's PROTOCOL_CARD already
advertises: `{answer, evidence, confidence, unanswered?}` (plus a `cost`
report). It is NOT a `packages/protocol` command — the protocol layer is Zod
data-shapes, and the agent-facing surface is the canvasOps tool registry. The
answering machinery lives behind the tool boundary and MAY be upgraded
(e.g. from deterministic composition to a warmer answering agent) without
changing the tool contract.

#### Scenario: orchestrator asks through the registered tool

- **WHEN** the orchestrator calls `context.ask` from the `canvasOps@2` tool
  registry with a question answerable from the knowledge layer or snapshot
- **THEN** it receives the `{answer, evidence, confidence, unanswered?}` answer
  document, and the tool appears in the primer's tool index (`TOOL_WHEN_TO_USE`)
  like any other registered tool — matching the standing PROTOCOL_CARD promise

#### Scenario: the tool conforms to the pre-declared routing

- **WHEN** `context.ask` runs
- **THEN** it resolves its model through the Model Council's already-declared
  `context-ask-fetch` (light) / `context-ask-thorough` (heavy) seats by
  `budgetHint`, carrying an honest resolution trace

#### Scenario: the answer document survives to any renderer surface

- **WHEN** an answer document containing every optional field (including
  `unanswered` and `cost`) is surfaced to the reviewer through the conversation
  stream
- **THEN** every field arrives intact; any field that crosses the desktop IPC
  boundary is declared in its Zod schema, proven by a round-trip parse test

### Requirement: every claim in an answer carries resolvable evidence

Each claim in an answer document SHALL carry evidence anchors (file:line,
snapshot shard references, or knowledge statement ids) that resolve against
the pinned snapshot and support the claim. An answer without evidence is
invalid.

#### Scenario: evidence anchors resolve

- **WHEN** `context.ask` answers a question from the scripted fixture set
- **THEN** every evidence anchor in the answer resolves to real content at the
  pinned base OID, and the resolved content supports the claim it anchors

#### Scenario: an evidence-free answer is rejected as malformed

- **WHEN** the answering machinery produces an answer document with claims but
  an empty evidence list
- **THEN** validation fails and the result is reported as a failed ask, never
  rendered as a clean answer

### Requirement: unanswered-with-reason is a first-class success

When the knowledge layer cannot support an answer, the system SHALL return
`unanswered` with a human-readable reason as a successful, schema-valid
result — not an error, not a guess.

#### Scenario: honest refusal instead of a fluent guess

- **WHEN** `context.ask` is asked a question the snapshot and knowledge layer
  demonstrably cannot answer (e.g. about generated code outside the snapshot)
- **THEN** the answer document carries `unanswered` with a reason naming what
  was consulted and why it did not suffice, and the UI renders it as an honest
  outcome, not a failure state

### Requirement: ask budgets meter and report, never refuse

The system SHALL track the spend of every ask and report it in the answer
document's cost report and the run ledger. A `budgetHint: 'thorough'` ask
without budget headroom SHALL still run and SHALL report its overage; no
budget state causes a question to be refused.

#### Scenario: spend is visible in the ledger

- **WHEN** any ask completes
- **THEN** its spend appears in the run ledger alongside fleet spend, and the
  answer document's cost report matches the ledger entry

#### Scenario: no headroom still answers

- **WHEN** a `thorough` ask is made with the invocation budget already
  exhausted
- **THEN** the ask executes, the answer document is produced, and the cost
  report states the overage — there is no refusal path

### Requirement: fleet context assembly is deterministic

The context pipeline SHALL assemble the context each fleet agent is told from
declared inputs with a deterministic, golden-tested ordering. The same inputs
SHALL produce byte-identical assembled context.

#### Scenario: golden ordering holds

- **WHEN** the pipeline assembles context twice from identical inputs on the
  fixture repos
- **THEN** the assembled bytes are identical, and they match the committed
  golden files

#### Scenario: an ordering change fails the golden test

- **WHEN** a code change alters the section ordering of assembled context
- **THEN** the golden test fails, making the ordering change a reviewed
  decision rather than a silent drift in review quality

### Requirement: byte budgets truncate visibly at section boundaries

Assembled context SHALL respect per-assembly byte budgets. Truncation SHALL
happen at section boundaries and SHALL always be recorded: which sections were
truncated or dropped, and how many bytes each lost. The budget SHALL never
silently drop content.

#### Scenario: over-budget assembly reports its cuts

- **WHEN** the pipeline assembles context whose candidate sections exceed the
  byte budget
- **THEN** the assembled output stays within budget, is cut only at section
  boundaries, and the manifest lists every truncated and dropped section with
  its byte count

### Requirement: a ContextManifest is recorded and persisted per patchset

The `ContextManifest` type already exists and is built per review (it rides out
of `createLiveCanvasOpsBackend` today and is discarded at the desktop boundary);
this change SHALL extend it to record, and SHALL persist it. For every fleet
dispatch the recorded manifest SHALL carry: each document sent, with content
hash, source path, order position, and included/truncated/dropped state; the
total assembled byte size; `exhaustive` set from evidence (false until proven)
with `unmanagedSources` listing what may have reached the harness outside the
pipeline; and a digest of the assembled prompt. The existing absent-member
disclosure contract (promoted in `openspec/specs/nested-repo-maps`) SHALL be
preserved, not redefined.

#### Scenario: manifest survives and reloads

- **WHEN** a review's fleet runs and the app is later restarted
- **THEN** the manifest for each patchset loads from the local-first project
  entry and its document hashes still match the recorded assembled prompt

#### Scenario: exhaustive is evidence, not optimism

- **WHEN** no isolation probe has established that the harness sees only
  pipeline-assembled context
- **THEN** the manifest reports `exhaustive: false` and names the unmanaged
  sources (e.g. the harness's own ambient file reads), rather than claiming
  completeness it cannot prove

### Requirement: the "what was sent" panel shows the truth

The desktop UI SHALL provide a per-agent inspector that renders the
ContextManifest — documents in sent order with hashes, byte counts, and
truncation state — and an "Open the assembled prompt" view that displays the
actual bytes the adapter sent, byte-identical, never a reconstruction.

#### Scenario: reviewer inspects what an agent was told

- **WHEN** the reviewer opens the "what was sent" panel for a fleet agent
- **THEN** they see every document that went into that agent's context in the
  order it was sent, with per-document truncation clearly marked, and nothing
  the panel shows is absent from the manifest

#### Scenario: the assembled prompt is byte-identical

- **WHEN** the reviewer opens the assembled prompt view
- **THEN** the displayed text's digest equals the digest the adapter recorded
  at send time, asserted by an automated test on the capture path

### Requirement: the wiring is live in desktop main

The `context.*` commands SHALL be constructed and dispatched in the desktop
main process against the real adapter stores, replacing the current
not-wired-at-all state.

#### Scenario: a fresh app session answers from real stores

- **WHEN** the desktop app opens a project with an existing local-first map
  entry and the reviewer asks a question
- **THEN** the answer is produced from the on-disk snapshot and knowledge
  stores through the dispatch path, with no in-memory fixture standing in

### Requirement: no gates in the context capability

The `context.*` surface SHALL NOT contain consent gates, trust gates,
acceptance ceremonies, read-only postures, or capability denials. Repo
guidance and context documents feed the pipeline directly; honesty about what
was sent is provided by the manifest and panel, not by gating what may be
sent.

#### Scenario: repo guidance flows without ceremony

- **WHEN** a repository contains guidance documents (CLAUDE.md, AGENTS.md,
  `.rennet/` conventions) matched by the pipeline's detection
- **THEN** they are assembled into fleet context immediately — labelled with
  their source in the manifest — with no accept/trust step in between
