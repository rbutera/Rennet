import type { OpenSpecChange } from "@rennet/types";

// A REAL Rennet OpenSpec change, parsed by `@rennet/core parseOpenSpecChange`
// (`openspec/changes/add-review-intelligence-core/`) and frozen here as the Spec
// angle worked example. It is the exact structured model the parser emits from the
// on-disk artifacts, so the surface renders the genuine change, not a mock. The
// live source (parse-on-open of a selected change) is the deferred wiring half.
export const openSpecChangeFixture: OpenSpecChange = {
  name: "add-review-intelligence-core",
  proposal: {
    why: [
      {
        kind: "paragraph",
        text: "Rennet exists to REPLACE and SUPERSEDE the `/review-pr` skill Florence runs. A study of that skill against Rennet's code (`~/expedition/Rennet Review Intelligence Bar.md`) found the exact shape of the problem: **Rennet's surfaces are ahead of the skill, but its review INTELLIGENCE is behind, and the intelligence is the actual product.** The lenses today render single-model, context-starved, unverified-beyond-anchor findings. A beautiful roll-up over one unverified model is \"a prettier rubber stamp, not a supersede\" — the very failure mode Rai is trying to escape (over-relying on an autonomous verdict, never reading the code).",
      },
      {
        kind: "paragraph",
        text: "Three of the skill's LLM-intelligence moves are the load-bearing gaps, and they INTERLOCK — a hypothesis that nobody checks against, a second model with nobody to reconcile it, and a verification pass with no findings to verify are each half a mechanism. This change designs them as one layer laid ON the existing engine (decomposition, the three live lens runners, the Model Council, `canvasOps@2`, the reading surfaces), rebuilding none of it.",
      },
      {
        kind: "list",
        ordered: true,
        items: [
          {
            lead: "Hypothesis-first pre-read pass (#178).",
            text: "Before the lens runners read hunks, produce a committed hypothesis (Domain / Scope / Design-we-would-choose / Risks 5–10) from the change's intent and the repo context. It feeds every runner as **disconfirmation criteria** (\"did the author diverge from what we'd have done\") and surfaces to the human as their reading frame. Rennet has no analog today; this is the single most load-bearing anti-rubber-stamp move.",
          },
          {
            lead: "Dual-model per-lens + disagreement-as-signal (#41).",
            text: "Run two independent minds (Claude + Codex) per lens, feed both the same hypothesis disconfirmers, and surface their **disagreement as its own mark — never averaged into consensus.** The `FindingAgreement` data model (`concur` | `disagree` with side-by-side answers) and the Flagged lens that renders it already exist; what is missing is the second seat and the deterministic reconcile that populates the `disagree` state.",
          },
          {
            lead: "Per-finding reproduce-or-refute verification (#179).",
            text: "Every non-obvious finding goes to a fresh verification pass that must reproduce-or-refute it against the real code before it can surface, attaching a one-line evidence chip. Today Rennet culls only hallucinated anchor LOCATIONS (grounding); it never reproduces a finding's SUBSTANCE.",
          },
        ],
      },
      {
        kind: "paragraph",
        text: "This proposal is design only. It ships no implementation — it is a spec for Navi + Rai to review, with the cost/latency envelope and the always-on-vs-opt-in questions surfaced explicitly for Rai's decision.",
      },
    ],
    whatChanges: [
      {
        lead: "A hypothesis pre-read pass (`review.hypothesis`), a new pipeline stage that runs before the lens runners.",
        text: "A node-free core runner mirroring the existing runner shape (offered manifest + prompt contract + injected `runTurn` + shared `InvocationBudget` + validator-admitted RSP envelope) produces one atomic `review.hypothesis` document from the change's INTENT (`ReviewIntent` — PR title/body/spec, widening the live `DecisionIntent` seam) and the REPO CONTEXT (the ProjectSnapshot the Repo-Map already builds, read through the existing `context.map`/`context.file` backend). Its Domain/Scope/Design/Risks are (a) injected into every lens runner as a labelled disconfirmation layer via the existing `assemblePrompt`, and (b) delivered as a first-class pipeline output rendered as the human's reading frame. A deterministic post-runner **predicted-risk cross-check** reconciles each hypothesised risk against the findings (predicted-and-found = strong signal; predicted-but-unflagged = an open risk the human is told to check).",
      },
      {
        lead: "Dual-model execution per lens plus a deterministic reconcile.",
        text: "The pipeline's seat resolver is widened to resolve TWO seats for a dual-model lens (one per installed provider), run the SAME lens runner on each independently (same hypothesis disconfirmers, never merged), and a pure `reconcileFindings` folds the two `FindingBody` sets into one `FindingElement[]` with a POPULATED `agreement`: same-anchor overlap → `concur` (2 of 2); a solo or conflicting finding → `disagree` with each model's answer side by side. No synthesis, ever (Rai's #139 invariant). Under a single installed provider it degrades honestly to single-model with a visible \"no second opinion\" badge.",
      },
      {
        lead: "A per-finding reproduce-or-refute verification pass.",
        text: 'A deterministic classifier marks the non-obvious findings (a behavioural/correctness claim, not a mechanically-settled or low-severity nit); each is sent to a FRESH verification session fed the real file content around its anchor (via `context.file`, more than the offered hunk) with a reproduce-or-refute contract. `refuted` findings are dropped; `reproduced` findings surface with an evidence chip; `inconclusive` findings surface with an honest "could not verify" chip (never silently dropped — could-not-check must not read as clean). The evidence chip is an ADDITIVE optional field on `FindingElement`.',
      },
      {
        lead: "Additive schema + validator work.",
        text: "A new `review.hypothesis` RSP doc type (atomic) with its body schema and rules; an additive optional `verification` field on the `finding` body. The RSP validator gains the new body dispatch; the anchor/quote/identity guarantees are unchanged.",
      },
      {
        lead: "New reading-surface derivations (host-free `@rennet/ui`):",
        text: "a hypothesis reading-frame derivation + component, and the risk-cross-check status rendered against each risk. The Flagged lens's disagreement rendering and empty-vs-failed distinction already exist and are reused as-is.",
      },
    ],
    newCapabilities: [
      {
        name: "review-hypothesis-pass",
        summary:
          "The pre-read hypothesis runner (Domain/Scope/Design/Risks), its injection into every lens runner as disconfirmation criteria, the reading-frame output, and the deterministic predicted-risk cross-check.",
      },
      {
        name: "dual-model-lens-review",
        summary:
          "Two-seat resolution per dual-model lens, independent runs fed the same disconfirmers, the deterministic cross-model reconcile that populates `concur`/`disagree`, and the honest single-provider degradation.",
      },
      {
        name: "per-finding-verification",
        summary:
          "The non-obvious classifier, the reproduce-or-refute contract over the real code in a fresh session, the drop/surface/caveat disposition, and the evidence chip on the finding.",
      },
    ],
    modifiedCapabilities: [
      {
        name: "rsp-validator",
        summary:
          "Gains the `review.hypothesis` doc type (body schema + rules for totality/scope/risk-count/severity vocabulary) dispatched from the existing generic gate, and admits the additive optional `verification` field on a `finding` element. The existing anchor/quote/vocabulary/identity guarantees are unchanged.",
      },
    ],
    impact: [
      {
        area: "packages/types",
        detail:
          "additive only: `ReviewIntent`, `ReviewHypothesisBody` + `HypothesisRisk`, `RiskCrossCheck`, `FindingVerification` and an optional `FindingElement.verification`, and dual-model result shapes. No existing field changes, so documents stamped before this change validate unchanged.",
      },
      {
        area: "packages/protocol",
        detail:
          "`review.hypothesis` added to `RSP_DOC_TYPES` + `DOC_TYPE_REGISTRY` (atomic), its body schema/rules in `bodies.ts`, and the `finding` body schema widened to accept the optional `verification`. Generic gate untouched.",
      },
      {
        area: "packages/instructions",
        detail:
          "two new node-free contracts: `REVIEW_HYPOTHESIS_CONTRACT` and `FINDING_VERIFICATION_CONTRACT`, both filled instances of the existing seven-slot `PromptContract`; registered in `CONTRACTS`.",
      },
      {
        area: "packages/core",
        detail:
          "new node-free modules `hypothesis-generation.ts`, `risk-crosscheck.ts`, `finding-reconcile.ts`, `finding-verification.ts` (all pure or injected-`runTurn`), and extensions to `pipeline.ts` (`buildReviewCanvases`) to sequence the hypothesis stage, the dual-model seat resolution, and the verification stage, all drawing from the ONE shared `InvocationBudget`. Runner signatures gain an optional `hypothesis` / `intent` input.",
      },
      {
        area: "packages/adapters",
        detail:
          "the second seat executor reuses the existing `createCodexRunTurn` port; the verification and hypothesis sessions read real file content through the existing `ProjectContextReader`/`context.file` backend. No new store, no new external dependency.",
      },
      {
        area: "packages/ui",
        detail:
          "new host-free `canvas/hypothesis.ts` + `components/hypothesis.tsx`; the Flagged lens (`canvas/flagged.ts`, `components/flagged.tsx`) is reused unchanged for disagreement + the evidence chip.",
      },
      {
        area: "Dependency arrows preserved",
        detail:
          "(`instructions → types`; `core → types, protocol, instructions`; `adapters → …, core`; `ui → types, protocol`). No new arrows.",
      },
      {
        area: "Cost/latency",
        detail:
          "dual-model and per-finding verification each multiply model turns. They run on the user's OWN subscription ($0-metered) but cost latency + quota, so the bounding is designed into the shared budget and surfaced as a decision for Rai (see design.md §Cost/latency envelope and §Decisions that need Rai before build).",
      },
      {
        area: "Deferred / seams",
        detail:
          "the durable frozen intent snapshot (#136) — this change consumes the live `ReviewIntent` seam and degrades honestly without it; the full Repo-Map (#14/#141–144) — the hypothesis reads whatever the ProjectSnapshot backend serves and degrades to a typed `absent` when it refuses; an optional third `adjudication` turn for a genuine tie — designed as opt-in and additive only, never a synthesis.",
      },
    ],
  },
  design: {
    sections: [
      {
        id: "context",
        level: 2,
        heading: "Context",
        blocks: [
          {
            kind: "paragraph",
            text: "Rennet's engine is genuinely live. The three lens runners — `runFindingAngle` (`finding-generation.ts`), `runDecisionAngle` (`decision-generation.ts`), `runNoiseAngle` (`noise-generation.ts`) — each take an offered manifest, a `PromptContract` from `@rennet/instructions`, a provenance seed, an injected `runTurn`, and a shared `InvocationBudget`; they cull emitted items to the grounded set, stamp a trustworthy RSP envelope (the agent never mints identity), validate through `@rennet/protocol`, retry, and resolve to an honest `failed` state on terminal failure. The Model Council (`resolveAssignment`) decides which mind runs which job and stamps a resolution trace. `buildReviewCanvases` (`pipeline.ts`) sequences decompose → route-plan Brita gate → shared budget → seat resolution → decomposition/ordering/narration → canvas projection, all as a pure function of its inputs plus injected turns.",
          },
          {
            kind: "paragraph",
            text: "Three facts make this change small rather than large:",
          },
          {
            kind: "list",
            ordered: true,
            items: [
              {
                lead: "The disagreement data model already exists.",
                text: '`FindingElement.agreement` is `FindingAgreement = { kind: "concur"; agree; total } | { kind: "disagree"; answers: FindingModelAnswer[] }`, and `buildFlaggedIndex` (`packages/ui/src/canvas/flagged.ts`) already renders the `disagree` state side by side, labelled, in the index. #41 does not need a new surface — it needs the second seat and the reconcile that POPULATES `disagree`.',
              },
              {
                lead: "The council already names the pieces.",
                text: "`finding-generation` (row 21) resolves to one seat; `providerHarness` maps every council model to exactly one provider→harness; `adjudication` (row 25) and `self-consistency` (row 26) are already in the catalogue as the divergence hooks. Cross-harness routing (R39) already runs a Codex seat via `createCodexRunTurn`.",
              },
              {
                lead: "The intent + repo-context seams exist.",
                text: "`runDecisionAngle` already takes `intent?: DecisionIntent` (prTitle/prBody/spec). The ProjectSnapshot the Repo-Map builds is already read, model-free and fail-closed, through `context.map`/`context.file` (`live-review-backend.ts`, `ProjectContextReader`). The hypothesis pass consumes the SAME two seams.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "Everything below is laid ON these. No runner is rebuilt; the finding schema grows only by ADDITIVE optional fields; no dependency arrow is added.",
          },
          {
            kind: "code",
            language: "",
            code: "   INTENT (ReviewIntent)  +  REPO CONTEXT (ProjectSnapshot via context.map/file)\n                       │\n                       ▼\n        ① runHypothesisPass  → review.hypothesis  (Domain/Scope/Design/Risks)\n                       │                         │\n        injected as disconfirmers                └──► reading FRAME (ui)\n                       ▼\n        ② dual-model lens run  (seatA ∥ seatB, same disconfirmers, never merged)\n                       │\n             reconcileFindings → FindingElement[] with concur | disagree\n                       ▼\n        ③ per-finding verification (non-obvious → reproduce-or-refute, fresh session)\n                       │\n        drop refuted · chip reproduced · caveat inconclusive\n                       ▼\n             Flagged / Decisions / Noise lenses  +  crossCheckRisks on the frame",
          },
          {
            kind: "paragraph",
            text: "The three stages share ONE `InvocationBudget` (the vital money circuit, Rule 75, fail-closed on an absent budget), so the total model turns per review are bounded regardless of retries.",
          },
        ],
      },
      {
        id: "hypothesis-first-pre-read-pass-178",
        level: 2,
        heading: "① Hypothesis-first pre-read pass (#178)",
        blocks: [
          {
            kind: "paragraph",
            text: "### Where it is produced and stored",
          },
          {
            kind: "paragraph",
            text: "A new node-free core module `hypothesis-generation.ts` exports `runHypothesisPass(input)`, shaped exactly like the existing runners:",
          },
          {
            kind: "code",
            language: "",
            code: 'runHypothesisPass({\n  patchsetId, manifest,               // the offered manifest (identity + inputDigest)\n  intent?: ReviewIntent,              // PR title/body/committed spec (degraded-but-honest when absent)\n  repoContext?: HypothesisRepoContext,// a compact projection of the ProjectSnapshot (see below)\n  structure: HypothesisStructure,     // file list + decomposition chunk titles (NOT hunk bodies)\n  contract = REVIEW_HYPOTHESIS_CONTRACT,\n  provenance, runTurn, budget, guidance?, maxRetries?\n}) : Promise<RunHypothesisResult>     // { status: "ok"|"failed"; hypothesis?; document?; attempts; budgetRefused }',
          },
          {
            kind: "paragraph",
            text: "The pass emits an atomic `review.hypothesis` RSP document. Its body:",
          },
          {
            kind: "code",
            language: "",
            code: "ReviewHypothesisBody {\n  domain: string                       // what this change should do\n  scope: { inScope: string[]; outOfScope: string[] }\n  designExpectation: string            // the shape/layer/tests/alternatives we'd have chosen\n  risks: HypothesisRisk[]              // 5–10 (validator-bounded)\n}\nHypothesisRisk {\n  riskId: string                       // minted by the pass, referenced by the cross-check\n  statement: string                    // the concrete failure mode we'd look for\n  severity: FindingSeverity            // reuse the closed high|medium|low vocabulary\n  disconfirmer: string                 // the check a runner applies: \"did the author diverge from what we'd have done\"\n}",
          },
          {
            kind: "paragraph",
            text: "The document is a first-class `hypothesis` field on `ReviewPipelineResult` (alongside `narration` — NOT embedded on a `Canvas`, so canvas projection stays byte-identical for replay). It is not a lens of findings; it is the reading frame.",
          },
          {
            kind: "paragraph",
            text: '### The "genuine prior" decision (what the pass sees)',
          },
          {
            kind: "paragraph",
            text: 'To be a real prior rather than a summary of the diff, the pass is fed **intent + structure + repo context**, deliberately NOT the full hunk line text. It sees the PR title/body/spec, the changed file list, the decomposition chunk titles, and the repo context (what these files are, their neighbours, the local conventions). It commits Domain/Scope/Design/Risks from THAT, before any runner reads a hunk. This is the faithful analog of Florence\'s "before reading a single line of the diff." It is a design decision Rai should confirm (§Decisions), because the cheaper alternative — let the pass see the hunks too — is easier to build but produces a prior contaminated by the very code it is supposed to check against.',
          },
          {
            kind: "paragraph",
            text: '`repoContext` is a compact, node-free projection built by `core` from the ProjectSnapshot the adapter already serves (`ProjectMap`/`FileContext` via `context.map`/`context.file`). The pass never touches the store — the composition root (`live-review-backend.ts`) reads the snapshot and hands `core` a plain projection, exactly as the pipeline already keeps `core` node-free. When the snapshot backend refuses (oversize repo, stale, corrupt — all already typed), the pass runs on intent + structure alone and stamps a "repo context absent" note; it degrades, it never fabricates.',
          },
          {
            kind: "paragraph",
            text: "### How a runner consumes it as disconfirmation criteria",
          },
          {
            kind: "paragraph",
            text: "The lens runners already assemble their prompt with `assemblePrompt`, which composes labelled, byte-budgeted layers and wraps untrusted repo text as material. We add an optional `hypothesis?: ReviewHypothesis` input to `RunFindingAngleInput` / `RunDecisionAngleInput` / `RunNoiseAngleInput`. When present, the runner renders it into a NEW labelled layer (`hypothesis`) carrying the Domain/Scope/Design and the numbered risks-with-disconfirmers, positioned in the fixed assembly order after the base instruction and before the payload. The instruction slot for each contract is amended (versioned, so it is A/B-able against rejection rate) to say: *treat the hypothesis as expectations to disconfirm — for each risk, check whether the change diverges from it; surface a finding when it does.* This is why intent reaches EVERY runner without plumbing `intent` into each one: the hypothesis is derived from intent, and the hypothesis is what the runners consume.",
          },
          {
            kind: "paragraph",
            text: "### Predicted-risk cross-check (the downstream half)",
          },
          {
            kind: "paragraph",
            text: "A pure core function `crossCheckRisks(hypothesis, findings) : RiskCrossCheck[]` runs AFTER the lens runners (deterministic, no model turn). For each `HypothesisRisk` it matches findings by anchor proximity and semantic overlap of the disconfirmer:",
          },
          {
            kind: "list",
            ordered: false,
            items: [
              {
                lead: "predicted-and-found",
                text: 'a finding addresses the risk → the risk is marked confirmed and the finding badged "predicted."',
              },
              {
                lead: "predicted-but-unflagged",
                text: "no finding addresses the risk → surfaced on the frame as an OPEN risk the human is explicitly told to check themselves (a \"manual finding,\" Florence's stage 6). This is the anti-rubber-stamp payoff: a risk we predicted that the automated pass did not clear is exactly what the human's attention should go to.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: '`RiskCrossCheck { riskId; status: "confirmed" | "open"; findingIds: string[] }` rides the pipeline result next to the hypothesis.',
          },
          {
            kind: "paragraph",
            text: "### UI reading frame",
          },
          {
            kind: "paragraph",
            text: "A host-free derivation `packages/ui/src/canvas/hypothesis.ts` → `buildHypothesisFrame(hypothesis, crossChecks)` folds the document + cross-check into a `HypothesisFrame` the surface renders (Domain, Scope in/out, Design, and the risk list each showing confirmed/open + jump-to-finding anchors). `components/hypothesis.tsx` renders it as the reading frame. The UX shape (a frame the human reads BEFORE the lenses vs. a collapsible panel alongside) is a Rai decision.",
          },
        ],
      },
      {
        id: "where-it-is-produced-and-stored",
        level: 3,
        heading: "Where it is produced and stored",
        blocks: [
          {
            kind: "paragraph",
            text: "A new node-free core module `hypothesis-generation.ts` exports `runHypothesisPass(input)`, shaped exactly like the existing runners:",
          },
          {
            kind: "code",
            language: "",
            code: 'runHypothesisPass({\n  patchsetId, manifest,               // the offered manifest (identity + inputDigest)\n  intent?: ReviewIntent,              // PR title/body/committed spec (degraded-but-honest when absent)\n  repoContext?: HypothesisRepoContext,// a compact projection of the ProjectSnapshot (see below)\n  structure: HypothesisStructure,     // file list + decomposition chunk titles (NOT hunk bodies)\n  contract = REVIEW_HYPOTHESIS_CONTRACT,\n  provenance, runTurn, budget, guidance?, maxRetries?\n}) : Promise<RunHypothesisResult>     // { status: "ok"|"failed"; hypothesis?; document?; attempts; budgetRefused }',
          },
          {
            kind: "paragraph",
            text: "The pass emits an atomic `review.hypothesis` RSP document. Its body:",
          },
          {
            kind: "code",
            language: "",
            code: "ReviewHypothesisBody {\n  domain: string                       // what this change should do\n  scope: { inScope: string[]; outOfScope: string[] }\n  designExpectation: string            // the shape/layer/tests/alternatives we'd have chosen\n  risks: HypothesisRisk[]              // 5–10 (validator-bounded)\n}\nHypothesisRisk {\n  riskId: string                       // minted by the pass, referenced by the cross-check\n  statement: string                    // the concrete failure mode we'd look for\n  severity: FindingSeverity            // reuse the closed high|medium|low vocabulary\n  disconfirmer: string                 // the check a runner applies: \"did the author diverge from what we'd have done\"\n}",
          },
          {
            kind: "paragraph",
            text: "The document is a first-class `hypothesis` field on `ReviewPipelineResult` (alongside `narration` — NOT embedded on a `Canvas`, so canvas projection stays byte-identical for replay). It is not a lens of findings; it is the reading frame.",
          },
        ],
      },
      {
        id: "the-genuine-prior-decision-what-the-pass-sees",
        level: 3,
        heading: 'The "genuine prior" decision (what the pass sees)',
        blocks: [
          {
            kind: "paragraph",
            text: 'To be a real prior rather than a summary of the diff, the pass is fed **intent + structure + repo context**, deliberately NOT the full hunk line text. It sees the PR title/body/spec, the changed file list, the decomposition chunk titles, and the repo context (what these files are, their neighbours, the local conventions). It commits Domain/Scope/Design/Risks from THAT, before any runner reads a hunk. This is the faithful analog of Florence\'s "before reading a single line of the diff." It is a design decision Rai should confirm (§Decisions), because the cheaper alternative — let the pass see the hunks too — is easier to build but produces a prior contaminated by the very code it is supposed to check against.',
          },
          {
            kind: "paragraph",
            text: '`repoContext` is a compact, node-free projection built by `core` from the ProjectSnapshot the adapter already serves (`ProjectMap`/`FileContext` via `context.map`/`context.file`). The pass never touches the store — the composition root (`live-review-backend.ts`) reads the snapshot and hands `core` a plain projection, exactly as the pipeline already keeps `core` node-free. When the snapshot backend refuses (oversize repo, stale, corrupt — all already typed), the pass runs on intent + structure alone and stamps a "repo context absent" note; it degrades, it never fabricates.',
          },
        ],
      },
      {
        id: "how-a-runner-consumes-it-as-disconfirmation-criteria",
        level: 3,
        heading: "How a runner consumes it as disconfirmation criteria",
        blocks: [
          {
            kind: "paragraph",
            text: "The lens runners already assemble their prompt with `assemblePrompt`, which composes labelled, byte-budgeted layers and wraps untrusted repo text as material. We add an optional `hypothesis?: ReviewHypothesis` input to `RunFindingAngleInput` / `RunDecisionAngleInput` / `RunNoiseAngleInput`. When present, the runner renders it into a NEW labelled layer (`hypothesis`) carrying the Domain/Scope/Design and the numbered risks-with-disconfirmers, positioned in the fixed assembly order after the base instruction and before the payload. The instruction slot for each contract is amended (versioned, so it is A/B-able against rejection rate) to say: *treat the hypothesis as expectations to disconfirm — for each risk, check whether the change diverges from it; surface a finding when it does.* This is why intent reaches EVERY runner without plumbing `intent` into each one: the hypothesis is derived from intent, and the hypothesis is what the runners consume.",
          },
        ],
      },
      {
        id: "predicted-risk-cross-check-the-downstream-half",
        level: 3,
        heading: "Predicted-risk cross-check (the downstream half)",
        blocks: [
          {
            kind: "paragraph",
            text: "A pure core function `crossCheckRisks(hypothesis, findings) : RiskCrossCheck[]` runs AFTER the lens runners (deterministic, no model turn). For each `HypothesisRisk` it matches findings by anchor proximity and semantic overlap of the disconfirmer:",
          },
          {
            kind: "list",
            ordered: false,
            items: [
              {
                lead: "predicted-and-found",
                text: 'a finding addresses the risk → the risk is marked confirmed and the finding badged "predicted."',
              },
              {
                lead: "predicted-but-unflagged",
                text: "no finding addresses the risk → surfaced on the frame as an OPEN risk the human is explicitly told to check themselves (a \"manual finding,\" Florence's stage 6). This is the anti-rubber-stamp payoff: a risk we predicted that the automated pass did not clear is exactly what the human's attention should go to.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: '`RiskCrossCheck { riskId; status: "confirmed" | "open"; findingIds: string[] }` rides the pipeline result next to the hypothesis.',
          },
        ],
      },
      {
        id: "ui-reading-frame",
        level: 3,
        heading: "UI reading frame",
        blocks: [
          {
            kind: "paragraph",
            text: "A host-free derivation `packages/ui/src/canvas/hypothesis.ts` → `buildHypothesisFrame(hypothesis, crossChecks)` folds the document + cross-check into a `HypothesisFrame` the surface renders (Domain, Scope in/out, Design, and the risk list each showing confirmed/open + jump-to-finding anchors). `components/hypothesis.tsx` renders it as the reading frame. The UX shape (a frame the human reads BEFORE the lenses vs. a collapsible panel alongside) is a Rai decision.",
          },
        ],
      },
      {
        id: "dual-model-per-lens-disagreement-as-signal-41",
        level: 2,
        heading: "② Dual-model per-lens + disagreement-as-signal (#41)",
        blocks: [
          {
            kind: "paragraph",
            text: "### Execution: two seats, one runner, run twice",
          },
          {
            kind: "paragraph",
            text: "`pipeline.ts` already has an internal `resolveSeat(jobId, docType, manifest, claudeTurn)` that returns `{ seed, runTurn }` from the council. We add `resolveDualSeat(jobId, docType, manifest, turns)` that returns an ORDERED pair of resolved seats, one per installed provider, using the same `providerHarness` mapping the single resolver uses. Under `both` availability that is one Claude seat (Opus/Sonnet) and one Codex seat (Sol/GPT-5.5, executed through the existing `createCodexRunTurn` port). The same lens runner (`runFindingAngle`) is invoked once per seat, INDEPENDENTLY, each fed the SAME hypothesis disconfirmers and the same manifest. Neither sees the other's output. Two `FindingBody` sets come back, each already grounded and validator-admitted by its own runner.",
          },
          {
            kind: "paragraph",
            text: "### Reconcile: deterministic, never averaged",
          },
          {
            kind: "paragraph",
            text: "A pure core function `reconcileFindings(seatAFindings, seatBFindings, labels) : FindingElement[]` folds the two sets into one, populating `agreement`:",
          },
          {
            kind: "list",
            ordered: false,
            items: [
              {
                lead: "Match",
                text: "two findings by anchor resolution + proximity (±N lines, the same matching primitive the `finding-dedupe` job uses, applied CROSS-model rather than within one model's output) and comparable severity → one `concur` row (`agree: 2, total: 2`), keeping the higher severity and the clearer summary.",
              },
              {
                lead: "Solo",
                text: 'a finding only one seat raised → a `disagree` row: `answers = [{ model: labelA, answer: <the raiser\'s summary> }, { model: labelB, answer: "no concern raised here" }]`. The reviewer sees that one model flagged it and the other did not, and decides.',
              },
              {
                lead: "Conflict",
                text: "both raise at the same anchor with materially different verdicts → a `disagree` row carrying BOTH answers side by side.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "The reconcile is arithmetic over anchors and vocabularies; it NEVER produces a third merged summary. This is the structural guarantee behind Rai's #139 invariant, and it matches how `AskReviewResult` already refuses a synthesis field by construction. Provenance: each contributing seat's `resolutionTrace` is retained, so a `disagree` row is auditable to the two minds that produced it.",
          },
          {
            kind: "paragraph",
            text: "### The seam to Repo-Map / #41 / adjudication",
          },
          {
            kind: "list",
            ordered: false,
            items: [
              {
                lead: "#41",
                text: "is this reconcile plus the second seat; the `FindingAgreement`/`FindingModelAnswer` types and the Flagged renderer are the parts #41 already shipped, so this WIDENS #41 rather than duplicating it.",
              },
              {
                lead: "Repo-Map seam",
                text: "both seats read the same ProjectSnapshot-derived context (through the hypothesis and, for verification, `context.file`), so as the Repo-Map (#14/#141–144) enriches, both minds get richer context symmetrically — the disagreement stays a signal about the CODE, not an artifact of asymmetric context.",
              },
              {
                lead: "Adjudication",
                text: '(`adjudication` doc type + council row 25) stays OPT-IN and additive. When (and only when) Rai wants it, a genuine same-anchor conflict can trigger one extra `adjudication` turn that appends a labelled "which is more likely" note — it NEVER collapses the two answers into one. Default off; the default is to show the disagreement.',
              },
            ],
          },
          {
            kind: "paragraph",
            text: "### Single-provider degradation",
          },
          {
            kind: "paragraph",
            text: '`resolveDualSeat` under `claude-only` or `codex-only` returns one real seat and marks the lens `singleProvider`. The runner runs once; every finding keeps its existing `concur { agree: 1, total: 1 }`, and the lens header carries a visible "single provider — no second opinion" badge (the same honest-degradation family as the council\'s existing "degraded single-provider self-consistency" note). Dual-model is a capability that lights up when two providers are installed, never a hard requirement.',
          },
        ],
      },
      {
        id: "execution-two-seats-one-runner-run-twice",
        level: 3,
        heading: "Execution: two seats, one runner, run twice",
        blocks: [
          {
            kind: "paragraph",
            text: "`pipeline.ts` already has an internal `resolveSeat(jobId, docType, manifest, claudeTurn)` that returns `{ seed, runTurn }` from the council. We add `resolveDualSeat(jobId, docType, manifest, turns)` that returns an ORDERED pair of resolved seats, one per installed provider, using the same `providerHarness` mapping the single resolver uses. Under `both` availability that is one Claude seat (Opus/Sonnet) and one Codex seat (Sol/GPT-5.5, executed through the existing `createCodexRunTurn` port). The same lens runner (`runFindingAngle`) is invoked once per seat, INDEPENDENTLY, each fed the SAME hypothesis disconfirmers and the same manifest. Neither sees the other's output. Two `FindingBody` sets come back, each already grounded and validator-admitted by its own runner.",
          },
        ],
      },
      {
        id: "reconcile-deterministic-never-averaged",
        level: 3,
        heading: "Reconcile: deterministic, never averaged",
        blocks: [
          {
            kind: "paragraph",
            text: "A pure core function `reconcileFindings(seatAFindings, seatBFindings, labels) : FindingElement[]` folds the two sets into one, populating `agreement`:",
          },
          {
            kind: "list",
            ordered: false,
            items: [
              {
                lead: "Match",
                text: "two findings by anchor resolution + proximity (±N lines, the same matching primitive the `finding-dedupe` job uses, applied CROSS-model rather than within one model's output) and comparable severity → one `concur` row (`agree: 2, total: 2`), keeping the higher severity and the clearer summary.",
              },
              {
                lead: "Solo",
                text: 'a finding only one seat raised → a `disagree` row: `answers = [{ model: labelA, answer: <the raiser\'s summary> }, { model: labelB, answer: "no concern raised here" }]`. The reviewer sees that one model flagged it and the other did not, and decides.',
              },
              {
                lead: "Conflict",
                text: "both raise at the same anchor with materially different verdicts → a `disagree` row carrying BOTH answers side by side.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "The reconcile is arithmetic over anchors and vocabularies; it NEVER produces a third merged summary. This is the structural guarantee behind Rai's #139 invariant, and it matches how `AskReviewResult` already refuses a synthesis field by construction. Provenance: each contributing seat's `resolutionTrace` is retained, so a `disagree` row is auditable to the two minds that produced it.",
          },
        ],
      },
      {
        id: "the-seam-to-repo-map-41-adjudication",
        level: 3,
        heading: "The seam to Repo-Map / #41 / adjudication",
        blocks: [
          {
            kind: "list",
            ordered: false,
            items: [
              {
                lead: "#41",
                text: "is this reconcile plus the second seat; the `FindingAgreement`/`FindingModelAnswer` types and the Flagged renderer are the parts #41 already shipped, so this WIDENS #41 rather than duplicating it.",
              },
              {
                lead: "Repo-Map seam",
                text: "both seats read the same ProjectSnapshot-derived context (through the hypothesis and, for verification, `context.file`), so as the Repo-Map (#14/#141–144) enriches, both minds get richer context symmetrically — the disagreement stays a signal about the CODE, not an artifact of asymmetric context.",
              },
              {
                lead: "Adjudication",
                text: '(`adjudication` doc type + council row 25) stays OPT-IN and additive. When (and only when) Rai wants it, a genuine same-anchor conflict can trigger one extra `adjudication` turn that appends a labelled "which is more likely" note — it NEVER collapses the two answers into one. Default off; the default is to show the disagreement.',
              },
            ],
          },
        ],
      },
      {
        id: "single-provider-degradation",
        level: 3,
        heading: "Single-provider degradation",
        blocks: [
          {
            kind: "paragraph",
            text: '`resolveDualSeat` under `claude-only` or `codex-only` returns one real seat and marks the lens `singleProvider`. The runner runs once; every finding keeps its existing `concur { agree: 1, total: 1 }`, and the lens header carries a visible "single provider — no second opinion" badge (the same honest-degradation family as the council\'s existing "degraded single-provider self-consistency" note). Dual-model is a capability that lights up when two providers are installed, never a hard requirement.',
          },
        ],
      },
      {
        id: "per-finding-reproduce-or-refute-verification-179",
        level: 2,
        heading: "③ Per-finding reproduce-or-refute verification (#179)",
        blocks: [
          {
            kind: "paragraph",
            text: '### Trigger: which findings are "non-obvious"',
          },
          {
            kind: "paragraph",
            text: 'A deterministic classifier `classifyNonObvious(finding) : boolean` (pure, in `finding-verification.ts`) decides which findings pay for a verification turn. A finding is **obvious** (skip verification, surface directly, no chip) when it is a low-severity nit or a claim already mechanically settled by the deterministic floor (e.g. "this import is now unused," which the floor\'s own signals confirm). A finding is **non-obvious** (verify) when it is a high/medium-severity BEHAVIOURAL or CORRECTNESS claim that requires reasoning beyond the anchored hunk — a null deref, a broken invariant, a race, a missing guard. The rule set is small, versioned, and testable against a fixture corpus; it is the cost knob, and its exact shape is a Rai decision.',
          },
          {
            kind: "paragraph",
            text: "### The reproduce-or-refute contract",
          },
          {
            kind: "paragraph",
            text: "For each non-obvious finding, `runFindingVerification` drives a FRESH session (a new provenance/runId — no contamination from the generating model's context, and by default a different seat than the one that raised it, so a model is not asked to certify its own claim). The session is fed:",
          },
          {
            kind: "list",
            ordered: false,
            items: [
              {
                text: "the finding (anchor, summary, severity),",
              },
              {
                text: "the REAL file content around the anchor — via the existing `context.file` reader, which serves MORE than the offered hunk, so the verifier can trace the claim through the actual code — and",
              },
              {
                text: "the `FINDING_VERIFICATION_CONTRACT` instruction: reproduce (construct the concrete failure path / cite the exact lines that make the claim true) OR refute (show why it does not hold). Output body:",
              },
            ],
          },
          {
            kind: "code",
            language: "",
            code: 'FindingVerification {\n  verdict: "reproduced" | "refuted" | "inconclusive"\n  evidence: string          // one-line "we dug into it and found Y" (reproduced) or why-not (refuted/inconclusive)\n}',
          },
          {
            kind: "paragraph",
            text: "### Disposition",
          },
          {
            kind: "list",
            ordered: false,
            items: [
              {
                lead: "refuted",
                text: "→ the finding is DROPPED. It never surfaces (the anti-hallucination-of-substance gate).",
              },
              {
                lead: "reproduced",
                text: "→ the finding surfaces with `verification` attached; the Flagged lens renders the evidence chip at its anchor.",
              },
              {
                lead: "inconclusive",
                text: '→ the finding surfaces with an honest "could not verify" chip, NEVER silently dropped. Rationale (Rule 75/81ak, could-not-check beats a false clear): for a claim of a PROBLEM, a dead/uncertain verifier that silently dropped the finding would fail toward hiding a real bug — the worse direction, and exactly the "prettier rubber stamp" this whole change fights. The human decides on a caveated flag. Whether inconclusive surfaces-with-caveat or is dropped is a Rai decision; the design defaults to surface-with-caveat.',
              },
            ],
          },
          {
            kind: "paragraph",
            text: "### The evidence chip in the schema",
          },
          {
            kind: "paragraph",
            text: "`FindingElement` gains an optional `verification?: FindingVerification`. This is an ADDITIVE superset (the note names the #32 finding schema an additive superset), so existing `finding` documents validate unchanged, and a finding with no verification (obvious, or the pass did not run) renders exactly as today. The protocol `finding` body schema is widened to accept the optional field; the itemwise admission and grounding are untouched.",
          },
          {
            kind: "paragraph",
            text: "### Cost containment for verification",
          },
          {
            kind: "paragraph",
            text: 'Verification is the biggest multiplier (up to one turn per non-obvious finding), so it is bounded three ways, all consuming the shared budget: (a) only non-obvious findings, (b) a per-review cap `maxVerifications` — verify the top-K by severity, the rest surface with a "not verified" chip, and (c) batching — multiple findings in the same file/region are verified in one turn (the light-tier batched shape the council already uses). Default tier is light; a high-severity finding may be escalated to heavy.',
          },
        ],
      },
      {
        id: "trigger-which-findings-are-non-obvious",
        level: 3,
        heading: 'Trigger: which findings are "non-obvious"',
        blocks: [
          {
            kind: "paragraph",
            text: 'A deterministic classifier `classifyNonObvious(finding) : boolean` (pure, in `finding-verification.ts`) decides which findings pay for a verification turn. A finding is **obvious** (skip verification, surface directly, no chip) when it is a low-severity nit or a claim already mechanically settled by the deterministic floor (e.g. "this import is now unused," which the floor\'s own signals confirm). A finding is **non-obvious** (verify) when it is a high/medium-severity BEHAVIOURAL or CORRECTNESS claim that requires reasoning beyond the anchored hunk — a null deref, a broken invariant, a race, a missing guard. The rule set is small, versioned, and testable against a fixture corpus; it is the cost knob, and its exact shape is a Rai decision.',
          },
        ],
      },
      {
        id: "the-reproduce-or-refute-contract",
        level: 3,
        heading: "The reproduce-or-refute contract",
        blocks: [
          {
            kind: "paragraph",
            text: "For each non-obvious finding, `runFindingVerification` drives a FRESH session (a new provenance/runId — no contamination from the generating model's context, and by default a different seat than the one that raised it, so a model is not asked to certify its own claim). The session is fed:",
          },
          {
            kind: "list",
            ordered: false,
            items: [
              {
                text: "the finding (anchor, summary, severity),",
              },
              {
                text: "the REAL file content around the anchor — via the existing `context.file` reader, which serves MORE than the offered hunk, so the verifier can trace the claim through the actual code — and",
              },
              {
                text: "the `FINDING_VERIFICATION_CONTRACT` instruction: reproduce (construct the concrete failure path / cite the exact lines that make the claim true) OR refute (show why it does not hold). Output body:",
              },
            ],
          },
          {
            kind: "code",
            language: "",
            code: 'FindingVerification {\n  verdict: "reproduced" | "refuted" | "inconclusive"\n  evidence: string          // one-line "we dug into it and found Y" (reproduced) or why-not (refuted/inconclusive)\n}',
          },
        ],
      },
      {
        id: "disposition",
        level: 3,
        heading: "Disposition",
        blocks: [
          {
            kind: "list",
            ordered: false,
            items: [
              {
                lead: "refuted",
                text: "→ the finding is DROPPED. It never surfaces (the anti-hallucination-of-substance gate).",
              },
              {
                lead: "reproduced",
                text: "→ the finding surfaces with `verification` attached; the Flagged lens renders the evidence chip at its anchor.",
              },
              {
                lead: "inconclusive",
                text: '→ the finding surfaces with an honest "could not verify" chip, NEVER silently dropped. Rationale (Rule 75/81ak, could-not-check beats a false clear): for a claim of a PROBLEM, a dead/uncertain verifier that silently dropped the finding would fail toward hiding a real bug — the worse direction, and exactly the "prettier rubber stamp" this whole change fights. The human decides on a caveated flag. Whether inconclusive surfaces-with-caveat or is dropped is a Rai decision; the design defaults to surface-with-caveat.',
              },
            ],
          },
        ],
      },
      {
        id: "the-evidence-chip-in-the-schema",
        level: 3,
        heading: "The evidence chip in the schema",
        blocks: [
          {
            kind: "paragraph",
            text: "`FindingElement` gains an optional `verification?: FindingVerification`. This is an ADDITIVE superset (the note names the #32 finding schema an additive superset), so existing `finding` documents validate unchanged, and a finding with no verification (obvious, or the pass did not run) renders exactly as today. The protocol `finding` body schema is widened to accept the optional field; the itemwise admission and grounding are untouched.",
          },
        ],
      },
      {
        id: "cost-containment-for-verification",
        level: 3,
        heading: "Cost containment for verification",
        blocks: [
          {
            kind: "paragraph",
            text: 'Verification is the biggest multiplier (up to one turn per non-obvious finding), so it is bounded three ways, all consuming the shared budget: (a) only non-obvious findings, (b) a per-review cap `maxVerifications` — verify the top-K by severity, the rest surface with a "not verified" chip, and (c) batching — multiple findings in the same file/region are verified in one turn (the light-tier batched shape the council already uses). Default tier is light; a high-severity finding may be escalated to heavy.',
          },
        ],
      },
      {
        id: "cost-latency-envelope",
        level: 2,
        heading: "Cost/latency envelope",
        blocks: [
          {
            kind: "paragraph",
            text: "Everything runs on the user's own subscription, so the cost is **latency + quota, not dollars**. The bounding is a turn budget, and it is the vital money circuit (Rule 75): ONE shared `InvocationBudget`, fail-closed on absence, threaded through every new stage exactly as it is through decomposition/ordering/narration today. A refused turn falls to that stage's honest floor (hypothesis absent, single-model, or unverified chip) — the ceiling stops spend, never the review.",
          },
          {
            kind: "paragraph",
            text: "Per-review turn accounting (heavy H, light L), on top of today's structural turns (decompose + ordering + narration ≈ 3):",
          },
          {
            kind: "table",
            headers: ["Stage", "Turns", "Notes"],
            rows: [
              ["① Hypothesis pass", "1 (H)", "once per review"],
              [
                "② Dual-model, per dual lens",
                "×2 the lens's turns",
                "Flagged-only default → +1; all three lenses → +3",
              ],
              [
                "③ Verification",
                "ceil(K/batch), capped at `maxVerifications` (L, some H)",
                "K = non-obvious findings",
              ],
              ["①b Cross-check", "0", "deterministic"],
            ],
          },
          {
            kind: "paragraph",
            text: "Worst case with defaults (hypothesis on, dual-model Flagged-only, verify top-K=6 batched by ~3): ≈ 1 + 1 + 2 = 4 turns above today's baseline. All-on (dual-model all three lenses, K=12): materially higher, which is exactly why the scope switches below are Rai's to set. The single shared ceiling makes the worst case a hard bound, not a hope.",
          },
          {
            kind: "paragraph",
            text: "**Budget model.** A per-review `ReviewIntelligenceBudget` names sub-ceilings (hypothesis: 1; dual-model: on/off + which lenses; verification: `maxVerifications` + batch size) but all draw from ONE underlying `createInvocationBudget` counter, so the TOTAL is the single number Rai sets and the fail-closed guarantee is unchanged. The default ceiling is a Rai decision (§below).",
          },
        ],
      },
      {
        id: "decisions-that-need-rai-before-build",
        level: 2,
        heading: "Decisions that need Rai before build",
        blocks: [
          {
            kind: "list",
            ordered: true,
            items: [
              {
                lead: "Hypothesis-first UX (the reading frame).",
                text: 'Is the frame a surface the human reads BEFORE the lenses unlock (a soft gate that enforces "read the frame first," matching the anti-rubber-stamp intent), or a collapsible panel alongside the lenses they can glance at? The former is truer to the mission; the latter is lighter. This shapes `components/hypothesis.tsx` and the workspace layout.',
              },
              {
                lead: "Always-on vs opt-in per review.",
                text: 'Proposed default: hypothesis-first ALWAYS ON (it is the cheapest, +1 turn, and the load-bearing move); dual-model and verification opt-in via a "deep review" toggle vs a "quick review." Confirm, or set a different split (e.g. all three behind one deep-review mode).',
              },
              {
                lead: "Dual-model scope.",
                text: "Flagged lens only (default — disagreement is most valuable on concerns), or all three lenses (Flagged + Decisions + Noise)? This is the ×2 cost line.",
              },
              {
                lead: "Verification cap + inconclusive policy.",
                text: "`maxVerifications` (default proposal: top 6–8 by severity, batched) and whether `inconclusive` findings surface-with-caveat (default) or are dropped. Also: the non-obvious classifier's rule set (which severities/claim-kinds always verify).",
              },
              {
                lead: "The total turn ceiling per review.",
                text: 'The single number that bounds latency/quota. Propose a default (e.g. 12) and a "quick review" lower value.',
              },
              {
                lead: "The genuine-prior decision.",
                text: 'Confirm the hypothesis pass sees intent + structure + repo context but NOT the full hunk bodies (a true prior), accepting the extra plumbing over the cheaper "let it see the diff too" (a contaminated prior).',
              },
            ],
          },
        ],
      },
      {
        id: "testing-strategy-for-the-eventual-build",
        level: 2,
        heading: "Testing strategy (for the eventual build)",
        blocks: [
          {
            kind: "paragraph",
            text: "TDD, hermetic. Every new core unit is pure or driven by an injected `FakeSession`, so the default gate spends nothing: the hypothesis runner (admit / reject-retry / terminal-failed-honest), `reconcileFindings` (concur match, solo → disagree, conflict → disagree, never a third summary), `crossCheckRisks` (predicted-and-found, predicted-but-unflagged), `classifyNonObvious` (a fixture corpus in both directions), and `runFindingVerification` (reproduced surfaces + chip, refuted dropped, inconclusive caveated). Red-then-green proofs on the load-bearing invariants: the reconcile never emits a merged answer; a refuted finding never reaches the index; an absent budget refuses every new-stage turn (fail-closed). Protocol: one fixture per new `review.hypothesis` rule in both directions, and a `finding` with `verification` admits while the anchor/quote guarantees stay green. UI: `buildHypothesisFrame` derivation is unit-tested host-free; the Flagged lens's disagreement + chip rendering is exercised through the existing DOM tests. A gated real-turn integration test (the existing `RENNET_LIVE_CLAUDE` pattern, plus a Codex seat) drives one tiny end-to-end dual-model review and is excluded from the default gate.",
          },
        ],
      },
    ],
  },
  tasks: {
    groups: [
      {
        id: "0-rai-decisions-gate-the-build",
        title: "0. Rai decisions (gate the build)",
        items: [
          {
            text: "0.1 Confirm the hypothesis-first UX: reading frame BEFORE the lenses (soft gate) vs. collapsible panel alongside",
            status: "todo",
          },
          {
            text: '0.2 Confirm always-on vs opt-in: hypothesis always-on; dual-model + verification behind a "deep review" toggle (or a different split)',
            status: "todo",
          },
          {
            text: "0.3 Confirm dual-model scope: Flagged lens only vs. all three lenses",
            status: "todo",
          },
          {
            text: "0.4 Confirm the verification cap `maxVerifications`, the inconclusive policy (surface-with-caveat vs. drop), and the non-obvious classifier rule set",
            status: "todo",
          },
          {
            text: '0.5 Confirm the total per-review turn ceiling (and a "quick review" lower value)',
            status: "todo",
          },
          {
            text: "0.6 Confirm the genuine-prior decision: hypothesis sees intent + structure + repo context, NOT full hunk bodies",
            status: "todo",
          },
        ],
        total: 6,
        done: 0,
      },
      {
        id: "1-shared-types-types",
        title: "1. Shared types (types)",
        items: [
          {
            text: "1.1 Add `ReviewIntent` (prTitle/prBody/spec), widening the live `DecisionIntent` seam",
            status: "todo",
          },
          {
            text: "1.2 Add `ReviewHypothesisBody` + `HypothesisRisk` (riskId, statement, severity, disconfirmer) and the `ReviewHypothesis` envelope alias",
            status: "todo",
          },
          {
            text: "1.3 Add `RiskCrossCheck` (riskId, status confirmed|open, findingIds)",
            status: "todo",
          },
          {
            text: "1.4 Add `FindingVerification` (verdict reproduced|refuted|inconclusive, evidence) and the optional `FindingElement.verification`",
            status: "todo",
          },
          {
            text: "1.5 Add the dual-model result shapes (per-seat result pair + reconcile output), reusing `FindingAgreement`/`FindingModelAnswer`",
            status: "todo",
          },
        ],
        total: 5,
        done: 0,
      },
      {
        id: "2-protocol-rsp-validator",
        title: "2. Protocol (rsp-validator)",
        items: [
          {
            text: "2.1 Add `review.hypothesis` to `RSP_DOC_TYPES` and `DOC_TYPE_REGISTRY` (atomic)",
            status: "todo",
          },
          {
            text: "2.2 Add the `review.hypothesis` body schema + rules in `bodies.ts` (domain non-empty, scope in/out, design, risks bounded 5–10, per-risk severity vocabulary + non-empty disconfirmer); dispatch from `validateDocument`",
            status: "todo",
          },
          {
            text: "2.3 Widen the `finding` body schema to accept the optional `verification` field; keep itemwise admission + grounding unchanged",
            status: "todo",
          },
          {
            text: "2.4 Add `bodyJsonSchema` projections for the new/changed bodies (structured-output constraint)",
            status: "todo",
          },
        ],
        total: 4,
        done: 0,
      },
      {
        id: "3-prompt-contracts-instructions",
        title: "3. Prompt contracts (instructions)",
        items: [
          {
            text: "3.1 Author `REVIEW_HYPOTHESIS_CONTRACT` (seven-slot; EMIT `review.hypothesis`; ORDERING = logical/first-principles; FAILURE VALVE = honest-null), register in `CONTRACTS`",
            status: "todo",
          },
          {
            text: "3.2 Author `FINDING_VERIFICATION_CONTRACT` (reproduce-or-refute; verdict + one-line evidence; refuse to guess)",
            status: "todo",
          },
          {
            text: "3.3 Amend the three lens contracts' instruction slots (versioned) to consume the hypothesis layer as disconfirmation criteria",
            status: "todo",
          },
          {
            text: "3.4 Ensure `assemblePrompt` renders the hypothesis as a labelled layer after base, before payload, base never truncated",
            status: "todo",
          },
        ],
        total: 4,
        done: 0,
      },
      {
        id: "4-core-intelligence-modules-core-node-free",
        title: "4. Core intelligence modules (core, node-free)",
        items: [
          {
            text: "4.1 `hypothesis-generation.ts` → `runHypothesisPass` (manifest + intent + repoContext + structure → admitted `review.hypothesis`, retry, honest `failed`); a compact `HypothesisRepoContext` projection built from `ProjectMap`/`FileContext`",
            status: "todo",
          },
          {
            text: "4.2 Add optional `hypothesis` input to `runFindingAngle`/`runDecisionAngle`/`runNoiseAngle` and render it as the disconfirmation layer",
            status: "todo",
          },
          {
            text: "4.3 `risk-crosscheck.ts` → `crossCheckRisks(hypothesis, findings)` (deterministic; predicted-and-found vs predicted-but-unflagged)",
            status: "todo",
          },
          {
            text: "4.4 `finding-reconcile.ts` → `reconcileFindings(seatA, seatB, labels)` (concur match / solo → disagree / conflict → disagree; never a merged summary)",
            status: "todo",
          },
          {
            text: "4.5 `finding-verification.ts` → `classifyNonObvious` + `runFindingVerification` (fresh session, real file content, verdict + evidence; drop/surface/caveat; cap + batching)",
            status: "todo",
          },
        ],
        total: 5,
        done: 0,
      },
      {
        id: "5-adapters-store-model-i-o",
        title: "5. Adapters (store + model I/O)",
        items: [
          {
            text: "5.1 Second seat executor for dual-model via the existing `createCodexRunTurn` port; provider→harness follows the resolved model",
            status: "todo",
          },
          {
            text: "5.2 Feed `runHypothesisPass` the ProjectSnapshot projection through `ProjectContextReader`/`context.map`; keep `core` node-free",
            status: "todo",
          },
          {
            text: "5.3 Feed `runFindingVerification` real file content through `context.file`; a fresh session per verification (default a different seat)",
            status: "todo",
          },
        ],
        total: 3,
        done: 0,
      },
      {
        id: "6-pipeline-wiring-core",
        title: "6. Pipeline wiring (core)",
        items: [
          {
            text: "6.1 Extend `ReviewPipelineInput`/`Result` with hypothesis, cross-checks, dual-model config, and verification config",
            status: "todo",
          },
          {
            text: "6.2 Sequence in `buildReviewCanvases`: hypothesis pass → dual-model lens runs (`resolveDualSeat`) → reconcile → verification → cross-check, all drawing from the ONE shared `InvocationBudget`",
            status: "todo",
          },
          {
            text: "6.3 A per-review `ReviewIntelligenceBudget` over one `createInvocationBudget` counter (sub-ceilings for hypothesis/dual/verification); fail-closed on absence",
            status: "todo",
          },
          {
            text: "6.4 Honest degradation paths: no hypothesis, single-provider, unverified-caveat — each on a budget refusal or a missing provider",
            status: "todo",
          },
        ],
        total: 4,
        done: 0,
      },
      {
        id: "7-reading-surface-ui-host-free",
        title: "7. Reading surface (ui, host-free)",
        items: [
          {
            text: "7.1 `canvas/hypothesis.ts` → `buildHypothesisFrame(hypothesis, crossChecks)` (domain/scope/design/risks + confirmed|open + jump anchors)",
            status: "todo",
          },
          {
            text: "7.2 `components/hypothesis.tsx` per the confirmed UX (frame vs panel)",
            status: "todo",
          },
          {
            text: "7.3 Reuse `buildFlaggedIndex` for disagreement + render the verification evidence chip at the finding's anchor",
            status: "todo",
          },
        ],
        total: 3,
        done: 0,
      },
      {
        id: "8-tests-gates",
        title: "8. Tests + gates",
        items: [
          {
            text: "8.1 Hermetic FakeSession suites: hypothesis (admit/reject-retry/failed), reconcile (concur/solo/conflict/no-synthesis), cross-check (found/open), classifier (both directions), verification (reproduced/refuted/inconclusive)",
            status: "todo",
          },
          {
            text: "8.2 Protocol: one fixture per new `review.hypothesis` rule both directions; `finding` with `verification` admits; grounding/anchor guarantees stay green",
            status: "todo",
          },
          {
            text: "8.3 Red-then-green invariants: reconcile never merges; a refuted finding never reaches the index; an absent budget refuses every new-stage turn",
            status: "todo",
          },
          {
            text: "8.4 UI: `buildHypothesisFrame` host-free tests; Flagged disagreement + chip through the existing DOM tests",
            status: "todo",
          },
          {
            text: "8.5 Gated real-turn E2E (`RENNET_LIVE_CLAUDE` + a Codex seat) for one tiny dual-model+verified review; excluded from the default gate",
            status: "todo",
          },
          {
            text: "8.6 Full `pnpm check` green (format, boundaries, licenses, lint, typecheck, test, build); no new dependency arrows",
            status: "todo",
          },
        ],
        total: 6,
        done: 0,
      },
    ],
    total: 40,
    done: 0,
  },
  specDeltas: [
    {
      capability: "dual-model-lens-review",
      groups: [
        {
          operation: "added",
          requirements: [
            {
              name: "A dual-model lens runs two independent minds fed the same disconfirmers",
              statement:
                "For a lens configured as dual-model, the system SHALL resolve two seats — one per installed provider — through the Model Council, run the SAME lens runner once per seat INDEPENDENTLY, and feed both seats the same hypothesis disconfirmers and the same offered manifest. Neither seat's output SHALL be shown to the other, and each seat SHALL ground and validate its own findings through the existing runner path.",
              scenarios: [
                {
                  name: "Both providers produce independent finding sets",
                  steps: [
                    {
                      keyword: "when",
                      text: "a dual-model Flagged lens runs with both Claude and Codex installed",
                    },
                    {
                      keyword: "then",
                      text: "the runner executes once per provider, each fed the same disconfirmers, and returns two independently grounded, validator-admitted finding sets",
                    },
                  ],
                },
                {
                  name: "The executing harness follows the resolved model",
                  steps: [
                    {
                      keyword: "when",
                      text: "a seat resolves to a Codex model",
                    },
                    {
                      keyword: "then",
                      text: "that seat's turn runs through the Codex port and its provenance records the Codex harness, never a Codex model stamped as a Claude run",
                    },
                  ],
                },
              ],
            },
            {
              name: "Disagreement is reconciled deterministically and never averaged",
              statement:
                "A pure reconcile SHALL fold the two seats' findings into one set with a populated agreement state: findings that match by anchor proximity and comparable severity become a single `concur` finding carrying both votes; a finding raised by only one seat, or two conflicting verdicts at one anchor, become a `disagree` finding carrying each model's answer side by side, labelled. The reconcile SHALL NOT produce a third, merged summary, and the resulting shape SHALL have no field able to express one.",
              scenarios: [
                {
                  name: "Overlapping findings concur",
                  steps: [
                    {
                      keyword: "when",
                      text: "both seats raise a finding at the same anchor with comparable severity",
                    },
                    {
                      keyword: "then",
                      text: "the reconcile emits one finding with `concur` and a vote of two of two",
                    },
                  ],
                },
                {
                  name: "A solo finding becomes a labelled disagreement",
                  steps: [
                    {
                      keyword: "when",
                      text: "only one seat raises a finding at an anchor",
                    },
                    {
                      keyword: "then",
                      text: "the reconcile emits a `disagree` finding whose answers show the raising model's summary and the other model's absence of concern, each labelled by model",
                    },
                  ],
                },
                {
                  name: "No synthesis is ever produced",
                  steps: [
                    {
                      keyword: "when",
                      text: "the two seats conflict at an anchor",
                    },
                    {
                      keyword: "then",
                      text: "both answers are carried side by side and no averaged or merged verdict is generated",
                    },
                  ],
                },
              ],
            },
            {
              name: "Disagreement surfaces as a first-class mark in the lens",
              statement:
                "The reconciled findings SHALL flow through the existing Flagged lens index unchanged, so a `disagree` finding renders each model's answer side by side and labelled at its anchor, and a review that ran and found nothing stays distinct from a runner that failed. Disagreement SHALL be an index mark the reviewer can jump to, never a chat interruption or a synthesis block.",
              scenarios: [
                {
                  name: "A disagreement renders side by side in the index",
                  steps: [
                    {
                      keyword: "when",
                      text: "the lens renders a reconciled set containing a `disagree` finding",
                    },
                    {
                      keyword: "then",
                      text: "the row shows both models' answers side by side, labelled, at the finding's anchor",
                    },
                  ],
                },
              ],
            },
            {
              name: "Single-provider availability degrades honestly",
              statement:
                'When only one provider is installed, the lens SHALL run single-model, keep each finding\'s existing self-concur agreement, and carry a visible "single provider — no second opinion" indication. Dual-model SHALL be a capability that activates when two providers are installed, never a hard requirement that blocks a review.',
              scenarios: [
                {
                  name: "One provider yields a badged single-model review",
                  steps: [
                    {
                      keyword: "when",
                      text: "only Claude (or only Codex) is installed",
                    },
                    {
                      keyword: "then",
                      text: "the lens runs once, findings keep a one-of-one concur agreement, and the lens is marked single-provider",
                    },
                  ],
                },
              ],
            },
            {
              name: "Optional adjudication only adds a note, never a verdict",
              statement:
                'When adjudication is explicitly enabled, a genuine same-anchor conflict MAY trigger one additional adjudication turn that appends a labelled "which is more likely" note to the disagreement. It SHALL NOT collapse the two answers into one, and the default SHALL be that disagreement is shown, not adjudicated.',
              scenarios: [
                {
                  name: "Adjudication is off by default",
                  steps: [
                    {
                      keyword: "when",
                      text: "a conflict occurs and adjudication is not enabled",
                    },
                    {
                      keyword: "then",
                      text: "the disagreement is shown with both answers and no adjudication turn runs",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      capability: "per-finding-verification",
      groups: [
        {
          operation: "added",
          requirements: [
            {
              name: "Non-obvious findings are selected for verification deterministically",
              statement:
                "A deterministic, versioned classifier SHALL decide which findings pay for a verification turn. A finding is non-obvious — and SHALL be verified — when it is a higher-severity behavioural or correctness claim that requires reasoning beyond its anchored hunk. A finding is obvious — and SHALL be surfaced directly without verification — when it is a low-severity nit or a claim already settled mechanically by the deterministic floor. The classifier SHALL run no model turn.",
              scenarios: [
                {
                  name: "A behavioural claim is marked for verification",
                  steps: [
                    {
                      keyword: "when",
                      text: "a high or medium severity finding asserts a defect that cannot be confirmed from the anchored hunk alone",
                    },
                    {
                      keyword: "then",
                      text: "the classifier marks it non-obvious and it is routed to verification",
                    },
                  ],
                },
                {
                  name: "A low-severity nit is surfaced without verification",
                  steps: [
                    {
                      keyword: "when",
                      text: "a low-severity stylistic finding is produced",
                    },
                    {
                      keyword: "then",
                      text: "the classifier marks it obvious and it surfaces directly with no verification chip",
                    },
                  ],
                },
              ],
            },
            {
              name: "Each non-obvious finding is reproduced or refuted against the real code",
              statement:
                "Each non-obvious finding SHALL be sent to a fresh verification session — a new run, by default a different seat than the one that raised it — fed the real file content around its anchor (more than the offered hunk) and instructed to either reproduce the claim (cite the concrete failure path or the exact lines that make it true) or refute it (show why it does not hold). The verification SHALL produce a verdict of reproduced, refuted, or inconclusive with a one-line evidence string.",
              scenarios: [
                {
                  name: "A verifier is not asked to certify its own claim",
                  steps: [
                    {
                      keyword: "when",
                      text: "a finding is verified",
                    },
                    {
                      keyword: "then",
                      text: "the verification runs in a fresh session with its own provenance, and by default on a seat other than the one that raised the finding",
                    },
                  ],
                },
                {
                  name: "The verifier reads more than the offered hunk",
                  steps: [
                    {
                      keyword: "when",
                      text: "the verification session runs",
                    },
                    {
                      keyword: "then",
                      text: "it is fed the real file content around the anchor via the context reader, so it can trace the claim through the actual code rather than the hunk alone",
                    },
                  ],
                },
              ],
            },
            {
              name: "Verification disposition — drop refuted, chip reproduced, caveat inconclusive",
              statement:
                'A refuted finding SHALL be dropped and never surface. A reproduced finding SHALL surface with its evidence attached. An inconclusive finding SHALL surface with an honest "could not verify" caveat and SHALL NOT be silently dropped, so a dead or uncertain verifier never reads as an all-clear.',
              scenarios: [
                {
                  name: "A refuted finding never reaches the index",
                  steps: [
                    {
                      keyword: "when",
                      text: "verification refutes a finding",
                    },
                    {
                      keyword: "then",
                      text: "the finding is dropped and does not appear in the lens",
                    },
                  ],
                },
                {
                  name: "A reproduced finding carries its evidence chip",
                  steps: [
                    {
                      keyword: "when",
                      text: "verification reproduces a finding",
                    },
                    {
                      keyword: "then",
                      text: "the finding surfaces with its verification verdict and evidence, and the lens renders the evidence chip at its anchor",
                    },
                  ],
                },
                {
                  name: "An inconclusive finding surfaces caveated, not dropped",
                  steps: [
                    {
                      keyword: "when",
                      text: "verification cannot reproduce or refute a finding",
                    },
                    {
                      keyword: "then",
                      text: 'the finding surfaces with a "could not verify" caveat rather than being removed',
                    },
                  ],
                },
              ],
            },
            {
              name: "The evidence chip is an additive optional field on a finding",
              statement:
                "The `finding` element SHALL gain an optional verification field carrying the verdict and evidence, and this SHALL be an additive superset: a finding without verification validates and renders exactly as before, and existing `finding` documents remain admissible unchanged.",
              scenarios: [
                {
                  name: "An unverified finding is unchanged",
                  steps: [
                    {
                      keyword: "when",
                      text: "a finding has no verification field",
                    },
                    {
                      keyword: "then",
                      text: "it validates and renders exactly as it does today",
                    },
                  ],
                },
                {
                  name: "A verified finding validates with the new field",
                  steps: [
                    {
                      keyword: "when",
                      text: "a finding carries a verification verdict and evidence",
                    },
                    {
                      keyword: "then",
                      text: "the document is admitted and the field is preserved",
                    },
                  ],
                },
              ],
            },
            {
              name: "Verification is bounded by the shared budget and a per-review cap",
              statement:
                'Verification turns SHALL draw from the one shared invocation budget and SHALL be bounded by a per-review cap and by batching findings that share a file or region into a single turn. When the cap or budget is reached, the remaining non-obvious findings SHALL surface with a "not verified" caveat rather than blocking the review or spending unbounded turns.',
              scenarios: [
                {
                  name: "Findings beyond the cap surface unverified",
                  steps: [
                    {
                      keyword: "when",
                      text: "the number of non-obvious findings exceeds the per-review verification cap",
                    },
                    {
                      keyword: "then",
                      text: 'the top findings by severity are verified and the remainder surface with a "not verified" caveat',
                    },
                  ],
                },
                {
                  name: "An exhausted budget stops verification spend, not the review",
                  steps: [
                    {
                      keyword: "when",
                      text: "the shared budget refuses a verification turn",
                    },
                    {
                      keyword: "then",
                      text: 'the affected finding surfaces with a "not verified" caveat and the review still completes',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      capability: "review-hypothesis-pass",
      groups: [
        {
          operation: "added",
          requirements: [
            {
              name: "A hypothesis is committed before the lens runners read the diff",
              statement:
                "The system SHALL run a hypothesis pre-read pass that produces a committed `review.hypothesis` document — Domain, Scope (in/out), the design it would have chosen, and 5–10 concrete Risks — from the change's stated intent, its structure, and the repo context, BEFORE any lens runner reads the hunks. The pass SHALL mirror the existing runner shape: an offered manifest for identity, a versioned prompt contract, an injected turn, a shared invocation budget, and a validator-admitted RSP envelope whose `docId` and `inputDigest` are stamped by the pass and never by the agent.",
              scenarios: [
                {
                  name: "The hypothesis is produced from intent and repo context",
                  steps: [
                    {
                      keyword: "when",
                      text: "the pass runs over a change with a PR title/body (or committed spec) and available repo context",
                    },
                    {
                      keyword: "then",
                      text: "it emits an admitted `review.hypothesis` document carrying a domain, an in/out scope, a design expectation, and between five and ten risks, each with a severity and a disconfirmer",
                    },
                  ],
                },
                {
                  name: "The pass forms a prior, not a diff summary",
                  steps: [
                    {
                      keyword: "when",
                      text: "the pass is invoked",
                    },
                    {
                      keyword: "then",
                      text: "it is fed the intent, the changed-file list, and the decomposition chunk titles plus repo context, and it is NOT fed the full hunk line text, so its risks are expectations to check rather than a restatement of the code",
                    },
                  ],
                },
              ],
            },
            {
              name: "The pass degrades honestly when intent or repo context is absent",
              statement:
                "The pass SHALL run on whatever inputs are present and SHALL never fabricate an input. With no intent it reasons over structure and repo context alone; with the repo-context backend refusing (absent, stale, corrupt, or over the size ceiling) it reasons over intent and structure alone and records that the repo context was absent. A pass that cannot complete SHALL resolve to an honest `failed` state, distinct from a pass that ran and produced a hypothesis.",
              scenarios: [
                {
                  name: "Missing repo context does not block the hypothesis",
                  steps: [
                    {
                      keyword: "when",
                      text: "the ProjectSnapshot backend returns a typed refusal for the review's base",
                    },
                    {
                      keyword: "then",
                      text: "the pass still produces a hypothesis from intent and structure and marks the repo context as absent, and no snapshot is fabricated",
                    },
                  ],
                },
                {
                  name: "A failed pass is not conflated with an empty one",
                  steps: [
                    {
                      keyword: "when",
                      text: "every attempt of the pass fails or the budget refuses it",
                    },
                    {
                      keyword: "then",
                      text: 'the result carries `failed` with a reason, and downstream stages treat that as "no hypothesis," never as an empty-but-successful hypothesis',
                    },
                  ],
                },
              ],
            },
            {
              name: "The hypothesis feeds every lens runner as disconfirmation criteria",
              statement:
                "When a hypothesis is present, each lens runner SHALL receive it and render its domain, scope, design expectation, and numbered risks-with-disconfirmers as a labelled layer in the assembled prompt, positioned after the base instruction and before the payload, and SHALL be instructed to surface a finding where the change diverges from an expectation. The hypothesis is the vehicle by which intent reaches runners that do not themselves take an intent input.",
              scenarios: [
                {
                  name: "A runner receives the hypothesis as a labelled disconfirmation layer",
                  steps: [
                    {
                      keyword: "when",
                      text: "a lens runner assembles its prompt with a hypothesis supplied",
                    },
                    {
                      keyword: "then",
                      text: "the assembled prompt contains a labelled hypothesis layer carrying the risks and their disconfirmers, and the base instruction is never truncated to fit it",
                    },
                  ],
                },
                {
                  name: "Absent hypothesis leaves runner behaviour unchanged",
                  steps: [
                    {
                      keyword: "when",
                      text: "a lens runner is invoked with no hypothesis",
                    },
                    {
                      keyword: "then",
                      text: "it assembles and runs exactly as it does today, with no hypothesis layer",
                    },
                  ],
                },
              ],
            },
            {
              name: "The predicted-risk cross-check reconciles risks against findings",
              statement:
                "After the lens runners return, a deterministic cross-check SHALL match each hypothesised risk against the produced findings and mark it confirmed (a finding addresses it) or open (no finding addresses it). An open risk SHALL be surfaced to the human as a risk to check themselves, never silently discarded. The cross-check SHALL run no model turn.",
              scenarios: [
                {
                  name: "A predicted-and-found risk is confirmed",
                  steps: [
                    {
                      keyword: "when",
                      text: "a finding's anchor and substance match a hypothesised risk's disconfirmer",
                    },
                    {
                      keyword: "then",
                      text: "that risk is marked confirmed and the finding is associated with the risk",
                    },
                  ],
                },
                {
                  name: "A predicted-but-unflagged risk is surfaced as open",
                  steps: [
                    {
                      keyword: "when",
                      text: "no finding addresses a hypothesised risk",
                    },
                    {
                      keyword: "then",
                      text: "that risk is marked open and presented as a manual check for the human, and it is not dropped",
                    },
                  ],
                },
              ],
            },
            {
              name: "The hypothesis is the human's reading frame",
              statement:
                "The system SHALL deliver the hypothesis and its cross-check as a first-class reading frame rendered from a host-free derivation, showing the domain, the in/out scope, the design expectation, and the risk list with each risk's confirmed/open status and a jump to any associated finding. The frame SHALL be delivered alongside the canvas set and SHALL NOT be embedded on a `Canvas`, so canvas projection stays byte-identical for replay.",
              scenarios: [
                {
                  name: "The frame renders the committed hypothesis and risk statuses",
                  steps: [
                    {
                      keyword: "when",
                      text: "a review with a produced hypothesis is opened",
                    },
                    {
                      keyword: "then",
                      text: "the reading frame shows the domain, scope, design expectation, and each risk with its confirmed or open status and any linked finding anchors",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      capability: "rsp-validator",
      groups: [
        {
          operation: "added",
          requirements: [
            {
              name: "The `review.hypothesis` document type is validated atomically",
              statement:
                "The validator SHALL recognise a new `review.hypothesis` document type, admitted atomically (any body error rejects the whole document), and SHALL validate its body: a non-empty domain, a scope with in and out lists, a design expectation, and a risks array bounded to between five and ten items, where each risk carries a non-empty statement, a severity in the closed high|medium|low vocabulary, and a non-empty disconfirmer. The envelope, anchor, quote, vocabulary, and identity guarantees SHALL be unchanged, and the document's `docId` and `inputDigest` SHALL be stamped by the pass, not the agent.",
              scenarios: [
                {
                  name: "A well-formed hypothesis is admitted",
                  steps: [
                    {
                      keyword: "when",
                      text: "a `review.hypothesis` document with a domain, an in/out scope, a design expectation, and seven valid risks is validated",
                    },
                    {
                      keyword: "then",
                      text: "it is admitted with no errors",
                    },
                  ],
                },
                {
                  name: "A risk count outside the bound rejects the document",
                  steps: [
                    {
                      keyword: "when",
                      text: "a `review.hypothesis` body carries fewer than five or more than ten risks",
                    },
                    {
                      keyword: "then",
                      text: "the document is rejected atomically with an error naming the bound",
                    },
                  ],
                },
                {
                  name: "A risk with an out-of-vocabulary severity rejects the document",
                  steps: [
                    {
                      keyword: "when",
                      text: "a risk declares a severity outside high|medium|low",
                    },
                    {
                      keyword: "then",
                      text: "the document is rejected atomically",
                    },
                  ],
                },
              ],
            },
            {
              name: "The `finding` body admits an additive optional verification field",
              statement:
                "The validator SHALL accept an optional verification field on a `finding` element — a verdict of reproduced, refuted, or inconclusive with an evidence string — while keeping the finding body's existing itemwise admission, anchor grounding, severity vocabulary, and identity rules unchanged. A finding without the field SHALL remain admissible exactly as before.",
              scenarios: [
                {
                  name: "A finding with a verification field is admitted",
                  steps: [
                    {
                      keyword: "when",
                      text: "a `finding` element carries a verification verdict and evidence",
                    },
                    {
                      keyword: "then",
                      text: "the item is admitted and the field is preserved",
                    },
                  ],
                },
                {
                  name: "A finding without a verification field is unchanged",
                  steps: [
                    {
                      keyword: "when",
                      text: "a `finding` element omits the verification field",
                    },
                    {
                      keyword: "then",
                      text: "it is admitted exactly as it is today",
                    },
                  ],
                },
                {
                  name: "A malformed verification verdict is rejected without sinking grounded findings",
                  steps: [
                    {
                      keyword: "when",
                      text: "a `finding` element carries a verification verdict outside the closed set",
                    },
                    {
                      keyword: "then",
                      text: "that item is dropped by the itemwise gate with a visible rejected count, and the grounded findings in the same document are still admitted",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
