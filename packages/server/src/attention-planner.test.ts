import { describe, expect, it } from "vitest";
import {
  AttentionRegistry,
  type ConnectedClient,
  deepLinkFor,
  planDelivery,
} from "./attention-planner";
import type { PushRegistration } from "./push-token-store";

const phone = (deviceId: string): PushRegistration => ({
  deviceId,
  token: `ExponentPushToken[${deviceId}]`,
  platform: "ios",
  updatedAt: 0,
});

const focusedOn = (connectionId: string, deviceId: string, reviewId: string): ConnectedClient => ({
  connectionId,
  deviceId,
  presence: { focused: true, visible: true, deviceClass: "phone", focusedReviewId: reviewId },
});

describe("planDelivery — presence-aware delivery (attention-notifications spec)", () => {
  it("focused client gets the live event and no push; a backgrounded phone gets the push", () => {
    // Scenario: "focused client is not pushed".
    const desk = focusedOn("conn-desk", "dev-desk", "rev-1");
    const plan = planDelivery(
      { family: "review-finished", reviewId: "rev-1" },
      [desk],
      [phone("dev-desk"), phone("dev-phone")],
    );
    expect(plan.live).toEqual(["conn-desk"]);
    // dev-desk is covered live (focused) ⇒ no push; dev-phone (not connected/focused) ⇒ push.
    expect(plan.push.map((r) => r.deviceId)).toEqual(["dev-phone"]);
  });

  it("treats a client that never reported presence as away (push-eligible)", () => {
    // Scenario: "old client, new daemon" — no presence ⇒ away.
    const silentClient: ConnectedClient = { connectionId: "conn-x", deviceId: "dev-phone" };
    const plan = planDelivery(
      { family: "review-finished", reviewId: "rev-1" },
      [silentClient],
      [phone("dev-phone")],
    );
    expect(plan.live).toEqual([]);
    expect(plan.push.map((r) => r.deviceId)).toEqual(["dev-phone"]);
  });

  it("high-priority families reach every registered device that is not focused-live", () => {
    for (const family of ["ask-pending", "review-finished", "turn-failed"] as const) {
      const plan = planDelivery({ family, reviewId: "rev-1" }, [], [phone("dev-phone")]);
      expect(plan.priority).toBe("high");
      expect(plan.push.map((r) => r.deviceId)).toEqual(["dev-phone"]);
    }
  });

  it("a silent family (processing-finished) posts no push — in-app only", () => {
    const plan = planDelivery(
      { family: "processing-finished", reviewId: undefined },
      [],
      [phone("dev-phone")],
    );
    expect(plan.priority).toBe("silent");
    expect(plan.push).toEqual([]);
  });

  it("a client focused on a DIFFERENT review still gets its device pushed", () => {
    const elsewhere = focusedOn("conn-a", "dev-a", "rev-OTHER");
    const plan = planDelivery(
      { family: "review-finished", reviewId: "rev-1" },
      [elsewhere],
      [phone("dev-a")],
    );
    expect(plan.live).toEqual([]);
    expect(plan.push.map((r) => r.deviceId)).toEqual(["dev-a"]);
  });

  it("a backgrounded (hidden) client focused on the review is NOT counted as live", () => {
    const hidden: ConnectedClient = {
      connectionId: "conn-h",
      deviceId: "dev-h",
      presence: { focused: true, visible: false, deviceClass: "phone", focusedReviewId: "rev-1" },
    };
    const plan = planDelivery(
      { family: "review-finished", reviewId: "rev-1" },
      [hidden],
      [phone("dev-h")],
    );
    expect(plan.live).toEqual([]);
    expect(plan.push.map((r) => r.deviceId)).toEqual(["dev-h"]);
  });
});

describe("deepLinkFor — every taxonomy entry has a daemon-relative route", () => {
  it("routes each family to its decision surface", () => {
    expect(deepLinkFor("ask-pending", { reviewId: "r" })).toBe("rennet://review/r/ask");
    expect(deepLinkFor("review-finished", { reviewId: "r" })).toBe("rennet://review/r/digest");
    expect(deepLinkFor("turn-failed", { reviewId: "r" })).toBe("rennet://review/r/error");
    expect(deepLinkFor("handoff-completed", { reviewId: "r" })).toBe("rennet://review/r/handoff");
    expect(deepLinkFor("publish-ready", { reviewId: "r" })).toBe("rennet://review/r/publish");
    expect(deepLinkFor("processing-finished", { projectId: "p" })).toBe("rennet://project/p");
  });
});

describe("AttentionRegistry — raise, dedupe, clear (handled once, quiet everywhere)", () => {
  it("re-raising the same family on the same review refreshes rather than stacks", () => {
    const registry = new AttentionRegistry();
    registry.raise({
      family: "review-finished",
      reviewId: "r1",
      deepLink: "d",
      title: "t",
      body: "a",
    });
    registry.raise({
      family: "review-finished",
      reviewId: "r1",
      deepLink: "d",
      title: "t",
      body: "b",
    });
    const active = registry.active();
    expect(active).toHaveLength(1);
    expect(active[0]?.body).toBe("b");
  });

  it("clears every item on a review, and clears a single item by id", () => {
    const registry = new AttentionRegistry();
    const ask = registry.raise({
      family: "ask-pending",
      reviewId: "r1",
      deepLink: "d",
      title: "t",
      body: "",
    });
    registry.raise({
      family: "review-finished",
      reviewId: "r1",
      deepLink: "d",
      title: "t",
      body: "",
    });
    registry.raise({
      family: "review-finished",
      reviewId: "r2",
      deepLink: "d",
      title: "t",
      body: "",
    });

    const clearedById = registry.clear({ attentionId: ask.id });
    expect(clearedById.map((i) => i.id)).toEqual([ask.id]);

    const clearedByReview = registry.clear({ reviewId: "r1" });
    expect(clearedByReview).toHaveLength(1);
    // Only r2's item survives.
    expect(registry.active().map((i) => i.reviewId)).toEqual(["r2"]);
  });

  it("needsYou is true for a review with an active HIGH-priority attention, false otherwise (#383)", () => {
    const registry = new AttentionRegistry();
    expect(registry.needsYou("r1")).toBe(false);

    // A high-priority family (ask-pending) sets needs-you for its review only.
    const ask = registry.raise({
      family: "ask-pending",
      reviewId: "r1",
      deepLink: "d",
      title: "t",
      body: "",
    });
    expect(registry.needsYou("r1")).toBe(true);
    expect(registry.needsYou("r2")).toBe(false);

    // A silent family (processing-finished) never demands you — it must NOT set needs-you.
    registry.raise({
      family: "processing-finished",
      reviewId: "r3",
      deepLink: "d",
      title: "t",
      body: "",
    });
    expect(registry.needsYou("r3")).toBe(false);

    // Clearing the ask drops needs-you for its review.
    registry.clear({ attentionId: ask.id });
    expect(registry.needsYou("r1")).toBe(false);
  });
});
