import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BOARD_TARGETS,
  type BoardTarget,
  LEGACY_LENS_ABSENCES,
  LENS_ADMISSIBLE_ABSENCES,
  type LensAbsenceReason,
  settleAbsentReasonFor,
  TYPED_KINDS_BY_TARGET,
} from "./kind-tables";
import type { DraftKind } from "./schema";
import {
  type BoardTool,
  boardToolsByName,
  buildBoardTools,
  flatInputViolations,
  HOST_OWNED_FIELDS,
  toolFieldsForKind,
} from "./tool-schemas";

/**
 * The board tool surface: it is admissible to a provider (D3, #810), and it is DERIVED
 * from the kind tables rather than listed per lens (D2).
 */

const names = (target: BoardTarget, table?: Record<BoardTarget, readonly DraftKind[]>) =>
  buildBoardTools(target, table).map((tool) => tool.name);

const fieldNames = (tool: BoardTool) => Object.keys((tool.input as z.ZodObject).shape);

describe("every board tool input is a flat shape a provider can carry (D3)", () => {
  // 1.2 — the whole answer to #810. `flatInputViolations` renders the input to JSON
  // Schema and reports a missing top-level object type, a combinator at any depth, a
  // nested object, or an array of objects.
  it("renders with a top-level object type and no anyOf/oneOf/allOf at any depth", () => {
    const reported: string[] = [];
    for (const target of BOARD_TARGETS) {
      for (const tool of buildBoardTools(target)) {
        reported.push(...flatInputViolations(`${target}.${tool.name}`, tool.input));
      }
    }
    expect(reported).toEqual([]);
  });

  it("the rendered schemas really do carry the type keyword the API asked for", () => {
    // The assertion above passes vacuously if `flatInputViolations` never rendered
    // anything, so read one rendering directly. `400 tools.9.custom.input_schema.type:
    // Field required` is the exact error this keyword answers.
    const cite = boardToolsByName("noise").get("cite");
    if (cite === undefined) throw new Error("the Noise seat must be able to cite");
    const rendered = z.toJSONSchema(cite.input, { io: "input" }) as Record<string, unknown>;
    expect(rendered.type).toBe("object");
    expect(Object.keys(rendered.properties as object)).toContain("start_line");
    expect(JSON.stringify(rendered)).not.toContain("anyOf");
  });

  // The positive control, executed rather than described: the same function that clears
  // every real tool must FAIL on an input carrying a union-valued field, and must name
  // the tool and the field when it does.
  it("positive control: a union-valued field is reported, naming the tool and the field", () => {
    const probe = z.object({
      title: z.string(),
      // Exactly the shape that produced #810: a union rendering as a bare `anyOf`.
      source: z.union([z.string(), z.number()]),
    });
    const reported = flatInputViolations("probe_tool", probe);
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.join("\n")).toContain("probe_tool");
    expect(reported.join("\n")).toContain("source");
    expect(reported.join("\n")).toContain("anyOf");
  });

  it("positive control: a nested object field is reported even though it carries a type", () => {
    // The combinator walk alone would pass this: `{"type":"object"}` is not a union.
    // A nested object is still inadmissible under D3, so the property check catches it.
    const probe = z.object({ source: z.object({ path: z.string() }) });
    const reported = flatInputViolations("probe_tool", probe);
    expect(reported.join("\n")).toContain("`source` renders as `object`");
  });

  it("positive control: an array of objects is reported", () => {
    const probe = z.object({ sources: z.array(z.object({ path: z.string() })) });
    const reported = flatInputViolations("probe_tool", probe);
    expect(reported.join("\n")).toContain("array of `object`");
  });

  it("positive control: an input that is not an object at all is reported", () => {
    const reported = flatInputViolations("probe_tool", z.array(z.string()));
    expect(reported.join("\n")).toContain('no top-level `"type": "object"`');
  });
});

describe("the tool set is derived from the kind tables, not listed per lens (D2)", () => {
  // 1.3 — the derivation itself. Adding a kind to a lens's typed-kind row must produce
  // that kind's verbs with NO per-lens list edited anywhere.
  it("a kind added to a lens's typed-kind row brings its verbs with it", () => {
    expect(names("sequence")).not.toContain("add_finding");

    const withFindings: Record<BoardTarget, readonly DraftKind[]> = {
      ...TYPED_KINDS_BY_TARGET,
      sequence: ["order_step", "finding"],
    };
    const derived = names("sequence", withFindings);

    expect(derived).toContain("add_finding");
    expect(derived).toContain("update_finding");
    // …and the lens keeps everything it already had.
    expect(derived).toContain("add_step");
    expect(derived).toContain("update_step");
  });

  it("a lens gets no verb for a kind it does not author", () => {
    const sequence = names("sequence");
    for (const absent of ["add_finding", "add_decision", "add_requirement", "add_noise_verdict"]) {
      expect(sequence).not.toContain(absent);
    }
    // …including the report seat's own kind: `round_outcome` is never on a lens board.
    expect(sequence).not.toContain("add_outcome");
    expect(names("design")).not.toContain("add_outcome");
    expect(names("report")).toContain("add_outcome");
  });

  it("every lens carries the shared authoring verbs, a citation verb and a finish", () => {
    for (const target of BOARD_TARGETS) {
      const set = names(target);
      for (const shared of [
        "set_document",
        "add_section",
        "add_prose",
        "add_callout",
        "add_annotation",
        "cite",
        "remove_element",
        "finish",
      ]) {
        expect(set, `${target} is missing ${shared}`).toContain(shared);
      }
    }
  });

  it("every add verb has a matching update verb, and nothing else does", () => {
    for (const target of BOARD_TARGETS) {
      const tools = buildBoardTools(target);
      const adds = tools.filter((tool) => tool.verb === "add").map((tool) => tool.kind);
      const updates = tools.filter((tool) => tool.verb === "update").map((tool) => tool.kind);
      expect([...updates].sort()).toEqual([...adds].sort());
    }
  });

  it("Sequence admits no absence and therefore has no settle-absent verb", () => {
    // The one lens whose absence is a failure, not a result.
    expect(names("sequence")).not.toContain("settle_absent");
    expect(names("report")).not.toContain("settle_absent");
    for (const lens of ["design", "decisions", "flagged", "noise"] as const) {
      expect(names(lens), `${lens} admits an absence`).toContain("settle_absent");
    }
  });

  it("a settle-absent verb names the lens's own absence and has no field to name another", () => {
    const noise = boardToolsByName("noise").get("settle_absent");
    const design = boardToolsByName("design").get("settle_absent");
    expect(noise?.description).toContain("no-noise");
    expect(design?.description).toContain("no-spec");
    // Design's legacy `no-material` stays readable on old generations and is never offered.
    expect(design?.description).not.toContain("no-material");
    // No reason field anywhere: a seat cannot name an absence its lens does not admit.
    expect(fieldNames(noise as BoardTool)).toEqual(["note"]);
  });
});

