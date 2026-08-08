// @vitest-environment happy-dom
import type { NarrativeProgressEvent } from "@rennet/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount } from "../test/dom";
import { NarrativeFeed } from "./narrative-feed";

const progress: NarrativeProgressEvent[] = [
  {
    reviewId: "review-1",
    patchsetId: "patch-1",
    key: "starting",
    seq: 1,
    phase: "starting",
    status: "working",
    text: "Starting a local reading of this changeset…",
  },
  {
    reviewId: "review-1",
    patchsetId: "patch-1",
    key: "floor",
    seq: 2,
    phase: "floor",
    status: "landed",
    text: "The local floor found 2 chapters.",
    artifact: { angle: "sequence" },
  },
  {
    reviewId: "review-1",
    patchsetId: "patch-1",
    key: "complete",
    seq: 3,
    phase: "complete",
    status: "complete",
    text: "The review is ready to read.",
    artifact: { angle: "sequence" },
  },
];

describe("NarrativeFeed (issue #71)", () => {
  it("has an honest deterministic first line — never a blank or spinner", () => {
    const html = renderToStaticMarkup(<NarrativeFeed />);
    expect(html).toContain("Starting a local reading");
    expect(html).toContain("LIVE READING");
    expect(html).not.toMatch(/spinner|loading glyph/i);
  });

  it("renders deterministic progress without a model call and makes landed lines navigable", () => {
    // The event list is deliberately plain deterministic pipeline data. No
    // narration/garnish or utility port is required for the entire feed.
    const onNavigate = vi.fn();
    const { getByRole } = mount(<NarrativeFeed events={progress} onNavigate={onNavigate} />);

    const floor = getByRole("button", { name: /local floor found 2 chapters/i });
    fireEvent.click(floor);

    expect(onNavigate).toHaveBeenCalledWith({ angle: "sequence" });
    expect(getByRole("button", { name: /review is ready to read/i })).toBeDefined();
  });

  it("degrades a completed run to a resumable landed-artifact summary", () => {
    const html = renderToStaticMarkup(<NarrativeFeed events={progress} compact />);
    expect(html).toContain("2 artifacts are ready");
    // The volatile opening line is compacted after completion, but the landed
    // destination remains tappable when the reader returns to the stage.
    expect(html).not.toContain("Starting a local reading");
    expect(html).toContain("The local floor found 2 chapters.");
  });
});
