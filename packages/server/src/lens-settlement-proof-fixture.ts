import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Author, DraftBoard } from "@rennet/protocol";
import type { ScriptedHarnessPlan } from "./scripted-harness-plan";

/**
 * The scripted plan behind the launched-app LENS SETTLEMENT proof (#548 / #549).
 *
 * It is deliberately not the owner-loop plan: this one drives the two settlements those
 * issues are about, in the real window, with no provider call anywhere.
 *
 * - Sequence and Decisions draw real boards citing the reviewed source, so the launched
 *   run can hydrate their anchors against the captured patchset (#548's acceptance).
 * - Flagged is NOT part of this proof. The #548 Flagged half proved a reconciler-merge
 *   bad-ref repoint; move two retired the merge (the compiler writes the board directly,
 *   with in-turn lint), so there is no post-lint reference shape left to prove here.
 * - Noise's seat either draws a real skip-safe group or emits the empty board that is its
 *   honest "nothing here is skippable" — the two settlements #549's launched proof needs.
 *   The two legs run over DIFFERENT repositories, because a `no-noise` settlement over a
 *   change that does contain generated churn proves only that the script said so: the
 *   signal-only leg seeds a source-only repository, and the populated leg keeps the
 *   generated file as the control that must still produce a verdict board.
 */
export const LENS_SETTLEMENT_LANE = "lens-settlement-548";
export const LENS_SETTLEMENT_SOURCE = "src/settlement.ts";
export const LENS_SETTLEMENT_GENERATED = "generated/table.json";
/** The path-unique sentinel each fixture file carries, so a hydrated span names its file. */
export const LENS_SETTLEMENT_SOURCE_SENTINEL = "settlementSourceSentinel";
export const LENS_SETTLEMENT_GENERATED_SENTINEL = "settlement-generated-sentinel";
/** The step title the launched proof reads back off the settled Sequence board. */
export const LENS_SETTLEMENT_SEQUENCE_STEP = "Read `src/settlement.ts` first.";

const author: Author = { kind: "lens-agent", id: LENS_SETTLEMENT_LANE };

function codeRef(id: string, path: string): DraftBoard["elements"][number] {
  return {
    id,
    kind: "code_ref",
    data: {
      author,
      // NO `patchset_id`, and no `${patchsetId}` placeholder to resolve it with: a seat is
      // never told the captured patchset's identity (commit dcaff8a85 stamps it once, host
      // side, on the board `validateDraft` returns). A scripted seat that emitted one
      // would be modelling a channel that does not exist — and since the placeholder
      // resolved off a JSON context layer no prompt carries any more, it made every board
      // seat of this proof fail before it drafted anything.
      path,
      side: "head",
      start_line: 1,
      end_line: 1,
    },
  };
}

function sequenceBoard(): DraftBoard {
  return {
    document: {
      title: "Settlement reading order",
      introMarkdown: "Start at the changed export, then read the table it feeds.",
      measure: "reading",
    },
    elements: [
      codeRef("seq-code", LENS_SETTLEMENT_SOURCE),
      {
        id: "seq-step",
        kind: "order_step",
        data: {
          author,
          title: LENS_SETTLEMENT_SEQUENCE_STEP,
          span: "seq-code",
          children: [],
        },
      },
      {
        id: "seq-section",
        kind: "section",
        data: { author, title: "Settlement", children: ["seq-step"] },
      },
    ],
  };
}

function decisionsBoard(): DraftBoard {
  return {
    document: {
      title: "Settlement value representation",
      introMarkdown: "The change keeps the settlement value as an exported literal.",
      measure: "reading",
    },
    elements: [
      codeRef("dec-code", LENS_SETTLEMENT_SOURCE),
      {
        id: "dec-alternative",
        kind: "prose",
        data: { author, markdown: "Read the value from ambient configuration instead." },
      },
      {
        id: "dec-choice",
        kind: "decision",
        data: {
          author,
          statement: "Keep the settlement value in source rather than configuration.",
          evidence: ["dec-code"],
          alternatives: ["dec-alternative"],
          why: "The captured patchset then holds the exact value under review.",
          inferred: true,
        },
      },
      {
        id: "dec-section",
        kind: "section",
        data: { author, title: "Source-controlled value", children: ["dec-choice"] },
      },
    ],
  };
}

/** The populated Noise board: the generated table is real, skip-safe churn. */
function noiseBoard(): DraftBoard {
  return {
    document: {
      title: "Generated table regeneration",
      introMarkdown: "The generated table is regenerated output and can be skipped.",
      measure: "reading",
    },
    elements: [
      codeRef("noise-code", LENS_SETTLEMENT_GENERATED),
      {
        id: "noise-verdict",
        kind: "noise_verdict",
        data: {
          author,
          hunk: "noise-code",
          verdict: "noise",
          reason: "The table is regenerated from the changed export; reading it teaches nothing.",
          judge: "llm",
        },
      },
      {
        id: "noise-section",
        kind: "section",
        data: { author, title: "Regenerated output", children: ["noise-verdict", "noise-code"] },
      },
    ],
  };
}

/** How the scripted Noise seat answers: a real skip-safe group, or its honest empty board. */
export type ScriptedNoiseSettlement = "populated" | "no-noise";

export function lensSettlementScriptedHarnessPlan(
  invocationLog: string,
  noise: ScriptedNoiseSettlement,
): ScriptedHarnessPlan {
  return {
    schemaVersion: 1,
    lane: LENS_SETTLEMENT_LANE,
    harness: "claude-code",
    invocationLog,
    steps: [
      {
        id: "project-scout",
        kind: "structured",
        promptIncludes: "You are the project scout.",
        output: { facts: {}, guidanceRules: [] },
      },
      {
        id: "sequence",
        kind: "structured",
        promptIncludes: "You draft the Sequence board for a code change under review.",
        output: sequenceBoard(),
      },
      {
        id: "decisions",
        kind: "structured",
        promptIncludes: "You draft the Decisions board for a code change under review.",
        output: decisionsBoard(),
      },
      {
        id: "noise",
        kind: "structured",
        promptIncludes: "You draft the Noise board for a code change under review.",
        // The empty board is the seat's own "nothing here is skippable" claim — the only
        // return that may settle a typed clean absence.
        output: noise === "populated" ? noiseBoard() : { elements: [] },
      },
    ],
  };
}

export function writeLensSettlementScriptedHarnessPlan(
  root: string,
  noise: ScriptedNoiseSettlement,
): {
  readonly planPath: string;
  readonly invocationLog: string;
} {
  const invocationLog = join(root, `${LENS_SETTLEMENT_LANE}-${noise}-invocations.jsonl`);
  const planPath = join(root, `${LENS_SETTLEMENT_LANE}-${noise}-plan.json`);
  writeFileSync(
    planPath,
    `${JSON.stringify(lensSettlementScriptedHarnessPlan(invocationLog, noise))}\n`,
  );
  return { planPath, invocationLog };
}
