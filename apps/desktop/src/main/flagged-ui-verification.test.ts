import type { RunUiVerificationResult } from "@rennet/core";
import type { FindingElement, FlaggedReview } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { applyImmediateUiVerification, applyUiVerification } from "./flagged-ui-verification";

const EXISTING: FindingElement = {
  findingId: "F1",
  anchor: "rennet:hunk/h1",
  summary: "a pre-existing finding",
  severity: "high",
  agreement: { kind: "concur", agree: 1, total: 1 },
};

const OK_REVIEW: FlaggedReview = { status: "ok", findings: [EXISTING] };

const OBSERVATION: FindingElement = {
  findingId: "ui-verify:1",
  anchor: "rennet:hunk/h1",
  summary: "submit button has no accessible name",
  severity: "high",
  agreement: { kind: "concur", agree: 1, total: 1 },
  verification: { verdict: "reproduced", evidence: "axe: button-name" },
};

const RAN_RESULT: RunUiVerificationResult = {
  observations: [OBSERVATION],
  status: {
    status: "ran",
    classifierVersion: 1,
    screenshots: [{ path: "a.png", label: "A" }],
    observationCount: 1,
    mounted: true,
  },
};

describe("applyUiVerification (#183)", () => {
  it("appends the observations to the findings and stamps the ran status", () => {
    const result = applyUiVerification(OK_REVIEW, RAN_RESULT);
    if (result.status !== "ok") throw new Error("expected ok");
    // Observations flow through the ordinary findings channel — no new surface.
    expect(result.findings).toEqual([EXISTING, OBSERVATION]);
    expect(result.uiVerification).toEqual(RAN_RESULT.status);
  });

  it("stamps not-ui with no findings change (the distinct not-applicable status)", () => {
    const result = applyUiVerification(OK_REVIEW, {
      observations: [],
      status: { status: "not-ui", classifierVersion: 1 },
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.findings).toEqual([EXISTING]);
    expect(result.uiVerification).toEqual({ status: "not-ui", classifierVersion: 1 });
  });

  it("stamps an unavailable status without dropping or gating anything (Rule Zero)", () => {
    // An unavailable status + the review's unresolved findings still produce an ok
    // review: nothing about verify-ui blocks, drops, or hides a row. Sign/publish
    // never read `uiVerification`, so a present field cannot change their behaviour.
    const result = applyUiVerification(OK_REVIEW, {
      observations: [],
      status: {
        status: "unavailable",
        classifierVersion: 1,
        reason: "could not mount the UI change",
      },
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.findings).toEqual([EXISTING]);
    expect(result.uiVerification).toEqual({
      status: "unavailable",
      classifierVersion: 1,
      reason: "could not mount the UI change",
    });
  });

  it("stamps status on a failed base review without inventing findings", () => {
    const failed: FlaggedReview = { status: "failed", reason: "model unavailable" };
    expect(applyUiVerification(failed, RAN_RESULT)).toEqual({
      ...failed,
      uiVerification: RAN_RESULT.status,
    });
  });
});

describe("applyImmediateUiVerification (#183)", () => {
  it("stamps pending before a UI-touching deep verification finishes", () => {
    const result = applyImmediateUiVerification(OK_REVIEW, {
      touchesUi: true,
      classifierVersion: 1,
      deepReview: true,
      verifierAvailable: true,
    });
    expect(result.uiVerification).toEqual({ status: "pending", classifierVersion: 1 });
  });

  it("stamps verifier unavailable on a UI-touching no-adapter deep review", () => {
    const result = applyImmediateUiVerification(OK_REVIEW, {
      touchesUi: true,
      classifierVersion: 1,
      deepReview: true,
      verifierAvailable: false,
    });
    expect(result.uiVerification).toEqual({
      status: "unavailable",
      classifierVersion: 1,
      reason: "verifier unavailable",
    });
  });
});
