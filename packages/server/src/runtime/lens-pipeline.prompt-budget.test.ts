import { readFileSync } from "node:fs";
import { buildDeltaPacket } from "@rennet/core";
import {
  expandPromptPartials,
  INVESTIGATE_PARTIAL_FILE,
  LENS_KINDS,
  LENS_PROMPT_FILES,
} from "@rennet/prompts";
import { patchsetSchema } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { renderDrafterPrompt } from "./lens-pipeline";

// The prompt-size tripwire (#737). A token regression is invisible in a diff — the
// audit's most expensive one was a five-line deletion — so the drafter prompt is
// assembled here against the REAL captured patchset and measured in UTF-8 bytes.
// When a prompt grows on purpose, raise the budget in the same change and say so
// in the PR; when it grows by accident, this is what reddens.
const fixtureUrl = new URL("../../../core/src/delta/real-capture-fixture.json", import.meta.url);
const promptsDir = new URL("../../../prompts/src/", import.meta.url);
const patchset = patchsetSchema.parse(JSON.parse(readFileSync(fixtureUrl, "utf8")));
const packet = buildDeltaPacket(patchset, []);
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const read = (file: string): string => readFileSync(new URL(file, promptsDir), "utf8");
const lensPrompt = (lens: (typeof LENS_KINDS)[number]): string =>
  expandPromptPartials(read(LENS_PROMPT_FILES[lens]), read(INVESTIGATE_PARTIAL_FILE));

// Measured 2026-09-02 on this fixture (2 files, 3 hunks) after the schema stopped
// riding in the prompt: design 15,233 B, flagged 9,076, sequence 8,672, decisions
// 8,407, noise 8,379 — of which 1,925 is the packet share below. Each lens's fixed
// cost is its measurement minus that share, plus 10% headroom; one shared number
// would let the small lenses grow by half before anything reddened. The packet
// scales at roughly 550 bytes per file row and 275 per hunk row.
const FIXED_BUDGET: Record<(typeof LENS_KINDS)[number], number> = {
  design: 14_650,
  sequence: 7_450,
  decisions: 7_150,
  flagged: 7_900,
  noise: 7_100,
};
const PER_FILE = 550;
const PER_HUNK = 275;
const packetShare = PER_FILE * patchset.files.length + PER_HUNK * packet.hunks.hunks.length;
const budgetFor = (lens: (typeof LENS_KINDS)[number]): number => FIXED_BUDGET[lens] + packetShare;

describe("drafter prompt byte budget (tripwire, #737)", () => {
  it.each(LENS_KINDS)("%s drafter prompt stays under the declared budget", (lens) => {
    expect(bytes(renderDrafterPrompt(lensPrompt(lens), packet))).toBeLessThanOrEqual(
      budgetFor(lens),
    );
  });

  it("reddens when a layer inflates (positive control)", () => {
    // Ten percent is the headroom, so an eleven-percent inflation must cross the line.
    const budget = budgetFor("noise");
    const inflated = `${lensPrompt("noise")}\n${"x".repeat(Math.ceil(budget * 0.11))}`;
    expect(bytes(renderDrafterPrompt(inflated, packet))).toBeGreaterThan(budget);
  });
});
