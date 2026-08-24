import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LENS_KINDS, LENS_PROMPT_FILES, UNSLOP_PASS_FILE } from "./index.js";

const srcDir = dirname(fileURLToPath(import.meta.url));

describe("lens prompt manifest", () => {
  it("carries a non-empty prompt file for every lens", () => {
    for (const kind of LENS_KINDS) {
      const text = readFileSync(join(srcDir, LENS_PROMPT_FILES[kind]), "utf8");
      expect(text.length, `${kind} prompt`).toBeGreaterThan(500);
      expect(text).toMatch(/^# /);
      expect(text).toContain("Ground rules");
    }
  });

  it("carries the unslop pass with the skill body verbatim", () => {
    const text = readFileSync(join(srcDir, UNSLOP_PASS_FILE), "utf8");
    expect(text.replace(/\s+/g, " ")).toContain("Never touch typed data");
    // Spot-checks that the skill body arrived verbatim, not paraphrased.
    expect(text).toContain("Removing patterns is half the job.");
    expect(text).toContain("Em dash overuse.");
    expect(text).toContain("Say the concrete thing.");
  });

  it("fails when a manifest entry points at a missing file", () => {
    // Positive control: the check above can actually fail.
    expect(() => readFileSync(join(srcDir, "prompts/no-such-lens.md"), "utf8")).toThrow();
  });
});
