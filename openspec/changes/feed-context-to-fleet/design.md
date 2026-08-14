# Design — feed-context-to-fleet

## Context

What #312 (`wire-context-knowledge-layer`) left behind, verified against the code on this branch:

- **The assembly** — `assembleContext` (`packages/core/src/context-assembly.ts`): pure, deterministic, byte-budgeted over an ordered document list; returns `{ text, digest, documents, totalBytes }`. Gathered by `assembleContextForComposition` (`packages/adapters/src/context-manifest.ts`): CLAUDE.md, AGENTS.md, then a deterministic project-map projection, 32 KiB default budget.
- **The one producer** — `buildReviewContextManifest` → `captureReviewContextManifest` (`packages/adapters/src/live-review-backend.ts` lines ~116–167): builds `{ manifest, assembly }`, persists ONLY the manifest JSON (`ContextManifestStore`, `context-manifests/<baseOid>.json`), returns only the manifest. **The `assembly.text` is dropped on the floor here.** No other caller receives it.
- **The consumers that never see it** — every fleet turn:
  - Pipeline seats (`packages/core/src/pipeline.ts` `buildReviewCanvases`): hypothesis, decomposition, ordering, narration. Each runner calls `assemblePrompt({ base, …, payload })`.
  - Desktop-composed seats (`apps/desktop/src/main/index.ts`): finding (dual seats via `resolveDualSeat` + `runDualFindingReview`, ~line 926), noise (~1152), decisions (~825), hypothesis (`computeReviewHypothesis`, ~741).
  - The orchestrator turn (`packages/adapters/src/orchestrator-turn.ts` `runOrchestratorTurn`): sends `systemPrompt: { append: session.primer.text }` — primer only.
- **The unfed slot** — `assemblePrompt` (`packages/instructions/src/index.ts` ~line 602) composes labelled layers in the fixed order `base, hypothesis, conventions, general, angle, task, files, context, payload`. The `context` layer is in the order, typed on `PromptLayers`, and **supplied by no caller anywhere in the repo.** It sits after `task`/`files` and before `payload`, and under a byte budget it drops before the payload does — a sane priority for repo guidance.
- **The manifest's honesty posture** — `nested-project-context.ts` stamps `exhaustive: false` and `unmanagedSources: ["harness ambient file reads (context-isolation probe not yet run)"]`; the panel (`packages/ui/src/components/context-manifest-panel.tsx`) says "Context Rennet assembled".

## Goals / Non-Goals

**Goals**

1. Every fleet turn's real prompt carries the assembly, verbatim, as the labelled `context` layer (seats) or a labelled block in the system-append (orchestrator).
2. The manifest records what was actually sent, per agent, captured at the wire — not inferred from intent.
3. The panel's claim upgrades exactly as far as the evidence: "sent" for the proven sends, "assembled" otherwise; ambient harness reads stay disclosed.
4. Rule Zero throughout: no turn is ever refused for context reasons; budgets meter and report.

**Non-Goals**

- Per-seat tailored assemblies (one shared assembly this change; tailoring is a follow-up and the send records are already per-agent to support it).
- Removing the harness's ambient reads or the §7.2 live-checkout cwd deviation. Unchanged, still disclosed.
- `exhaustive: true` (requires the isolation probe; out of scope).
- Widening the gathered document set.

## Decisions

### D1 — Injection seam: the existing `context` layer of `assemblePrompt`

Each seat runner input gains an optional `assembledContext?: string`. At the runner's existing `assemblePrompt` call site it maps to `{ context: assembledContext }`:

- `angle-generation.ts` `runDecompositionAngle` (call at ~line 310)
- `ordering-pass.ts` `runOrderingPass` (~325)
- `finding-generation.ts` `runFindingGeneration` (~427) — threaded to BOTH dual seats through `dual-finding-review.ts` (which already threads `guidance` the same way, line ~98)
- `noise-generation.ts`, `decision-generation.ts`, `hypothesis-generation.ts` (~345), `rollup-narration.ts` — same shape.

