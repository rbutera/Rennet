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
      expect(text).toContain("`document.title`");
      expect(text).toContain("`document.introMarkdown`");
      const measure = kind === "design" ? "structured" : "reading";
      expect(text.replace(/\s+/g, " ")).toContain(`Set \`document.measure\` to \`${measure}\``);
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
    expect(text).toContain("Never add or remove it");
    expect(text.replace(/\s+/g, " ")).toContain("never change `document.measure`");
  });

  it("keeps the Design prompt on one candidate and one canonical scenario owner", () => {
    const text = readFileSync(join(srcDir, LENS_PROMPT_FILES.design), "utf8");
    const normalized = text.replace(/\s+/g, " ");

    expect(normalized).toContain("Never combine candidates into one document");
    expect(normalized).not.toContain("render their complete artifact sets together");
    expect(normalized).toContain("A scenario is a child only through `requirement.scenarios`");
    expect(normalized).toContain("exact `Format` label");
    expect(normalized).toContain("exact first line names the selected plan");
    expect(normalized).toContain("one source-linked capability root");
    expect(normalized).toContain("exact nested operation sections");
    expect(normalized).toContain("Never promote the operations into separate capability roots");
  });

  it("assigns each format-specific Design projection to one canonical owner", () => {
    const text = readFileSync(join(srcDir, LENS_PROMPT_FILES.design), "utf8");
    const fields = [
      "`requirement_refs`",
      "`status`",
      "`acceptance_criteria`",
      "`task_manifest`",
      "`source_cells`",
      "`glossary_term`",
    ];

    for (const field of fields) expect(text.split(field)).toHaveLength(2);
    expect(fields.map((field) => text.indexOf(field))).toEqual(
      [...fields.map((field) => text.indexOf(field))].sort((left, right) => left - right),
    );
    expect(text.replace(/\s+/g, " ")).toContain(
      "The surface renders each display projection once, on the owning element named below",
    );
    expect(text.replace(/\s+/g, " ")).toContain(
      "host-owned parser projections: do not author them",
    );
    expect(text.replace(/\s+/g, " ")).toContain(
      "strips any drafter-supplied claims for these fields, then stamps exact source values before lint and rendering",
    );
  });

  it("carries the round-report drafter with verification duty and the shared ground rules", () => {
    const text = readFileSync(join(srcDir, ROUND_REPORT_FILE), "utf8");
    expect(text.length).toBeGreaterThan(500);
    expect(text).toMatch(/^# /);
    expect(text).toContain("Ground rules");
    // The seat's defining duties: verify against the diff, never launder.
    expect(text).toContain("Investigate before you report");
    expect(text).toMatch(/[Nn]ever launder/);
    expect(text).toContain("`document.title`");
    expect(text).toContain("`document.introMarkdown`");
    expect(text).toMatch(/Set `document\.measure` to\s+`reading`/);
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
