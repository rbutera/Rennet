import { describe, expect, it } from "vitest";
import {
  REPAIR_FROZEN_IDS_MAX_BYTES,
  REPAIR_POINTER_LINE_MAX_BYTES,
  REPAIR_POINTERS_MAX_BYTES,
  renderRepairTurn,
} from "./prompt-contracts";

const pointers = [
  {
    path: ["elements", 1, "data", "markdown"] as const,
    message: "no code bytes",
    ruleId: "no-code-bytes",
    elementId: "p1",
  },
];

describe("renderRepairTurn", () => {
  it("carries the pointers, the frozen ids, and NOTHING else", () => {
    const prompt = renderRepairTurn(pointers, ["f1", "f2"]);
    expect(prompt).toContain(
      'no-code-bytes at ["elements",1,"data","markdown"] (element `p1`): no code bytes',
    );
    expect(prompt).toContain("- `f1`");
    expect(prompt).toContain("- `f2`");
    // The base prompt and the draft are already on the thread. Re-sending either is the
    // regression this partial exists to stop.
    expect(prompt).not.toContain("elementsToFix");
    expect(prompt).not.toContain("Previous draft");
    // The output schema travels once, as the turn's contract, never in the text.
    expect(prompt).not.toContain("json_schema");
    expect(prompt).not.toContain('"type":"object"');
  });

  it("asks for the whole board when nothing is frozen", () => {
    const prompt = renderRepairTurn(pointers, []);
    expect(prompt).toContain("return the whole board:");
    expect(prompt).not.toContain("PATCH board");
  });

  it("names a parse pointer with no element, because its path indexes the rejected return", () => {
    const prompt = renderRepairTurn([{ path: ["elements", 0, "kind"], message: "invalid kind" }]);
    expect(prompt).toContain('schema at ["elements",0,"kind"]: invalid kind');
    expect(prompt).not.toContain("(element");
  });

  it("bounds the pointer list with an honest omission marker", () => {
    const many = Array.from({ length: 2_000 }, (_, i) => ({
      path: ["elements", i, "data", "markdown"],
      message: `pointer number ${i} with a reasonably long explanatory message attached`,
      ruleId: "no-code-bytes",
      elementId: `e${i}`,
    }));
    const prompt = renderRepairTurn(many, []);
    const bytes = new TextEncoder().encode(prompt).length;
    expect(bytes).toBeLessThan(REPAIR_POINTERS_MAX_BYTES + 500);
    expect(prompt).toMatch(/… \d+ more issues omitted \(byte cap\)/u);
    // Positive control on the bound: unbounded, this list is an order of magnitude larger.
    const unbounded = many
      .map((p) => `- ${p.ruleId} at ${JSON.stringify(p.path)}: ${p.message}`)
      .join("\n");
    expect(new TextEncoder().encode(unbounded).length).toBeGreaterThan(
      REPAIR_POINTERS_MAX_BYTES * 5,
    );
  });

  it("caps a single oversized pointer instead of dropping it, so the repair still names an issue", () => {
    // A Zod parse pointer embeds the value it rejected, so one pointer can exceed the whole
    // list's cap on its own. Uncapped, `boundedJoin` breaks before keeping anything and the
    // prompt reads "Fix ONLY these issues:" with nothing under it.
    const huge = "x".repeat(20_000);
    const prompt = renderRepairTurn([
      { path: ["elements", 0, "data", "markdown"], message: huge, ruleId: "no-code-bytes" },
    ]);
    // Position, not membership: the pointer is the line directly under the instruction, it
    // ends in the truncation marker, and it is the last thing in the prompt.
    expect(prompt).toMatch(
      /return the whole board:\n- no-code-bytes at \["elements",0,"data","markdown"\]: x{900,960}…$/u,
    );
    // Nothing else was in the list, so nothing claims to have been omitted.
    expect(prompt).not.toContain("omitted (byte cap)");
    expect(new TextEncoder().encode(prompt).length).toBeLessThan(
      REPAIR_POINTER_LINE_MAX_BYTES + 200,
    );

    // Positive control on WHY the cap is load-bearing: the uncapped line is bigger than the
    // list cap by itself, which is exactly the input `boundedJoin` keeps none of.
    const uncapped = `- no-code-bytes at ["elements",0,"data","markdown"]: ${huge}\n`;
    expect(new TextEncoder().encode(uncapped).length).toBeGreaterThan(REPAIR_POINTERS_MAX_BYTES);
  });

  it("bounds the frozen-id list too", () => {
    const ids = Array.from({ length: 5_000 }, (_, i) => `element-with-a-long-id-${i}`);
    const prompt = renderRepairTurn(pointers, ids);
    const bytes = new TextEncoder().encode(prompt).length;
    expect(bytes).toBeLessThan(REPAIR_POINTERS_MAX_BYTES + REPAIR_FROZEN_IDS_MAX_BYTES + 1_000);
    expect(prompt).toMatch(/… \d+ more frozen ids omitted \(byte cap\)/u);
  });
});
