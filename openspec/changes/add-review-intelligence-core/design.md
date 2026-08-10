# Design — Review Intelligence Core

## Context

Rennet's engine is genuinely live. The three lens runners — `runFindingAngle` (`finding-generation.ts`), `runDecisionAngle` (`decision-generation.ts`), `runNoiseAngle` (`noise-generation.ts`) — each take an offered manifest, a `PromptContract` from `@rennet/instructions`, a provenance seed, an injected `runTurn`, and a shared `InvocationBudget`; they cull emitted items to the grounded set, stamp a trustworthy RSP envelope (the agent never mints identity), validate through `@rennet/protocol`, retry, and resolve to an honest `failed` state on terminal failure. The Model Council (`resolveAssignment`) decides which mind runs which job and stamps a resolution trace. `buildReviewCanvases` (`pipeline.ts`) sequences decompose → route-plan Brita gate → shared budget → seat resolution → decomposition/ordering/narration → canvas projection, all as a pure function of its inputs plus injected turns.

Three facts make this change small rather than large:

1. **The disagreement data model already exists.** `FindingElement.agreement` is `FindingAgreement = { kind: "concur"; agree; total } | { kind: "disagree"; answers: FindingModelAnswer[] }`, and `buildFlaggedIndex` (`packages/ui/src/canvas/flagged.ts`) already renders the `disagree` state side by side, labelled, in the index. #41 does not need a new surface — it needs the second seat and the reconcile that POPULATES `disagree`.
2. **The council already names the pieces.** `finding-generation` (row 21) resolves to one seat; `providerHarness` maps every council model to exactly one provider→harness; `adjudication` (row 25) and `self-consistency` (row 26) are already in the catalogue as the divergence hooks. Cross-harness routing (R39) already runs a Codex seat via `createCodexRunTurn`.
3. **The intent + repo-context seams exist.** `runDecisionAngle` already takes `intent?: DecisionIntent` (prTitle/prBody/spec). The ProjectSnapshot the Repo-Map builds is already read, model-free and fail-closed, through `context.map`/`context.file` (`live-review-backend.ts`, `ProjectContextReader`). The hypothesis pass consumes the SAME two seams.

Everything below is laid ON these. No runner is rebuilt; the finding schema grows only by ADDITIVE optional fields; no dependency arrow is added.

```
   INTENT (ReviewIntent)  +  REPO CONTEXT (ProjectSnapshot via context.map/file)
                       │
                       ▼
        ① runHypothesisPass  → review.hypothesis  (Domain/Scope/Design/Risks)
                       │                         │
        injected as disconfirmers                └──► reading FRAME (ui)
                       ▼
        ② dual-model lens run  (seatA ∥ seatB, same disconfirmers, never merged)
                       │
             reconcileFindings → FindingElement[] with concur | disagree
                       ▼
        ③ per-finding verification (non-obvious → reproduce-or-refute, fresh session)
                       │
        drop refuted · chip reproduced · caveat inconclusive
                       ▼
             Flagged / Decisions / Noise lenses  +  crossCheckRisks on the frame
```

The three stages share ONE `InvocationBudget` (the vital money circuit, Rule 75, fail-closed on an absent budget), so the total model turns per review are bounded regardless of retries.

---

## ① Hypothesis-first pre-read pass (#178)

### Where it is produced and stored

A new node-free core module `hypothesis-generation.ts` exports `runHypothesisPass(input)`, shaped exactly like the existing runners:

```
runHypothesisPass({
  patchsetId, manifest,               // the offered manifest (identity + inputDigest)
  intent?: ReviewIntent,              // PR title/body/committed spec (degraded-but-honest when absent)
  repoContext?: HypothesisRepoContext,// a compact projection of the ProjectSnapshot (see below)
  structure: HypothesisStructure,     // file list + decomposition chunk titles (NOT hunk bodies)
  contract = REVIEW_HYPOTHESIS_CONTRACT,
  provenance, runTurn, budget, guidance?, maxRetries?
}) : Promise<RunHypothesisResult>     // { status: "ok"|"failed"; hypothesis?; document?; attempts; budgetRefused }
```

