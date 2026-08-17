import { buildCapabilities, type CapabilityName } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { OmpAdapter } from "./omp-adapter";
import { deriveOmpImplementedEvidence } from "./omp-turn-transport";

// ─────────────────────────────────────────────────────────────────────────────
// Hermetic omp conformance (#26, task 4.1/4.2). The cross-adapter suite runs against
// an OmpAdapter wired to a DOCUMENTED-shape fake transport (no process, no spend). The
// evidence caps at `implementedByAdapter`; the derived descriptor's `true` flags are
// exactly the passing set; `runConformance` refuses to certify unless every refuting
// control fails (it throws otherwise), so a successful derive IS the positive-control
// proof. Stats are not requested, so cost/context reporting remain absent.
// ─────────────────────────────────────────────────────────────────────────────

// What the documented-shape fake proves at introduction. The gated real run either
// matches this (records the range) or reveals divergence (fix the fake and decoders).
const EXPECTED_HERMETIC_PASSES: readonly CapabilityName[] = ["interrupt", "textDeltas"];

describe("omp conformance — hermetic (documented shapes, zero spend)", () => {
  it("derives implementedByAdapter evidence for exactly the documented-passing set", async () => {
    // `deriveOmpImplementedEvidence` runs the WHOLE suite (controls included). It throws
    // if any refuting control cannot be shown to fail, so resolving proves the positive
    // control fired — the suite could tell pass from fail.
    const evidence = await deriveOmpImplementedEvidence("/x/omp");

    // The layer cap: a fake-transport run earns ONLY implementedByAdapter.
    expect(evidence?.advertisedByHarness).toBeUndefined();
    expect(evidence?.availableInSession).toBeUndefined();
    expect([...(evidence?.implementedByAdapter ?? [])].sort()).toEqual(
      [...EXPECTED_HERMETIC_PASSES].sort(),
    );
  });

  it("builds a descriptor whose true flags are exactly the passing set, nothing declared", async () => {
    const evidence = await deriveOmpImplementedEvidence("/x/omp");
    const adapter = new OmpAdapter({
      binaryPath: "/x/omp",
      transport: () => ({
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          // Never invoked — the descriptor is read, not a turn run.
          throw new Error("descriptor-only adapter: transport must not be invoked");
        },
      }),
      ...(evidence === undefined ? {} : { capabilityEvidence: evidence }),
    });
    const caps = adapter.descriptor.capabilities;

    for (const name of EXPECTED_HERMETIC_PASSES) {
      expect(caps[name].implementedByAdapter).toBe(true);
      // Even a passing hermetic check never earns the outer layers.
      expect(caps[name].advertisedByHarness).toBe(false);
      expect(caps[name].availableInSession).toBe(false);
    }
    // costUsd and reportsContextWindow are expected-fail; resume/fork/toolGating have
    // no check at all — all structurally false, never stubbed true.
    for (const name of [
      "costUsd",
      "reportsContextWindow",
      "structuredOutput",
      "resume",
      "fork",
      "toolGating",
    ] as const) {
      expect(caps[name].implementedByAdapter).toBe(false);
    }
    // Sanity: an all-false baseline is what a no-evidence descriptor would give.
    const baseline = buildCapabilities();
    expect(baseline.structuredOutput.implementedByAdapter).toBe(false);
  });
});
