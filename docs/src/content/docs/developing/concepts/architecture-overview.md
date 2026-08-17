---
title: Architecture overview
description: How Rennet's packages, desktop processes, review engine, and local data fit together.
---

This page is the quickest way to get your bearings in the Rennet codebase. It
shows the boundaries that exist on `main`, then follows one review from Git to a
signed GitHub result and shows where the coding-agent handoff is meant to join.

## The short version

Rennet is an Electron app in a pnpm + Nx monorepo. The renderer is deliberately
thin: it asks the desktop main process to do work through a typed inter-process
communication (IPC) bridge, while
`@rennet/core` owns review behaviour and `@rennet/adapters` talks to Git, GitHub,
SQLite, the filesystem, and installed coding harnesses.

```mermaid
flowchart LR
  user[Reviewer]
  ui["Renderer<br/>@rennet/ui"]
  preload["Preload<br/>typed bridge"]
  main["Electron main<br/>composition root"]
  core["Review engine<br/>@rennet/core"]
  adapters["Host integrations<br/>@rennet/adapters"]
  local["Local machine<br/>Git · SQLite · Repo Map"]
  harness["Installed harnesses<br/>Claude first"]
  github[GitHub]

  user <--> ui
  ui <--> preload <--> main
  main <--> core
  main <--> adapters
  adapters <--> local
  adapters <--> harness
  adapters <--> github
```

The main process is the authority boundary. The renderer cannot import core or
reach Node APIs directly, and adapters never leak host-specific behaviour back
into the portable protocol.

## Package graph

The arrows below mean “may depend on.” They are enforced by
`scripts/check-boundaries.mjs` and the Nx module-boundary rule; the architecture
target includes a deliberately forbidden import so the check proves it can fail.

```mermaid
flowchart BT
  types["@rennet/types<br/>shared data shapes"]
  protocol["@rennet/protocol<br/>typed IPC + review-document validation"]
  instructions["@rennet/instructions<br/>versioned prompt contracts"]
  core["@rennet/core<br/>portable review engine"]
  adapters["@rennet/adapters<br/>Node and service integrations"]
  ui["@rennet/ui<br/>React review surfaces"]
  desktop["apps/desktop<br/>Electron composition root"]

  protocol --> types
  instructions --> types
  core --> types
  core --> protocol
  core --> instructions
  adapters --> types
  adapters --> protocol
  adapters --> instructions
  adapters --> core
  ui --> types
  ui --> protocol
  desktop --> types
  desktop --> protocol
  desktop --> core
  desktop --> adapters
  desktop --> ui
```

| Project | Owns | Must not own |
|---|---|---|
| `@rennet/types` | Shared, transport-safe TypeScript shapes | Runtime behaviour or in-repo dependencies |
| `@rennet/protocol` | IPC commands, Rennet Surfacing Protocol (RSP) schemas, wire validation | Electron, filesystem, or product orchestration |
| `@rennet/instructions` | Versioned base instructions and prompt assembly | Public protocol or host access |
| `@rennet/core` | Capture-independent review logic, event folds, canvases, routing, lineage, publication decisions | Electron, GitHub clients, filesystem calls, or renderer state |
| `@rennet/adapters` | Git, GitHub, SQLite, local files, harness SDKs, and other host integrations | UI or product policy |
| `@rennet/ui` | React surfaces and ephemeral view state | Core imports, Node APIs, or durable review truth |
| `apps/desktop` | Electron main/preload/renderer assembly and live dependency wiring | Reusable domain logic that belongs in a package |

## A review from input to outcome

Both local branches and pull requests become immutable patchsets. Everything
after capture refers to that fixed input, even if the working tree changes or a
pull request is force-pushed while the reviewer is reading.

```mermaid
flowchart LR
  source{"Working tree<br/>or pull request"}
  capture["Immutable patchset<br/>diff + intent + provenance"]
  floor["Deterministic floor<br/>total coverage + basic grouping"]
  models["Model jobs<br/>ordering · decisions · findings · noise"]
  validate["Rennet Surfacing Protocol validation<br/>grounded documents only"]
  canvases["Five canvases<br/>Spec · Sequence · Decisions · Flagged · Noise"]
  draft["Collation draft<br/>editable dispositions"]
  paper["Signed paper<br/>frozen outbound bytes"]
  review["GitHub review"]
  handoff["Coding-agent handoff<br/>write · test · recapture"]
  pr["Push branch + open PR"]

  source --> capture --> floor --> models --> validate --> canvases --> draft --> paper
  paper -->|someone else's PR| review
  paper -->|your branch needs changes| handoff --> capture
  paper -->|your branch is ready| pr
```

The deterministic pass is the floor, not the final reading order. It guarantees
that every changed byte has somewhere to go. Model jobs then propose the
human-friendly cohorts, decisions, findings, and noise groups. Rennet validates
their output and places it on a canvas; the reviewer owns the dispositions. The
[surfacing and routing page](/developing/concepts/surfacing-and-routing/)
explains the RSP document shapes and how model jobs reach them.

## The local data model

Rennet keeps three kinds of local state separate because they have different
lifetimes:

