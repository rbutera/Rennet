import type { Disposition } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  coverageMosaic,
  dispositionsToViewEvents,
  foldReadState,
  nextUnread,
  type ViewEvent,
} from "./read-state";

describe("foldReadState — read-state is defined by actions only", () => {
  it("marks an actioned path read", () => {
    const state = foldReadState([{ type: "Actioned", path: "a.ts" }]);
    expect(state.get("a.ts")).toBe("read");
  });

  it("marks a scrolled-through, never-actioned path skimmed (not read)", () => {
    const state = foldReadState([{ type: "ScrolledPast", path: "a.ts" }]);
    expect(state.get("a.ts")).toBe("skimmed");
  });

  it("collapse never marks anything read, and never lowers a skim (OQ4)", () => {
    expect(foldReadState([{ type: "Collapsed", path: "a.ts" }]).get("a.ts")).toBe("unread");
    const scrolledThenCollapsed = foldReadState([
      { type: "ScrolledPast", path: "a.ts" },
      { type: "Collapsed", path: "a.ts" },
    ]);
    expect(scrolledThenCollapsed.get("a.ts")).toBe("skimmed");
  });

  it("is order-independent: action wins over a scroll regardless of order", () => {
    const forward = foldReadState([
      { type: "ScrolledPast", path: "a.ts" },
      { type: "Actioned", path: "a.ts" },
    ]);
    const reverse = foldReadState([
      { type: "Actioned", path: "a.ts" },
      { type: "ScrolledPast", path: "a.ts" },
    ]);
    expect(forward.get("a.ts")).toBe("read");
    expect(reverse.get("a.ts")).toBe("read");
  });
});

describe("dispositionsToViewEvents — read is tied to L2 actions only", () => {
  it("turns each disposition into an Actioned event on its anchor path", () => {
    const dispositions: Disposition[] = [
      { anchor: { path: "a.ts", contentDigest: "x" }, type: "approve", body: "" },
      { anchor: { path: "b.ts", contentDigest: "y" }, type: "comment", body: "hi" },
    ];
    const events = dispositionsToViewEvents(dispositions);
    expect(events).toEqual([
      { type: "Actioned", path: "a.ts" },
      { type: "Actioned", path: "b.ts" },
    ]);
  });
});

describe("coverageMosaic — the totality/residue surface over the whole changeset", () => {
  const paths = ["a.ts", "b.ts", "c.ts", "d.ts"];
  const events: ViewEvent[] = [
    { type: "Actioned", path: "a.ts" },
    { type: "ScrolledPast", path: "b.ts" },
    { type: "Collapsed", path: "c.ts" },
    // d.ts has no event → unread
  ];

  it("projects read/skimmed/unread over every changeset path", () => {
    const mosaic = coverageMosaic(paths, events);
    expect(mosaic.total).toBe(4);
    expect(mosaic.read).toBe(1);
    expect(mosaic.skimmed).toBe(1);
    expect(mosaic.unread).toBe(2);
    expect(mosaic.cells.map((c) => c.state)).toEqual(["read", "skimmed", "unread", "unread"]);
  });

  it("rebuilds identically from event replay in any order", () => {
    const forward = coverageMosaic(paths, events);
    const reversed = coverageMosaic(paths, [...events].reverse());
    expect(reversed).toEqual(forward);
  });

  it("keeps cell order as the reading order it was given", () => {
    const mosaic = coverageMosaic(paths, events);
    expect(mosaic.cells.map((c) => c.path)).toEqual(paths);
  });
});

describe("nextUnread — keyboard traversal to the next unread thing", () => {
  const paths = ["a.ts", "b.ts", "c.ts", "d.ts"];
  const events: ViewEvent[] = [
    { type: "Actioned", path: "a.ts" },
    { type: "ScrolledPast", path: "b.ts" },
  ];

  it("returns the next unread cell index after the given position", () => {
    const mosaic = coverageMosaic(paths, events);
    expect(nextUnread(mosaic.cells, 0)).toBe(2); // a=read, b=skimmed, c=unread
  });

  it("wraps to the first unread when past the end", () => {
    const mosaic = coverageMosaic(paths, events);
    expect(nextUnread(mosaic.cells, 3)).toBe(2);
  });

  it("returns -1 when nothing is unread", () => {
    const allRead = coverageMosaic(
      paths,
      paths.map((p) => ({ type: "Actioned", path: p })),
    );
    expect(nextUnread(allRead.cells, 0)).toBe(-1);
  });
});
