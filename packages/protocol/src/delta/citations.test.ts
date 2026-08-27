import { describe, expect, it } from "vitest";
import { codeRefSchema } from "./citations";

const valid = {
  patchsetId: "ps-1",
  path: "src/a.ts",
  side: "head",
  startLine: 3,
  endLine: 9,
} as const;

describe("canonical CodeRef (B3 task 6.2)", () => {
  it("parses a valid citation, with and without a symbol", () => {
    expect(codeRefSchema.parse(valid).endLine).toBe(9);
    expect(codeRefSchema.parse({ ...valid, symbol: "decompose" }).symbol).toBe("decompose");
  });

  it("rejects line zero — lines are 1-based like anchorSpanSchema", () => {
    expect(codeRefSchema.safeParse({ ...valid, startLine: 0 }).success).toBe(false);
    expect(codeRefSchema.safeParse({ ...valid, endLine: 0 }).success).toBe(false);
  });

  it("rejects an inverted span (endLine < startLine)", () => {
    expect(codeRefSchema.safeParse({ ...valid, startLine: 9, endLine: 3 }).success).toBe(false);
  });

  it("accepts a single-line span (endLine === startLine)", () => {
    expect(codeRefSchema.safeParse({ ...valid, startLine: 5, endLine: 5 }).success).toBe(true);
  });
});