```mermaid
flowchart TB
  repo[Reviewed repository]
  authored[".rennet/<br/>human config + optional promoted map"]
  map["~/.rennet/projects/&lt;escaped-path&gt;/<br/>local Repo Map"]
  app["Electron Application Support<br/>review events + command receipts + settings"]

  repo --> authored
  repo -->|deterministic indexing| map
  repo -->|immutable capture| app
```

- The **Repo Map** is derived project context. Current `main` stores it by escaped
  repository path under `~/.rennet/projects/`; each checkout or worktree gets its
  own local entry. A deliberate promotion can mirror it into `.rennet/` for a team.
- The **review event store** is durable app data that outlives any single session:
  events and idempotent command receipts are persisted, and canvas projections are
  rebuilt in product code.
  - Any persisted review is **loadable by id** — `review.load` folds it back from its
    events as a pure read (no event appended), independent of which review is most
    recent.
  - A load reports whether its recorded repository root still exists, so the renderer
    can show honest missing-context status; bootstrap reports the same presence fact
    for the latest review.
  - Every id-addressed command resolves the review it names rather than assuming the
    globally latest one, so an older reopened review is fully addressable, and
    repository-dependent commands bind their caller path to the addressed review's
    stored root.
- **Navigation state** (the back/forward surface stack plus recents) is
  renderer-local UI state, persisted to a versioned `localStorage` blob and restored
  on the next launch so the app reopens where the user left off. It is deliberately
  separate from the durable event store:
  - A landing rehydrator reloads each surface's content as the user arrives on it.
  - An unreadable or older blob degrades to recents-only with no migration step, and
    an entry that can no longer load is discarded from both Back and Forward in favour
    of the nearest surface that still opens.
  - The parser rejects unrooted or cross-review breadcrumb routes, and each stack half
    is capped at 100 entries so the local blob stays bounded.
- Review harnesses currently run against the live checkout. The separate
  immutable materialisation and prompt-staging cache described by the long-term
  contract is not implemented yet.

## What is live and what is a contract

The package boundary, typed Electron bridge, immutable local and remote capture,
review pipeline, five lenses, dual-model findings, comment refinement,
deterministic Repo Map refresh, GitHub review publication, and own-branch
push-plus-PR submission are wired on current `main`.

The handoff bundle, capable harness turn, checkpoints, successor capture,
exact-evidence carry, and model composer are wired end to end, as is the
deterministic delta account over the successor patchset; the remaining seam is fuzzy
lineage carry.

The acting command runs the composer's exact output bound by its digest, refusing a
tampered or stale bundle, and the renderer composes, previews, and invokes it from
the own-branch destination, surfacing the run outcome truthfully.

The architecture still contains deliberate future seams: additional harnesses,
remote/mobile clients, and public release machinery are not all live merely
because their ports or contracts exist. The
[architecture contracts](/developing/concepts/architecture-contracts/) page
keeps those requirements separate from observed implementation.

## Conversation transport and durability

Inline review questions stream from desktop main to the renderer on a channel
keyed by review and turn. The renderer coalesces token deltas before painting;
those partial bodies are live display state, not durable conversation history.

```mermaid
sequenceDiagram
  participant UI as Renderer thread
  participant Main as Desktop main
  participant Store as Thread store
  participant Harness

  UI->>Main: review.ask with thread and turn ids
  Main->>Store: Persist question plus empty streaming placeholder
  Main->>Harness: Start turn
  Harness-->>Main: Token deltas
  Main-->>UI: Push deltas keyed by review and turn
  UI->>UI: Coalesce and paint partial answer
  Harness->>Main: canvas.focus effect
  Main-->>UI: Push ask-focus keyed by review
  UI->>UI: Scroll once and pulse the exact span
  Harness-->>Main: Final answer
  Main->>Store: Replace placeholder with one durable completion
  Main-->>UI: Push final body
```

If the process dies first, the empty `streaming` placeholder reloads as
`interrupted`; no partial token buffer is promoted to a finished answer. A
malformed thread file degrades to no restored threads and is left untouched for
manual recovery. On app quit, desktop main aborts every registered turn. Codex's
child is killed through its executor; the Claude SDK exposes no child PID, so
Rennet can request cancellation but cannot claim it observed the process exit.

Persisted threads reattach after reload; live in-flight deltas do not. Main-alive
in-flight enumeration is not wired yet — `review.reattach` returns an empty
`inFlight` list — so a freshly loaded renderer cannot reconstruct deltas it missed
before subscribing. The durable completion or honest interrupted placeholder remains
the source of truth.

## Where to go next

- [Architecture contracts](/developing/concepts/architecture-contracts/) explains
  patchsets, freshness, persistence, harness authority, and publication in depth.
- [Contracts and rulings](/developing/reference/contracts-and-rulings/) explains
  which decision wins when old plans disagree.
- [Dependency standard](/developing/reference/dependency-standard/) records which
  package owns each piece of plumbing and which alternatives stay out.
- [Delivery order](/developing/reference/delivery-order/) is the current build
  sequence. Re-check its “true right now” claims against `main` before acting.
