import {
  ADJUDICATION_CORPUS,
  type AdjudicationOutcome,
  createHarnessRunTurn,
  createInvocationBudget,
  type FindingProvenanceSeed,
  resolveAssignment,
  resolveDualSeat,
  runDualFindingReview,
  runFindingAdjudication,
  scoreAdjudicationCalibration,
} from "@rennet/core";
import type { CouncilResolveContext, FindingAdjudicationVerdict } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createClaudeAdjudicationTurn, createCodexAdjudicationTurn } from "./adjudication-backend";
import { recordAdjudicationCalibration } from "./adjudication-calibration";
import { createClaudeHarness } from "./claude-query";
import { createCodexExecutor, createCodexUtilityAdapter } from "./codex-exec";
import { createCodexHarness } from "./codex-turn-transport";

// ─────────────────────────────────────────────────────────────────────────────
// Gated MANUAL real adjudication-calibration run (#41, task 5.1).
//
// Drives BOTH the user's real installed finding seats over each synthetic corpus
// item, reconciles, adjudicates the contested rows on the seat the council resolves
// for the `adjudication` job, scores overlap vs adjudication against the KNOWN truth,
// and RECORDS the per-class calibration table into the committed
// `adjudication-calibration.json` artifact. It authenticates on the user's own
// subscriptions (no metered tokens) but spends quota and needs both binaries, so it
// is SKIPPED unless RENNET_LIVE_ADJUDICATION=1 and NEVER runs in the normal gate.
//
//   RENNET_LIVE_ADJUDICATION=1 pnpm exec vitest run \
//     packages/adapters/src/adjudication-calibration.real.test.ts
//
// The corpus is Rennet-authored SYNTHETIC data only — never client data (fixed
// boundary). The committed table is informational; nothing gates on it.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.RENNET_LIVE_ADJUDICATION === "1";

const BASE_SEED: FindingProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "real",
  adapterVersion: "real",
  model: "real",
  modelReportedBy: "config",
  capability: {
    structuredOutput: {
      implementedByAdapter: true,
      advertisedByHarness: true,
      availableInSession: true,
    },
    perCallModelSelection: {
      implementedByAdapter: true,
      advertisedByHarness: true,
      availableInSession: true,
    },
  },
};

function idFactory() {
  let n = 0;
  return () => `0000000000000000000000000${n++}`.slice(-26);
}

describe("adjudication calibration — real dual harness (gated)", () => {
  it.skipIf(!LIVE)(
    "measures overlap vs adjudication over the corpus and records the table",
    async () => {
      const { adapter: claude, discovery: claudeDiscovery } = await createClaudeHarness();
      const { adapter: codex, discovery: codexDiscovery } = await createCodexHarness();
      expect(claude, "the calibration run needs a real claude binary").not.toBeNull();
      expect(codex, "the calibration run needs a real codex binary").not.toBeNull();
      if (!claude || !codex) return;

      const cwd = process.cwd();
      const council: CouncilResolveContext = {
        availability: { installed: ["claude-code", "codex"] },
      };
      const executor = createCodexExecutor();

      // The resolved adjudication seat (under `both` a different family than either
      // reviewer) and its real turn executor — provenance follows the model.
      const adjResolution = resolveAssignment("adjudication", council);
      if (adjResolution.kind !== "model") throw new Error("expected a model adjudication seat");
      const adjudicatedBy = `${adjResolution.model} (${adjResolution.harness})`;
      const adjudicationTurn =
        adjResolution.harness === "codex"
          ? createCodexAdjudicationTurn(executor, {
              model: adjResolution.model,
              effort: adjResolution.effort,
            })
          : createClaudeAdjudicationTurn(claude, { cwd, model: adjResolution.model });

      const outcomes: AdjudicationOutcome[] = [];
      for (const item of ADJUDICATION_CORPUS) {
        const seats = resolveDualSeat({
          council,
          jobId: "finding-generation",
          docType: "finding",
          patchsetId: item.id,
          manifest: item.manifest,
          baseSeed: BASE_SEED,
          claudeTurn: createHarnessRunTurn(claude, { docType: "finding", cwd }),
          codexPort: createCodexUtilityAdapter({ executor }),
        });
        const { review } = await runDualFindingReview({
          deepReview: true,
          patchsetId: item.id,
          manifest: item.manifest,
          seats,
          budget: createInvocationBudget(6),
          mintDocId: idFactory(),
          newRunId: () => "calibration",
        });
        if (review.status !== "ok") {
          outcomes.push({ id: item.id, overlapFlagged: false });
          continue;
        }
        // Overlap's raw answer: did any row stand for this item after reconcile?
        const overlapFlagged = review.findings.length > 0;
        const adjudicated = await runFindingAdjudication({
          findings: review.findings,
          manifest: item.manifest,
          readFileWindow: async () => undefined,
          runTurn: adjudicationTurn,
          adjudicatedBy,
          budget: createInvocationBudget(6),
        });
        const contested = adjudicated.findings.find(
          (f) => f.agreement.kind === "disagree" && f.agreement.adjudication !== undefined,
        );
        const verdict: FindingAdjudicationVerdict | undefined =
          contested?.agreement.kind === "disagree"
            ? contested.agreement.adjudication?.verdict
            : undefined;
        outcomes.push({
          id: item.id,
          overlapFlagged,
          ...(verdict ? { adjudicatedVerdict: verdict } : {}),
        });
      }

      const classes = scoreAdjudicationCalibration(ADJUDICATION_CORPUS, outcomes);
      const recorded = await recordAdjudicationCalibration({
        binaries: {
          "claude-code": claudeDiscovery.chosen?.version ?? "unknown",
          codex: codexDiscovery.chosen?.version ?? "unknown",
        },
        classes,
      });
      expect(recorded.recordedAt).toBeTruthy();
      expect(recorded.classes.length).toBeGreaterThan(0);
    },
    600_000,
  );
});
