import { readFileSync } from "node:fs";
import { buildDeltaPacket } from "@rennet/core";
import {
  expandPromptPartials,
  INVESTIGATE_PARTIAL_FILE,
  LENS_KINDS,
  LENS_PROMPT_FILES,
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
  expandPromptPartials(read(LENS_PROMPT_FILES[lens]), read(INVESTIGATE_PARTIAL_FILE));

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

// Measured 2026-09-04 on this fixture (2 files, 3 hunks) once the context layer became a
// path reference (session-bound-workspace 3.1), rendered WITHOUT a context directory:
// design 12,152 B, flagged 6,673, sequence 6,288, noise 7,095, decisions 6,004. The
// DeltaPacket no longer rides, so there is no per-file term any more — on the
// 74-file/292-hunk packet below every one of these numbers is IDENTICAL, which is the
// property the second test pins. Each budget is its measurement plus 10% headroom; one
// shared number would let the small lenses grow by half before anything reddened.
//
// What this cannot catch, stated so no reader inherits a wider claim: the prompt is
// rendered with no context directory, so the path-reference layer (bounded under 2 KB by
// its own test in `lens-pipeline.test.ts`) is not measured here.
// Noise moved 6,088 → 7,095 B on 2026-09-04, deliberately: Rai's ruling made the lens the
// COMPLEMENT of the other four boards rather than an independent skip-safety verdict, and
// `noise.md` had to carry the new definition, the total-remainder rule, and the `signal`
// escape that replaces "when in doubt, it is signal" (openspec `lens-board-tools` D16).
// The budget is raised in the same change, which is what this tripwire asks for.
const BUDGET: Record<(typeof LENS_KINDS)[number], number> = {
  design: 13_400,
  sequence: 6_950,
  decisions: 6_650,
  flagged: 7_400,
  noise: 7_800,
};

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
