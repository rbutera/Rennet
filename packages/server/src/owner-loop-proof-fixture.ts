import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Author, DraftBoard } from "@rennet/protocol";
import type { ScriptedHarnessPlan } from "./scripted-harness-plan";

export const OWNER_LOOP_LANE = "owner-loop-685";
export const OWNER_LOOP_SOURCE = "src/owner.ts";
/**
 * A second MODIFIED file on the reviewed branch that no core lens cites — so the Noise
 * complement has something real to be the complement OF (#864).
 *
 * Before the complement subtracted per hunk, this proof drafted a Noise board over the
 * BASE side of `src/owner.ts`: the one line all four siblings had just cited, kept in the
 * remainder because their citations named the head side. The board was green over the
 * defect. A modified hunk nobody reads is the honest shape, and it is also the shape the
 * fix is about — one change with two sides, filed once.
 */
export const OWNER_LOOP_UNCITED = "src/generated.ts";
export const OWNER_LOOP_SPEC = "openspec/changes/owner-loop/specs/owner/spec.md";
export const OWNER_LOOP_ROUND_ONE_ASK = "owner-loop-round-one";
export const OWNER_LOOP_ROUND_TWO_ASK = "owner-loop-round-two";
export const OWNER_LOOP_ROUND_ONE_BODY = "Set `ownerValue` to `round-one`.";
export const OWNER_LOOP_ROUND_TWO_BODY = "Set `ownerValue` to `round-two`.";
export const OWNER_LOOP_SEQUENCE_QUOTE = "Read `src/owner.ts` first.";

const author: Author = { kind: "lens-agent", id: OWNER_LOOP_LANE };
const askPlanValue = `\${askId}`;
const evidenceIdsPlanValue = `\${evidenceIds}`;
const askIdsPlanValue = `\${askIds}`;

function codeRef(id: string, path: string = OWNER_LOOP_SOURCE): DraftBoard["elements"][number] {
  return {
    id,
    kind: "code_ref",
    data: {
      author,
      // NO `patchset_id`: a seat is never told the captured patchset's identity, so a
      // scripted seat that emitted one would be modelling a channel that does not exist.
      // `validateDraft` stamps it once, on the board it returns for persistence.
      path,
      side: "head",
      start_line: 1,
      end_line: 1,
    },
  };
}

function designBoard(): DraftBoard {
  return {
    document: {
      title: "owner-loop",
      introMarkdown: "The owner-loop value remains visible across review rounds.",
      measure: "structured",
      sources: [{ path: OWNER_LOOP_SPEC, line: 1 }],
      stats: [
        { label: "Format", value: "OpenSpec" },
        { label: "Requirements", value: "1" },
        { label: "Capabilities", value: "1 new / 0 modified" },
      ],
    },
    elements: [
      {
        id: "design-scenario",
        kind: "prose",
        data: {
          author,
          markdown:
            "Scenario: Review the owner loop WHEN the owner loop is reviewed THEN the current value remains source-backed.",
        },
      },
      {
        id: "design-requirement",
        kind: "requirement",
        data: {
          author,
          name: "Keep the owner-loop value source-backed",
          capability: "owner",
          shall: "The system SHALL keep the owner-loop value source-backed.",
          scenarios: ["design-scenario"],
          related_files: [OWNER_LOOP_SOURCE],
          source: { path: OWNER_LOOP_SPEC, line: 3 },
          spec_delta: "added",
        },
      },
      codeRef("design-code"),
      {
        id: "design-operation",
        kind: "section",
        data: {
          author,
          title: "ADDED Requirements",
          children: ["design-requirement"],
          spec_delta: "added",
        },
      },
      {
        id: "design-capability",
        kind: "section",
        data: {
          author,
          title: "Owner",
          children: ["design-operation"],
          spec_delta: "added",
        },
      },
      {
        id: "design-section",
        kind: "section",
        data: {
          author,
          title: "Owner specification",
          children: ["design-capability", "design-code"],
          sources: [{ path: OWNER_LOOP_SPEC, line: 1 }],
        },
      },
    ],
  };
}

function sequenceBoard(): DraftBoard {
  return {
    document: {
      title: "Owner value reading order",
      introMarkdown: "Start at the exported value, then follow its review history.",
      measure: "reading",
    },
    elements: [
      codeRef("sequence-code"),
      {
        id: "sequence-step",
        kind: "order_step",
        data: {
          author,
          title: OWNER_LOOP_SEQUENCE_QUOTE,
          span: "sequence-code",
          children: [],
        },
      },
      {
        id: "sequence-section",
        kind: "section",
        data: { author, title: "Owner value", children: ["sequence-step"] },
      },
    ],
  };
}

function decisionsBoard(): DraftBoard {
  return {
    document: {
      title: "Owner value representation",
      introMarkdown: "The change keeps the reviewed value as an exported string literal.",
      measure: "reading",
    },
    elements: [
      codeRef("decisions-code"),
      {
        id: "decisions-alternative",
        kind: "prose",
        data: { author, markdown: "Load the value from ambient configuration." },
      },
      {
        id: "decisions-choice",
        kind: "decision",
        data: {
          author,
          statement: "Keep `ownerValue` as source-controlled review state.",
          evidence: ["decisions-code"],
          alternatives: ["decisions-alternative"],
          why: "The immutable patchset then captures the exact value under review.",
          inferred: true,
        },
      },
      {
        id: "decisions-section",
        kind: "section",
        data: { author, title: "Source-controlled value", children: ["decisions-choice"] },
      },
    ],
  };
}

