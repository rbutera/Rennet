import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The guard-deletion control (#183, the #339/#349 lesson): verify-ui must stay plugged
 * into the LIVE flagged flow, and it must be NON-BLOCKING. This reddens if the pass is
 * unplugged from `runFlaggedReviewWithContextFeed` or made to block row delivery.
 *
 * The behaviour of the fold itself (observations → findings, status stamped) is proven
 * in `flagged-ui-verification.test.ts`; this proves the WIRING, which a source-text
 * test is the honest tool for (the live flow needs Electron + a real harness to run).
 */
describe("desktop verify-ui composition (#183)", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("classifies the changeset and runs the verify-ui pass in the live flagged flow", () => {
    expect(source).toContain("classifyUiSurface(patchset.files)");
    expect(source).toContain("runUiVerification({");
    expect(source).toContain("applyUiVerification(");
  });

  it("rides the non-blocking late-enrichment channel (never delays row delivery)", () => {
    // Chained onto the same late promise as adjudication and returned as `adjudication`
    // — the immediate review delivers now. If this becomes an `await` before the return
    // (a blocking mount), the row delivery would stall.
    expect(source).toContain(".then(uiVerificationRunner)");
    expect(source).toContain("return { review: immediate, adjudication };");
    // The runner is CHAINED onto the late promise, never awaited before the return.
    expect(source).not.toContain("await uiVerificationRunner");
  });

  it("records not-ui synchronously (a backend-only changeset spends nothing)", () => {
    expect(source).toContain('status: { status: "not-ui" }');
  });
});
