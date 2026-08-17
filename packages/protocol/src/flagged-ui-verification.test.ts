import type { FindingElement, UiVerification } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { parseCommandOutput } from "./index";

/**
 * The delivery check (Rule 80, the #349 lesson) for the verify-ui status (#183) that
 * MUST survive the `flagged.review` command boundary. The ok branch is a strict
 * `z.object`, so a field absent from the schema is silently stripped by `.parse()` —
 * exactly how #179's `verification` and #178's `hypothesis` once vanished at the IPC
 * boundary. These prove `uiVerification` (screenshots included) is carried, that a
 * malformed status is rejected (a real check that can go red), and that a review
 * without it round-trips byte-identical to the pre-#183 shape.
 *
 * Red-first: with `uiVerification` removed from `flaggedReviewSchema`, the first case
 * fails (`output.uiVerification` is `undefined` after the strip) — verified by
 * deleting the schema line and watching this go red before wiring it back.
 */

function finding(overrides: Partial<FindingElement> & { findingId: string }): FindingElement {
  return {
    anchor: "rennet:hunk/h1",
    summary: "the focus ring is invisible against the new surface",
    severity: "medium",
    agreement: { kind: "concur", agree: 1, total: 1 },
    ...overrides,
  };
}

const RAN: Extract<UiVerification, { status: "ran" }> = {
  status: "ran",
  screenshots: [
    { path: "login.png", label: "login form, desktop" },
    { path: "login-mobile.png", label: "login form, mobile" },
  ],
  observationCount: 1,
  mounted: true,
};

describe("flagged.review — verify-ui status delivery across the boundary (#183)", () => {
  it("carries a ran status with screenshot references through the output (it reaches the strip)", () => {
    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [finding({ findingId: "f1" })],
      uiVerification: RAN,
    });
    if (output.status !== "ok") throw new Error("expected ok");
    if (output.uiVerification?.status !== "ran") throw new Error("expected ran");
    expect(output.uiVerification.screenshots).toEqual(RAN.screenshots);
    expect(output.uiVerification.mounted).toBe(true);
    expect(output.uiVerification.observationCount).toBe(1);
  });

  it("carries an unavailable status with its honest reason (never dropped, never a clear)", () => {
    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [],
      uiVerification: { status: "unavailable", reason: "could not mount the UI change" },
    });
    if (output.status !== "ok") throw new Error("expected ok");
    expect(output.uiVerification).toEqual({
      status: "unavailable",
      reason: "could not mount the UI change",
    });
  });

  it("carries a not-ui status (distinct from absent — not applicable, not an all-clear)", () => {
    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [],
      uiVerification: { status: "not-ui" },
    });
    if (output.status !== "ok") throw new Error("expected ok");
    expect(output.uiVerification).toEqual({ status: "not-ui" });
  });

  it("round-trips an ok review WITHOUT the field unchanged (pre-#183 shape preserved)", () => {
    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [finding({ findingId: "f1" })],
    });
    if (output.status !== "ok") throw new Error("expected ok");
    expect(output.uiVerification).toBeUndefined();
  });

  it("rejects a status outside the closed vocabulary (positive control)", () => {
    expect(() =>
      parseCommandOutput("flagged.review", {
        status: "ok",
        findings: [],
        uiVerification: { status: "maybe" },
      }),
    ).toThrow();
  });
});

describe("review.uiEvidence — the screenshot read command (#183)", () => {
  it("round-trips an ok data-URL result", () => {
    const output = parseCommandOutput("review.uiEvidence", {
      status: "ok",
      dataUrl: "data:image/png;base64,AAAA",
    });
    expect(output).toEqual({ status: "ok", dataUrl: "data:image/png;base64,AAAA" });
  });

  it("round-trips a not-found result (a missing/escaping path is honest, not a crash)", () => {
    const output = parseCommandOutput("review.uiEvidence", { status: "not-found" });
    expect(output).toEqual({ status: "not-found" });
  });
});
