import { describe, expect, it } from "vitest";
import {
  DEFAULT_LENS,
  DEFAULT_VIEW,
  lensToggle,
  openSession,
  openSettings,
  parseLens,
  parseView,
  readSessionQuery,
  sessionPath,
  viewToggle,
} from "./url";

describe("url grammar", () => {
  describe("sessionPath — canonical minimal query", () => {
    it("omits default view/lens, keeps non-defaults and file", () => {
      expect(sessionPath("abc")).toBe("/s/abc");
      expect(sessionPath("abc", { view: DEFAULT_VIEW, lens: DEFAULT_LENS })).toBe("/s/abc");
      expect(sessionPath("abc", { view: "map", lens: "flagged", file: "src/a.ts" })).toBe(
        "/s/abc?view=map&lens=flagged&file=src%2Fa.ts",
      );
    });

    it("board is the default (omitted); diff is a non-default and MUST serialize (#489)", () => {
      expect(DEFAULT_VIEW).toBe("board");
      // ?view=diff must survive a round-trip — the accepted route table makes board the
      // default, so an explicit diff is a real alternative, never erased into a board URL.
      expect(sessionPath("abc", { view: "diff" })).toBe("/s/abc?view=diff");
      expect(parseView("diff")).toBe("diff");
      expect(parseView(null)).toBe("board");
    });
  });

  describe("parseView / parseLens — fallback on unknown", () => {
    it("falls back to the board default for an unknown or absent view", () => {
      expect(parseView("map")).toBe("map");
      expect(parseView("bogus")).toBe(DEFAULT_VIEW);
      expect(parseView(null)).toBe(DEFAULT_VIEW);
    });

    it("falls back to the first available lens for an unknown or absent lens", () => {
      expect(parseLens("flagged")).toBe("flagged");
      expect(parseLens("bogus")).toBe(DEFAULT_LENS);
      expect(parseLens(null)).toBe(DEFAULT_LENS);
      expect(parseLens("design", ["noise", "flagged"])).toBe("noise"); // not available → first available
    });
  });

  it("readSessionQuery applies fallbacks across the whole grammar", () => {
    const search = new URLSearchParams("view=bogus&lens=noise&file=x.ts&round=gen2");
    expect(readSessionQuery(search)).toEqual({
      view: DEFAULT_VIEW,
      lens: "noise",
      file: "x.ts",
      round: "gen2", // the round-diff identity (finding 2) round-trips through the grammar
    });
    expect(readSessionQuery(new URLSearchParams())).toEqual({
      view: DEFAULT_VIEW,
      lens: DEFAULT_LENS,
      file: null,
      round: null,
    });
  });

  describe("navigation intents — replace vs push", () => {
    it("view/lens toggles REPLACE; opening a screen PUSHES", () => {
      expect(viewToggle("abc", "map")).toEqual({ path: "/s/abc?view=map", replace: true });
      expect(lensToggle("abc", "flagged")).toEqual({ path: "/s/abc?lens=flagged", replace: true });
      expect(openSession("abc")).toEqual({ path: "/s/abc", replace: false });
      expect(openSettings("appearance")).toEqual({ path: "/settings/appearance", replace: false });
    });

    it("a toggle preserves the other current query params", () => {
      expect(viewToggle("abc", "map", { lens: "flagged", file: "a.ts" })).toEqual({
        path: "/s/abc?view=map&lens=flagged&file=a.ts",
        replace: true,
      });
    });
  });
});
