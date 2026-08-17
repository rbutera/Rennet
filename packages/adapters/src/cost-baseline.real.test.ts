import { writeFileSync } from "node:fs";
import {
  buildOfferedManifest,
  buildReviewCanvases,
  createInvocationBudget,
  DEFAULT_MAX_HARNESS_INVOCATIONS,
  decompose,
  guardSeatTurn,
  runDecisionAngle,
  runFindingAngle,
  runHypothesisPass,
  runNoiseAngle,
} from "@rennet/core";
import type { HypothesisStructure, Patchset } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createClaudeHarness } from "./claude-query";
import { captureRangePatchset, execaGit } from "./git-range-diff";
import { createInstrumentedRunTurn, createMetricsCollector, type TurnMetric } from "./turn-metrics";

// ─────────────────────────────────────────────────────────────────────────────
// COST BASELINE harness (measure-first, Rai's ask 2026-08-10).
//
// Drives the REAL live review producers against a dogfood target — Rennet
// reviewing a previously merged Rennet PR (a git range, no live GitHub fetch) —
// on the user's own `claude` (subscription OAuth, $0 metered), and records per
// model turn: model, input/output/cache tokens, and wall-clock latency, via the
// `turn-metrics` instrumentation seam. It measures the four core producers the
// intelligence-core build will later measure its DELTA against:
//
//   decomposition.proposal  (buildReviewCanvases → runDecompositionAngle)
//   finding                 (runFlaggedReview    → runFindingAngle)
//   decision.record         (runDecisionsForReview→ runDecisionAngle)
//   noise                   (runNoiseReview      → runNoiseAngle)
//
// plus the two secondary turns review.canvases also drives (ordering, rollup
// narration), AND the new hypothesis-first pre-read pass (#178) so its own token
// cost is measurable against the ~294K baseline. Each producer runs with its OWN
// invocation budget exactly as the production commands do (they are separate
// budget-gated user actions).
//
// It spends NO metered tokens but DOES spend subscription quota and needs a
// discoverable `claude`, so it is SKIPPED unless RENNET_COST_BASELINE=1:
//
//   RENNET_COST_BASELINE=1 RENNET_METRICS_OUT=/abs/metrics.json \
//     pnpm exec vitest run packages/adapters/src/cost-baseline.real.test.ts
//
// Optional: RENNET_BASE_OID / RENNET_HEAD_OID / RENNET_REPO_ROOT override the
// dogfood target (default: PR #109, 5956d96...88ce92c on this repo).
// ─────────────────────────────────────────────────────────────────────────────

const RUN = process.env.RENNET_COST_BASELINE === "1";

const REPO_ROOT = process.env.RENNET_REPO_ROOT ?? process.cwd();
const BASE_OID = process.env.RENNET_BASE_OID ?? "5956d96";
const HEAD_OID = process.env.RENNET_HEAD_OID ?? "88ce92c";
const METRICS_OUT = process.env.RENNET_METRICS_OUT ?? "";

