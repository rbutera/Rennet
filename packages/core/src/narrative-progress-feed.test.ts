import type { NarrativeProgressEvent } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { NarrativeProgressFeed } from "./narrative-progress-feed";

function event(
  key: string,
  seq: number,
  text = key,
  status: NarrativeProgressEvent["status"] = "working",
): NarrativeProgressEvent {
  return {
    reviewId: "review-1",
    patchsetId: "patch-1",
    key,
    seq,
    phase: key === "starting" ? "starting" : "angle",
    status,
    text,
  };
}

describe("NarrativeProgressFeed (R35-shaped transport, issue #71)", () => {
  it("conflates a repeated line by stable key and delivers pipeline order", () => {
    const feed = new NarrativeProgressFeed();
    const seen: NarrativeProgressEvent[] = [];
    feed.subscribe("review-1", (progress) => seen.push(progress));

    feed.publish(event("floor", 2, "finding chapters"));
    feed.publish(event("capture", 1, "reading changes"));
    feed.publish(event("floor", 3, "2 chapters found", "landed"));
    feed.flush();

    expect(seen.map((progress) => progress.text)).toEqual(["reading changes", "2 chapters found"]);
    expect(feed.snapshot("review-1").map((progress) => progress.text)).toEqual([
      "reading changes",
      "2 chapters found",
    ]);
  });

  it("replays the resumable summary to a later subscriber and has an explicit teardown", () => {
    const feed = new NarrativeProgressFeed();
    feed.publish(event("starting", 1));
    feed.publish(event("floor", 2, "local floor", "landed"));
    const listener = vi.fn();

    const dispose = feed.subscribe("review-1", listener);
    expect(
      listener.mock.calls.map(([progress]) => (progress as NarrativeProgressEvent).key),
    ).toEqual(["starting", "floor"]);

    dispose();
    feed.publish(event("complete", 3, "ready", "complete"));
    feed.flush();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("starts a new review run without leaking buffered progress from the prior run", () => {
    const feed = new NarrativeProgressFeed();
    const seen: NarrativeProgressEvent[] = [];
    feed.subscribe("review-1", (progress) => seen.push(progress));

    feed.publish(event("floor", 2, "old floor", "landed"));
    feed.publish(event("starting", 1, "new run"));
    feed.flush();

    expect(seen.map((progress) => progress.text)).toEqual(["new run"]);
    expect(feed.snapshot("review-1").map((progress) => progress.text)).toEqual(["new run"]);
  });
});
