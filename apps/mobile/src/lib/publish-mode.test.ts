import type { Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { mobilePublishDecision } from "./publish-mode";

const postTarget = {
  repo: { forge: "github", owner: "acme", name: "widget" },
  number: 7,
  forgeRef: "PR_7",
  headOid: "deadbeef",
};

describe("mobilePublishDecision", () => {
  it("posts a review only on a teammate pull request", () => {
    expect(
      mobilePublishDecision({ postTarget: { ...postTarget, viewerDidAuthor: false } } as Review),
    ).toEqual({ status: "mode", mode: "review" });
    expect(mobilePublishDecision({ postTarget } as Review)).toEqual({
      status: "mode",
      mode: "review",
    });
  });

  it("opens a pull request only for a branch capture with no existing PR", () => {
    expect(mobilePublishDecision({} as Review)).toEqual({ status: "mode", mode: "pr" });
    expect(
      mobilePublishDecision({ postTarget: { ...postTarget, viewerDidAuthor: true } } as Review),
    ).toEqual({
      status: "unavailable",
      reason: "This is your existing pull request; continue its review rounds instead.",
    });
  });

  it("offers no publish exit for a retrospective review", () => {
    expect(mobilePublishDecision({ retrospective: true } as Review)).toEqual({
      status: "unavailable",
      reason: "Retrospective reviews do not have a publish exit.",
    });
  });
});