describe("the settle-absent reason is derived, and refuses to guess", () => {
  it("each lens gets the one absence it admits today, and Sequence gets none", () => {
    expect(settleAbsentReasonFor("design")).toBe("no-spec");
    expect(settleAbsentReasonFor("decisions")).toBe("no-decisions");
    expect(settleAbsentReasonFor("flagged")).toBe("no-findings");
    expect(settleAbsentReasonFor("noise")).toBe("no-noise");
    // Zero is legitimate: an absent Sequence is a failure, not a result.
    expect(settleAbsentReasonFor("sequence")).toBeUndefined();
    expect(settleAbsentReasonFor("report")).toBeUndefined();
  });

  it("Design's legacy absence is filtered, not counted", () => {
    // `no-material` stays admissible so pre-respec generations keep reading, and nothing
    // settles it now — so Design has one LIVE absence even though the table lists two.
    expect(LENS_ADMISSIBLE_ABSENCES.design).toEqual(["no-material", "no-spec"]);
    expect(LEGACY_LENS_ABSENCES).toContain("no-material");
  });

  it("two live absences throw rather than silently removing the verb", () => {
    // Returning `undefined` here would drop `settle_absent` off that lens's surface and
    // cost the lane a settlement it is entitled to — a second live absence needs the verb
    // to grow a way of choosing, which is a decision and not a default.
    const table = LENS_ADMISSIBLE_ABSENCES as Record<string, readonly LensAbsenceReason[]>;
    const original = table.noise;
    table.noise = ["no-noise", "no-findings"];
    try {
      expect(() => settleAbsentReasonFor("noise")).toThrow(/admits 2 live absences/);
      // …and it reaches the surface builder, so the tool set fails loudly too.
      expect(() => buildBoardTools("noise")).toThrow(/admits 2 live absences/);
    } finally {
      table.noise = original as readonly LensAbsenceReason[];
    }
    // Restored, so the rest of the suite sees the real table.
    expect(settleAbsentReasonFor("noise")).toBe("no-noise");
  });
});

describe("host-owned fields appear on no tool input", () => {
  it("a seat cannot author an author, a patchset id, a judge, a status, or a concurrence", () => {
    const forbidden = new Set([
      "author",
      "patchset_id",
      "judge",
      "concurrence",
      "accord",
      "children",
      "delta",
      "measure",
    ]);
    for (const target of BOARD_TARGETS) {
      for (const tool of buildBoardTools(target)) {
        for (const field of fieldNames(tool)) {
          expect(forbidden.has(field), `${target}.${tool.name} exposes \`${field}\``).toBe(false);
        }
      }
    }
  });

  it("a finding's draft status is host-owned; a round outcome's status is the seat's", () => {
    // Both kinds declare a `status`. Only the finding's is the host's — `open` on a
    // draft — so a blanket name-based exclusion would have silently cost the report
    // seat its own classification field.
    expect(HOST_OWNED_FIELDS.finding).toContain("status");
    expect(toolFieldsForKind("finding").map((f) => f.name)).not.toContain("status");
    expect(toolFieldsForKind("round_outcome").map((f) => f.name)).toContain("status");
  });

  it("the fields a seat DOES get are the schema's own, enums included", () => {
    const finding = toolFieldsForKind("finding");
    expect(finding.map((f) => f.name)).toEqual(["severity", "concern", "code_ref_ids"]);
    // The severity vocabulary is reused from the host schema, never retyped here.
    const severity = finding.find((f) => f.name === "severity");
    expect(severity?.schema.safeParse("high").success).toBe(true);
    expect(severity?.schema.safeParse("catastrophic").success).toBe(false);
  });

  it("a structured source is flattened into named scalars, never nested", () => {
    const decision = toolFieldsForKind("decision").map((f) => f.name);
    expect(decision).toContain("source_path");
    expect(decision).toContain("source_candidate");
    expect(decision).toContain("source_line");
    expect(decision).not.toContain("source");
    // A citation is an id, not an object.
    expect(decision).toContain("evidence_ref_ids");
  });

  it("a creating verb takes a parent id and an updating verb takes an element id", () => {
    const tools = boardToolsByName("design");
    expect(fieldNames(tools.get("add_decision") as BoardTool)).toContain("parent_id");
    expect(fieldNames(tools.get("update_decision") as BoardTool)).toContain("element_id");
    // Parenting is decided once, when the element is created.
    expect(fieldNames(tools.get("update_decision") as BoardTool)).not.toContain("parent_id");
  });
});
