import { buildCapabilities, runConformance } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { createCodexHarness } from "./codex-turn-transport";
import { matchesConformanceMatrix, recordTestedRange } from "./harness-tested-range";

// ─────────────────────────────────────────────────────────────────────────────
// Gated MANUAL real conformance run (#25, task 4.1).
//
// Runs the cross-adapter conformance suite against the user's REAL installed
// `codex` binary — one real `codex exec` turn per check. It authenticates on the
// user's ChatGPT subscription (no metered tokens) but spends subscription quota
// and needs a discoverable `codex`, so it is SKIPPED unless RENNET_LIVE_CODEX=1
// and NEVER runs in the normal gate.
//
//   RENNET_LIVE_CODEX=1 pnpm exec vitest run packages/adapters/src/harness-conformance.real.test.ts
//
// Passing checks earn `advertisedByHarness` / `availableInSession` (the outer
// layers a fake run can never produce), and the run RECORDS the codex version it
// passed against into the committed `harness-tested-range.json` artifact.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.RENNET_LIVE_CODEX === "1";
const EXPECTED_CODEX_MATRIX = {
  passed: ["interrupt", "structuredOutput"],
  failed: ["costUsd", "reportsContextWindow", "textDeltas"],
} as const;

describe("harness conformance — real codex (gated)", () => {
  it.skipIf(!LIVE)(
    "certifies codex over the real binary and records its tested range",
    async () => {
      const { adapter, discovery } = await createCodexHarness();
      expect(
        adapter,
        `no codex binary discovered: ${JSON.stringify(discovery.health)}`,
      ).not.toBeNull();
      if (!adapter) return;

      // A real run in a real git repo cwd (this worktree). Passing checks earn the
      // outer layers; the positive control still fires against the internal broken port.
      const report = await runConformance(adapter, { real: true, cwd: process.cwd() });
      expect(report.controlDemonstrated).toBe(true);
      expect(matchesConformanceMatrix(report, EXPECTED_CODEX_MATRIX)).toBe(true);

      const caps = buildCapabilities(report.evidence);
      // structuredOutput is the load-bearing capability the council depends on.
      expect(caps.structuredOutput.advertisedByHarness).toBe(true);
      expect(caps.structuredOutput.availableInSession).toBe(true);

      // Record/extend the codex tested range from this real run.
      const version = discovery.chosen?.version;
      expect(version).toBeTruthy();
      if (!version) return;
      const recorded = await recordTestedRange("codex", version);
      expect(recorded.maxTested).toBeTruthy();
    },
    120_000,
  );
});
