import { readFileSync } from "node:fs";
import { buildDeltaPacket } from "@rennet/core";
import {
  expandPromptPartials,
  INVESTIGATE_PARTIAL_FILE,
  LENS_KINDS,
  LENS_PROMPT_FILES,
  PROMPT_PARTIAL_MARKER,
  WRITE_WITH_TOOLS_MARKER,
  WRITE_WITH_TOOLS_PARTIAL_FILE,
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
  expandPromptPartials(read(LENS_PROMPT_FILES[lens]), {
    [PROMPT_PARTIAL_MARKER]: read(INVESTIGATE_PARTIAL_FILE),
    [WRITE_WITH_TOOLS_MARKER]: read(WRITE_WITH_TOOLS_PARTIAL_FILE),
  });

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
// design 12,152 B, flagged 6,673, sequence 6,288, noise 6,636, decisions 6,004. The
// DeltaPacket no longer rides, so there is no per-file term any more — on the
// 74-file/292-hunk packet below every one of these numbers is IDENTICAL, which is the
// property the second test pins. Each budget is its measurement plus 10% headroom; one
// shared number would let the small lenses grow by half before anything reddened.
//
// What this cannot catch, stated so no reader inherits a wider claim: the prompt is
// rendered with no context directory, so the path-reference layer (bounded under 2 KB by
// its own test in `lens-pipeline.test.ts`) is not measured here.
// Noise moved 6,088 → 6,636 B on 2026-09-04, deliberately: Rai's ruling made the lens the
// COMPLEMENT of the other four boards rather than an independent skip-safety verdict, so
// `noise.md` carries the new definition and the total-remainder rule (openspec
// `lens-board-tools` D16). It grew and then shrank again in the same change, because the
// second half of the ruling deleted every instruction that invited the seat to judge.
// 6,636 still fits the old 6,750 budget, but only by 1.7% — the number below is restated
// as measurement + 10% so this file's own convention stays true and the next harmless
// edit reddens for a real reason rather than for the leftover headroom.
//
// RAISED 2026-09-05 for `lens-board-tools` 3.6, deliberately and with the figure stated.
// Each lens prompt's emit slot — "your output is a draft board of typed blocks in the
// schema supplied with your task" — became the tool vocabulary: the shared
// `write-with-tools.md` partial (1,654 B) plus the one line naming that lens's own verb.
//
// Measured on this fixture against `origin/main`, before → after (delta):
//
//   design    12,169 → 14,223  (+2,054)
//   sequence   6,627 →  8,503  (+1,876)
//   decisions  6,432 →  8,294  (+1,862)
//   flagged    7,379 →  9,226  (+1,847)
//   noise      6,636 →  8,103  (+1,467)
//
// Four of the five sit just above the partial's own 1,814 B, which is what a slot swap
// costs; Noise is the one below it, because `noise.md` also LOST its members bullet, its
// document instruction and the line stamping `verdict`/`judge` — the host writes all four
// now (D16f).
//
// Three of these figures were first recorded as 8,033 / 7,735 / 8,389, which were wrong.
// They were inherited from an earlier lane rather than re-derived, and their impossibility
// was legible without re-running anything: the shared partial alone was 1,654 B and only
// about 180 B came out, so no lens could have grown by 1,010–1,406. Re-measure through
// `renderDrafterPrompt(lensPrompt(lens), packet)` — this file's own helpers — rather than
// copying a number forward. The budget-headroom test below is the mechanical half of that
// rule: it fails on a budget that no longer matches what the prompt actually measures, in
// either direction, so a stale figure cannot sit here green for a whole change again.
//
// It is a real growth in what a seat is SENT and it is not free, so it is named rather
// than absorbed. What pays for it is on the other side of the same change: the seat turn
// stops carrying an output schema (9,618 B as the Claude leg sends it, 10,874 B as the
// Codex leg does), and it carried that on EVERY turn while this text rides the base
// prompt once per thread — a repair turn now carries the `finish` verdict alone.
//
// ── #869: +800 B on NOISE, and on no other lens ─────────────────────────────────
//
// `noise.md` gained two paragraphs teaching `write_board`, the whole-board verb. Measured
// here on 2026-09-05, through this file's own helpers rather than copied from the spike:
//
//   design    14,223 → 14,223  (unchanged)
//   sequence   8,503 →  8,503  (unchanged)
//   decisions  8,294 →  8,294  (unchanged)
//   flagged    9,226 →  9,226  (unchanged)
//   noise      8,103 →  8,903  (+800)
//
// The four zeroes are the point of the change and not an accident of where the text went.
// The spike (draft PR #878) put this teaching in the shared `write-with-tools.md` partial
// and paid +870 B on every lens, ~5.2 KB across a generation's six threads, for a verb its
// own measurement showed made the four reasoning lenses SLOWER. Here it rides `noise.md`'s
// own tail, beside the `update_noise_verdict` paragraph it belongs with, so one thread
// pays for it. The tool surface is scoped the same way (`writesWholeBoard`).
//
// +800 B once per thread against 961 → 4 board calls and 317.8 s → 108.7 s on the lane
// that is the generation's serial tail, measured on the 95-file drive. That is the trade,
// and it is stated because it is a real growth in what a seat is sent.
//
// #898 (2026-09-06) took design 14,223 → 12,668 (−1,555): the "Format-specific
// structured fields" section named seven fields the tool surface has no input for, so
// the seat was paying to read instructions it could not follow. The host assembler
// stamps those projections now; the seat keeps the one it can write, `scenario_clauses`.
//
// Budgets are measurement + 10% headroom, as this file's convention has always been.
const BUDGET: Record<(typeof LENS_KINDS)[number], number> = {
  design: 13_930,
  sequence: 9_360,
  decisions: 9_130,
  flagged: 10_150,
  noise: 9_790,
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