The pass emits an atomic `review.hypothesis` RSP document. Its body:

```
ReviewHypothesisBody {
  domain: string                       // what this change should do
  scope: { inScope: string[]; outOfScope: string[] }
  designExpectation: string            // the shape/layer/tests/alternatives we'd have chosen
  risks: HypothesisRisk[]              // 5–10 (validator-bounded)
}
HypothesisRisk {
  riskId: string                       // minted by the pass, referenced by the cross-check
  statement: string                    // the concrete failure mode we'd look for
  severity: FindingSeverity            // reuse the closed high|medium|low vocabulary
  disconfirmer: string                 // the check a runner applies: "did the author diverge from what we'd have done"
}
```

The document is a first-class `hypothesis` field on `ReviewPipelineResult` (alongside `narration` — NOT embedded on a `Canvas`, so canvas projection stays byte-identical for replay). It is not a lens of findings; it is the reading frame.

### The "genuine prior" decision (what the pass sees)

To be a real prior rather than a summary of the diff, the pass is fed **intent + structure + repo context**, deliberately NOT the full hunk line text. It sees the PR title/body/spec, the changed file list, the decomposition chunk titles, and the repo context (what these files are, their neighbours, the local conventions). It commits Domain/Scope/Design/Risks from THAT, before any runner reads a hunk. This is the faithful analog of Florence's "before reading a single line of the diff." It is a design decision Rai should confirm (§Decisions), because the cheaper alternative — let the pass see the hunks too — is easier to build but produces a prior contaminated by the very code it is supposed to check against.

`repoContext` is a compact, node-free projection built by `core` from the ProjectSnapshot the adapter already serves (`ProjectMap`/`FileContext` via `context.map`/`context.file`). The pass never touches the store — the composition root (`live-review-backend.ts`) reads the snapshot and hands `core` a plain projection, exactly as the pipeline already keeps `core` node-free. When the snapshot backend refuses (oversize repo, stale, corrupt — all already typed), the pass runs on intent + structure alone and stamps a "repo context absent" note; it degrades, it never fabricates.

### How a runner consumes it as disconfirmation criteria

The lens runners already assemble their prompt with `assemblePrompt`, which composes labelled, byte-budgeted layers and wraps untrusted repo text as material. We add an optional `hypothesis?: ReviewHypothesis` input to `RunFindingAngleInput` / `RunDecisionAngleInput` / `RunNoiseAngleInput`. When present, the runner renders it into a NEW labelled layer (`hypothesis`) carrying the Domain/Scope/Design and the numbered risks-with-disconfirmers, positioned in the fixed assembly order after the base instruction and before the payload. The instruction slot for each contract is amended (versioned, so it is A/B-able against rejection rate) to say: *treat the hypothesis as expectations to disconfirm — for each risk, check whether the change diverges from it; surface a finding when it does.* This is why intent reaches EVERY runner without plumbing `intent` into each one: the hypothesis is derived from intent, and the hypothesis is what the runners consume.

### Predicted-risk cross-check (the downstream half)

A pure core function `crossCheckRisks(hypothesis, findings) : RiskCrossCheck[]` runs AFTER the lens runners (deterministic, no model turn). For each `HypothesisRisk` it matches findings by anchor proximity and semantic overlap of the disconfirmer:

