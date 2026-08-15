import { describe, expect, it } from "vitest";
import {
  CI_CLASSIFICATION_CONTRACT,
  CI_CLASSIFICATION_OUTPUT_SCHEMA,
  renderCiClassificationPrompt,
} from "./index";

describe("CI_CLASSIFICATION_CONTRACT", () => {
  it("renders one schema-constrained batch over only the failures supplied", () => {
    const prompt = renderCiClassificationPrompt(CI_CLASSIFICATION_CONTRACT, {
      failures: [{ ref: "failure-1", checkName: "acceptance", evidence: "snapshot mismatch" }],
      changedPaths: ["packages/core/src/pipeline.ts"],
    });
    expect(prompt).toContain("ci-failure-classification@2");
    expect(prompt).toContain('"ref": "failure-1"');
    expect(prompt).toContain('"checkName": "acceptance"');
    expect(prompt).toContain('"packages/core/src/pipeline.ts"');
    expect(prompt).toContain("unclassified");
    expect(prompt).toContain("environmental");
    expect(prompt).toContain("change-caused");
    expect(
      CI_CLASSIFICATION_OUTPUT_SCHEMA.properties.classifications.items.properties.verdict.enum,
    ).toEqual(["change-caused", "unclassified"]);
  });

  it("is deterministic", () => {
    const input = {
      failures: [{ ref: "failure-0", checkName: "build", evidence: "failed" }],
      changedPaths: ["src/build.ts"],
    } as const;
    expect(renderCiClassificationPrompt(CI_CLASSIFICATION_CONTRACT, input)).toBe(
      renderCiClassificationPrompt(CI_CLASSIFICATION_CONTRACT, input),
    );
  });
});