`buildReviewCanvases` (`pipeline.ts`) gains `assembledContext?: string` on `ReviewPipelineInput` and threads it to its four seats. Desktop main threads it into the pipeline input plus the finding/noise/decisions/hypothesis call sites.

*Why here and not the adapter?* The layer framing (`<<<rennet:layer context>>>`) keeps the assembled text attributable inside the prompt, participates in the existing layer byte-budget drop order (visible, recorded — never a silent cut), and keeps `core` node-free: the runner receives a string, not a file path. *Alternative considered:* injecting at `createHarnessRunTurn` by prepending to every prompt — rejected: it would bypass the labelled layer discipline, double-inject on retries built from reports, and be invisible to the runners' golden prompt tests.

*Absent-context invariant:* `assembledContext === undefined` ⇒ the layer is simply not part of the assembly and the prompt is **byte-identical to today** (the same invariant hypothesis/conventions layers already keep). This is the no-gate guarantee: a failed capture degrades the feed, never the turn.

### D2 — The text comes from the capture, digest-verified — never a re-read

`ContextManifestStore` gains the assembly text as a sibling artifact: `context-manifests/<baseOid>.context.txt`, written atomically in the same capture that writes the JSON. A new adapters function `ensureReviewContextAssembly(deps): Promise<{ manifest, text } | undefined>` is the ONE send-path source:

