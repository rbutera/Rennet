import { createHarnessRunTurn } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { createClaudeHarness } from "./claude-query";

// ─────────────────────────────────────────────────────────────────────────────
// Gated MANUAL real-turn proof (issue #54).
//
// This composes the REAL Claude harness and drives one `createHarnessRunTurn`
// turn end to end, proving the live wiring (core's injected turn ↔ the Claude
// adapter ↔ the user's installed `claude`). It runs on the user's subscription
// OAuth (R2), so it spends NO metered tokens — but it does spend subscription
// quota and needs a discoverable `claude` binary, so it is SKIPPED unless
// `RENNET_LIVE_HARNESS` is set and never runs in the normal gate.
//
//   RENNET_LIVE_HARNESS=1 pnpm exec vitest run packages/adapters/src/harness-run-turn.real.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.RENNET_LIVE_HARNESS === "1";

describe("createHarnessRunTurn — real harness (gated)", () => {
  it.skipIf(!LIVE)(
    "drives a real claude turn to a terminal result on the user's subscription",
    async () => {
      const { adapter, discovery } = await createClaudeHarness({ env: process.env });
      expect(
        adapter,
        `no claude binary discovered: ${JSON.stringify(discovery.health)}`,
      ).not.toBeNull();
      if (!adapter) return;

      const runTurn = createHarnessRunTurn(adapter, {
        docType: "decomposition.proposal",
        cwd: process.cwd(),
      });
      const result = await runTurn(
        "Emit a decomposition.proposal document body with an empty chunks array, empty edges, empty readingOrder, and empty residue.",
        0,
      );

      // The wiring drove a real turn to a terminal frame (an emitted body, or a
      // clean failure that the angle's deterministic floor would absorb). Either
      // way the real path executed without a metered key.
      expect(["emitted", "failed"]).toContain(result.status);
      if (result.status === "emitted") {
        expect(typeof result.body).toBe("object");
      }
    },
    120_000,
  );
});
