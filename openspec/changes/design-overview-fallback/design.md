## Context

The Design lane has three endings today. The host's readers select a specification from the reviewed change's own paths; when its format is one the assembler renders, the board is a pure host transform and no seat runs. When the assembler declines, the seat opens on `design-sources.md` and renders those files. When the host located nothing, the seat searches the checkout with `pr.md` and the reviewed range's commit messages as its clue, and either drafts from what it finds or calls `settle_absent`, whose one admissible reason for Design is `no-spec`.

Two of the three sources this change draws on already exist on the host. `pr.md` is written for the session and named to the Design seat alone (`packages/core/src/pr-paper.ts`). Related-context retrieval (`packages/adapters/src/related-context.ts`, `live-review-backend.ts`) runs fire-and-forget at `onReviewOpened`: it extracts refs from the branch name, commit messages, PR title and body, fetches them through `gh` or the configured tracker's REST endpoint resolved off the settings ladder, enriches them with one light-tier council turn, and saves the bounded dossier to `~/.rennet/projects/<esc>/dossier/<target@patchset>/record.json`. Nothing on the board path reads that record. The third source, documentation the branch touches, is in the change index and the checkout.

The seat runs as a persistent T3 thread with the review's checkout as its working directory (`t3-lens-threads`), reads context files with its own tools, and authors through the board tool surface (`set_document`, `add_section`, `add_prose`, `add_decision`, `add_requirement`, `cite`, `settle_absent`, `write_board`).

## Goals / Non-Goals

Goals:

- A branch written from a PR description and a couple of issues gets a Design board that says what the change was for, in the author's and the tracker's words, with every line traceable to its source.
- The overview is unmistakable as an overview. No reader takes it for a specification, and no stat on it claims a count it did not read.
- The related issues the host already fetched reach the one seat that can use them, as a file, without inlining and without a second retrieval.
- The residual `no-spec` absence survives, with the same words, for the branch that has none of the three.

Non-Goals:

- A host assembler for PR bodies. A PR description is prose; rendering it deterministically makes the board a Markdown viewer, which the whiteboard consumption reference says it is not.
- Requirement coverage or code tracing from the overview. Its `requirement` elements come from tracker acceptance criteria and may carry `trace` when the seat read the implementing code, exactly as today; nothing new is inferred from the diff.
- Changing when retrieval runs, what it fetches, or the dossier's shape. The dossier is read, not redefined.
- Any second search for a specification. The overview arm begins after the existing search has ended empty.

## Decisions

### D1. The overview is the seat's second arm, entered only after the specification search ends empty

The prompt's "When there is no specification" section keeps its first paragraph — repositories without a spec workflow are ordinary; an unfinished search is not an absence; read the commit messages and `pr.md` before concluding — and then, instead of directing the seat to `settle_absent`, directs it to draft an overview from three sources in a fixed order:

1. The reviewed pull request's title and description, from `pr.md`.
2. Documentation the branch adds or modifies: every `.md`, `.mdx`, `.rst` or `.txt` file and every file under a `docs/` directory that the change index lists as added or modified, read at the reviewed tree. When the change index is cut short, the seat runs the task layer's diff command with `--name-status -- '*.md' '*.mdx' 'docs/'`; the prompt says so, and never carries a range of its own, because a working-tree review diffs the pinned reviewed tree rather than `base..head`.
3. Related issues, from `related-context.md`.

`settle_absent` is called only when all three are empty: no `pr.md` listed, no documentation file in the change, and `related-context.md` absent or listing no item. The note names the three as looked for.

Why: the search already costs the seat its opening turns; the overview reuses what the search read. Ordering the sources fixes what the intro is distilled from when several exist, so the same branch drafts the same opening.

Alternatives: run the overview as a separate lane or a separate seat. Rejected: it would re-read `pr.md` and the change index on a fresh thread, paying the base prompt twice, for a board that belongs on the Design tab.

### D2. Related issues travel as `related-context.md`, written from the stored dossier

