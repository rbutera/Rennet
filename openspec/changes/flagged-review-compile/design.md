# Design

The decisions below were settled with Rai on 2026-09-08 by grilling the rework against the #927 root cause. Each records the choice and why the alternative lost, so a later reader does not reopen a settled branch.

## Root cause of the #927 "Proposal fidelity" header

Confirmed from the persisted board log (board `20fbf9b5-8a92-4080-bd8a-beb758cdf4a8`) and the Codex seat transcript. The Codex seat called `add_section {title: "Proposal fidelity"}` and attached three bare `code_ref` elements (`ge6/ge7/ge8`) to it, then two findings (`ge9`, and `fe4` — which the Claude seat's earlier "Findings" section `fe1` already owned). A `section` has no body attribute per the board schema, so a section header can never carry prose; the orphaned `code_ref`s rendered as standalone code excerpts under it.

It was NOT a model emitting an empty body field (both findings carry full `concern` prose) and NOT a render crash. It was a seat authoring structure the prompt did not intend, two seats racing into one board, and no guard against a finding-less section. The rework removes the first two by giving structure a single author; move one adds the third guard as defense in depth.

## Decision 1 — Concurrence is the compiler's judgment, not a location match

The dual-seat design exists for the concurrence signal (concur / split / solo). Today it is computed mechanically by matching findings on code location after both seats write one board (`reconcileFlaggedVoices`). The rework replaces that with one compiler reading two finished findings files.

**Chosen: the compiler judges agreement semantically.** Two models describing the same bug at different lines currently stay two separate solos — a silent defect of location-matching. Semantic matching is strictly better and the pill is too valuable to drop. The cost — a fallible, billable model judgment — is acceptable because the compiler is judging agreement between two *finished* findings, not authoring them.

Rejected: dropping concurrence (loses the whole reason Flagged runs two seats); keeping location-matching (keeps the dual-solo defect).

## Decision 2 — Origin attribution survives the merge

**Chosen: each compiled finding keeps its origin model as author.** "Codex caught this alone" is exactly the signal an agentic engineer wants. The compiler stamps each finding's origin from the file it came out of. Depends on Decision 1.

Rejected: authoring everything as the compiler and relying on the concurrence pill alone — it erases which model raised a solo.

## Decision 3 — Review files are structured, not freeform

**Chosen: each review seat writes one finding per section in the exact shape the `concern` string already mandates** — claim ≤10 words, blank line, body, `**Fix:**`, explicit `path:line` refs, severity tag. This keeps the discipline that lives in the `add_finding` schema today, makes the compiler's job a merge rather than a reconstruction, and is the load-bearing constraint that fixes #927: a seat that must fill a body field cannot emit a bare header.

Rejected: freeform prose the compiler parses — pushes citation/severity reconstruction onto the compiler and reopens the empty-finding failure mode.

This decision is load-bearing, not cosmetic: it is what keeps the compiler an assembler.

## Decision 4 — The compiler assembles, it does not rewrite

**Chosen: finding prose travels verbatim from the review file into `concern`.** The compiler dedupes by semantic match, stamps concurrence and origin, ranks by severity, and writes the flat list. It never paraphrases a finding. A compiler that rewrote both reviews into its own prose would be a model that can quietly drop or distort what Claude and Codex found — a fidelity loss and a UI-lie risk, and it would launder Codex's independent voice through a Claude rewriter. Given Decision 3's structured files, verbatim assembly is straightforward.

## Decision 5 — Flat ranked list, no thematic sections

**Chosen: a flat ranked list of findings under a single heading.** The Flagged board is "the list of real problems, ranked and located" per its own prompt; severity ranking is the organizing principle readers want, and dropping thematic sections removes the exact element kind (`section`) that produced #927. If a board ever grows big enough to need grouping, that is a follow-up, not this change.

Rejected: the compiler groups findings into thematic sections — reads better on a huge board but reintroduces the section machinery that just failed.

## Decision 6 — Scope to Flagged now, shaped to generalize

**Chosen: solve Flagged concretely, reusing `composeContextFiles` / `renderComposePrompt` so it is the same mechanism the general composition seat would use.** Ship the narrow win; do not try to light up the whole (currently omitted) composition seat in this change.

## Decision 7 — "Don't run the gate" is scope and cost, never "the branch is fine"

Rennet does not run the reviewed repo's gate. It reviews the diff, reads real file content, and fetches the forge's already-computed CI status as read-only, non-gating telemetry (Rule Zero: CI never gates the sign). So "assume the branch is fine" is a claim we cannot back, and it is in tension with the lens's purpose — telling a review seat the code is correct suppresses the findings it exists to catch.

**Chosen: forbid running the gate on scope-and-cost grounds** ("reviewing whether the gate passes is not your job; finding real problems in the diff is; don't run build/test/lint"), and say nothing that implies the code works. Handing the seats the already-fetched CI status explicitly is a possible separate enhancement, not required here.

## Decision 8 — the compile seat authors origin, concurrence, and accord

A finding's `author`, `concurrence`, and `accord` are host-owned today: a board seat cannot write them (`tool-schemas.ts` — `author` is "never a seat's to write", concurrence/accord are "computed by `reconcileFindings`"). The invariant exists so an ordinary lens seat cannot forge authorship or fake agreement, because the seat is known from its address and its findings are its own. The compiler is a different animal: its whole job is to attribute each finding to the model that raised it and to judge whether both did (Decisions 1 and 2).

**Chosen: relax the host-owned constraint for the compile target only — the compiler sets `author` (origin model), `concurrence`, and `accord` directly through its board tools, in the one `write_board` call.** The anti-forgery rationale does not apply to a trusted assembler whose output those fields *are*; a side-channel that emitted them separately would be a second authoring format for the same facts. Scoped to the compile target: the two review seats write no board at all, and every other lens seat keeps the fields host-owned exactly as before.

Rejected: keeping the fields host-owned and having the compiler emit a separate per-finding judgment the pipeline post-stamps — it preserves the invariant for a seat the invariant was not written for, at the cost of a parallel judgment channel and a second place origin/concurrence can drift.

## Decision 9 — the compiler reuses the `flagged` board target; the review seats are lane-less

A board seat is a THREAD; a board target is a BOARD; the two are decoupled, and the Flagged lane already runs two seats over one board (`SEAT_BOARD_TARGET` maps both `flagged-claude` and `flagged-codex` to `flagged`). Move two keeps that target and changes who writes it: the two review seats write NO board (no open lane, so `seatBoardServer` hands them no address and no board tools — they write their findings file with the harness's own file tools), and a third seat, `flagged-compile`, is the sole writer of the `flagged` board.

**Chosen: the compiler writes the existing `flagged` target; no new board target is introduced.** The rendered Flagged lens board is read as `lane("flagged")`, so reusing the target means the compiler's board IS the lens board with nothing to bridge. `finding` is authored by the flagged lens alone (`LENS_TYPED_KINDS`), so relaxing finding-authoring for "the compile target" and relaxing it for "the finding kind" are the same relaxation — there is no other target to leak to. `writesWholeBoard` gains `flagged` beside `noise`; its own comment already invites this ("a target that wants it for another reason changes this one line and says which measurement it has"), and the measurement here is Decision 1: one compiler composing the whole board is authoring, which is what the whole-board write is for.

Rejected: a distinct `flagged-compile` board target. It would make `BoardTarget` no longer `LensKind | "report"`, force a row in every table keyed on `BoardTarget`, and open a lane that nothing renders as the Flagged lens — so the pipeline would have to copy the compile lane's board into the flagged result. More surface, more tables, a bridge, for a separation the seat≠target decoupling already provides.

## Decision 10 — the compiler authors `origin` and `agreement`; the host expands them (mechanism for Decision 8)

Decision 8 relaxes the host-owned constraint so the compiler owns each finding's origin and agreement. The wire fields those facts live in — `author` (`{kind,id}`), `concurrence` (an array of `{model,agree,total}`), `accord` — are nested shapes, and the flat-input rule (`flatInputViolations`, the fix for #810) forbids a seat authoring a nested or union input. So the compiler cannot write them directly; it authors two FLAT ENUM inputs and the host expands them.

**Chosen: `add_finding`/`update_finding` on the flagged target carry two extra input-only enums — `origin` (`claude` | `codex`) and `agreement` (`concur` | `diverge` | `solo`) — and the board writer expands them into the host-owned `author`, `concurrence`, and `accord` at write time.** The two enums do not persist as finding attributes: `author` already encodes the model and `accord` already encodes the agreement, so persisting the enums beside them would be the same fact twice. They ride the tool input (beside `parent_id`), never `AUTHORED_BOARD_SCHEMA`, so the schema-derived field machinery ignores them and `dataFromInput` never lands them in `data`; the writer reads them in the finding arm and stamps the three host fields, overriding the voice-author default and the `concurrence: []` host default.

The agreement vocabulary is deliberately NOT the schema's `accord` words. `accord` is `concur | split | conflict`, where `split` means "one model raised it, the other said no concern" — i.e. a solo. Reusing `split` for the compiler would make the writer's `agreement → accord` map read like a bug (`solo → split`, `diverge → conflict`). The compiler's words are chosen to map without a collision:

- `concur` → accord `concur`, concurrence both models (`[{claude,1,1},{codex,1,1}]`) — both raised it at comparable severity.
- `diverge` → accord `conflict`, concurrence both models — both raised it, materially different verdict (the higher severity wins).
- `solo` → accord `split`, concurrence the one model (`[{origin,1,1}]`) — only `origin` raised it.

The origin→author and origin→concurrence-label mappings are protocol constants (`flaggedOriginAuthor`, `flaggedOriginLabel`) so the compiler-authored board carries the same `lens:flagged:claudeAgent` / `lens:flagged:codex` author ids the two seats stamped before the rework — the reader's attribution is unchanged. This retires `reconcileFlaggedVoices` location-matching (Decision 1): the compiler's `agreement` IS the accord, stamped per finding, not inferred from where two boards' findings landed.

## Move ordering

Move one (prompt guard + render/projection guard + a positive-control test using the #927 element shape) ships as its own PR first. It is the real fix for the observed header and is correct independent of the rework. Move two supersedes the *cause* by collapsing structural authorship to one compiler; the move-one guards remain as defense in depth.

## Recurring cost

Move two adds one orchestrator-class turn per Flagged run (input: two bounded review files). Some structuring work moves off the two seats onto the one compiler, so it is not purely additive, but the net is a modest increase. The PR description names it; the collector threads usage so the spend is not invisible.
