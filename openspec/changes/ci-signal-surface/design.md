# Design — ci-signal-surface (#182)

## 0. Rule Zero framing (read first)

The CI signal is INFORMATIONAL. It never gates review, sign, or publish; there is no consent step, no confirmation, no "are you sure — CI is red". The reviewer reads it the way they read the hypothesis frame or the blast-radius chips: as evidence. Every failure path degrades to an honest label ("CI status unavailable — <reason>"), never to a block and never to a silent absence that reads as "all clear". If any task in this change grows a gate, the task is wrong, not the rule.

## 1. The forge seam: `ForgePort.fetchCiStatus`

**Where:** `packages/core/src/forge-port.ts` (interface) + `packages/adapters/src/github-forge.ts` (implementation).

`ForgePort` is the forge-neutral seam (Contracts R24): every forge fact crosses it in Rennet nouns with an opaque `forgeRef`, and no GitHub vocabulary leaks past the adapter. CI status is a forge fact about a commit, so the read belongs here — a fourth method beside `listOpenPullRequests` / `fetchPullRequest` / `fetchDiff`:

```ts
/** One check/status attached to a commit, in forge-neutral nouns. */
export interface ForgeCheckRun {
  name: string;
  outcome: "passing" | "failing" | "pending" | "neutral";
  /** The forge's one-line failure summary/description; "" when none. Never a full log. */
  summary: string;
  detailsUrl?: string;
}

export interface ForgeCiStatus {
  checks: ForgeCheckRun[];
  sso: SsoState;
}

// on ForgePort:
/** Per-check CI results for a commit — keyed by OID, never by branch. */
fetchCiStatus(ref: ForgePullRequestRef, headOid: string): Promise<ForgeCiStatus>;
```

**GitHub implementation:** one GraphQL query on `repository.object(oid: $headOid) ... on Commit { statusCheckRollup { state, contexts(first: 100) { nodes { ... on CheckRun { name status conclusion title summary detailsUrl } ... on StatusContext { context state description targetUrl } } } } }`. Both node kinds map into `ForgeCheckRun` (CheckRun `conclusion` and legacy StatusContext `state` each map to the four-value `outcome`; queued/in-progress/EXPECTED → `pending`; ERROR is a failure, per the `mapCi` precedent in `project-pr-source.ts`). `X-GitHub-SSO` is parsed on the response like every other call, and a `partial-results` SSO state rides out on `sso` so a truncated check set is never presented as complete. All HTTP goes through the injected `HttpFetch`; no test touches the network.