- **predicted-and-found** — a finding addresses the risk → the risk is marked confirmed and the finding badged "predicted."
- **predicted-but-unflagged** — no finding addresses the risk → surfaced on the frame as an OPEN risk the human is explicitly told to check themselves (a "manual finding," Florence's stage 6). This is the anti-rubber-stamp payoff: a risk we predicted that the automated pass did not clear is exactly what the human's attention should go to.

`RiskCrossCheck { riskId; status: "confirmed" | "open"; findingIds: string[] }` rides the pipeline result next to the hypothesis.

### UI reading frame

A host-free derivation `packages/ui/src/canvas/hypothesis.ts` → `buildHypothesisFrame(hypothesis, crossChecks)` folds the document + cross-check into a `HypothesisFrame` the surface renders (Domain, Scope in/out, Design, and the risk list each showing confirmed/open + jump-to-finding anchors). `components/hypothesis.tsx` renders it as the reading frame. The UX shape (a frame the human reads BEFORE the lenses vs. a collapsible panel alongside) is a Rai decision.

---

## ② Dual-model per-lens + disagreement-as-signal (#41)

### Execution: two seats, one runner, run twice

`pipeline.ts` already has an internal `resolveSeat(jobId, docType, manifest, claudeTurn)` that returns `{ seed, runTurn }` from the council. We add `resolveDualSeat(jobId, docType, manifest, turns)` that returns an ORDERED pair of resolved seats, one per installed provider, using the same `providerHarness` mapping the single resolver uses. Under `both` availability that is one Claude seat (Opus/Sonnet) and one Codex seat (Sol/GPT-5.5, executed through the existing `createCodexRunTurn` port). The same lens runner (`runFindingAngle`) is invoked once per seat, INDEPENDENTLY, each fed the SAME hypothesis disconfirmers and the same manifest. Neither sees the other's output. Two `FindingBody` sets come back, each already grounded and validator-admitted by its own runner.

### Reconcile: deterministic, never averaged

A pure core function `reconcileFindings(seatAFindings, seatBFindings, labels) : FindingElement[]` folds the two sets into one, populating `agreement`:

- **Match** two findings by anchor resolution + proximity (±N lines, the same matching primitive the `finding-dedupe` job uses, applied CROSS-model rather than within one model's output) and comparable severity → one `concur` row (`agree: 2, total: 2`), keeping the higher severity and the clearer summary.
- **Solo** — a finding only one seat raised → a `disagree` row: `answers = [{ model: labelA, answer: <the raiser's summary> }, { model: labelB, answer: "no concern raised here" }]`. The reviewer sees that one model flagged it and the other did not, and decides.
- **Conflict** — both raise at the same anchor with materially different verdicts → a `disagree` row carrying BOTH answers side by side.

The reconcile is arithmetic over anchors and vocabularies; it NEVER produces a third merged summary. This is the structural guarantee behind Rai's #139 invariant, and it matches how `AskReviewResult` already refuses a synthesis field by construction. Provenance: each contributing seat's `resolutionTrace` is retained, so a `disagree` row is auditable to the two minds that produced it.

### The seam to Repo-Map / #41 / adjudication

- **#41** is this reconcile plus the second seat; the `FindingAgreement`/`FindingModelAnswer` types and the Flagged renderer are the parts #41 already shipped, so this WIDENS #41 rather than duplicating it.
- **Repo-Map seam**: both seats read the same ProjectSnapshot-derived context (through the hypothesis and, for verification, `context.file`), so as the Repo-Map (#14/#141–144) enriches, both minds get richer context symmetrically — the disagreement stays a signal about the CODE, not an artifact of asymmetric context.
- **Adjudication** (`adjudication` doc type + council row 25) stays OPT-IN and additive. When (and only when) Rai wants it, a genuine same-anchor conflict can trigger one extra `adjudication` turn that appends a labelled "which is more likely" note — it NEVER collapses the two answers into one. Default off; the default is to show the disagreement.

### Single-provider degradation

`resolveDualSeat` under `claude-only` or `codex-only` returns one real seat and marks the lens `singleProvider`. The runner runs once; every finding keeps its existing `concur { agree: 1, total: 1 }`, and the lens header carries a visible "single provider — no second opinion" badge (the same honest-degradation family as the council's existing "degraded single-provider self-consistency" note). Dual-model is a capability that lights up when two providers are installed, never a hard requirement.

---

## ③ Per-finding reproduce-or-refute verification (#179)

### Trigger: which findings are "non-obvious"

A deterministic classifier `classifyNonObvious(finding) : boolean` (pure, in `finding-verification.ts`) decides which findings pay for a verification turn. A finding is **obvious** (skip verification, surface directly, no chip) when it is a low-severity nit or a claim already mechanically settled by the deterministic floor (e.g. "this import is now unused," which the floor's own signals confirm). A finding is **non-obvious** (verify) when it is a high/medium-severity BEHAVIOURAL or CORRECTNESS claim that requires reasoning beyond the anchored hunk — a null deref, a broken invariant, a race, a missing guard. The rule set is small, versioned, and testable against a fixture corpus; it is the cost knob, and its exact shape is a Rai decision.

### The reproduce-or-refute contract

For each non-obvious finding, `runFindingVerification` drives a FRESH session (a new provenance/runId — no contamination from the generating model's context, and by default a different seat than the one that raised it, so a model is not asked to certify its own claim). The session is fed:

- the finding (anchor, summary, severity),
- the REAL file content around the anchor — via the existing `context.file` reader, which serves MORE than the offered hunk, so the verifier can trace the claim through the actual code — and
- the `FINDING_VERIFICATION_CONTRACT` instruction: reproduce (construct the concrete failure path / cite the exact lines that make the claim true) OR refute (show why it does not hold). Output body:

```
FindingVerification {
  verdict: "reproduced" | "refuted" | "inconclusive"
  evidence: string          // one-line "we dug into it and found Y" (reproduced) or why-not (refuted/inconclusive)
}
```

### Disposition

- **refuted** → the finding is DROPPED. It never surfaces (the anti-hallucination-of-substance gate).
- **reproduced** → the finding surfaces with `verification` attached; the Flagged lens renders the evidence chip at its anchor.
- **inconclusive** → the finding surfaces with an honest "could not verify" chip, NEVER silently dropped. Rationale (Rule 75/81ak, could-not-check beats a false clear): for a claim of a PROBLEM, a dead/uncertain verifier that silently dropped the finding would fail toward hiding a real bug — the worse direction, and exactly the "prettier rubber stamp" this whole change fights. The human decides on a caveated flag. Whether inconclusive surfaces-with-caveat or is dropped is a Rai decision; the design defaults to surface-with-caveat.

### The evidence chip in the schema

`FindingElement` gains an optional `verification?: FindingVerification`. This is an ADDITIVE superset (the note names the #32 finding schema an additive superset), so existing `finding` documents validate unchanged, and a finding with no verification (obvious, or the pass did not run) renders exactly as today. The protocol `finding` body schema is widened to accept the optional field; the itemwise admission and grounding are untouched.

### Cost containment for verification

Verification is the biggest multiplier (up to one turn per non-obvious finding), so it is bounded three ways, all consuming the shared budget: (a) only non-obvious findings, (b) a per-review cap `maxVerifications` — verify the top-K by severity, the rest surface with a "not verified" chip, and (c) batching — multiple findings in the same file/region are verified in one turn (the light-tier batched shape the council already uses). Default tier is light; a high-severity finding may be escalated to heavy.

---

## Cost/latency envelope

Everything runs on the user's own subscription, so the cost is **latency + quota, not dollars**. The bounding is a turn budget, and it is the vital money circuit (Rule 75): ONE shared `InvocationBudget`, fail-closed on absence, threaded through every new stage exactly as it is through decomposition/ordering/narration today. A refused turn falls to that stage's honest floor (hypothesis absent, single-model, or unverified chip) — the ceiling stops spend, never the review.

Per-review turn accounting (heavy H, light L), on top of today's structural turns (decompose + ordering + narration ≈ 3):

| Stage | Turns | Notes |
|---|---|---|
| ① Hypothesis pass | 1 (H) | once per review |
| ② Dual-model, per dual lens | ×2 the lens's turns | Flagged-only default → +1; all three lenses → +3 |
| ③ Verification | ceil(K/batch), capped at `maxVerifications` (L, some H) | K = non-obvious findings |
| ①b Cross-check | 0 | deterministic |

Worst case with defaults (hypothesis on, dual-model Flagged-only, verify top-K=6 batched by ~3): ≈ 1 + 1 + 2 = 4 turns above today's baseline. All-on (dual-model all three lenses, K=12): materially higher, which is exactly why the scope switches below are Rai's to set. The single shared ceiling makes the worst case a hard bound, not a hope.

**Budget model.** A per-review `ReviewIntelligenceBudget` names sub-ceilings (hypothesis: 1; dual-model: on/off + which lenses; verification: `maxVerifications` + batch size) but all draw from ONE underlying `createInvocationBudget` counter, so the TOTAL is the single number Rai sets and the fail-closed guarantee is unchanged. The default ceiling is a Rai decision (§below).

---

## Decisions that need Rai before build

1. **Hypothesis-first UX (the reading frame).** Is the frame a surface the human reads BEFORE the lenses unlock (a soft gate that enforces "read the frame first," matching the anti-rubber-stamp intent), or a collapsible panel alongside the lenses they can glance at? The former is truer to the mission; the latter is lighter. This shapes `components/hypothesis.tsx` and the workspace layout.
2. **Always-on vs opt-in per review.** Proposed default: hypothesis-first ALWAYS ON (it is the cheapest, +1 turn, and the load-bearing move); dual-model and verification opt-in via a "deep review" toggle vs a "quick review." Confirm, or set a different split (e.g. all three behind one deep-review mode).
3. **Dual-model scope.** Flagged lens only (default — disagreement is most valuable on concerns), or all three lenses (Flagged + Decisions + Noise)? This is the ×2 cost line.
4. **Verification cap + inconclusive policy.** `maxVerifications` (default proposal: top 6–8 by severity, batched) and whether `inconclusive` findings surface-with-caveat (default) or are dropped. Also: the non-obvious classifier's rule set (which severities/claim-kinds always verify).
5. **The total turn ceiling per review.** The single number that bounds latency/quota. Propose a default (e.g. 12) and a "quick review" lower value.
6. **The genuine-prior decision.** Confirm the hypothesis pass sees intent + structure + repo context but NOT the full hunk bodies (a true prior), accepting the extra plumbing over the cheaper "let it see the diff too" (a contaminated prior).

---

## Testing strategy (for the eventual build)

TDD, hermetic. Every new core unit is pure or driven by an injected `FakeSession`, so the default gate spends nothing: the hypothesis runner (admit / reject-retry / terminal-failed-honest), `reconcileFindings` (concur match, solo → disagree, conflict → disagree, never a third summary), `crossCheckRisks` (predicted-and-found, predicted-but-unflagged), `classifyNonObvious` (a fixture corpus in both directions), and `runFindingVerification` (reproduced surfaces + chip, refuted dropped, inconclusive caveated). Red-then-green proofs on the load-bearing invariants: the reconcile never emits a merged answer; a refuted finding never reaches the index; an absent budget refuses every new-stage turn (fail-closed). Protocol: one fixture per new `review.hypothesis` rule in both directions, and a `finding` with `verification` admits while the anchor/quote guarantees stay green. UI: `buildHypothesisFrame` derivation is unit-tested host-free; the Flagged lens's disagreement + chip rendering is exercised through the existing DOM tests. A gated real-turn integration test (the existing `RENNET_LIVE_CLAUDE` pattern, plus a Codex seat) drives one tiny end-to-end dual-model review and is excluded from the default gate.