A new core builder, `relatedContextFile(items, { maxItems, maxBytes })`, renders the dossier as a context file: a heading naming the fetch time of the first item, then one region per item in dossier order with `id`, `tracker`, `title`, `state`, `url`, `provenance`, the bounded `body`, and `acceptanceCriteria` under its own subheading when present. Bounds are declared at the call site: 20 items, 64 KiB whole file (the dossier's own `DOSSIER_TOTAL_MAX_CHARS`); past either the file ends on a line that says how many items were dropped. `undefined` when there are no items, so the prompt never names a file that was not written.

The file is named to the Design seat alone, in `designOnlyFiles` beside `pr.md` and `design-sources.md`, with `holds` "The issues and pull requests the host found linked to this branch, from the project's tracker" and `readWhen` "when there is no specification and you are drafting the overview; each item is a stated intent with its tracker id".

Why: the dossier already exists, already bounded, already deterministic. Reading it is free; refetching it is a second egress and a second council turn. A file, not an interpolation, because the seat reads only the items it decides it needs.

Alternatives: tell the seat to run `gh issue view` itself. Rejected as the primary path: it covers GitHub only, the configured Jira or Linear tracker is unreachable from a seat without the daemon's endpoint resolution, and it repeats a fetch the host already made. The seat may still run `gh` for a ref the file lists without a body, and the prompt says so.

### D3. The Design lane waits for retrieval, bounded, only when it will run the seat without a located specification

`onReviewOpened` already kicks retrieval; `create-server.ts` holds that promise per review id in a map that the review's archive clears. The lens pipeline's deps gain `relatedContext?: (review) => Promise<readonly DossierItem[] | undefined>`. The Design lane calls it before opening the seat when, and only when, `designSources` is undefined and the assembler produced no board. The call resolves with the dossier when retrieval settles, or after `RELATED_CONTEXT_WAIT_MS` (120 s, declared in `lens-pipeline.ts`) with whatever the store holds for the key; when the store holds nothing, the file is written from `extractRefs` over the same inputs retrieval used — zero cost, no egress — with each ref's URL and a line saying retrieval had not finished, so the seat can fetch a GitHub ref itself if it chooses.

`runRelatedContextRetrieval` resolves with the items it saved or loaded instead of `void`; its early return on a stored dossier returns that dossier.

Why: the context directory is written before the seat starts (`session-context-files`), so the file must exist at open. The wait is a ceiling, not a delay: the lane continues the moment retrieval settles, which on an ordinary branch is a few `gh` fetches (15 s timeout each, already declared in `github-fetch.ts`) plus one light-tier council turn. The ceiling exists so that a hung tracker endpoint or a stalled model turn cannot hold the slowest lane indefinitely; 120 s is a chosen bound, not a measurement, and task 4.3 records what retrieval actually took on the drives so a later change can tighten it from a number. Past the ceiling the fallback is honest rather than empty.

Alternatives: write the file at open from an empty store and let the seat poll. Rejected: a seat that polls a file is a seat spending round trips on the host's job. Wait unbounded. Rejected: a lane that cannot open is a spinner the reviewer cannot explain.

### D4. The overview's document shape

`set_document`:

- `title`: the PR title when `pr.md` exists; otherwise the first related issue's title; otherwise the branch name.
- `intro_markdown`: one paragraph, opening with the sentence "No specification was found for this branch; this overview is drafted from" followed by the sources used, then the stated purpose distilled from the first source in D1's order. Nothing the sources do not say.
- `source_paths`: `pr.md`'s repo-relative path, each documentation file, and `related-context.md`, in reading order, each once.
- `stat_labels` / `stat_values`: `Format` → `Overview`, `Specification` → `none found`, `Sources` → the count of source paths, `Related issues` → the count of items read when the file exists. No capability, requirement or task stats.

Sections, each with `sources` naming the file it was read from:

- **What the author says** — from `pr.md`: the description's headings as nested sections in its own order, its paragraphs as `prose`. A stated decision becomes `decision` with `inferred: false` and `source` `{ path: <pr.md>, label: "PR description" }`.
- **Documentation on this branch** — one nested section per documentation file, its headings nested in source order, its prose as `prose`. A code fence is left out and its place stated, exactly as a proposal's fence is today.
- **Related issues** — one nested section per item, titled `<tracker>#<id> <title>` with state and provenance as its first prose line and the body's paragraphs following. Acceptance criteria become `requirement` elements: `shall` verbatim, `capability` the item id, `source` `{ path: <related-context.md>, label: <item id> }`, `trace` only for code the seat read.

Why: the same canonical elements the spec-backed board uses, so the surface, the source chips and the dispositions work unchanged; the stats and the intro's first sentence are the facts that make it an overview and not a spec, stated on the object rather than as chrome.

Alternatives: a new `overview` element kind or document field. Rejected: the schema already carries everything; a new kind is a wire change for a fact two stats state.

### D5. The linter reads context files as sources

The Design lint rules that check a `source.path` — `design-source-known`, `requirement-source-known` and `design-decision-stated` — are gated on a discovered artifact bundle (`ctx.artifacts`) that production's lint context never supplies, so on the model-seat path no rule reads a source path at all, and `pr.md` and `related-context.md` under `.rennet/context/<sessionId>/` pass untouched; the rules need no new arm. Task 3.3 proves it on a fixture whose positive control is the same board under a located-artifact context, where both source rules fire.

### D6. What stays exactly as it is

The host-located and assembler paths never wait and never draft an overview. The spec-only dispatch is untouched. The `no-spec` reason, its bench-reader copy, and the tab that stays are untouched for the residual case. `no-material` stays legacy. `LENS_ADMISSIBLE_ABSENCES` does not change: the overview is a board, not a new absence.

## Risks / Trade-offs

- **A thin overview.** A PR body of one line and no issues yields a board of one section. That is what the author wrote, stated as such; it is more than "No spec found", and the seat is told not to pad it. Mitigation: the prompt's existing rule against inventing requirements and rationale applies unchanged.
- **Tracker text as requirements.** An issue's acceptance criteria are the reporter's words, not a spec's normative text. They render as `requirement` because they are the nearest thing the branch has to one and the disposition anchors are useful; the `source` label makes their origin visible on the row.
- **The wait.** Up to 120 s before the Design seat opens on a branch with no located spec, and only when retrieval has not settled by then; the ordinary case is the retrieval's own duration. Noise starts on the four core settlements, so the same ceiling bounds its start. The preparation surface already shows the lane's latest event; the lane publishes "waiting for related issues" as that event so the delay is visible, not silent.
- **Token growth.** Stated in the proposal's Impact. The measure is the collector, as for every seat.

## Migration Plan

Additive. Generations persisted before this change render as they did: a `no-spec` absence stays an absence. No wire field changes; no setting changes. Rollback is the prompt section and the file writer.

## Open Questions

None. Every choice above is settled in this file.