function flaggedBoard(): DraftBoard {
  return {
    document: {
      title: "Owner value checks",
      introMarkdown: "The exported value has one direct source anchor and no observed defect.",
      measure: "reading",
    },
    elements: [
      codeRef("flagged-code"),
      {
        id: "flagged-finding",
        kind: "finding",
        data: {
          author,
          severity: "medium",
          concern: "The exported review value has no validation at its use boundary.",
          code: ["flagged-code"],
          concurrence: [],
          status: "open",
        },
      },
      {
        id: "flagged-section",
        kind: "section",
        data: { author, title: "Observed behavior", children: ["flagged-finding"] },
      },
    ],
  };
}

function noiseBoard(): DraftBoard {
  return {
    document: {
      title: "Owner value classification",
      introMarkdown: "The changed line is behavioral signal and stays in the reading path.",
      measure: "reading",
    },
    elements: [
      // The Noise seat cites what it GROUPS, which is the file no core lens read — the
      // host's own complement members point there too.
      codeRef("noise-code", OWNER_LOOP_UNCITED),
      {
        id: "noise-verdict",
        kind: "noise_verdict",
        data: {
          author,
          hunk: "noise-code",
          verdict: "signal",
          reason: "The exported string changes runtime behavior.",
          judge: "llm",
        },
      },
      {
        id: "noise-section",
        kind: "section",
        data: {
          author,
          title: "Behavioral change",
          children: ["noise-verdict", "noise-code"],
        },
      },
    ],
  };
}

function reportClassification(value: string): unknown {
  return {
    outcomes: [
      {
        askId: askPlanValue,
        status: "addressed",
        note: `\`${OWNER_LOOP_SOURCE}\` now exports \`${value}\`.`,
        // The whole round is this one ask's work, so the ask owns every measured
        // evidence id and the `beyond` bucket stays empty (#726).
        evidenceIds: evidenceIdsPlanValue,
      },
    ],
    beyond: [],
  };
}

export function ownerLoopScriptedHarnessPlan(
  invocationLog: string,
  harness: ScriptedHarnessPlan["harness"] = "claude-code",
): ScriptedHarnessPlan {
  return {
    schemaVersion: 1,
    lane: OWNER_LOOP_LANE,
    harness,
    invocationLog,
    steps: [
      {
        id: "project-scout",
        kind: "structured",
        promptIncludes: "You are the project scout.",
        output: { facts: {}, guidanceRules: [] },
      },
      {
        id: "design",
        kind: "structured",
        promptIncludes: "You draft the Design document for a code change under review.",
        output: designBoard(),
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
        id: "flagged",
        kind: "structured",
        promptIncludes: "You draft one seat of the Flagged board for a code change under review.",
        output: flaggedBoard(),
      },
      {
        id: "noise",
        kind: "structured",
        promptIncludes: "You draft the Noise board for a code change under review.",
        output: noiseBoard(),
      },
      {
        // The handoff compose turn (3.7): the work order the round dispatches is AUTHORED,
        // not the mechanical floor. Without a step here the scripted port has no answer,
        // the compose port fails, and the core router silently falls back — a real turn on
        // the owner loop's path that the proof never exercised. The ids come from
        // `compose/asks.json`, which is a context FILE the turn reads: the prompt names a
        // directory and carries no note text, so the plan resolves them the same way.
        id: "compose-work-order",
        kind: "structured",
        promptIncludes:
          "You are composing a code reviewer's separate review notes into ONE coherent work order",
        output: {
          groups: [{ title: "Advance the owner value", dispositionIds: askIdsPlanValue }],
        },
      },
      {
        id: "report-round-one",
        kind: "structured",
        promptIncludes: ["# Round report — classification instructions", OWNER_LOOP_ROUND_ONE_BODY],
        promptExcludes: [OWNER_LOOP_ROUND_TWO_BODY],
        output: reportClassification("round-one"),
      },
      {
        id: "report-round-two",
        kind: "structured",
        promptIncludes: ["# Round report — classification instructions", OWNER_LOOP_ROUND_TWO_BODY],
        output: reportClassification("round-two"),
      },
      {
        id: "round-one-edit",
        kind: "edit",
        promptIncludes: OWNER_LOOP_ROUND_ONE_BODY,
        edits: [
          {
            path: OWNER_LOOP_SOURCE,
            from: "export const ownerValue = 'reviewed';",
            to: "export const ownerValue = 'round-one';",
          },
        ],
        finalText: "Set ownerValue to round-one.",
      },
      {
        id: "round-two-edit",
        kind: "edit",
        promptIncludes: OWNER_LOOP_ROUND_TWO_BODY,
        edits: [
          {
            path: OWNER_LOOP_SOURCE,
            from: "export const ownerValue = 'round-one';",
            to: "export const ownerValue = 'round-two';",
          },
        ],
        finalText: "Set ownerValue to round-two.",
      },
    ],
  };
}

export function writeOwnerLoopScriptedHarnessPlan(
  root: string,
  harness: ScriptedHarnessPlan["harness"] = "claude-code",
): {
  readonly planPath: string;
  readonly invocationLog: string;
} {
  const invocationLog = join(root, `${OWNER_LOOP_LANE}-invocations.jsonl`);
  const planPath = join(root, `${OWNER_LOOP_LANE}-plan.json`);
  writeFileSync(
    planPath,
    `${JSON.stringify(ownerLoopScriptedHarnessPlan(invocationLog, harness))}\n`,
  );
  return { planPath, invocationLog };
}
