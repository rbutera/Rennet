import { describe, expect, it } from "vitest";
import { sharedUrlFromIntent } from "./share-intent";

describe("sharedUrlFromIntent (#382 M2 finding 9 — read what was shared)", () => {
  it("prefers the parsed web URL", () => {
    expect(
      sharedUrlFromIntent({ webUrl: "https://github.com/o/r/pull/12", text: "look at this" }),
    ).toBe("https://github.com/o/r/pull/12");
  });

  it("falls back to the raw shared text (kickoff scans it for a PR ref)", () => {
    expect(
      sharedUrlFromIntent({ webUrl: null, text: "Review https://github.com/o/r/pull/7 please" }),
    ).toBe("Review https://github.com/o/r/pull/7 please");
  });

  it("trims, and returns null when nothing shareable is present", () => {
    expect(sharedUrlFromIntent({ webUrl: "  ", text: "  " })).toBeNull();
    expect(sharedUrlFromIntent({})).toBeNull();
    expect(sharedUrlFromIntent({ webUrl: "  https://x/y  " })).toBe("https://x/y");
  });
});
