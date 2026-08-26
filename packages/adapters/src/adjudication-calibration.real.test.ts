import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  ADJUDICATION_CORPUS,
  type AdjudicationOutcome,
  createHarnessRunTurn,
  createInvocationBudget,
  DEFAULT_REVIEW_INTELLIGENCE_BUDGET,
  type FindingProvenanceSeed,
  findCalibrationClaim,
  resolveAssignment,
  resolveDualSeat,
  reviewInvocationCeiling,
  runDualFindingReview,
  runFindingAdjudication,
  scoreAdjudicationCalibration,
} from "@rennet/core";
import type { CouncilResolveContext, FindingAdjudicationVerdict } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createClaudeAdjudicationTurn, createCodexAdjudicationTurn } from "./adjudication-backend";
import { recordCommittedAdjudicationCalibration } from "./adjudication-calibration";
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
const execFileAsync = promisify(execFile);

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

      const council: CouncilResolveContext = {
        availability: { installed: ["claude-code", "codex"] },
      };
      const executor = createCodexExecutor();

      // The resolved adjudication seat (under `both` a different family than either
      // reviewer) and its real turn executor — provenance follows the model.
      const adjResolution = resolveAssignment("adjudication", council);
      if (adjResolution.kind !== "model") throw new Error("expected a model adjudication seat");
      const adjudicatedBy = `${adjResolution.model} (${adjResolution.harness})`;
      const outcomes: AdjudicationOutcome[] = [];
      let contestedItems = 0;
      let actualAdjudicationTurns = 0;
      for (const item of ADJUDICATION_CORPUS) {
        const repository = await mkdtemp(join(tmpdir(), `rennet-adjudication-${item.id}-`));
        try {
          const file = join(repository, item.filePath);
          await mkdir(dirname(file), { recursive: true });
          const occurrence = item.manifest.occurrences.find(
            (candidate) => candidate.id === item.claimAnchor.split("/").at(-1),
          );
          if (!occurrence) throw new Error(`Missing corpus occurrence for ${item.id}`);
          const source = [
            ...(occurrence.sides?.context ?? []),
            ...(occurrence.sides?.additions ?? []),
          ].join("\n");
          await writeFile(file, `${source}\n`, "utf8");
          await execFileAsync("git", ["init", "--quiet"], { cwd: repository });

          // Production has ONE ceiling across generation and post-hoc adjudication.
          const budget = createInvocationBudget(
            reviewInvocationCeiling(DEFAULT_REVIEW_INTELLIGENCE_BUDGET, true),
          );
          const seats = resolveDualSeat({
            council,
            jobId: "finding-generation",
            docType: "finding",
            patchsetId: item.id,
            manifest: item.manifest,
            baseSeed: BASE_SEED,
            claudeTurn: createHarnessRunTurn(claude, {
              docType: "finding",
              cwd: repository,
            }),
            codexPort: createCodexUtilityAdapter({ executor }),
          });
          const { review } = await runDualFindingReview({
            deepReview: true,
            patchsetId: item.id,
            manifest: item.manifest,
            seats,
            budget,
            mintDocId: idFactory(),
            newRunId: () => "calibration",
          });
          if (review.status !== "ok") {
            throw new Error(`Calibration review failed for ${item.id}: ${review.reason}`);
          }

          const claim = findCalibrationClaim(item, review.findings);
          const overlapFlagged = claim !== undefined;
          let verdict: FindingAdjudicationVerdict | undefined;
          if (claim?.agreement.kind === "disagree") {
            contestedItems += 1;
            const adjudicationTurn =
              adjResolution.harness === "codex"
                ? createCodexAdjudicationTurn(executor, {
                    model: adjResolution.model,
                    effort: adjResolution.effort,
                  })
                : createClaudeAdjudicationTurn(claude, {
                    cwd: repository,
                    model: adjResolution.model,
                  });
            let adjudicationFailed = false;
            const adjudicated = await runFindingAdjudication({
              findings: [claim],
              manifest: item.manifest,
              readFileWindow: async () => {
                const text = await readFile(file, "utf8");
                return {
                  path: item.filePath,
                  startLine: 1,
                  endLine: Math.max(1, text.trimEnd().split("\n").length),
                  text: text.trimEnd(),
                };
              },
              runTurn: async (prompt) => {
                try {
                  const result = await adjudicationTurn(prompt);
                  if (result.status === "failed") adjudicationFailed = true;
                  return result;
                } catch (error) {
                  adjudicationFailed = true;
                  throw error;
                }
              },
              adjudicatedBy,
              budget,
            });
            actualAdjudicationTurns += adjudicated.telemetry.adjudicationTurns;
            const adjudicatedClaim = adjudicated.findings[0];
            verdict =
              adjudicatedClaim?.agreement.kind === "disagree"
                ? adjudicatedClaim.agreement.adjudication?.verdict
                : undefined;
            if (adjudicationFailed || adjudicated.telemetry.adjudicationTurns !== 1 || !verdict) {
              throw new Error(`Contested calibration claim did not run a turn: ${item.id}`);
            }
          }
          outcomes.push({
            id: item.id,
            claimAnchor: item.claimAnchor,
            claimSummary: item.claimSummary,
            overlapFlagged,
            ...(verdict ? { adjudicatedVerdict: verdict } : {}),
          });
        } finally {
          await rm(repository, { recursive: true, force: true });
        }
      }

      expect(outcomes).toHaveLength(ADJUDICATION_CORPUS.length);
      expect(contestedItems, "the corpus run must produce contested seeded claims").toBeGreaterThan(
        0,
      );
      expect(actualAdjudicationTurns).toBe(contestedItems);
      const classes = scoreAdjudicationCalibration(ADJUDICATION_CORPUS, outcomes);
      const recorded = await recordCommittedAdjudicationCalibration({
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
