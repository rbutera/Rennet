import type { RunUiVerificationResult } from "@rennet/core";
import type { FlaggedReview } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { composeFlaggedLateEnrichment } from "./flagged-late-enrichment";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle;
    }),
    resolve,
  };
}

describe("desktop verify-ui late composition (#183)", () => {
  it("delivers all-concur rows immediately and composes deferred verify-ui later", async () => {
    const immediate: FlaggedReview = {
      status: "ok",
      findings: [],
      uiVerification: { status: "pending", classifierVersion: 1 },
    };
    const ui = deferred<RunUiVerificationResult>();
    const composed = composeFlaggedLateEnrichment({ immediate, uiVerification: ui.promise });

    expect(composed.review).toEqual({ ...immediate, lateEnrichmentScheduled: true });
    expect(composed.enrichment).not.toBeNull();

    ui.resolve({
      observations: [
        {
          findingId: "ui-verify:1",
          anchor: "rennet:hunk/h1",
          summary: "the dialog is clipped",
          severity: "high",
          agreement: { kind: "concur", agree: 1, total: 1 },
          verification: { verdict: "reproduced", evidence: "captured in app.png" },
        },
      ],
      status: {
        status: "ran",
        classifierVersion: 1,
        mounted: true,
        observationCount: 1,
        screenshots: [{ path: "patch/run/app.png", label: "App" }],
      },
    });

    await expect(composed.enrichment).resolves.toMatchObject({
      status: "ok",
      findings: [{ findingId: "ui-verify:1" }],
      uiVerification: { status: "ran", screenshots: [{ path: "patch/run/app.png" }] },
    });
    const enriched = await composed.enrichment;
    if (enriched?.status !== "ok") throw new Error("expected ok");
    expect(enriched?.lateEnrichmentScheduled).toBeUndefined();
  });
});
