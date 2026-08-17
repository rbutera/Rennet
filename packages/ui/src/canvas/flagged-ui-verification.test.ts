import type { FlaggedReview } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildFlaggedIndex } from "./flagged";

const OK: Extract<FlaggedReview, { status: "ok" }> = { status: "ok", findings: [] };

describe("buildFlaggedIndex — verify-ui status carry (#183)", () => {
  it("carries a well-formed ran status through additively", () => {
    const index = buildFlaggedIndex({
      ...OK,
      uiVerification: {
        status: "ran",
        mounted: true,
        observationCount: 2,
        screenshots: [{ path: "a.png", label: "A" }],
      },
    });
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.uiVerification).toEqual({
      status: "ran",
      mounted: true,
      observationCount: 2,
      screenshots: [{ path: "a.png", label: "A" }],
    });
  });

  it("carries unavailable and not-ui statuses", () => {
    const unavailable = buildFlaggedIndex({
      ...OK,
      uiVerification: { status: "unavailable", reason: "no tooling" },
    });
    if (unavailable.state !== "ok") throw new Error("expected ok");
    expect(unavailable.uiVerification).toEqual({ status: "unavailable", reason: "no tooling" });

    const notUi = buildFlaggedIndex({ ...OK, uiVerification: { status: "not-ui" } });
    if (notUi.state !== "ok") throw new Error("expected ok");
    expect(notUi.uiVerification).toEqual({ status: "not-ui" });
  });

  it("drops a malformed status (a bad field renders as the pre-#183 shape)", () => {
    const index = buildFlaggedIndex({
      ...OK,
      // A ran status missing its screenshots array is malformed — the guard drops it.
      uiVerification: { status: "ran", mounted: true, observationCount: 1 } as never,
    });
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.uiVerification).toBeUndefined();
  });

  it("omits the field for a review without it (byte-identical to pre-#183)", () => {
    const index = buildFlaggedIndex(OK);
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.uiVerification).toBeUndefined();
  });
});
