import { describe, expect, it } from "vitest";
import { FINDING_ADJUDICATION_CONTRACT, renderFindingAdjudicationPrompt } from "./index";

// The cross-harness adjudication contract + prompt (issue #41). The contract must
// carry the three-way vocabulary and the third-opinion framing (never the final
// word); the render must feed the adjudicator the real file window (line-numbered)
// AND both seats' labelled answers with explicit polarity, so a fresh session can
// settle a disagreement against the actual code without hiding either answer.

describe("FINDING_ADJUDICATION_CONTRACT (#41)", () => {
  const text = [
    FINDING_ADJUDICATION_CONTRACT.role,
    FINDING_ADJUDICATION_CONTRACT.task,
    FINDING_ADJUDICATION_CONTRACT.discipline,
    FINDING_ADJUDICATION_CONTRACT.failureValve,
  ]
    .join(" ")
    .toLowerCase();

  it("names supported, contradicted, and insufficient — never reproduced/refuted (no drop semantic)", () => {
    expect(text).toContain("supported");
    expect(text).toContain("contradicted");
    expect(text).toContain("insufficient");
    expect(text).not.toContain("refuted");
    expect(text).not.toContain("reproduced");
  });

  it("frames the verdict as a third opinion beside both answers, not the final word", () => {
    expect(FINDING_ADJUDICATION_CONTRACT.discipline.toLowerCase()).toContain("third");
    // The failure valve prefers an honest unknown over a confident guess.
    expect(FINDING_ADJUDICATION_CONTRACT.failureValve.toLowerCase()).toContain("insufficient");
  });
});

describe("renderFindingAdjudicationPrompt (#41)", () => {
  const file = {
    path: "packages/core/src/loader.ts",
    startLine: 10,
    endLine: 12,
    text: "const x = load();\nif (x) use(x);\nreturn x.value;",
  };

  it("renders the line-numbered window and both labelled answers with polarity", () => {
    const prompt = renderFindingAdjudicationPrompt(FINDING_ADJUDICATION_CONTRACT, {
      file,
      row: {
        ref: "a1",
        severity: "high",
        anchor: "rennet:hunk/h1",
        answers: [
          { model: "Claude", answer: "x may be null at return" },
          { model: "Codex", answer: "no concern raised here" },
        ],
        hunk: "+ return x.value;",
      },
    });
    expect(prompt).toContain("packages/core/src/loader.ts");
    expect(prompt).toContain("10\tconst x = load();");
    expect(prompt).toContain("## Contested row a1");
    expect(prompt).toContain("Claude answers: x may be null at return");
    expect(prompt).toContain("Codex answers: no concern raised here");
    expect(prompt).toContain("+ return x.value;");
  });

  it("marks an unavailable hunk explicitly rather than an empty block", () => {
    const prompt = renderFindingAdjudicationPrompt(FINDING_ADJUDICATION_CONTRACT, {
      file,
      row: {
        ref: "a1",
        severity: "medium",
        anchor: "rennet:hunk/h1",
        answers: [
          { model: "Claude", answer: "concern" },
          { model: "Codex", answer: "no concern raised here" },
        ],
        hunk: "",
      },
    });
    expect(prompt).toContain("Offered hunk: (unavailable)");
  });

  it("is deterministic — the same inputs render byte-for-byte identically", () => {
    const args = {
      file,
      row: {
        ref: "a1",
        severity: "low" as const,
        anchor: "rennet:hunk/h1",
        answers: [
          { model: "Claude", answer: "s" },
          { model: "Codex", answer: "t" },
        ],
        hunk: "h",
      },
    };
    expect(renderFindingAdjudicationPrompt(FINDING_ADJUDICATION_CONTRACT, args)).toBe(
      renderFindingAdjudicationPrompt(FINDING_ADJUDICATION_CONTRACT, args),
    );
  });
});
