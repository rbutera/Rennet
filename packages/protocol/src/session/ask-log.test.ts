import { describe, expect, it } from "vitest";
import { QuoteThreadSchema } from "./ask-log";

const exchange = [{ author: "user", text: "Keep this exact." }] as const;

describe("QuoteThreadSchema lifecycle", () => {
  it("reads legacy scoped threads as attached-compatible", () => {
    expect(
      QuoteThreadSchema.parse({
        anchor: "quoted text",
        target: "element-1",
        generation: "gen-1",
        messages: exchange,
      }),
    ).toEqual({
      anchor: "quoted text",
      target: "element-1",
      generation: "gen-1",
      messages: exchange,
    });
  });

  it("accepts a detached scoped thread while retaining its prior identity", () => {
    expect(
      QuoteThreadSchema.parse({
        anchor: "quoted text",
        lifecycle: "detached",
        target: "element-1",
        generation: "gen-1",
        messages: exchange,
      }).lifecycle,
    ).toBe("detached");
  });

  it("keeps legacy partial board scope readable without treating it as attached", () => {
    expect(
      QuoteThreadSchema.parse({
        anchor: "quoted text",
        target: "element-1",
        messages: exchange,
      }),
    ).toEqual({
      anchor: "quoted text",
      target: "element-1",
      messages: exchange,
    });
  });
});
