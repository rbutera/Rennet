import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LENS_KINDS,
  LENS_PROMPT_FILES,
  POST_PROCESS_FILE,
  REVIEW_DRAFT_VOICE_FILE,
  ROUND_REPORT_FILE,
} from "./index.js";

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

  it("carries the post-process pass with the unslop skill body verbatim", () => {
    const text = readFileSync(join(srcDir, POST_PROCESS_FILE), "utf8");
    expect(text.replace(/\s+/g, " ")).toContain("Never touch typed data");
    // Spot-checks that the skill body arrived verbatim, not paraphrased.
    expect(text).toContain("Removing patterns is half the job.");
    expect(text).toContain("Em dash overuse.");
    expect(text).toContain("Say the concrete thing.");
    // The two steps wrapped around it.
    expect(text).toContain("break it down");
    expect(text).toContain("humanizer additions");
  });

  it("carries the round-report drafter with verification duty and the shared ground rules", () => {
    const text = readFileSync(join(srcDir, ROUND_REPORT_FILE), "utf8");
    expect(text.length).toBeGreaterThan(500);
    expect(text).toMatch(/^# /);
    expect(text).toContain("Ground rules");
    // The seat's defining duties: verify against the diff, never launder.
    expect(text).toContain("Investigate before you report");
    expect(text).toMatch(/[Nn]ever launder/);
  });

  it("carries the review-draft voice rules", () => {
    const text = readFileSync(join(srcDir, REVIEW_DRAFT_VOICE_FILE), "utf8");
    expect(text.length).toBeGreaterThan(500);
    expect(text).toContain("post-process.md");
    expect(text.replace(/\s+/g, " ")).toContain("under their own name");
  });

  it("fails when a manifest entry points at a missing file", () => {
    // Positive control: the check above can actually fail.
    expect(() => readFileSync(join(srcDir, "prompts/no-such-lens.md"), "utf8")).toThrow();
  });
});