**Keyed by the pinned head.** The patchset pins `headOid` at review start, and `Review.postTarget` (present exactly on non-retrospective PR reviews, issue #21) carries `{repo, number, forgeRef, headOid}`. The CI fetch uses `postTarget.headOid` — checks attach to the commit, so the signal describes the code actually under review even if the branch has moved since (the same binding discipline as `patchsetId` on the flagged wire, #160). Local working-tree reviews have no `postTarget` → no fetch, no `ciSignal` field, pre-change shape. Retrospective reviews also omit `postTarget` → no signal (named deferral in the proposal).

**Adding a method to `ForgePort` is a breaking interface change** for in-repo fakes: every test double implementing the port gains a `fetchCiStatus` (the throwing default is fine for tests that never touch CI). No capability flag is added — GitHub is the only forge, and the honest-degradation path (any fetch failure → `unavailable`) already covers a forge that cannot answer.

## 2. Classification: deterministic-first, honest UNCLASSIFIED floor

**Where:** `packages/core/src/ci-classification.ts` — pure, model-free, $0, no I/O.

```ts
export type CiFailureVerdict = "change-caused" | "environmental" | "unclassified";

export interface CiFailure {
  checkName: string;
  verdict: CiFailureVerdict;
  /** The forge's failure summary excerpt — the evidence a human (or a finding) reads. */
  evidence: string;
  /** Changed paths the failure implicates; non-empty exactly when overlap made it change-caused. */
  implicatedPaths: string[];
  detailsUrl?: string;
  classifiedBy: "deterministic" | "model";
}

export function classifyCiFailures(
  checks: readonly ForgeCheckRun[],
  changedPaths: readonly string[],
): CiFailure[];
```

Rules, applied in order to each `failing` check:

1. **Environmental, by signature.** A versioned, conservative pattern table of infrastructure failure signatures matched against name + summary: runner lost/communication lost, "timed out waiting for", no space left on device, rate limit / secondary rate limit, ECONNRESET / ETIMEDOUT / DNS resolution, artifact-upload/download infrastructure errors, "cancelled" caused by a concurrency group. The table is deliberately narrow: only signatures that are *about the machinery* qualify. (A test timeout inside a test suite is NOT on this table — a slow test can be change-caused.)
2. **Change-caused, by overlap.** Real token overlap between the check's name + failure summary and the changeset's changed paths: full path matches, path-segment and file-stem matches, and project-name stems derived from changed paths (e.g. a changed `packages/core/src/…` matching a failing `core:test` target). This reuses the conservative-overlap spirit of `risk-crosscheck.ts` (#181) — a match requires a real, salient token, never an incidental stopword.
3. **Everything else → `unclassified`.**

**The bias, stated and inverted from #181.** In the risk cross-check the safe wrong answer is `open` (mildly redundant); here the DANGEROUS wrong answer is `environmental`, because it tells the reviewer "not your change" about a break that is. So uncertainty NEVER resolves to `environmental` — it resolves to `unclassified`, a visible FYI whose copy explicitly says Rennet could not attribute it and the human should look. A red-proof test pins this: make the classifier default uncertain failures to `environmental` and watch the "uncertain is visible" test fire.

**The ratchet.** A deterministic `change-caused` verdict is final: no later stage (including the model refinement) may demote it. Demotion only ever moves toward visibility (`unclassified` → `change-caused` or `environmental`), never away from it.

**Optional model refinement (the council seat).** A new catalogue job `ci-failure-classification` (light tier, batched — a table edit in `model-council.ts`, per the council doctrine; Table 1 resolves light-tier volume to the Codex seat when both harnesses are installed). One batched turn over ONLY the `unclassified` failures, given each failure's name + summary and the changed-path list, with a `CI_CLASSIFICATION_CONTRACT` in `@rennet/instructions`. It draws from the SAME shared review invocation budget (`sharedBudget` in `runFlaggedReviewWithContextFeed`) — it METERS and REPORTS like the hypothesis and verification passes, and on budget refusal, missing adapter, or a failed/invalid turn the deterministic verdicts simply stand. It never refuses the review. Verdicts it returns are stamped `classifiedBy: "model"`.

## 3. The finding-vs-FYI split

**Change-caused → findings.** Each `change-caused` failure folds into the `FlaggedReview.findings` array as an additive `FindingElement`:

- `findingId`: minted deterministically from `(patchsetId, checkName)` — never model-minted (the "agents never mint identity" rule; here the producer is deterministic code).
- `anchor`: resolved against the OFFERED hunk manifest — the first offered hunk in an implicated changed path. A failure whose implicated paths resolve to no offered hunk stays panel-only (it still rides `ciSignal` with its verdict): a finding with an unresolvable anchor is the hallucinated-location failure class `finding-generation.ts` already culls, and we do not reintroduce it from the deterministic side.
- `severity`: `high`. Rationale: an actually-failing check attributable to the change is the strongest evidence class the lens carries — the break is not hypothesised, it already happened on a machine.
- `agreement`: `{ kind: "concur", agree: 1, total: 1 }` — the honest single-judge shape the quick single-seat review already uses.
- `verification`: `{ verdict: "reproduced", evidence: "CI: <checkName> — <summary excerpt>" }`. CI *is* the reproduction; the #179 verification pass SKIPS CI-derived findings (no model turn is spent re-proving a machine fact, and the budget is not taxed).

The fold happens AFTER the verification pass and the risk cross-check (#181) in `runFlaggedReviewWithContextFeed` — CI findings are appended last, so verification never sees them and the cross-check reconciles the hypothesis against the model findings exactly as today.

**Environmental + unclassified → FYI.** They never become findings. They ride `ciSignal` and render in the signal panel, clearly labelled, collapsible-as-noise but never hidden by default and never auto-suppressed. An `unclassified` failure's copy is the anti-rubber-stamp sentence: attribution unknown — check it yourself.

## 4. The wire contract (`packages/protocol`)

New schemas, hand-written like every wire shape here:

```ts
export const ciFailureVerdictSchema = z.enum(["change-caused", "environmental", "unclassified"]);
export const ciFailureSchema = objectSchemaFor<CiFailure>()({ … });
export const ciSignalSchema: z.ZodType<CiSignal> = z.union([
  z.object({
    status: z.literal("checked"),
    overall: z.enum(["passing", "failing", "pending"]),
    failures: z.array(ciFailureSchema), // empty when overall is passing/pending
    headOid: z.string().min(1),         // the pinned head the checks describe
    /** True when SSO partial-results may have truncated the check set. */
    incomplete: z.boolean(),
  }),
  z.object({ status: z.literal("no-checks"), headOid: z.string().min(1) }),
  z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }),
]);
```

`ciSignal: ciSignalSchema.optional()` is added to BOTH `flaggedReviewSchema` branches — the `ok` branch (beside `hypothesis`/`crossChecks`) and the `failed` branch, because the CI facts do not depend on the model runner: a failed model review with a red CI is exactly when the FYI earns its keep. Absent ⇒ no PR review (local/retrospective), the pre-change shape; every existing snapshot and fixture validates unchanged.

**This field MUST be declared in the schema or the `flagged.review` command boundary strips it silently** — the strict-`z.object` stripping failure class the `findingVerificationSchema` (#179) and `riskCrossCheckSchema` (#181) comments both document (Rule 80: a delivery gap, the UI would honestly-looking render "no CI signal" forever). A strip-proof round-trip test guards it: build an `ok` review with a populated `ciSignal`, parse it through `flaggedReviewSchema`, assert the field survives byte-identically. Red-proof: delete the field from the schema and watch the test fire.

The `CiFailure`/`CiSignal` TYPES live in `@rennet/types` (imported by protocol via `objectSchemaFor<T>()`, by core for the classifier, and by ui for the fold — `ui` may import only `types`/`protocol`, which this respects).

## 5. Composition: where fetch → classify → fold runs

**Where:** `runFlaggedReviewWithContextFeed` in `apps/desktop/src/main/index.ts` (the live Flagged runner behind the `flagged.review` dispatch, `dispatch.ts` case `"flagged.review"`).

```
postTarget present?
  ├─ no  → no ciSignal at all (pre-change shape)
  └─ yes → try {
        forge.fetchCiStatus(postTarget → ref, postTarget.headOid)
        classifyCiFailures(failing checks, patchset changed paths)
        [optional] refine unclassified via council seat (shared budget)
      } catch/timeout → ciSignal = { status: "unavailable", reason }
      then: append change-caused findings (anchor-resolved), attach ciSignal
```

The whole block is wrapped so NO throw escapes: network failure, auth failure, a malformed GraphQL payload, a timeout — every one resolves to `unavailable` with a reason string, and the flagged review the model seats produced is returned exactly as it would have been. The forge adapter is constructed from the same auth ladder (`resolveGitHubAuth`) the existing PR paths use; no new credential handling.

**Never-blocks, proven not asserted:** tests pin that (a) a throwing `fetchCiStatus` yields `unavailable` and leaves the model findings untouched, and (b) the publish path (`publish.requestConsent` / `publish.review` dispatch) behaves byte-identically under `ciSignal` passing, failing, and unavailable — no dispatch handler reads CI state to decide anything. Red-proof for (b): make a publish handler consult `ciSignal` and watch the invariance test fire.

## 6. The UI surface (`packages/ui`)

**Reuse the Flagged lens; build no new lens.** The fold in `packages/ui/src/canvas/flagged.ts` carries `ciSignal` through to the index, and `components/flagged.tsx` gains a `CiSignalPanel` rendered with the existing header affordances (beside `DualBadge`), above the finding rows:

- `checked` + failures: one line per environmental failure ("CI — environmental (infra): <check>", with the evidence excerpt and `detailsUrl` link) and per unclassified failure ("CI — unclassified: <check> — Rennet could not attribute this; check it yourself"). Change-caused failures are NOT duplicated in the panel body — they are finding rows in the index below; the panel shows their count and that they appear as findings.
- `checked` + `overall: "passing"`: one quiet line — "CI: all checks passing on the reviewed head".
- `checked` + `incomplete: true`: the partial-results caveat renders (the SSO doctrine: a truncated surface never renders as complete).
- `no-checks`: "no CI checks reported for the reviewed head" — honest none, never implied-passing (the `smartListCi` "none" precedent).
- `unavailable`: "CI status unavailable — <reason>", one line, no drama, no block.
- field absent (local review): the panel does not render at all.

The panel is collapsible (dismiss-as-noise) but expanded by default and never auto-hidden while failures exist. DOM tests cover each state distinctly — the "two nothings" law of this lens (honestly-empty vs failed) extends to CI: "passing", "no checks", and "unavailable" are three different sentences, never conflated.

## 7. Budget

The deterministic path is $0 and always runs (when a `postTarget` exists). The refinement seat draws from the one shared per-review invocation budget (`sharedBudget`), counts toward the configured ceiling exactly like the hypothesis and verification turns, and its spend is visible through the same metering. Refusal degrades the *refinement*, never the signal and never the review.

## 8. Fixtures and the dogfood boundary

All adapter tests use the injected `HttpFetch` with synthetic GraphQL check payloads; `flagged-fixture.ts` gains `ciSignal` examples for the UI states. Live dogfood runs only against Rennet's own repository CI (`rbutera/rennet`). Never a client repository's CI, code, or infrastructure — fixed boundary, restated here because CI is infrastructure.

## 9. Explicitly not designed here

Re-running CI; downloading/parsing full job logs (the forge's summary/description excerpt is the entire evidence budget); verify-ui (#183); any CI influence on sign/publish; retrospective-review CI (needs a `postTarget`-shaped read-only ref first); base-branch differential classification.
