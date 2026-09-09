import { readFileSync } from "node:fs";
import { buildDeltaPacket } from "@rennet/core";
import {
  expandPromptPartials,
  FLAGGED_REVIEW_FILE,
  LENS_KINDS,
  LENS_PROMPT_FILES,
  PROMPT_PARTIALS,
} from "@rennet/prompts";
import { type Patchset, patchsetSchema } from "@rennet/protocol";
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
  expandPromptPartials(
    read(LENS_PROMPT_FILES[lens]),
    Object.fromEntries(
      Object.entries(PROMPT_PARTIALS).map(([marker, file]) => [marker, read(file)]),
    ),
  );

/**
 * A 74-file / 292-hunk patchset — the shape a large agent-written branch has, and the
 * one the 2026-09-03 audit measured the old inline packet on. It shares the fixture's
 * repository record, so the only thing that differs from the fixture is the change.
 */
function synthetic(): Patchset {
  const files = Array.from({ length: 74 }, (_, index) => {
    const path = `packages/pkg-${index % 9}/src/module-${index}.ts`;
    const hunkCount = index < 70 ? 4 : 3;
    const hunks = Array.from({ length: hunkCount }, (_, h) => {
      const start = 10 + h * 40;
      const added = Array.from(
        { length: 6 },
        (_unused, line) => `+export const v${index}_${h}_${line} = ${line};`,
      );
      return `@@ -${start},3 +${start},9 @@ function f${h}()\n context\n${added.join("\n")}\n-old line\n context\n`;
    });
    return {
      path,
      status: "modified" as const,
      additions: hunkCount * 6,
      deletions: hunkCount,
      binary: false,
      patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.join("")}`,
    };
  });
  return { ...patchset, id: "ps-synthetic", files };
}

const bigPacket = buildDeltaPacket(synthetic(), []);

// Full prompts on this fixture, including the task layer but no context directory:
// design 15,588 B (the located-specification section, this change); sequence 10,248 B;
// decisions 9,961 B; noise 10,594 B. Move two splits Flagged into two drafter prompts —
// the review leg (`flagged-review.md`) and the compiler (`flagged-compile.md`, which
// `LENS_PROMPT_FILES.flagged` names) — each much shorter than the old single flagged prompt.
// Budgets leave 10% headroom. The context-reference layer has its own bounded test.
// These are bytes sent, not measured provider tokens or total conversation cost.
const BUDGET: Record<(typeof LENS_KINDS)[number], number> = {
  design: 17_147,
  sequence: 11_273,
  decisions: 10_958,
  flagged: 4_698,
  noise: 11_654,
};
// The Flagged review leg is a drafter prompt too — sent by both review seats — so it gets
// the same tripwire. `flagged` above is the compiler prompt (`LENS_PROMPT_FILES.flagged`).
const FLAGGED_REVIEW_BUDGET = 8_486;

describe("drafter prompt byte budget (tripwire, #737)", () => {
  it.each(LENS_KINDS)("%s drafter prompt stays under the declared budget", (lens) => {
    expect(bytes(renderDrafterPrompt(lensPrompt(lens), packet))).toBeLessThanOrEqual(BUDGET[lens]);
  });

  it.each(LENS_KINDS)("%s drafter prompt does not grow with the change at all", (lens) => {
    // 2 files / 3 hunks against 74 files / 292 hunks: byte-identical, because nothing
    // derived from the packet reaches the prompt. This is the tripwire that reddens if an
    // inventory, a hunk index or a file-row list creeps back into any layer — the budget
    // above would still pass on the fixture while every large branch paid for it.
    expect(bigPacket.hunks.hunks.length).toBeGreaterThan(290);
    expect(bytes(renderDrafterPrompt(lensPrompt(lens), bigPacket))).toBe(
      bytes(renderDrafterPrompt(lensPrompt(lens), packet)),
    );
  });

  it.each(LENS_KINDS)("%s budget is the stated headroom over the real measurement", (lens) => {
    // The convention above — "measurement + 10%" — was prose, and prose does not redden.
    // A budget carried forward from a superseded figure left Flagged with 167 bytes of
    // headroom against a file that claims 10%, and nothing said so: the budget assertion
    // passes at ANY headroom, which is exactly why a stale number can sit here for a whole
    // change. This makes the convention executable in both directions — too little
    // headroom means a stale budget, too much means one raised past what was measured.
    const measured = bytes(renderDrafterPrompt(lensPrompt(lens), packet));
    const headroom = BUDGET[lens] / measured;
    expect(headroom, `${lens}: ${BUDGET[lens]} over a measured ${measured}`).toBeGreaterThan(1.09);
    expect(headroom, `${lens}: ${BUDGET[lens]} over a measured ${measured}`).toBeLessThan(1.12);
  });

  it("the flagged review prompt stays under budget at the stated headroom", () => {
    const review = expandPromptPartials(
      read(FLAGGED_REVIEW_FILE),
      Object.fromEntries(
        Object.entries(PROMPT_PARTIALS).map(([marker, file]) => [marker, read(file)]),
      ),
    );
    const measured = bytes(renderDrafterPrompt(review, packet));
    expect(measured).toBeLessThanOrEqual(FLAGGED_REVIEW_BUDGET);
    const headroom = FLAGGED_REVIEW_BUDGET / measured;
    expect(
      headroom,
      `flagged review: ${FLAGGED_REVIEW_BUDGET} over a measured ${measured}`,
    ).toBeGreaterThan(1.09);
    expect(
      headroom,
      `flagged review: ${FLAGGED_REVIEW_BUDGET} over a measured ${measured}`,
    ).toBeLessThan(1.12);
    // Nothing derived from the packet reaches it either, so a large branch pays the same.
    expect(bytes(renderDrafterPrompt(review, bigPacket))).toBe(measured);
  });

  it("reddens when a layer inflates (positive control)", () => {
    // Ten percent is the headroom, so an eleven-percent inflation must cross the line.
    const budget = BUDGET.noise;
    const inflated = `${lensPrompt("noise")}\n${"x".repeat(Math.ceil(budget * 0.11))}`;
    expect(bytes(renderDrafterPrompt(inflated, packet))).toBeGreaterThan(budget);
  });

  it("reddens when the change reaches the prompt (positive control for the scaling test)", () => {
    // The second test asserts an equality; an equality is satisfied by two prompts that
    // are both wrong in the same way. This proves it can see a difference at all: the same
    // comparison over a prompt that DOES interpolate the packet is not equal.
    const withPacket = (p: typeof packet): string =>
      `${renderDrafterPrompt(lensPrompt("noise"), p)}\n${JSON.stringify(p.patchset.files)}`;
    expect(bytes(withPacket(bigPacket))).not.toBe(bytes(withPacket(packet)));
  });
});
