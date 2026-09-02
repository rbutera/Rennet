---
title: Token efficiency plan (#737)
description: Implementation plan for the 2026-09-01 harness/prompt audit findings — spend observability, schema double-send, prompt hygiene, byte caps, the prompt-size tripwire, and pointer-only repair turns.
status: in-progress
tracking: https://github.com/rbutera/Rennet/issues/737
---

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every token a review generation spends visible to the reviewer, and stop the four structural over-sends the 2026-09-01 audit found.

**Architecture:** Three pull requests, landed in order so each builds on `main`. PR 1 is the prompt diet (issue items 2, 4, 5, 6): mechanical, no new behaviour except smaller sessions and a regression tripwire. PR 2 is the usage sink (item 1): one optional collector threaded through the single seat-resolution function, one durable `usage` record on the generation, one line on the round. PR 3 is the repair-turn diet (item 3): a pointer-plus-failing-elements patch prompt, because the resume design the issue proposed cannot work on ephemeral sessions.

**Tech Stack:** TypeScript, Zod v4, Vitest, Nx. Prompts in `@rennet/prompts`, validator in `@rennet/core`, pipeline in `@rennet/server`, wire in `@rennet/protocol`, UI in `@rennet/app-ui`.

**Spec:** [issue #737](https://github.com/rbutera/Rennet/issues/737) plus the verification comment of 2026-09-02 on that issue. CLAUDE.md "Harness prompts & token discipline" is the doctrine.

## Global Constraints

- Rule Zero: nothing here adds a gate, a consent step, or a restriction on what a seat may do.
- Seats inherit the user's settings: never touch `settingSources`, `strictMcpConfig`, or session isolation.
- Every internal seat stays `ephemeral: true` (#585). That is why item 3 is a patch prompt, not a resume.
- Every dynamic interpolation declares a byte bound at its call site. Never `JSON.stringify(x, null, 2)` for a model.
- A PR that changes what a session sends says so in its description with a rough size.
- Docs move in the same change. Pages named per task below; `docs/developing/concepts/lens-pipeline.md` is the prompt-composition home, `docs/developing/concepts/harness-adapters.md` the harness/token home.
- Gate before every push: `pnpm check`. A green test needs a positive control.
- No AI attribution or co-author trailers.

## Verified facts the plan relies on

- `JSON.stringify(boardOutputSchema())` is 9,815 bytes and rides twice per drafting turn (prompt `hostSchema` and SDK `outputFormat`), again on every repair.
- `persistSession: false` (what `ephemeral: true` maps to) sessions "cannot be resumed later" (SDK 0.3.223 `sdk.d.ts:1580`). The adapter session is single-turn by design (`claude-adapter.ts:671`).
- `validateDraft` already treats a retry return as a patch: `mergePatch` keeps frozen elements verbatim and takes the patch's version of the rest (`validate.ts`, `mergePatch`).
- `assemblePrompt`'s `maxBytes` has no caller in the repo. Its drop order removes `payload` first, which for the noise seat removes the only thing it classifies, so arming it there is wrong; the payload itself gets the bound.
- The round-report classifier is already bounded by #727 (`ROUND_EVIDENCE_MANIFEST_MAX_BYTES`). Only the dead `includeWorkerDiff` flag and a stale comment remain.
- Every board, report, and repair provider turn funnels through `resolveBoardSeatDetails` (`lens-pipeline.ts`), and `councilSeatTurn` already accepts `collector?: MetricsCollector`.
- `GenerationCoverage` rides on the `lens` round event and on the durable `Generation` record; `usage` follows the same fold.

---

## PR 1 — prompt diet (items 2, 4, 5, 6)

Branch: `737-prompt-diet`. Sends less per session: about 9.8 KB less per drafting turn (item 2), a compact and bounded noise payload (item 4), and no change to lens prompt bytes (item 5 moves 738 B × 5 into one shared partial that is spliced back at read time).

### Task 1: Stop inlining the board schema

**Files:**
- Modify: `packages/server/src/runtime/lens-pipeline.ts` (`boardOutputSchema` doc comment, `renderDrafterPrompt`, its callers, `runLegacyRoundReport`)
- Modify: `packages/server/src/runtime/lens-pipeline.test.ts` (~4039, ~6455-6510)
- Modify: `packages/prompts/src/prompts/report.md` (delete "Legacy compatibility" section)
- Modify: `docs/developing/concepts/lens-pipeline.md` (:38-40, :73, :87-89), `docs/developing/reference/whiteboard-consumption.md` (:60-79)

**Interfaces:**
- Produces: `renderDrafterPrompt(promptText, packet, reportBoard?, designArtifacts?, round?, options?)` with the `hostSchema` parameter and the `includeWorkerDiff` option removed.

- [ ] **Step 1: Flip the pinned test.** In `lens-pipeline.test.ts` change `expect(designTurn).toContain("hostSchema")` to `expect(designTurn).not.toContain("hostSchema")` with a comment that the schema travels once as SDK `outputFormat`. Remove the `includeWorkerDiff: true` case (~6501) or turn it into an assertion that a worker's `diff` never appears in any drafter prompt.
- [ ] **Step 2: Run the file, expect the flipped assertion to fail.** `pnpm exec vitest run packages/server/src/runtime/lens-pipeline.test.ts -t "hostSchema"`.
- [ ] **Step 3: Remove the parameter.** Delete `hostSchema: unknown = boardOutputSchema()` and the `hostSchema,` key in the context object. Delete the `includeWorkerDiff` option, the "UNCAPPED" comment, and the ternary; always send `{ outcome, changedPaths, commitRange }`. Update the three callers (lens drafting ~3564, legacy report ~2485, and any test helper) to drop the positional schema argument. Rewrite the `boardOutputSchema` comment: "Passed to the harness session as the output schema (the SDK `outputFormat`), never inlined into the prompt: the schema travels once."
- [ ] **Step 4: Delete `report.md` "Legacy compatibility"** (the paragraph naming `hostSchema` and `worker.diff`).
- [ ] **Step 5: Run the suite.** `pnpm nx test rennet-server` and `pnpm nx test rennet-prompts`. Expected: green.
- [ ] **Step 6: Docs.** `lens-pipeline.md` :87-89 becomes "receives the delta context and its lens prompt; the board schema is bound once, as the harness session's structured-output format, and is never inlined into the prompt." Adjust :38-40 and :73 to match. `whiteboard-consumption.md` :60-79: add one sentence that the host schema is declared at board creation and bound as the seat's output format, not sent as prompt text.
- [ ] **Step 7: Commit.** `git commit -m "feat(lens): send the board schema once, as the SDK output format"`.

### Task 2: Bound and compact the noise payload

**Files:**
- Modify: `packages/core/src/noise-generation.ts` (`renderPayload`)
- Modify: `packages/core/src/noise-generation.test.ts`
- Modify: `packages/prompts/src/prompt-contracts.ts` (`renderCiClassificationPrompt`, drop `null, 2`)
- Modify: `docs/developing/concepts/context-assembly.md` (:68-75), `docs/developing/concepts/lens-pipeline.md` (byte-budget prose near :499-505)

**Interfaces:**
- Produces: `export const NOISE_PAYLOAD_MAX_BYTES = 262_144` and `renderPayload(manifest, patchsetId, maxBytes = NOISE_PAYLOAD_MAX_BYTES)` returning compact JSON `{ patchsetId, hunks, truncated? }` where `truncated = { omittedHunkIds: string[], readWith: "git diff" }`.

- [ ] **Step 1: Write the failing tests.** In `noise-generation.test.ts`:

```ts
describe("renderPayload byte bound", () => {
  it("is compact JSON (no pretty-print) and unchanged below the bound", () => {
    const text = renderPayload(smallManifest, "ps-1");
    expect(text).not.toContain("\n  ");
    expect(JSON.parse(text)).not.toHaveProperty("truncated");
  });
  it("keeps whole hunks in order up to the bound and names every omitted id", () => {
    const text = renderPayload(bigManifest, "ps-1", 2_000);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(2_000 + 400); // marker allowance
    const parsed = JSON.parse(text);
    const kept = parsed.hunks.map((h: { id: string }) => h.id);
    const all = bigManifest.occurrences.filter((o) => o.kind === "hunk").map((o) => o.id);
    expect(all.slice(0, kept.length)).toEqual(kept);
    expect(parsed.truncated.omittedHunkIds).toEqual(all.slice(kept.length));
    expect(parsed.truncated.omittedHunkIds.length).toBeGreaterThan(0); // positive control
  });
});
```

- [ ] **Step 2: Run, expect failure** (`renderPayload` is not exported; pretty-printed).
- [ ] **Step 3: Implement.** Export `renderPayload`; build hunks one at a time, measuring `utf8` bytes of the compact serialisation as you go; stop adding once the next hunk would cross `maxBytes`; put remaining ids in `truncated.omittedHunkIds`; `readWith` says "run `git diff` in your working directory for the omitted hunks". `JSON.stringify` with no indent. Same for `renderCiClassificationPrompt`.
- [ ] **Step 4: Run tests, expect green.** `pnpm nx test rennet-core` and `pnpm nx test rennet-prompts`.
- [ ] **Step 5: Docs.** `context-assembly.md` :68-75 add: the noise seat's payload is the offered hunks in compact JSON under a 256 KiB bound; omitted hunk ids are listed so the seat reads them from the checkout. `lens-pipeline.md` byte-budget prose: mention the noise payload bound beside the manifest bound.
- [ ] **Step 6: Commit.** `git commit -m "feat(noise): compact, byte-bounded hunk payload with honest omission list"`.

### Task 3: Prompt hygiene

**Files:**
- Delete: `packages/prompts/src/prompts/post-process.md`
- Create: `packages/prompts/src/prompts/investigate-before-you-draft.md` (the 738-byte section, verbatim)
- Modify: `packages/prompts/src/index.ts` (remove `POST_PROCESS_FILE`; add `INVESTIGATE_PARTIAL_FILE`, `PROMPT_PARTIAL_MARKER`, `expandPromptPartials`)
- Modify: `packages/prompts/src/index.test.ts`
- Modify: `packages/prompts/src/prompts/{noise,flagged,design,sequence,decisions}.md` (section → marker line)
- Modify: `packages/prompts/src/prompts/review-draft-voice.md` (:8-9)
- Modify: `packages/prompts/src/prompt-contracts.ts` (delete `DECOMPOSITION_SKELETON_CONTRACT`, `DECOMPOSITION_PROPOSAL_CONTRACT`)
- Modify: `packages/protocol/src/manifests/index.ts` (`PROMPT_IDS` drop `"post-process"`)
- Modify: `packages/core/src/handoff-loop.ts` (:203-204), `packages/core/src/handoff-compose.ts` (:220-221)
- Modify: `packages/server/src/owner-loop-proof-fixture.ts` (:272-282), `packages/server/src/lens-settlement-proof-fixture.ts` (:210-220)
- Modify: `packages/server/src/runtime/lens-pipeline.ts` (lens prompt read ~3556)
- Remove: `packages/instructions/` (untracked, only `node_modules/`)
- Modify: docs `lens-pipeline.md` (:36-40, :511-513, :666-669), `model-council.md` (:28-33, :158), `reference/codex-app-server.md` (:131-134), `surfacing-and-routing.md` (:75-78, :116-118 only if `BODY_SCHEMAS` loses decomposition)

**Interfaces:**
- Produces:

```ts
export const INVESTIGATE_PARTIAL_FILE = "prompts/investigate-before-you-draft.md";
export const PROMPT_PARTIAL_MARKER = "{{investigate-before-you-draft}}";
/** Splice the shared partial into a lens prompt at its marker line. Throws if the marker is missing. */
export function expandPromptPartials(text: string, partial: string): string;
```

- [ ] **Step 1: Tests first.** In `index.test.ts`: delete the post-process test; change the voice test to `not.toContain("post-process.md")`; add:

```ts
it("every lens prompt carries the investigate marker exactly once and not the section body", () => {
  for (const kind of LENS_KINDS) {
    const text = readFileSync(join(srcDir, LENS_PROMPT_FILES[kind]), "utf8");
    expect(text.split(PROMPT_PARTIAL_MARKER)).toHaveLength(2);
    expect(text).not.toContain("## Investigate before you draft");
  }
});
it("expandPromptPartials splices the partial and refuses a prompt without the marker", () => {
  const partial = readFileSync(join(srcDir, INVESTIGATE_PARTIAL_FILE), "utf8");
  expect(partial).toContain("## Investigate before you draft");
  const out = expandPromptPartials(`# T\n\n${PROMPT_PARTIAL_MARKER}\n\n## Next`, partial);
  expect(out).toContain("## Investigate before you draft");
  expect(out).not.toContain(PROMPT_PARTIAL_MARKER);
  expect(() => expandPromptPartials("# T\n\n## Next", partial)).toThrow(); // positive control
});
```

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Move the section.** Cut lines from `## Investigate before you draft` up to (not including) the next `## ` heading from each of the five files into the new partial file; leave `{{investigate-before-you-draft}}` on one line in its place. Implement `expandPromptPartials` (`text.replace(marker, partial.trimEnd())`, throwing when `!text.includes(marker)`). In `lens-pipeline.ts` lens drafting: `const promptText = expandPromptPartials(await deps.readPrompt(LENS_PROMPT_FILES[lens]), await deps.readPrompt(INVESTIGATE_PARTIAL_FILE));`. Check the two bundlers' prompt-copy globs (`apps/desktop/vite.server.config.ts`, `build-server-cli.mjs`) include the flat new file; they copy `prompts/*.md`, so a flat file rides.
- [ ] **Step 4: Delete `post-process.md`**, its export, its `PROMPT_IDS` entry (grep `PromptId` consumers first; `board-post-process` is a council job id, not a prompt id, leave it). Rewrite `review-draft-voice.md:8-9` to "Write in the reviewer's register from the first draft, with these rules:" (the file's own bullet list already carries the rules).
- [ ] **Step 5: Dedupe the handoff rule.** In `handoff-compose.ts` export `HANDOFF_NO_GIT_RULE` (the two lines verbatim); import it in `handoff-loop.ts`.
- [ ] **Step 6: Delete the two decomposition contracts** and any now-unused imports. Run `pnpm nx typecheck rennet-prompts`.
- [ ] **Step 7: Prune the two proof fixtures** of the two dead swarm steps each (keep the scout step). Run `pnpm nx test rennet-server -- owner-loop lens-settlement`.
- [ ] **Step 8: `rm -rf packages/instructions`.**
- [ ] **Step 9: Run** `pnpm nx run-many -t test -p rennet-prompts,rennet-core,rennet-server,rennet-protocol`. Expected: green.
- [ ] **Step 10: Docs.** `lens-pipeline.md:36-40`: name the shared partial and marker. Remove the prose post-process editor claims at `lens-pipeline.md:511-513`, `:666-669`, `model-council.md:28-33` and `:158`, `codex-app-server.md:131-134` (keep any sentence about the deterministic `lens-post-process` phase). Add one sentence in `lens-pipeline.md` that the Noise lens prompt and the RSP `NOISE_CONTRACT` are two seats with two output shapes, both live.
- [ ] **Step 11: Commit.** `git commit -m "chore(prompts): delete dead post-process prompt, share the investigate partial, prune dead contracts and fixtures"`.

### Task 4: Prompt-size tripwire

**Files:**
- Create: `packages/server/src/runtime/lens-pipeline.prompt-budget.test.ts`
- Modify: `docs/developing/concepts/lens-pipeline.md` (beside the manifest budget prose ~:363-368)

- [ ] **Step 1: Write the test.**

```ts
import { readFileSync } from "node:fs";
import { buildDeltaPacket, patchsetSchema } from "@rennet/core";
import { INVESTIGATE_PARTIAL_FILE, LENS_KINDS, LENS_PROMPT_FILES, expandPromptPartials } from "@rennet/prompts";
import { describe, expect, it } from "vitest";
import { renderDrafterPrompt } from "./lens-pipeline";

const fixtureUrl = new URL("../../../core/src/delta/real-capture-fixture.json", import.meta.url);
const promptsDir = new URL("../../../prompts/src/", import.meta.url);
const patchset = patchsetSchema.parse(JSON.parse(readFileSync(fixtureUrl, "utf8")));
const packet = buildDeltaPacket(patchset, []);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const read = (file: string) => readFileSync(new URL(file, promptsDir), "utf8");

// Measured 2026-09-02 after PR 1: the fixed cost is the lens prompt plus the task layer;
// the packet scales at roughly 550 bytes per file row and 275 per hunk row.
const FIXED_BUDGET = 12_000;
const PER_FILE = 550;
const PER_HUNK = 275;
const budget = FIXED_BUDGET + PER_FILE * patchset.files.length + PER_HUNK * packet.hunks.hunks.length;

describe("drafter prompt byte budget (tripwire)", () => {
  it.each(LENS_KINDS)("%s drafter prompt stays under the declared budget", (lens) => {
    const text = expandPromptPartials(read(LENS_PROMPT_FILES[lens]), read(INVESTIGATE_PARTIAL_FILE));
    expect(bytes(renderDrafterPrompt(text, packet))).toBeLessThanOrEqual(budget);
  });
  it("reddens when a layer inflates (positive control)", () => {
    const text = expandPromptPartials(read(LENS_PROMPT_FILES.noise), read(INVESTIGATE_PARTIAL_FILE));
    const inflated = `${text}\n${"x".repeat(budget)}`;
    expect(bytes(renderDrafterPrompt(inflated, packet))).toBeGreaterThan(budget);
  });
});
```

- [ ] **Step 2: Run it, read the measured sizes**, and set `FIXED_BUDGET` to the largest lens's fixed cost rounded up 10 percent. Record the measured numbers in the test comment.
- [ ] **Step 3: Confirm the control reddens with the assertion inverted**, restore, commit. `git commit -m "test(lens): prompt-size tripwire against the real capture fixture"`.
- [ ] **Step 4: Docs.** One paragraph in `lens-pipeline.md` beside the manifest budget: the tripwire, its formula, and where to raise it when a prompt grows on purpose.

### Task 5: Gate, PR, issue comment

- [ ] `pnpm check` clean. Fix what it finds.
- [ ] Push `737-prompt-diet`, verify `git rev-parse origin/737-prompt-diet` equals HEAD.
- [ ] `gh pr create` with a body that states what each session now sends less of (schema 9.8 KB per turn; noise payload bounded at 256 KiB and compact; prompt bytes unchanged by the partial). Read the body back.
- [ ] Review: one opus reviewer seat and one Codex review round, fix findings, merge.
- [ ] Comment on #737: PR link, what closed (items 2, 4-noise, 5, 6), and the item 4 classifier note.

---

## PR 2 — usage sink (item 1)

Branch: `737-usage-sink`. Adds nothing to what a session sends.

### Task 6: Thread the collector and record the Codex leg

**Files:**
- Modify: `packages/adapters/src/council-seat-turn.ts` (`createCodexSwarmTurn` accepts `collector`, `label`; records `emitted`/`failed` with usage mapped from `result.tokens`)
- Modify: `packages/adapters/src/turn-metrics.ts` (add `export function summarizeUsage(metrics): GenerationUsage`)
- Modify: `packages/adapters/src/council-seat-turn.test.ts`, `turn-metrics.test.ts`
- Modify: `packages/server/src/runtime/lens-pipeline.ts` (`LensPipelineDeps.collector?`, spread in `resolveBoardSeatDetails`)
- Modify: `packages/server/src/runtime/project-scout.ts`, `packages/adapters/src/live-review-backend.ts` (accept and pass `collector?`)

**Interfaces:**
- Produces, in `@rennet/protocol` (Task 7) and re-used here:

```ts
export interface GenerationUsage {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly totalTokens: number;
  /** Summed provider-reported USD; null unless every turn was metered and reported a figure. */
  readonly reportedUsd: number | null;
}
```

- [ ] **Step 1: Tests.** `turn-metrics.test.ts`: `summarizeUsage` sums four token fields across metrics, counts turns, and returns `reportedUsd: null` when any metric has `apiKeySource` outside `METERED_API_KEY_SOURCES` or `usage.reportedUsd === null` (positive control: two metered metrics with figures produce the sum). `council-seat-turn.test.ts`: the Codex leg records one metric per turn with `usage` from `result.tokens` and `null` when absent.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** Export `METERED_API_KEY_SOURCES` from `claude-adapter.ts` if not already. In `createCodexSwarmTurn`, widen the `Pick` to include `collector` and `label`, map `result.tokens` (`RspTokenUsage`) into `ClaudeTurnUsage` shape (`inputTokens: tokens.input`, `outputTokens: tokens.output ?? 0`, cache fields 0, `reportedUsd: null`). Add `readonly collector?: MetricsCollector` to `LensPipelineDeps`, spread `...(deps.collector === undefined ? {} : { collector: deps.collector })` in `resolveBoardSeatDetails`. Thread the same optional through `project-scout.ts` and `live-review-backend.ts`.
- [ ] **Step 4: Green, commit.** `git commit -m "feat(adapters): record Codex seat usage and thread the metrics collector through the lens pipeline"`.

### Task 7: Durable and on-wire usage

**Files:**
- Modify: `packages/protocol/src/session/model.ts` (`GenerationUsageSchema`; `usage?` on `GenerationSchema` beside `timings`; `usage?` on `ScopedRoundLensEventSchema` beside `coverage`)
- Modify: `packages/protocol/src/session/model.test.ts` (or nearest schema test)
- Modify: `packages/server/src/runtime/rounds.ts` (create `createMetricsCollector()` per generation beside `benchmarkFrom` ~:1272; pass as `collector` in pipeline deps; put `summarizeUsage(collector.metrics)` on each `lens` event and on the returned generation)
- Modify: `packages/server/src/runtime/rounds.test.ts` (or the scripted-daemon e2e that already asserts `coverage`)
- Modify: `docs/developing/reference/protocol-compatibility.md` (:222-232), `docs/developing/concepts/lens-pipeline.md` (:265-273), `docs/developing/concepts/harness-adapters.md` (:346-350)

- [ ] **Step 1: Tests.** Schema test: a `lens` event and a `Generation` parse with and without `usage`; a negative `totalTokens` fails. Rounds test: with a scripted harness whose result frames carry `usage` and `total_cost_usd`, the emitted `lens` events carry cumulative `usage.turns` climbing and the durable generation carries the final total; with `apiKeySource: "none"` the `reportedUsd` is `null` (positive control: with a metered source it is the sum).
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** Schema, fold, emit. Keep `usage` optional so pre-existing generations parse.
- [ ] **Step 4: Green, commit.** `git commit -m "feat(rounds): per-generation token and cost usage on the wire and the durable generation"`.

### Task 8: One line on the round

**Files:**
- Modify: `packages/app-ui/src/rounds/round-machine.ts` (fold `event.usage` beside `coverage` at ~:778, :789, :837 and the `RoundState` fields at ~:141/:150/:159)
- Modify: `packages/app-ui/src/rounds/round-greeting.tsx` (`RegenerationProgress` props gain `usage?`; render a sibling span to the coverage line: `data-testid="generation-usage"`, text `"{tokens} tokens"` plus `" · ${usd}"` only when non-null; tokens formatted with `Intl.NumberFormat` compact notation)
- Modify: `packages/app-ui/src/rounds/round-greeting.test.tsx`, `round-machine.test.ts`
- Modify: `docs/using/guides/getting-started.md` (:461-463), `docs/using/guides/settings-and-setup.md` (:94)

- [ ] **Step 1: Tests.** Machine: a `lens` event with `usage` lands on state; a later event replaces it (cumulative, not summed twice). Greeting: renders "12.3K tokens" from `totalTokens: 12_345`, no dollar text when `reportedUsd` is null, "$0.42" when it is `0.42`; absent `usage` renders nothing (positive control: query the testid and expect null).
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement**, following the coverage span's classes exactly.
- [ ] **Step 4: Green, commit.** `git commit -m "feat(app-ui): show what the generation cost on the round"`.

### Task 9: Handoff turn usage on the round receipt

**Files:**
- Modify: `packages/protocol/src/session/model.ts` (`RoundRunReceiptSchema.usage?: RspTokenUsageSchema`-shaped optional)
- Modify: `packages/server/src/create-server.ts` (~:763-784: copy `outcome.usage` onto the receipt)
- Modify: `packages/app-ui/src/rounds/round-greeting.tsx` (`RunReceiptSummary` appends "worker: N tokens" when present)
- Tests: nearest receipt schema test and the `RunReceiptSummary` test.

- [ ] **Step 1: Tests**, **Step 2: fail**, **Step 3: implement**, **Step 4: green, commit** `git commit -m "feat(rounds): carry the coding turn's token usage on the run receipt"`.

### Task 10: Gate, PR, issue comment

- [ ] `pnpm check`; push; PR body states that no session grows and names the new wire fields; read back; review (opus + Codex once); merge.
- [ ] Comment on #737: item 1 closed; every estimate in the issue can now be measured by running a generation and reading the round.

---

## PR 3 — repair turn diet (item 3, redesigned)

Branch: `737-repair-patch`. Sends less per repair turn: the failing draft shrinks to the non-frozen elements; the base prompt still re-sends (cold session), minus the 9.8 KB schema from PR 1.

### Task 11: Pointer-plus-failing-elements repair prompt

**Files:**
- Modify: `packages/core/src/board/validate.ts` (`RetryRequest.frozenIds: readonly string[]`; populate from `frozen.keys()` at the `seams.runTurn` call)
- Modify: `packages/core/src/board/validate.test.ts`
- Modify: `packages/server/src/runtime/lens-pipeline.ts` (`renderRetryPrompt(basePrompt, draft, pointers, frozenIds)`; call site in `draftOneLens`)
- Modify: `packages/server/src/runtime/lens-pipeline.test.ts`
- Modify: `docs/developing/concepts/lens-pipeline.md` (:139-143, :156), `docs/developing/concepts/harness-adapters.md` (:200-208, add why repair does not resume)

**Interfaces:**
- Produces: `RetryRequest` gains `readonly frozenIds: readonly string[]`. `renderRetryPrompt` sends `{ elementsToFix: draft.elements.filter(e => !frozen.has(e.id)), frozenElementIds, skippedHunks }` with the instruction: "Return a PATCH board containing only the elements listed under `elementsToFix`, corrected, plus any new elements you need. Elements in `frozenElementIds` are already accepted and are kept verbatim by the host; do not resend them. References to frozen ids remain valid."

- [ ] **Step 1: Tests.** `validate.test.ts`: the runTurn seam receives `frozenIds` equal to the ids that passed lint on the previous round (positive control: with no passing elements it is empty). `lens-pipeline.test.ts`: the retry prompt contains the offending element's body, does not contain a frozen element's body, lists the frozen id, and contains the pointers (positive control: with `frozenIds: []` every element body appears).
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** Confirm `mergePatch` semantics hold for a patch that omits frozen elements (they are re-placed from `frozen`); a non-frozen element missing from the patch keeps its current version, which is the honest "unchanged" outcome.
- [ ] **Step 4: Green, commit.** `git commit -m "feat(lens): repair turns send pointers and the failing elements, not the whole draft"`.
- [ ] **Step 5: Docs.** `lens-pipeline.md:139-143`: the repair turn is a fresh ephemeral session carrying the lens prompt, the change inventory, the pointers, and only the failing elements; frozen elements are merged back by the host. `harness-adapters.md:200-208`: add that repair turns do not resume because ephemeral sessions are not persisted (`persistSession: false`), and that a held multi-turn session is the follow-up once item 1's numbers show the base re-send dominates.

### Task 12: Gate, PR, issue comment

- [ ] `pnpm check`; push; PR body states the per-repair reduction (frozen elements no longer re-sent) and the resume blocker; read back; review; merge.
- [ ] Comment on #737: item 3 redesigned and why; what remains (held session) and the measurement that would justify it.

---

## Deferred, with the reason

- **Compose prompt ceiling** (`renderComposePrompt`): the frozen boards are the content being composed; a cap would drop boards from the review. Measure under item 1 first, as the issue itself says.
- **Held multi-turn seat session** (true resume): needs a streaming-input path in `claude-query.ts` and a multi-send `HarnessSession`; justified only if item 1 shows repair base re-sends dominate.
- **Benchmark store token column**: the round shows the number; a history column is a dashboard.
