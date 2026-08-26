import type { FindingProvenanceSeed } from "@rennet/core";
import {
  buildOfferedManifest,
  createInvocationBudget,
  DEFAULT_MAX_HARNESS_INVOCATIONS,
  decompose,
  describeVerificationCost,
  runFindingAngle,
  runFindingVerification,
} from "@rennet/core";
import type { Patchset } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createClaudeHarness } from "./claude-query";
import {
  createVerificationFileReader,
  createVerificationTurn,
} from "./finding-verification-backend";
import { captureRangePatchset, execaGit } from "./git-range-diff";
import { createInstrumentedRunTurn, createMetricsCollector } from "./turn-metrics";

// ─────────────────────────────────────────────────────────────────────────────
// PER-FINDING VERIFICATION COST harness (#179, Rai's "MEASURE the verification
// cost" ask). It drives a REAL Flagged review against a dogfood target — Rennet
// reviewing a previously merged Rennet PR (a git range, no live GitHub fetch) —
// then runs the reproduce-or-refute verification pass over the real findings, and
// records the DELTA it pays ON TOP of the ~294K single-review baseline (see
// ~/expedition/Rennet Cost Baseline.md): "+N turns / +M tokens for K verified
// findings", plus the cap it applied.
//
//   • Claude finding turn — instrumented (real tokens off the SDK result frame).
//   • Verification turns — measured off what `createVerificationTurn` returns
//     (usage threaded from the terminal frame) + wall-clock latency, one per file
//     batch, bounded by `maxVerifications`.
//
// It spends NO metered tokens but DOES spend subscription quota and needs a
// discoverable `claude`, so it is SKIPPED unless RENNET_VERIFY_COST=1:
//
//   RENNET_VERIFY_COST=1 RENNET_VERIFY_METRICS_OUT=/abs/verify.json \
//     pnpm exec vitest run packages/adapters/src/finding-verification-cost.real.test.ts
//
// Optional RENNET_BASE_OID / RENNET_HEAD_OID / RENNET_REPO_ROOT override the target.
// ─────────────────────────────────────────────────────────────────────────────

const RUN = process.env.RENNET_VERIFY_COST === "1";
const REPO_ROOT = process.env.RENNET_REPO_ROOT ?? process.cwd();
const BASE_OID = process.env.RENNET_BASE_OID ?? "5956d96";
const HEAD_OID = process.env.RENNET_HEAD_OID ?? "88ce92c";

/** The single-review baseline (all turns), for the DELTA comparison (~/expedition/Rennet Cost Baseline.md). */
const BASELINE_TOTAL_TOKENS = 294_000;

const SEED: FindingProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "unknown",
  adapterVersion: "0.0.0",
  model: "unknown",
  modelReportedBy: "unknown",
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

function line(text: string): void {
  process.stdout.write(`${text}\n`);
}

describe("rennet per-finding verification — cost (gated real turns)", () => {
  it.skipIf(!RUN)(
    "measures the reproduce-or-refute delta over the single-review baseline",
    async () => {
      const { adapter, discovery } = await createClaudeHarness({ env: process.env });
      expect(
        adapter,
        `no claude binary discovered: ${JSON.stringify(discovery.health)}`,
      ).not.toBeNull();
      if (!adapter) return;

      const patchset: Patchset = await captureRangePatchset(execaGit, {
        root: REPO_ROOT,
        baseOid: BASE_OID,
        headOid: HEAD_OID,
        baseRef: "main",
      });
      const decomposition = decompose(patchset);
      const manifest = buildOfferedManifest(decomposition);

      // ── 1. A real Flagged review to produce the findings we then verify ────────
      const collector = createMetricsCollector();
      const findingResult = await runFindingAngle({
        patchsetId: patchset.id,
        manifest,
        provenance: SEED,
        runTurn: createInstrumentedRunTurn(
          adapter,
          { docType: "finding", cwd: REPO_ROOT },
          collector,
          "finding",
        ),
        budget: createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS),
      });
      const findings = findingResult.status === "ok" ? findingResult.findings : [];
      line(
        `\ndogfood ${BASE_OID}...${HEAD_OID}: ${patchset.files.length} files → ${findings.length} findings`,
      );

      // ── 2. The verification pass over the real findings ────────────────────────
      const readFileWindow = createVerificationFileReader({
        hunks: decomposition.hunks,
        repositoryRoot: REPO_ROOT,
      });
      let verifyLatencyMs = 0;
      const measuredVerifyTurn = createVerificationTurn(adapter, { cwd: REPO_ROOT });
      const result = await runFindingVerification({
        findings,
        manifest,
        readFileWindow,
        runTurn: async (prompt: string) => {
          const started = Date.now();
          const outcome = await measuredVerifyTurn(prompt);
          verifyLatencyMs += Date.now() - started;
          return outcome;
        },
        budget: createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS),
      });

      const { telemetry } = result;
      line("");
      line("=== RENNET PER-FINDING VERIFICATION COST (#179) ===");
      line(`  ${describeVerificationCost(telemetry, BASELINE_TOTAL_TOKENS)}`);
      line(
        `  candidates ${telemetry.candidates} · reproduced ${telemetry.reproduced} · refuted(dropped) ${telemetry.refuted} · inconclusive ${telemetry.inconclusive}`,
      );
      line(`  verification turns latency: ${Math.round(verifyLatencyMs)}ms`);
      line(
        `  capped: ${telemetry.cappedFindingIds.length} · budget-refused: ${telemetry.budgetRefusedFindingIds.length}`,
      );
      line(
        `  surfaced findings after verification: ${result.findings.length} (of ${findings.length} raised)`,
      );

      const out = process.env.RENNET_VERIFY_METRICS_OUT;
      if (out) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(out, JSON.stringify({ telemetry, verifyLatencyMs }, null, 2));
        line(`\nwrote metrics → ${out}`);
      }

      // The invariant the measurement must honour: a refuted finding is DROPPED, so
      // the surfaced set never exceeds the raised set, and nothing is fabricated.
      expect(result.findings.length).toBeLessThanOrEqual(findings.length);
      expect(telemetry.verificationTurns).toBeGreaterThanOrEqual(0);
    },
    600_000,
  );
});
