# B08 — lens-pipeline (#464 + #493 + #486: the drafting pipeline)

Packet: `context.md` (scope authority). Plan row B8 — the largest engine change, head of the critical path B8→B9→B11; expect multiple sub-waves. Blocked-by B4 (board runtime + `whiteboard-client`, landed), B5 (DeltaPacket, landed). B6/B7 outputs consumed if present, degraded gracefully if not. Authored 2026-08-27 against main @ 229fadc6 (B06 landed, C01/C02 merged).

## What this change does

The drafting pipeline: harness sessions draft one board per lens, a deterministic validation loop guarantees each draft before a human sees it, and the orchestrator composes across the boards. It lands in `server/src/runtime/` (the scheduler home B06 created) over a NEW pure `core/board/` layer, consuming the seam B03 froze in `protocol/src/board/` and the prompts in `@rennet/prompts` verbatim.

- **Drafters** are harness sessions in the PR worktree, seeded with the inlined DeltaPacket (B5) + the lens prompt from `packages/prompts` + the host board schema. Returns are **structured**, validated by `DraftBoardSchema` (`protocol/src/board/schema.ts` — consumed, never re-modeled); the host writes board ops on the drafter's behalf through `whiteboard-client` (the sole op writer, B04) — whiteboard tools stay orchestrator + human only. A landed-round **report classifier** has a different input set: successor patchset id, durable asks, and the exact worker receipt. It receives a classification schema rather than the DeltaPacket or host board schema. The host builds and verifies its report board. That one attempt settles before the lens drafters start, and per-board arrival emits the events that power the R58 reveal.
- **Validation loop** (#493): 19 lint rules + schema constraints run as `lint(draft) => Violation[]` (`ViolationSchema`, B03-frozen). Failures return to the drafter as ZodError-shaped JSON pointers on one retry channel; the drafter returns one repair patch and passing elements freeze. Validation makes at most one model repair turn after the initial draft. An element still invalid afterward takes an honest-omission exit (drop the element; its hunks move to `skippedHunks` with a reason); unresolved board-level or schema violations ship as labeled `blemishes[]` (`BlemishSchema`, B03-frozen) — visible, never blocking. The production scheduler does not run a model-backed board editor after validation; cross-lens every-hunk coverage remains the final composition check.
- **Composition** is split: mechanical parts live in `core/board/` (the coverage assertion — every patchset hunk taught-or-skipped across all lenses; verbatim carry on stable element ids; delta stamps), while the authored connective prose is the orchestrator's, write-through on the versioned composition prompt (`review-draft-voice.md`, B02). Curation feedback enters the next generation's packet. The lens boards ARE the reading surface — there is no sixth composed board.
- **Council rows.** The five job ids `lens-draft`, `lens-draft-flagged` (dual seat + `agreement` routing), `lens-draft-noise`, `board-post-process`, `round-report` are already frozen in `protocol` `COUNCIL_JOB_IDS` (B03); B08 adds only their CORE `JOB_CATALOGUE` entries + assignment-table rows in `core/model-council.ts` (no protocol edit, exactly the B06 pattern). The lens scheduler no longer invokes `board-post-process`; the frozen id remains available to the Council role catalogue. `round-report` is now a narrow classification job. It defaults to Sonnet at low effort in both-provider and Claude-only scenarios, and Terra at low effort in Codex-only; the normal task and tier overrides still win. The Flagged dual-seat merge keeps `finding-reconcile` (`core/finding-reconcile.ts`, landed).
- **#493's seven flagged conflicts are pre-resolved — applied, not re-opened:** R17 (no code bytes — enforced at parse time via the derived draft schema, reinforced by lint), R20 (backtick + patchset-identifier exemption in the code-bytes screen), `review-draft-voice.md` gets lint coverage (the process-vocabulary screen applies to the write-through authoring register too), and spike drift must not propagate into the schema (the schema is B03's derivation; B08 never hand-edits it).
- **Concurrency measurement.** The warm-session concurrency cost (engine asset risk 3) is measured against real harness sessions before the six-seat fan-out is trusted; the measurement is recorded in this change (§Concurrency measurement below).

## Out of scope

Client rendering of the boards (C5). Exits (B11). The rounds machinery that consumes the round-report seat and drives the R58 reveal (B09 — B08 emits the per-board arrival events and lands the round-report drafter; B09 wires the reveal). `DraftBoardSchema` / `LensBoardSchema` / `ViolationSchema` / `BlemishSchema` / `SkippedHunkSchema` / `COUNCIL_JOB_IDS` are B03-frozen contracts — consumed, never re-modeled.

## Reconciliation ledger (proposer findings — hold these, do not re-open)

1. **`core/board/` does not exist yet — B08 creates it.** Board *schema* lives in `protocol/src/board/` (B03); board *persistence + transport* landed in `server/src/boards/` (B04: `boards-runtime.ts`, `file-board-store.ts`, `whiteboard-client.ts`). The packet's "over pure `core/board/`" names the NEW pure-logic layer B08 builds — lint, validation loop, composition mechanics — the direct analogue of B06 creating `core/knowledge/`. No board runtime is re-built; the pure layer sits over B04's runtime.
2. **The seam is already frozen; B08 consumes it.** `DraftBoardSchema`, `parseDraft`/`DraftParseResult`, `ViolationSchema` + the `lint(draft) => Violation[]` signature, `BlemishSchema` (`Violation` + `attempts`), `LensBoardSchema`, `SkippedHunkSchema`, `LensSectionSchema` are all in `protocol/src/board/schema.ts` and `lens-board.ts` with JSDoc naming B8 as the consumer. B08 writes the pure functions over these shapes and never re-models them (drift tests 1/2 guard the schema).
3. **`COUNCIL_JOB_IDS` already carries all five ids** (`protocol/src/manifests/index.ts:49`). B08 adds only `core/model-council.ts` rows — `CouncilJobId` is `string`, no protocol touch (B06 reconciliation 1 precedent).
4. **The "19" lint rules are #493's target, not independently enumerated in the packet or codebase.** The rule *families* are already listed in the planned `docs/developing/concepts/lens-pipeline.md` (kind-allowlist-per-lens, no-code-bytes, citation-resolves, `skippedHunks`-present + cross-lens coverage, structured-fields-where-required, process-vocabulary screen). The implementer derives the exact 19 from #493 and enforces them; if #493's count and the derived rule set disagree, that is a report-back, not a silent trim.
5. **The packet's "versioned `composition` prompt" = the existing `review-draft-voice.md`** (`REVIEW_DRAFT_VOICE_FILE`) — its JSDoc is exactly "writing rules the orchestrator applies write-through when authoring or reworking the living review draft." No new prompt file; consumed verbatim like every other prompt.
6. **B7's related-context dossier is a delta-context input, not a B08 deliverable.** The planned docs page describes the dossier as inlined into every drafting prompt; if B7 has not landed, the drafter is seeded with B5's DeltaPacket alone and degrades gracefully (packet: "B6/B7 outputs consumed if landed"). B08 does not build retrieval.

7. **#493's lint catalog assumes a richer schema than B03 froze — implement the residue over the FROZEN fields (cluster 2 amendment; reconciliation 2 + F4).** #493's design (2026-08-26) was written before B03 froze `protocol/src/board/schema.ts`, and its rule catalog references fields/kinds the frozen 13-kind schema deliberately does not carry: a `finding.fix` field (S4, L5), `finding.details` (S5, L6), `requirement.status` (S7), a drafter-authored section `counts` (L8 — `counts` lives on the `LensBoard` *projection*, `LensSectionSchema`, not on a draft the drafter authors), a `noise-group` kind with `.hunks` (S8, L12 — the frozen kind is `noise_verdict` with a single `hunk`), and a `thread` kind (S1). Per reconciliation 2 and F4 the schema is B03's derivation and is **never hand-edited**, so:
   - **The KIND palette is enforced STRUCTURALLY at parse time, not as a lint rule.** The frozen `DraftBoardSchema` has no `thread` or `code` kind and omits `message`/`review_comment` (`DRAFT_OMITTED_KINDS`); `parseDraft` rejects an out-of-palette kind with ZodError issues (the KIND gate — code bytes inside a *legal* prose element are the `no-code-bytes` lint rule's lane, not parse-time; see P6 correction below). `board/lint.test.ts` proves both halves.
   - **`lint(draft) => Violation[]` (cluster 2) is the per-draft, element/board-scoped stage.** #493 itself stages **L18** (cross-lens every-hunk coverage) at **composition** → cluster 4, and **L19** (typed-data immutability across post-process) as a **post-pass assertion** → cluster 3. Neither is a per-draft rule.
   - **Implemented set (16 per-draft rules)**: `kind-allowlist` (S1 residue at lint scope + per-lens home-lens gate), `no-code-bytes` (L1/R17 + R20 backtick exemption), `no-dialogue` (L2), `citation-well-formed` (L3, incl. the GitHub `#L` form S3), `citation-resolves` (L4 + **S2 patchset-id + side-specific inventories** + **S8 range order** + L12's `noise_verdict.hunk` element-reference resolution), `process-vocabulary` (L7 + F2/F3 backtick + patchset-identifier exemptions, applied to structural fields only), `no-remainder-narration` (L9), `scaffold-is-noise-lane` (L10/R22, `**/` now matches root-level paths), `skipped-hunks-present` (S3-as-lint), `skip-reason-specific` (L11), `skipped-hunks-resolve` (L14), `no-taught-and-skipped` (L15), `decision-grounded` (**S6** — non-empty `evidence` + `alternatives`, both frozen `string[]` fields), `report-coherent` (L17/R57), `requirement-verbatim` (L13, degrades to no-op without source text), `requirement-order` (**L16/P5** — non-decreasing verbatim-`shall` offset in the source artifact; degrades to no-op without source text).
   - **Two lint targets (S1).** `lint(draft, ctx)` dispatches on `ctx.lens`: the five lenses run `LENS_RULES`; the **round-report seat** (`ctx.lens === "report"`) runs `REPORT_RULES` (the prose/kind screens + `report-coherent`, no hunk-coverage obligation). The report seat's `round_outcome` kind is admitted ONLY there and rejected on every lens board. **`beyond` reconciliation:** the frozen `askRefSchema.ref` is `.min(1)` and `ask` is a required field on `roundOutcomeData`, so a schema-valid `beyond` round_outcome **cannot** carry an empty `ask.ref`; R57's "leave `ask.ref` empty" is unenforceable against the frozen schema. Lint enforces the enforceable half — a non-empty accounting `note` on `beyond` — plus the status sort order. The frozen schema carries **no field** distinguishing "traces to a real ask" from "names work" (both use the same non-empty `ask.ref`), so that distinction is not lintable; recorded honestly.
   - **Spec-P1 lens table** (verified against `packages/prompts`, not adopted blind): the **Design** prompt renders BOTH requirement regions AND the implementer's stated `decision` calls, so Design admits `decision` + `requirement`; the **Decisions** prompt is decision-only, so Decisions admits `decision` alone (`requirement` on the Decisions board is a lane violation). Prior code had `design: []` and `decisions: ["decision","requirement"]` — both wrong against the prompts.
   - **The review-draft register (P3).** `review-draft-voice.md` is authored write-through as one prose text (no post-process stage after it), so it gets its own entry point `lintReviewDraft(text, ctx)` applying L3 (citation-well-formed), L4 (citation-resolves), L7 (no-machinery). Its machinery screen is narrower than a board's — the draft IS the review, so it may say "this review" but not name the pipeline's parts (lenses/boards/seats/drafts/agents).
   - **Dropped as inapplicable to the frozen schema** (each with the named absent field; reported, not silently trimmed): **L5** fix-in-body — no `finding.fix`/`finding.body` (only `concern`); **L6** body-wall — no `finding.details`; **L8** drafter counts — `counts` lives on `LensSectionSchema` (projection), never on a draft; **S4** (`finding.fix`) and **S5** (`finding.details`) — same absent fields; **S7** requirement `status` — the frozen requirement carries `coverage` (`met|gap|partial`, a required enum the schema already enforces) instead of a `status` field, so no lint rule is owed. These remain a **B03 schema follow-up** (add the field to the frozen host schema first), not a B08 hand-edit. **P4 correction:** the earlier blanket "S4–S8 cannot enforce" was FALSE — **S6** (`decision.evidence`/`alternatives`) and **S8** (`code_ref.start_line`/`end_line` order) DO have frozen fields and are now enforced above; only S4/S5/S7 reference truly-absent fields.
   - **P6 correction.** Parse-time (`DraftBoardSchema`) enforces only the KIND palette — an out-of-palette kind (`code`, `message`, `thread`) is rejected with ZodError issues. It does **not** screen code bytes inside a *legal* prose element; the earlier "R17 enforced at parse time" claim overreached. The `no-code-bytes` lint rule owns code bytes in legal prose. The test asserts both halves (kind rejected at parse; code-bytes-in-prose accepted at parse, caught by lint).
   - **Count**: #493 claims "19 lint rules". Of those, 2 (L18/L19) are other-stage by #493's own staging (composition / post-pass), and 4 (L5/L6/L8 + the never-a-rule S-only entries) reference absent fields; L12 is folded into `citation-resolves`, L16 is implemented as `requirement-order`. The faithful per-draft `lint(draft)` set over the frozen schema is **16 rules** (plus the separate `lintReviewDraft` register entry point) — a schema-shape reconciliation, not a trim to hit a number.

## Cluster 5 wiring points (the runtime seam bindings — recorded per 5.1)

`server/src/runtime/lens-pipeline.ts` binds the seams the earlier clusters left open:

- **`validateDraft`'s `postProcess` seam remains identity in the production lens scheduler.** The core seam and its typed immutability result remain available to deterministic callers, but lens drafting does not resolve or call the model-backed `board-post-process` job. A clean lens therefore pays for one drafting turn, not a draft plus an editor rewrite.
- **`assertCoverage(boards, hunks)` (cluster 4) runs ONCE over the frozen board set**, after every lens freezes — the per-board `compositionGate` seam stays no-op (binding handoff from cluster 4). Coverage violations are returned (visible), never block.
- **Council routing** reuses B06's `councilSeatTurn` (adapters) verbatim: each lens seat resolves on the RESOLVED harness (Claude port / Codex utility executor) with the board output schema. Lens→job map: `noise → lens-draft-noise`, `flagged → lens-draft-flagged`, the rest → `lens-draft`.
- **The host is the sole op writer** (`draftToOps` → `whiteboard-client.apply`, actor `lens:<lens>`); drafters never call whiteboard tools (D2). The wire element `{id,kind,data}` IS the draft element, so the projection is a straight `create`-op map.
- **The board output schema** is derived once from the frozen `DraftBoardSchema` via `z.toJSONSchema` (never hand-authored — reconciliation 2/F4); it is both the session output schema and the inlined host schema (D1).
- **Prompt files** are read through an injected `readPrompt` seam (the `@rennet/prompts` package is node-free; the composition root supplies `createNodePromptReader(promptsSrcDir)`), keeping the runtime pure/hermetic in the gate.
- **Flagged dual seat (5.2) — the reconcile bridge.** `reconcileFindings` (`core/finding-reconcile.ts`, J2) operates on the WIRE `FindingElement` shape `{findingId, anchor, summary, severity, agreement}`, but a board `finding` element carries `{severity, concern, code[], concurrence[], status}` with no anchor string — its location lives in the cited `code_ref`. So the runtime PROJECTS each board finding to a `FindingElement` with a **synthesized `rennet:file/<path>#L<start>-L<end>` anchor** from its first `code_ref` (an uncited finding gets a per-id `rennet:doc/<id>` anchor that never matches — an uncited finding cannot be located to concur), runs `reconcileFindings`, then **folds the reconciled `agreement` back into the board-native `finding.data.concurrence`** (`{model, agree, total}` per seat: concur ⇒ both models `agree:1`; a solo ⇒ the raiser `agree:1`, the other `agree:0`). This is the honest board-native home for cross-model concurrence; the wire `FindingElement.agreement` is the flagged-canvas path (#41), not the board's. The two flagged seats are forced per-provider (availability `{installed:["claude-code"]}` / `{installed:["codex"]}`) so each resolves its own table pick and runs on its own harness; single-seat degrade stamps single-model concurrence.

- **Composition authoring (5.4, C2) — no dedicated council job exists.** The authored connective prose runs on the versioned `REVIEW_DRAFT_VOICE_FILE` (reconciliation 5), which reconciliation 5 already establishes IS "the post-process steps in the reviewer's first-person register" — so the authoring turn IS the post-process for the review draft (no separate editor turn). The council catalogue carries no `composition`/`review-draft` job id, so `composeReviewDraft` is pure over an INJECTED `composeTurn` free-text seam (the orchestrator's own heavy turn, wired by the composition root exactly like the harness ports) rather than a new council row — B08 adds no council job (cluster 1 owned the rows). The mechanical carry (`carriedElementIds`, cluster 4) is computed here; delta stamps already live on each board's sections from 5.1. The prose is screened by `lintReviewDraft` (L3/L4/L7 register) — visible, never blocking. Curation feedback threads in through `curationFeedback` (inlined into the authoring prompt); the lens boards remain the reading surface — no sixth composed board (C3).
- **Writer-invariant (5.5).** `whiteboard-client.test.ts`'s `.apply(` scan is REUSED and STRENGTHENED: `packages/server/src/runtime/lens-pipeline.ts` is added as a `sanctionedCaller` (it routes through the INJECTED `WhiteboardClient` — the exact "B8 drafters route through WhiteboardClient.apply" case the client's docstring names), and the scan now additionally FAILS if any sanctioned caller imports `BoardService` — so an allowlisted caller can never quietly become a second direct writer.

## Concurrency measurement (engine asset risk 3 — packet-required, cluster 6)

**Method.** A warm harness session in Rennet includes a spawned `claude` node process:
the SDK's `query()` launches the user's own `claude` via
`pathToClaudeCodeExecutable` in stream-json in/out mode and keeps it resident
(`packages/adapters/src/claude-query.ts`). The original measurement sampled that
direct process only: spawn *N* real `claude` processes with the exact args the SDK warms them under
(`--output-format stream-json --input-format stream-json --verbose`), parked idle
on stdin — no complete message is ever written, so no API call is made and no
tokens are spent — then sample RSS via `ps` 6 s after spawn (fully loaded, at the
idle read state), and kill. Host: 16 GB, node v24.18, `claude` 2.1.246,
`@anthropic-ai/claude-agent-sdk` 0.3.223. (Measurement harness:
`scratchpad/measure.mjs`; outside the gate — the gate makes no live spawn.)

**Direct-process numbers (real, this host; descendants excluded).**

| Concurrent warm sessions | Total RSS | Per session | Range |
| --- | --- | --- | --- |
| 1 | 218 MB | 218 MB | — |
| 10 | 1 885 MB | 189 MB | 146–235 MB |

The sampled direct process costs **~190–220 MB RSS**. Ten direct processes total
approximately **1.9 GB**, but those figures exclude ambient MCP descendants and
therefore do not establish whole-seat headroom.

**Current runtime.** For a landed coding round, `runLensPipeline` awaits one
Council-routed semantic-classification turn as a report sequencing boundary.
The turn receives only the successor patchset id, durable asks, and exact worker
receipt; the host builds and verifies the report without the generic retry
ladder or post-process editor. Only a persisted, verified report opens this
boundary. A failed or unavailable required report returns its exact retryable
failure before any lens starts. The pipeline then starts the five independent
lens lanes concurrently. Flagged
owns two seats, so the peak is **6 concurrent warm sessions**: four single-seat
lanes plus the two Flagged seats. The report never overlaps them. Each lane gets
its initial draft plus at most one sequential repair turn (`RETRY_CAP = 1` in
`core/board/validate.ts`); validation adds no concurrent seat.
On a clean generation this is exactly six lens provider calls: one each for
Design, Sequence, Decisions, and Noise, plus two parallel Flagged calls. Missing
reachable core material settles as typed absence or a precise failure from that
first validated result; it does not restart a full semantic draft. Design can
add a separate grounded coverage turn only when coverage inputs and a mapper exist.

The generic report-board drafter remains only for compatibility with injected
callers that provide the older round context without an exact worker receipt. A
live durable coding round always has that receipt and takes the classifier path.

The descendant-inclusive proofs below predate this classifier replacement; they
prove the isolated six-seat lens fan-out and semantic board oracle, not the new
single-turn report latency.

**Restart and retry.** A partial retry reconstructs the exact reserved report
from its board metadata and element log, then repeats the changed-line evidence
verification. A passing report is reused without a second classifier turn. Every
other partial reserved board is replaced as one attempt. Recovery removes its
metadata before clearing its board state, so a crash leaves the cleanup safe to
repeat and cannot promote elements that are about to be replaced. A malformed or
semantically invalid report follows the same metadata-first scrub before one
fresh classification attempt.

**Descendant-inclusive server proof (2026-09-01).** A guard wrapper sampled the
complete command descendant tree once per second while running the authenticated
`NX_DAEMON=false pnpm nx run rennet-server:real-rounds` target. It tracked exact
PID plus process-start identities, aggregate RSS, process and provider counts,
memory pressure, swap, page-outs, and survivors. The first run inherited ambient
harness configuration and was intentionally interrupted when pressure rose. The
same proof then ran to completion after every board-pipeline Council job received
job-scoped isolation: Claude sessions set `ambientConfig: "isolated"` and Codex
turns pass `mcpServers: {}`.

| Run | Result | Peak descendant RSS | Peak processes | Peak MCP-classified | Pressure | Swap growth | Page-outs | Survivors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ambient inheritance | interrupted at 216 s, exit 130 | 8,816,208 KiB (8.6 GiB) | 119 | 72 | 2 | 4,893,890 KiB | 1,420 | 4 at wrapper exit |
| Job-scoped isolation, count-only oracle | passed in 459 s, exit 0 | 2,467,136 KiB (2,409.3 MiB) | 19 | 9 | 1 | 0 KiB | 887 | 0 |
| Job-scoped isolation, server semantic oracle | 7/7 tests passed in 417,424 ms, target and observer exit 0 | 2,718,752 KiB (2,655.0 MiB) | 29 | 11 | 2 | 290,058 KiB | 1,014 | 0 |

The count-only passing run's minimum system-free reading was 43%. Every provider
call recorded exactly one start and one terminal result, and the exact identity
cleanup found no descendants after exit. This is capacity evidence only. Its
count-only oracle called every non-empty element pool populated, but Flagged's
single element was clean-result prose with no reachable finding. That exposed
the semantic-empty defect; this run is not owner-journey board proof.

The strengthened authenticated run replaced the count check with the topology
that `board.read` and the client serve. Sequence had 4 elements with a reachable
`order_step`. Decisions returned the exact typed absence `no-decisions`; Flagged
returned `no-findings`. As diagnostic-only counts, the report had 2 elements,
Design had 1, and Noise had 2. The provider audit accounted for 46 Claude and 29
Codex call IDs. The audit recorded exactly one start and one terminal result for
each call ID. The single coverage violation was the deliberately unteachable
`smoke-uncovered` hunk. The test requires that violation and proves the same
boards report no coverage violations over an empty hunk set. The resource
observer ran for 437 seconds. Its minimum system-free reading was 30%, and it
found no surviving descendant identity.
This proves the server-side semantic pipeline run. It does not prove the
launched desktop owner journey.

**Launched-desktop owner-journey proof (2026-09-01).** The guarded
`rennet-desktop:e2e --args=board-drafting-live` run passed 2/2 Playwright tests.
The named live test took 15.4 minutes, the Nx target took 15 minutes 31 seconds,
and both the child command and observer exited 0. The initial generation exposed
a reachable Sequence `order_step`, with the exact typed absences `no-decisions`
and `no-findings` for Decisions and Flagged. After the intentional restart, the
replacement renderer stayed alive while the client reconstructed the boards,
ran a real coding round, rendered `/run`, followed the durable Return
auto-navigation, exposed `View the New Boards`, and verified the successor
ledger, diff, patchset, generation, and strict semantic oracle. The only logged
replacement-page close occurred during normal cleanup after both tests passed.

The resource observer ran for 933 seconds. Descendant RSS peaked at 2,693.0 MiB
across 30 processes, with peaks of 3 Claude, 6 Codex, and 11 MCP-classified
processes. System-free memory reached a minimum of 35% at pressure level 2;
swap did not grow, page-outs grew by 1,883, and no descendant identity survived.

**Capacity verdict — keep the six-seat fan-out.** The first isolated passing run
peaked at 2.41 GiB with no swap growth and no elevated pressure on this host.
The semantic run peaked at 2.59 GiB and completed with pressure level 2 and
290,058 KiB of swap growth. The current four single-seat lanes plus Flagged's
dual seat completed under both isolated proofs; neither run supports a wider
fan-out. Each lane gets at most one sequential repair turn after its initial
draft. Returned outcomes and post-coverage arrivals remain in canonical lens
order even when drafting and persistence complete in another order.
`project-scout` and unrelated Council jobs retain inherited harness
configuration.

## Verification (packet)

`pnpm check` green. E2E: a full pipeline run against a real Rennet PR produces five frozen lens boards in the event log, with every patchset hunk either covered by some lens or listed in a `skippedHunks` set; a deliberately-invalid drafter return exercises the retry ladder and lands as a labeled blemish, not a block. Positive controls that can fail: a hunk covered by no lens → the composition every-hunk assert fails; a draft carrying code bytes → the R17 parse/lint gate rejects it; an un-resolvable citation → the citation-resolves lint rule fires.

## Review-fix amendments (sub-wave 2 dual review — Codex 3 critical + 5 high, opus 2 P2, all upheld)

Recorded as scope rulings and resolutions made while fixing the upheld findings; the packet (`context.md`) stays authority. Codex proved findings 2/4/5/6/7 with direct probes against the real `BoardService`/`validateDraft`/`checkImmutability`/`reconcileFlaggedBoards`; each fix turns its probe into a real test.

- **A1 — pipeline wiring is the rounds machinery's, not B08's (finding 1, DOCS-ONLY ruling).** `runLensPipeline` has no non-test caller. The packet Objective builds the pipeline in `server/runtime/`; the packet **Out of scope** and this proposal's out-of-scope both assign *"the rounds machinery that consumes the round-report seat and drives the R58 reveal"* to **B09** — and the pipeline is invoked as part of a review generation / round, so its consuming turn is B09's. The sibling schedulers `knowledge-swarm` (B06) and `project-scout` (B07) are wired into `create-server.ts` because their consuming turns are in-scope for B06/B07; the lens pipeline's is not. This is the exact B10 precedent (A6: `buildAppTools` a tested pure projection, exported-but-unwired, live-turn E2E deferred to B9/B11). Resolution: **no composition root built on B08's authority**; `docs/developing/concepts/lens-pipeline.md` reframed to planned framing (built + test-exercised against a real board service; the consuming turn wired by B09). The "live scheduler" reading is removed.
- **A2 — writes are ordered and inspected; arrival follows acceptance (finding 2).** `draftToOps` preserved the drafter's authoring order, so a finding authored before its `code_ref` produced a `create` batch the board service rejects as `bad-ref` — while `runLensBoard`/`runRoundReport` ignored `response.ok` and announced arrival anyway. Now: `draftToOps` TOPOLOGICALLY orders ops (a referenced element created before its citer, cycle-safe fallback to source order); a shared `persistBoard` inspects `response.ok` and returns a lens FAILURE (carrying the validation metadata) on rejection, never announcing it; and the always-success test fake is joined by a REAL `WhiteboardClient` over `createBoardsRuntime` proving the raw finding-before-code_ref order is rejected while the `draftToOps` order is accepted, with the board reconstructed from the actual event log.
- **A3 — coverage/omission metadata is durable; gate 3 precedes arrival (finding 3).** `draftToOps` serializes only a board's ELEMENTS; its `skippedHunks` (coverage) and the validation blemishes are board-level and the frozen 13-kind vocabulary has no element to carry them, so they lived only in memory — and cross-lens coverage ran AFTER boards were persisted and announced. Now: each board's coverage/validation metadata is durably stored through an injected `persistBoardMeta` seam (the composition root supplies the store; B09's consuming turn wires it, per A1) BEFORE any arrival; cross-lens `assertCoverage` runs over the frozen set BEFORE the lens arrivals fire (the round-report keeps its inline greeting, R58). The E2E reconstructs the flagged board's elements from the real event log AND its `skippedHunks` from the persisted metadata, proving both survive.
- **A5 — honest omission resolves the incoming-reference closure (finding 5).** When validation omitted a `code_ref`, a surviving (frozen) finding could keep citing it — Codex's probe left `f1.code=["c1"]` after omitting `c1`, and the frozen-suppression filter hid the survivor's dangling-citation violation. The omission block now, after the one repair turn: (a) runs a BACKWARD closure to a fixpoint — a survivor's ARRAY refs to a dropped id are patched out (`finding.code`, `section.children`) and the element thawed to re-lint; a survivor whose SCALAR ref (`noise_verdict.hunk`) points at a dropped id cannot be patched and cascade-omits; (b) computes forward-shed from the PATCHED survivors, so a `code_ref` a survivor stopped citing is orphaned and its hunks shed; (c) validates the final board against the real wire boundary (`parseDraft`), surfacing any residual structural issue as a labeled blemish. No board ever ships a dangling reference. Test added: a frozen finding citing an omitted overrunning code_ref ends patched (`code: []`), the hunk shed, the omission recorded, the board re-parsing clean.
- **A6 — failure paths never fabricate empty success (finding 6, validate.ts half).** Exhausting the repair turn while stuck on PARSE failures once produced `blemishes: []` and a schema-valid empty board. Now: exhaustion labels unresolved parse issues as `schema-invalid` blemishes (never an empty `blemishes[]`), and `validateDraft` returns `everParsed` — `false` when both the initial draft and its one repair fail to parse and the board is the synthetic empty fallback, so the caller surfaces a lens FAILURE rather than an empty-but-successful board. The lens-pipeline half landed with findings 2+3: `draftOneLens` now returns a `failure` (never an empty-success board) when the INITIAL turn does not emit, when the loop never parses (`everParsed:false`), or when a seat call THROWS — the whole draft is wrapped in try/catch and a thrown RETRY degrades to keeping the current draft (the resolution-failure path), so a live-harness crash on the first turn or a retry becomes a recorded lens failure rather than aborting the generation (opus F1). `runLensBoard`/`runRoundReport`/`runFlaggedDual` propagate that failure. Tests (validate.ts): one unparseable repair → `everParsed:false`, `attempts:1`, labeled blemishes, empty board; a genuinely empty PARSED board → `everParsed:true`. Tests (pipeline): a never-parseable drafter and a throwing port each yield lens failures with no board and no write.
- **A4 — immutability gate is bidirectional (finding 4).** `checkImmutability` compared only the pre-existing typed kinds `{finding, decision, requirement, noise_verdict, order_step, round_outcome}` in the before→after direction, so a post-process edit to a `code_ref` and an invented `skippedHunks` set both passed with zero violations (Codex's probe). Rewritten: the board is compared BIDIRECTIONALLY — every kind outside a small narrative allowlist (`prose`/`callout`/`annotation`, the editor's connective furniture) is typed lens output that must survive byte-identical, its kind unchanged, and may neither vanish nor appear; the board's SET of skipped-hunk ids is immutable (a skip's reason prose is still the editor's to polish, matching the existing "only touches prose" contract). Catches the probe's code_ref edit, its invented skip, and a forged typed element. Tests added for all three; the existing drop test keeps its skip set so it isolates the drop.
- **A7 — flagged dual seats get disjoint id namespaces (finding 7).** `reconcileFlaggedBoards` keyed by raw model-authored ids and let seat A win a collision, so seat B's finding could resolve its `code:["c1"]` against seat A's `c1` (Codex's probe) and a seat-B solo finding sharing a seat-A finding id was silently dropped in the union. A new pure `namespaceBoard(board, "b:")` prefixes every element id in seat B and rewrites every intra-board reference to it (hunk ids in `skippedHunks` are patchset ids, left alone); reconciliation runs on the namespaced board — matching is by synthesized location anchor, not id, so it is undisturbed. The merged board is then wire-validated (`parseDraft`) and any structural residue folded into blemishes. Test: two seats that both minted `c1` for different files — seat B's finding cites its own (namespaced) code_ref, seat A's `c1` survives untouched. Two existing tests updated to the namespaced reality (seat B's solo id is `b:f2`; the matched pair is looked up by kind).
- **A8 — coverage is side-aware; deletion geometry restored (finding 8).** `LintHunk` gained the old-image span (`oldStart`/`oldLines`) and the base-side path (`previousPath`); a new shared `codeRefTeaches(ref, hunk)` / `taughtHunkIds(elements, hunks)` in `lint.ts` selects the span+path by the code_ref's `side`, and the three duplicated overlap loops (`lint.ts` `noTaughtAndSkipped`, `compose.ts` `boardTaughtHunks`, `validate.ts` `hunksTaughtBy`) now route through it. A base-side citation can no longer falsely cover an addition (`oldLines === 0` teaches nothing on the base side); a deletion-only hunk (`newLines === 0`) is teachable only from the base side; a rename resolves each side against its own path. Old-image fields are optional so a hunk built new-image-only degrades to head-side-only (never a false base-side pass). Tests added: base-side-no-false-cover, deletion-only-base-side-only, rename-per-path.
