import { describe, expect, it } from "vitest";
import { FINDING_VERIFICATION_CONTRACT, renderFindingVerificationPrompt } from "./index";

// The reproduce-or-refute contract + prompt (issue #179). The contract must carry
// the refuse-to-guess discipline; the render must feed the verifier the real file
// window (line-numbered), each finding's ref/severity/concern, and the drop-on-
// refute warning, so a fresh session can check the claim against the actual code.

describe("FINDING_VERIFICATION_CONTRACT (#179 + #259)", () => {
  const text = [
    FINDING_VERIFICATION_CONTRACT.role,
    FINDING_VERIFICATION_CONTRACT.task,
    FINDING_VERIFICATION_CONTRACT.discipline,
    FINDING_VERIFICATION_CONTRACT.failureValve,
  ]
    .join(" ")
    .toLowerCase();

  it("names reproduce, refute, and inconclusive and warns that refute DROPS the finding", () => {
    expect(text).toContain("reproduce");
    expect(text).toContain("refute");
    expect(text).toContain("inconclusive");
    // The load-bearing safety: refute drops the finding, so inconclusive is the safe honest answer.
    expect(FINDING_VERIFICATION_CONTRACT.failureValve.toLowerCase()).toContain("drop");
  });

  it("invites the verifier to RUN the code, not just read the shown lines (#259)", () => {
    // The pillar's whole point: a "reproduce" pass must be able to actually run
    // something. The contract must say so — and must NOT carry the old read-only
    // confinement that told the model to judge only from the file window.
    expect(text).toContain("run");
    expect(text).toMatch(/execut/);
    expect(text).toContain("shell");
    expect(text).not.toContain("judge only from the file content you are shown");
    // The version moves when the wording moves (A/B-able against verdict quality).
    expect(FINDING_VERIFICATION_CONTRACT.version).toBeGreaterThanOrEqual(2);
  });
});

describe("renderFindingVerificationPrompt (#179)", () => {
  const file = {
    path: "packages/core/src/loader.ts",
    startLine: 10,
    endLine: 12,
    text: "const x = load();\nif (x) use(x);\nreturn x.value;",
  };

  it("renders the line-numbered file window and each finding by ref", () => {
    const prompt = renderFindingVerificationPrompt(FINDING_VERIFICATION_CONTRACT, {
      file,
      findings: [
        {
          ref: "f1",
          severity: "high",
          summary: "x may be null at return",
          hunk: "+ return x.value;",
        },
      ],
    });
    expect(prompt).toContain("packages/core/src/loader.ts");
    // Line numbers are the requested base + offset.
    expect(prompt).toContain("10\tconst x = load();");
    expect(prompt).toContain("12\treturn x.value;");
    expect(prompt).toContain("### f1");
    expect(prompt).toContain("x may be null at return");
    expect(prompt).toContain("+ return x.value;");
  });

  it("marks an unavailable hunk explicitly rather than showing an empty block", () => {
    const prompt = renderFindingVerificationPrompt(FINDING_VERIFICATION_CONTRACT, {
      file,
      findings: [{ ref: "f1", severity: "medium", summary: "concern", hunk: "" }],
    });
    expect(prompt).toContain("Offered hunk: (unavailable)");
  });

  it("is deterministic — the same inputs render byte-for-byte identically", () => {
    const args = {
      file,
      findings: [{ ref: "f1", severity: "low", summary: "s", hunk: "h" }],
    } as const;
    expect(renderFindingVerificationPrompt(FINDING_VERIFICATION_CONTRACT, args)).toBe(
      renderFindingVerificationPrompt(FINDING_VERIFICATION_CONTRACT, args),
    );
  });
});
