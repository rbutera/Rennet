import { describe, expect, it } from "vitest";
import { groupReviews, type ReviewSummary } from "./review-list";

const NOW = new Date("2026-08-18T12:00:00Z").getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const row = (over: Partial<ReviewSummary> & Pick<ReviewSummary, "reviewId">): ReviewSummary => ({
  daemonId: "d1",
  repoDisplayName: "acme",
  updatedAt: NOW - HOUR,
  running: false,
  needsYou: false,
  reachable: true,
  stale: false,
  ...over,
});

describe("groupReviews (task 5.1 — status-first, cross-daemon)", () => {
  it("pins needs-you above running, and running above recency groups", () => {
    const grouped = groupReviews(
      [
        row({ reviewId: "plain", updatedAt: NOW - HOUR }),
        row({ reviewId: "running", running: true, updatedAt: NOW - 3 * DAY }),
        row({ reviewId: "needsYou", needsYou: true, updatedAt: NOW - 5 * DAY }),
      ],
      NOW,
    );
    expect(grouped.pinned.map((r) => r.reviewId)).toEqual(["needsYou", "running"]);
    // The plain row is NOT pinned; it drops into a recency group.
    expect(grouped.pinned.some((r) => r.reviewId === "plain")).toBe(false);
  });

  it("aggregates across daemons and groups the unpinned rest by recency", () => {
    const grouped = groupReviews(
      [
        row({ reviewId: "a", daemonId: "d1", updatedAt: NOW - HOUR }),
        row({ reviewId: "b", daemonId: "d2", updatedAt: NOW - DAY - HOUR }),
        row({ reviewId: "c", daemonId: "d2", updatedAt: NOW - 4 * DAY }),
        row({ reviewId: "d", daemonId: "d1", updatedAt: NOW - 30 * DAY }),
      ],
      NOW,
    );
    expect(grouped.groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "This week",
      "Earlier",
    ]);
    expect(grouped.groups[0]?.reviews.map((r) => r.reviewId)).toEqual(["a"]);
    expect(grouped.groups[3]?.reviews.map((r) => r.reviewId)).toEqual(["d"]);
  });

  it("keeps an unreachable/stale row in the list (never dropped)", () => {
    const grouped = groupReviews(
      [row({ reviewId: "offline", reachable: false, stale: true, updatedAt: NOW - HOUR })],
      NOW,
    );
    const all = [...grouped.pinned, ...grouped.groups.flatMap((g) => g.reviews)];
    expect(all.map((r) => r.reviewId)).toEqual(["offline"]);
    expect(all[0]?.stale).toBe(true);
  });

  it("omits empty recency groups", () => {
    const grouped = groupReviews([row({ reviewId: "a", updatedAt: NOW - HOUR })], NOW);
    expect(grouped.groups.map((g) => g.label)).toEqual(["Today"]);
  });
});