1. Load persisted manifest + text; if `sha256(text) === manifest.assembledPromptDigest`, serve them.
2. On absence/mismatch (e.g. a pre-this-change manifest with no text file), rebuild via the existing `buildReviewContextManifest` and re-persist BOTH. The rebuild is the same deterministic assembly; if guidance changed on disk the new capture honestly supersedes (and the manifest describes what will now be sent — the manifest must never describe bytes the fleet doesn't get).
3. `undefined` stays an honest absence (no snapshot/composition): the fleet runs unfed, exactly as today.

`captureReviewContextManifest` keeps its capture-once contract but is extended to write the text; both the panel path and the send path read through the same store, so they cannot diverge.

### D3 — Send-time capture at the wire, parsed from the sent bytes

A new core wrapper, sibling of `guardSeatTurn` (`harness-run-turn.ts`):

```
recordSeatSend(runTurn, meta: { seat: string; harness: string }, sink: (r: ContextSendRecord) => void)
```

Wraps the exact `runTurn(prompt, attempt)` every seat's turn passes through — Claude (`createHarnessRunTurn`), Codex (`createCodexRunTurn`), and mocks alike. On each call, BEFORE delegating, it stamps:

- `promptBytes` / `promptDigest`: UTF-8 length and sha256 of the exact prompt string handed over.
- `contextIncluded` / `contextDigest`: determined by extracting the `<<<rennet:layer context>>>` block from the SENT text (Rennet's own deterministic framing — exact delimiter parsing, not a heuristic) and hashing the block body. So a layer dropped by the prompt byte-budget is honestly `contextIncluded: false`, whatever the caller intended.

Composition order: `guardSeatTurn(recordSeatSend(runTurn, …))` — the send is recorded even when the turn later throws (the hand-off happened; the transcript says so).

*Why parse-back instead of having the runner report inclusion?* The manifest's claim is "what was sent," and the only artifact that proves it is the sent bytes at the seam the adapter actually reads from. Runner-reported intent can drift from the wire; the parse-back cannot.

Orchestrator: `runOrchestratorTurn` deps gain `assembledContext?: string`; when present the append becomes `primer.text + "\n\n" + renderLayer("context", assembledContext)` and a record with `channel: "system-append"` is stamped over the exact append string (same digest + parse-back rules). Seat records use `channel: "prompt"`.

### D4 — The manifest becomes the transcript: additive `sends`

`packages/types`:

```ts
interface ContextSendRecord {
  readonly seat: string;        // "decomposition" | "ordering" | "finding" | "noise" | "decisions" | "hypothesis" | "narration" | "orchestrator"
  readonly harness: string;     // "claude-code" | "codex"
  readonly channel: "prompt" | "system-append";
  readonly attempt: number;
  readonly promptBytes: number;
  readonly promptDigest: string;      // sha256 of the exact sent text
  readonly contextIncluded: boolean;  // the labelled context block was present in the sent bytes
  readonly contextDigest?: string;    // sha256 of that block's body when present
  readonly sentAt: string;            // ISO timestamp — transcript metadata, not identity
}

interface ContextManifest { …existing…; readonly sends?: readonly ContextSendRecord[]; }
```

`assembledPromptDigest` keeps its meaning (digest of the assembly text). **The send proof is the join**: a record with `contextIncluded && contextDigest === assembledPromptDigest` proves that agent was sent the recorded assembly byte-for-byte; a differing `contextDigest` is per-agent variance, recorded rather than papered over. `ContextManifestStore` gains `appendSends(repoKey, baseOid, records)` (atomic read-modify-write; a malformed persisted file still reads as absence, never a throw). Desktop main collects each run's records via the sinks and appends after the run completes.

`packages/protocol`: `contextSendRecordSchema` + `sends: z.array(…).optional()` on `contextManifestSchema`. Without this the strict IPC command output silently strips the field and the renderer never sees the transcript (the exact failure mode the schema comment at line ~484 warns about).

### D5 — The panel's label follows the evidence

`context-manifest-panel.tsx`: with ≥1 send record proving the assembly was sent, the eyebrow/heading becomes "Context sent to the fleet" and a per-seat send list renders (seat, harness, channel, attempt, bytes, included/dropped, digest match). With no proven send (old manifests, unfed runs) it stays "Context Rennet assembled". The panel keeps rendering `exhaustive: false` and `unmanagedSources` verbatim — the sent claim covers the context block, never the harness's ambient reads (the spawned `claude` still reads CLAUDE.md itself from the live-checkout cwd; that duplication is accepted and disclosed, not eliminated, this change).

### D6 — Determinism and byte-budget contract carried into the send

The assembly's two golden properties survive the feed unchanged: the `context` layer body IS the assembly text (byte-identical — provable by `contextDigest === assembledPromptDigest`), and its internal truncation markers arrived pre-rendered from `assembleContext`'s own budget. The PROMPT-level budget (`assembleOptions.maxBytes`, currently unset by callers) can additionally drop the whole layer — visibly, via `droppedLayers` and the send record's `contextIncluded: false`. Two meters, both reporting, neither refusing.

## Risks / Trade-offs

- [Prompt growth: up to 32 KiB per seat turn] → the assembly budget already meters it; seats that need a ceiling set `assembleOptions.maxBytes` and the drop is recorded. No new knob invented.
- [Duplication: the harness ambiently reads CLAUDE.md that the context layer also carries] → accepted and disclosed via `unmanagedSources`; dedup belongs to the tailoring follow-up, not here. The assembly is still the only DETERMINISTIC, RECORDED copy.
- [Golden prompt tests churn] → every runner's absent-context case must assert byte-identity with today's output; present-context cases get new goldens. Red-proof-first in tasks.
- [Send records accumulate across re-runs of one review] → they are a transcript; the panel groups by seat and shows the latest per seat with a count. Not identity data, so growth is honest history; the store file stays small (records are ~200 bytes).
- [Concurrent appendSends from parallel seat runs] → desktop main aggregates in-memory per run and appends once per run completion, from the one main process; last-writer-wins on interleaved runs is acceptable for a transcript and noted in the store docs.

## Migration Plan

Purely additive. Old persisted manifests lack `sends` and the text file → the panel shows "assembled" (unchanged behaviour) and the first post-upgrade run re-captures text + starts recording sends. No schema version bump needed (`isContextManifest` guard checks are unchanged; `sends` is optional). Rollback: drop the new fields — old readers ignore them.

## Open Questions

- Should the orchestrator's `question` (user prompt) digest also be recorded alongside the system-append record? Leaning no — the transcript is about Rennet-composed context, not the user's words; deferrable without schema change (additive later).
- Whether `context.ask`'s answering turns (contextAskBackend) should also record sends this change or in the tailoring follow-up. Proposed: follow-up — they consume `context.file` reads, not the shared assembly.
