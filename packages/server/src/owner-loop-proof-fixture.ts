import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Author, DraftBoard } from "@rennet/protocol";
import type { ScriptedHarnessPlan } from "./scripted-harness-plan";

export const OWNER_LOOP_LANE = "owner-loop-685";
export const OWNER_LOOP_SOURCE = "src/owner.ts";
export const OWNER_LOOP_SPEC = "openspec/changes/owner-loop/specs/owner/spec.md";
export const OWNER_LOOP_ROUND_ONE_ASK = "owner-loop-round-one";
export const OWNER_LOOP_ROUND_TWO_ASK = "owner-loop-round-two";
export const OWNER_LOOP_ROUND_ONE_BODY = "Set `ownerValue` to `round-one`.";
export const OWNER_LOOP_ROUND_TWO_BODY = "Set `ownerValue` to `round-two`.";
export const OWNER_LOOP_SEQUENCE_QUOTE = "Read `src/owner.ts` first.";

const author: Author = { kind: "lens-agent", id: OWNER_LOOP_LANE };

function codeRef(id: string): DraftBoard["elements"][number] {
  return {
    id,
    kind: "code_ref",
    data: {
      author,
      patchset_id: "${patchsetId}",
      path: OWNER_LOOP_SOURCE,
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
      sources: [{ path: OWNER_LOOP_SPEC, candidate: "${candidateId}", line: 1 }],
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
          source: { path: OWNER_LOOP_SPEC, candidate: "${candidateId}", line: 3 },
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
          sources: [{ path: OWNER_LOOP_SPEC, candidate: "${candidateId}", line: 1 }],
        },
      },
    ],
    skippedHunks: [],
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
    skippedHunks: [],
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
    skippedHunks: [],
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
        id: "flagged-note",
        kind: "annotation",
        data: {
          author,
          code_ref: "flagged-code",
          body: "No failure scenario is supported by this one-line change.",
        },
      },
      {
        id: "flagged-section",
        kind: "section",
        data: { author, title: "Observed behavior", children: ["flagged-note"] },
      },
    ],
    skippedHunks: [],
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
      codeRef("noise-code"),
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
        data: { author, title: "Behavioral change", children: ["noise-verdict"] },
      },
    ],
    skippedHunks: [],
  };
}

function reportBoard(askId: string, askText: string, value: string): DraftBoard {
  return {
    document: {
      title: `Owner value changed to ${value}`,
      introMarkdown: `The requested value is now \`${value}\` at the cited source line.`,
      measure: "reading",
    },
    elements: [
      codeRef(`report-code-${value}`),
      {
        id: `report-outcome-${value}`,
        kind: "round_outcome",
        data: {
          author,
          status: "addressed",
          ask: { ref: askId, text: askText },
          note: `\`${OWNER_LOOP_SOURCE}\` now exports \`${value}\`.`,
          code_ref: `report-code-${value}`,
        },
      },
    ],
    skippedHunks: [],
  };
}

export function ownerLoopScriptedHarnessPlan(invocationLog: string): ScriptedHarnessPlan {
  return {
    schemaVersion: 1,
    lane: OWNER_LOOP_LANE,
    invocationLog,
    steps: [
      {
        id: "project-scout",
        kind: "structured",
        promptIncludes: "You are the project scout.",
        output: { facts: {}, guidanceRules: [] },
      },
      {
        id: "knowledge-worker",
        kind: "structured",
        promptIncludes: "You are ONE worker in a partitioned swarm;",
        output: { statements: [] },
      },
      {
        id: "knowledge-verify",
        kind: "structured",
        promptIncludes: "You are the VERIFY/SYNTHESIS seat",
        output: { verdicts: [], crossCutting: [] },
      },
      {
        id: "design-coverage",
        kind: "coverage",
        promptIncludes: "You are mapping OpenSpec requirements to the code changes",
        implementationPath: OWNER_LOOP_SOURCE,
      },
      {
        id: "post-process",
        kind: "echo-board",
        promptIncludes: "# Post-process pass — board prose editor",
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
        id: "report-round-one",
        kind: "structured",
        promptIncludes: OWNER_LOOP_ROUND_ONE_BODY,
        promptExcludes: [OWNER_LOOP_ROUND_TWO_BODY, "# Post-process pass — board prose editor"],
        output: reportBoard(OWNER_LOOP_ROUND_ONE_ASK, OWNER_LOOP_ROUND_ONE_BODY, "round-one"),
      },
      {
        id: "report-round-two",
        kind: "structured",
        promptIncludes: OWNER_LOOP_ROUND_TWO_BODY,
        promptExcludes: "# Post-process pass — board prose editor",
        output: reportBoard(OWNER_LOOP_ROUND_TWO_ASK, OWNER_LOOP_ROUND_TWO_BODY, "round-two"),
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

export function writeOwnerLoopScriptedHarnessPlan(root: string): {
  readonly planPath: string;
  readonly invocationLog: string;
} {
  const invocationLog = join(root, `${OWNER_LOOP_LANE}-invocations.jsonl`);
  const planPath = join(root, `${OWNER_LOOP_LANE}-plan.json`);
  writeFileSync(planPath, `${JSON.stringify(ownerLoopScriptedHarnessPlan(invocationLog))}\n`);
  return { planPath, invocationLog };
}
