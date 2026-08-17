import type { FindingElement } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { parseCommandOutput } from "./index";

function disagree(overrides: Partial<FindingElement> = {}): FindingElement {
  return {
    findingId: "f1",
    anchor: "rennet:hunk/h1",
    summary: "the loop reads one element beyond the array",
    severity: "high",
    agreement: {
      kind: "disagree",
      answers: [
        { model: "Claude", answer: "the <= condition overruns the array" },
        { model: "Codex", answer: "no concern raised here" },
      ],
    },
    ...overrides,
  };
}

describe("flagged.review — adjudication delivery across the command boundary (#41)", () => {
  it("round-trips a disagree verdict through parseCommandOutput", () => {
    const finding = disagree({
      agreement: {
        kind: "disagree",
        answers: [
          { model: "Claude", answer: "the <= condition overruns the array" },
          { model: "Codex", answer: "no concern raised here" },
        ],
        adjudication: {
          verdict: "supported",
          evidence: "line 4 reads items[items.length]",
          adjudicatedBy: "opus-4.8 (claude-code)",
        },
      },
    });

    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [finding],
    });

    if (output.status !== "ok") throw new Error("expected ok");
    const agreement = output.findings[0]?.agreement;
    if (agreement?.kind !== "disagree") throw new Error("expected disagree");
    expect(agreement.adjudication).toEqual({
      verdict: "supported",
      evidence: "line 4 reads items[items.length]",
      adjudicatedBy: "opus-4.8 (claude-code)",
    });
  });

  it("keeps the old disagree shape compatible", () => {
    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [disagree()],
    });

    if (output.status !== "ok") throw new Error("expected ok");
    const agreement = output.findings[0]?.agreement;
    if (agreement?.kind !== "disagree") throw new Error("expected disagree");
    expect(agreement.adjudication).toBeUndefined();
  });
});