// Capability layers set true because these paths DO constrain structured output
// through the adapter (mirrors the seeds in apps/desktop/src/main/index.ts). The
// model label is a placeholder in provenance; the MEASURED model comes off the
// live session.started frame, recorded by the instrumentation seam.
const SEED = {
  harness: "claude-code",
  harnessVersion: "unknown",
  adapterVersion: "0.0.0",
  model: "unknown",
  modelReportedBy: "unknown" as const,
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

function summarize(metrics: readonly TurnMetric[]): void {
  const line = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  line("");
  line("=== RENNET COST BASELINE — per model turn ===");
  line(
    [
      "label".padEnd(22),
      "att".padStart(3),
      "status".padEnd(9),
      "in".padStart(9),
      "out".padStart(8),
      "cacheR".padStart(9),
      "cacheW".padStart(8),
      "total".padStart(9),
      "ms".padStart(8),
      "usd",
    ].join(" "),
  );
  let tIn = 0;
  let tOut = 0;
  let tCacheR = 0;
  let tCacheW = 0;
  let tTot = 0;
  let tMs = 0;
  for (const m of metrics) {
    const u = m.usage;
    line(
      [
        m.label.padEnd(22),
        String(m.attempt).padStart(3),
        m.status.padEnd(9),
        String(u?.inputTokens ?? "-").padStart(9),
        String(u?.outputTokens ?? "-").padStart(8),
        String(u?.cacheReadTokens ?? "-").padStart(9),
        String(u?.cacheCreationTokens ?? "-").padStart(8),
        String(u?.totalTokens ?? "-").padStart(9),
        String(Math.round(m.latencyMs)).padStart(8),
        u?.reportedUsd == null ? "-" : u.reportedUsd.toFixed(4),
      ].join(" "),
    );
    tIn += u?.inputTokens ?? 0;
    tOut += u?.outputTokens ?? 0;
    tCacheR += u?.cacheReadTokens ?? 0;
    tCacheW += u?.cacheCreationTokens ?? 0;
    tTot += u?.totalTokens ?? 0;
    tMs += m.latencyMs;
  }
  line("-".repeat(96));
  line(
    [
      `TOTAL (${metrics.length} turns)`.padEnd(22),
      "".padStart(3),
      "".padEnd(9),
      String(tIn).padStart(9),
      String(tOut).padStart(8),
      String(tCacheR).padStart(9),
      String(tCacheW).padStart(8),
      String(tTot).padStart(9),
      String(Math.round(tMs)).padStart(8),
      "",
    ].join(" "),
  );
  const models = [...new Set(metrics.map((m) => m.model).filter(Boolean))];
  const auth = [...new Set(metrics.map((m) => m.apiKeySource).filter(Boolean))];
  line(
    `model(s): ${models.join(", ") || "unknown"}   apiKeySource: ${auth.join(", ") || "unknown"}`,
  );
  line(`quota proxy: ${metrics.length} turns, ${tTot} total tokens throughput`);
  line("");
}

describe("rennet review pipeline — cost baseline (gated real turns)", () => {
  it.skipIf(!RUN)(
    "measures per-turn token cost + latency across the live producers on a dogfood PR",
    async () => {
      const { adapter, discovery } = await createClaudeHarness({ env: process.env });
      expect(
        adapter,
        `no claude binary discovered: ${JSON.stringify(discovery.health)}`,
      ).not.toBeNull();
      if (!adapter) return;

      // The dogfood patchset: a real merged Rennet PR as an immutable git range.
      const patchset: Patchset = await captureRangePatchset(execaGit, {
        root: REPO_ROOT,
        baseOid: BASE_OID,
        headOid: HEAD_OID,
        baseRef: "main",
      });
      process.stdout.write(
        `\ndogfood target ${BASE_OID}...${HEAD_OID}: ${patchset.files.length} files, ${patchset.byteLength} diff bytes\n`,
      );

      const collector = createMetricsCollector();
      const decomposition = decompose(patchset);
      const manifest = buildOfferedManifest(decomposition);

      // ── The hypothesis-first pre-read pass (#178) — measured against baseline ──
      const structure: HypothesisStructure = {
        changedFiles: patchset.files.map((file) => file.path),
        chunkTitles: decomposition.chunks.map((chunk) => chunk.title),
      };
      await runHypothesisPass({
        patchsetId: patchset.id,
        manifest,
        structure,
        provenance: SEED,
        runTurn: guardSeatTurn(
          createInstrumentedRunTurn(
            adapter,
            { docType: "review.hypothesis", cwd: REPO_ROOT },
            collector,
            "review.hypothesis",
          ),
        ),
        budget: createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS),
      });

      // ── The three lens producers, each its own budget-gated command ──────────
      await runFindingAngle({
        patchsetId: patchset.id,
        manifest,
        provenance: SEED,
        runTurn: guardSeatTurn(
          createInstrumentedRunTurn(
            adapter,
            { docType: "finding", cwd: REPO_ROOT },
            collector,
            "finding",
          ),
        ),
        budget: createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS),
      });

      await runDecisionAngle({
        patchsetId: patchset.id,
        manifest,
        provenance: SEED,
        runTurn: guardSeatTurn(
          createInstrumentedRunTurn(
            adapter,
            { docType: "decision.record", cwd: REPO_ROOT },
            collector,
            "decision.record",
          ),
        ),
        budget: createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS),
      });

      await runNoiseAngle({
        patchsetId: patchset.id,
        manifest,
        provenance: SEED,
        noiseJobModel: "Claude",
        runTurn: guardSeatTurn(
          createInstrumentedRunTurn(
            adapter,
            { docType: "noise", cwd: REPO_ROOT },
            collector,
            "noise",
          ),
        ),
        budget: createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS),
      });

      // ── review.canvases: decomposition (+ ordering + rollup narration) ───────
      await buildReviewCanvases({
        reviewId: `cost-baseline-${patchset.id.slice(0, 8)}`,
        patchset,
        dispositions: [],
        budget: createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS),
        provenance: SEED,
        runDecompositionTurn: createInstrumentedRunTurn(
          adapter,
          { docType: "decomposition.proposal", cwd: REPO_ROOT },
          collector,
          "decomposition.proposal",
        ),
        runOrderingTurn: createInstrumentedRunTurn(
          adapter,
          { docType: "ordering", cwd: REPO_ROOT },
          collector,
          "ordering",
        ),
        runNarrationTurn: createInstrumentedRunTurn(
          adapter,
          { docType: "rollup-narration", cwd: REPO_ROOT },
          collector,
          "rollup-narration",
        ),
      });

      summarize(collector.metrics);
      if (METRICS_OUT) {
        writeFileSync(
          METRICS_OUT,
          JSON.stringify(
            {
              target: {
                baseOid: BASE_OID,
                headOid: HEAD_OID,
                files: patchset.files.length,
                diffBytes: patchset.byteLength,
              },
              capturedAt: new Date().toISOString(),
              metrics: collector.metrics,
            },
            null,
            2,
          ),
        );
        process.stdout.write(`metrics written to ${METRICS_OUT}\n`);
      }

      // At least the four core producers each ran at least one real turn.
      const labels = new Set(collector.metrics.map((m) => m.label));
      expect(labels.has("finding")).toBe(true);
      expect(labels.has("decision.record")).toBe(true);
      expect(labels.has("noise")).toBe(true);
      expect(labels.has("decomposition.proposal")).toBe(true);
      // The new hypothesis pass also produced a measured turn.
      expect(labels.has("review.hypothesis")).toBe(true);
      // Every turn was measured (a metric exists) and ran on the unmetered path.
      for (const m of collector.metrics) {
        expect(["oauth", "none", null]).toContain(m.apiKeySource);
      }
    },
    900_000,
  );
});
