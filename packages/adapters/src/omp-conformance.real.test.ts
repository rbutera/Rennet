import { runConformance } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { matchesConformanceMatrix, recordTestedRange } from "./harness-tested-range";
import { createOmpHarness } from "./omp-turn-transport";

// ─────────────────────────────────────────────────────────────────────────────
// Gated MANUAL real conformance run (#26, task 4.3) — the `RENNET_LIVE_CODEX` precedent.
//
// Runs the cross-adapter conformance suite against the user's REAL installed `omp`
// binary (`omp --mode rpc`, executed by Bun), one real turn per check. It authenticates
// on the user's own omp configuration and spends the user's quota, so it is SKIPPED
// unless RENNET_LIVE_OMP=1 and NEVER runs in the normal gate:
//
//   RENNET_LIVE_OMP=1 pnpm exec vitest run packages/adapters/src/omp-conformance.real.test.ts
//
// The committed expectation below is what the DOCUMENTED-shape hermetic fake proves.
// Because no turn has ever been executed against omp, the FIRST real run is the moment
// of truth: if the observed frames diverge from the documented shapes, this test fails
// LOUD (matrix mismatch), and the fix is to correct the fake and decoders against the
// observed bytes and update this matrix — never the reverse. Only a full expected-matrix
// match records the omp version into `harness-tested-range.json` (no entry until then).
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.RENNET_LIVE_OMP === "1";
const EXPECTED_OMP_MATRIX = {
  passed: ["interrupt", "structuredOutput", "textDeltas"],
  failed: ["costUsd", "reportsContextWindow"],
} as const;

describe("omp conformance — real omp (gated)", () => {
  it.skipIf(!LIVE)(
    "certifies omp over the real binary and records its tested range on a full match",
    async () => {
      const { adapter, discovery } = await createOmpHarness();
      expect(
        adapter,
        `no runnable omp slot discovered (omp + Bun): ${JSON.stringify(discovery.health)}`,
      ).not.toBeNull();
      if (!adapter) return;

      const report = await runConformance(adapter, { real: true, cwd: process.cwd() });
      expect(report.controlDemonstrated).toBe(true);
      // First-run divergence between the documented shapes and the observed wire bytes
      // surfaces HERE. On mismatch, correct the fake/decoders + this matrix; do NOT record.
      expect(
        matchesConformanceMatrix(report, EXPECTED_OMP_MATRIX),
        `omp conformance matrix diverged from the documented shapes — passed=${JSON.stringify(
          report.passed,
        )} failed=${JSON.stringify(report.failed)}. Correct the fake and decoders against the observed bytes.`,
      ).toBe(true);

      const version = discovery.chosen?.version;
      expect(version).toBeTruthy();
      if (!version) return;
      const recorded = await recordTestedRange("omp", version);
      expect(recorded.maxTested).toBeTruthy();
    },
    120_000,
  );
});
