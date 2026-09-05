import { outputSchemaFor } from "@rennet/adapters";
import { BoardWriter } from "@rennet/core";
import type { Author, BoardTarget } from "@rennet/protocol";
import { boardToolsByName } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { boardOutputSchema } from "../runtime/lens-pipeline";
import { describeOutcome, servedToolCatalog } from "./board-mcp-server";

/**
 * Tasks 2.7 and 3.2 — what a board seat now sends and receives per turn, beside what it
 * replaced.
 *
 * This file is a MEASUREMENT, not coverage. Its assertions are the facts the PR states,
 * and it exists so a reader can re-run the figure rather than trust a number typed into a
 * description; do not read its green bar as proof that anything else about the board
 * server works.
 *
 * ── Every operand is the real one, and that took three goes ──────────────────────
 * EVERY side is taken from the code production uses: `servedToolCatalog` is what
 * `tools/list` answers with, `outputSchemaFor` is what `t3-seat-turn.ts` hands the
 * provider, the tool calls are applied by the real `BoardWriter`, and their results are
 * the real `describeOutcome` strings. Nothing here is reconstructed.
 *
 * That sentence is written out because getting it wrong is the recurring defect of this
 * change rather than a one-off. THREE times an assertion here pointed at a copy of the
 * thing instead of the thing: the tool side was a local rebuild, so a control that
 * stopped the server stripping `$schema` left this number describing a surface nobody
 * was sent; the schema side was the RAW `boardOutputSchema()` while the header claimed it
 * was "as it reaches the provider", which it is not — the seat leg strips the meta keys
 * off it and, for the Codex seat, runs `sanitizeSchemaForCodex` over it, which is 1,256 B
 * bigger; and before both of those the aggregate row summed six targets under a
 * seven-seat label. If you add an operand here, take it from the module that ships it.
 *
 * ── Seats, not targets ───────────────────────────────────────────────────────────
 * A generation seats SEVEN threads over six boards: Flagged runs two, one per provider,
 * pinned by construction (`runFlaggedDual`). Every other seat runs on the harness the
 * council routes it to, which is Claude in the default council — that is the assumption in
 * {@link SEATS}, and it is the only thing here that could drift without this file noticing.
 */

interface SeatRow {
  readonly seat: string;
  readonly target: BoardTarget;
  readonly provider: "claudeAgent" | "codex";
}

/** The seven threads of one generation, and the provider each one's schema is shaped for. */
const SEATS: readonly SeatRow[] = [
  { seat: "design", target: "design", provider: "claudeAgent" },
  { seat: "sequence", target: "sequence", provider: "claudeAgent" },
  { seat: "decisions", target: "decisions", provider: "claudeAgent" },
  { seat: "flagged-claude", target: "flagged", provider: "claudeAgent" },
  { seat: "flagged-codex", target: "flagged", provider: "codex" },
  { seat: "noise", target: "noise", provider: "claudeAgent" },
  { seat: "round-report", target: "report", provider: "claudeAgent" },
];

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const textBytes = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * The output schema a board seat's turn USED to carry, shaped by the leg that sent it.
 *
 * It carries none now (3.2): `outputSchemaFor` is not reached on a lens seat's turn at
 * all, because `t3-seat-turn.ts` omits the field entirely when the turn has no contract.
 * This is therefore the BASELINE — what stopped being sent, per turn, per seat — and the
 * one seat still on the document path (the legacy round-report leg) still pays it.
 */
const retiredSchema = (row: SeatRow): unknown => outputSchemaFor(row.provider, boardOutputSchema());

/**
 * The declared bounds (token discipline: "every dynamic interpolation declares a byte
 * bound at its call site"). RE-MEASURED 2026-09-05 with both operands as-sent, after #869
 * gave the Noise seat `write_board` and #856 gave `prose` its scenario clauses: the worst
 * seat is Design at 1.36x the schema it replaces, and a generation's seven seats together
 * are 0.984x (68,903 B of tools against 70,057 B of schema) — the tool surface is still
 * SMALLER in aggregate than the output schema it replaces.
 *
 * Two moves, one day apart, both worth telling apart:
 *
 * - #869 moved the Noise seat 7,693 → 8,179 B and no other seat at all, so the generation
 *   moved 64,595 → 65,081, +486 B once per session.
 * - #856 declared `scenario_clauses` on `prose`, which is a UNIVERSAL kind, so it lands on
 *   `add_prose` and `update_prose` for all six targets: +546 B on EVERY seat, 65,081 →
 *   68,903, +3,822 per generation. And because it is a field of the board schema, the
 *   output schema this is measured against grew too — 68,582 → 70,057, +1,475. Both
 *   operands moving is why the ratio only went 0.949 → 0.984, and the margin on the
 *   generation bound is now 0.02 rather than 0.05.
 *
 * (The figure this note carried before #869, 64,785, had drifted: it was measured before
 * #864/#868 changed the Noise verb set. Re-run the test — it prints the table — rather than
 * copying a number forward, which is this file's whole point. That is not a hypothetical:
 * the first draft of the #856 measurement subtracted from the drifted 64,785 and reported
 * a +3,632 delta that was 190 B per seat wrong.)
 *
 * The generation bound is therefore set at parity, which makes it a claim rather than
 * slack: a change that takes a generation's seats past what they replace has grown what
 * every seat sends on every request, and the PR that makes it has to say so. That is why
 * this is a test and not a script somebody once ran. It is also why #869 is Noise-only:
 * the spike that measured the verb put it on all seven and reached 67,997 B, 0.99x, with
 * its first draft over the ceiling at 69,222 B.
 */
const PER_SEAT_CEILING = 1.4;
const GENERATION_CEILING = 1.0;

describe("the tool surface a seat receives, beside the output schema it replaces (2.7)", () => {
  it("stays inside the declared bound against the board schema it replaces", () => {
    const rows = SEATS.map((row) => ({
      seat: row.seat,
      tools: boardToolsByName(row.target).size,
      toolSurfaceBytes: bytes(servedToolCatalog(row.target)),
      outputSchemaBytes: bytes(retiredSchema(row)),
    }));
    console.info(
      ["seat            tools  tool surface  output schema"]
        .concat(
          rows.map(
            (row) =>
              `${row.seat.padEnd(15)} ${String(row.tools).padStart(5)}  ${String(row.toolSurfaceBytes).padStart(12)}  ${String(row.outputSchemaBytes).padStart(13)}`,
          ),
        )
        .join("\n"),
    );
    for (const row of rows) {
      expect(
        row.toolSurfaceBytes / row.outputSchemaBytes,
        `${row.seat}: tool surface ${row.toolSurfaceBytes} B against an output schema of ${row.outputSchemaBytes} B`,
      ).toBeLessThan(PER_SEAT_CEILING);
    }
    const surface = rows.reduce((sum, row) => sum + row.toolSurfaceBytes, 0);
    const schemas = rows.reduce((sum, row) => sum + row.outputSchemaBytes, 0);
    expect(
      surface / schemas,
      `a generation's seven seats carry ${surface} B of tools against ${schemas} B of output schema`,
    ).toBeLessThan(GENERATION_CEILING);
  });

  it("prices `write_board` where it is served, and it is served to one seat (#869)", () => {
    // The PR's cost sentence, made executable. It is taken from `servedToolCatalog` — what
    // `tools/list` actually answers with — and not from a local rebuild of the tool set:
    // the recurring defect of this change is an assertion pointed at a copy of the thing,
    // and this file's own header names three times it happened.
    const priced = SEATS.map((row) => {
      const served = servedToolCatalog(row.target);
      const without = served.filter((tool) => tool.name !== "write_board");
      return { seat: row.seat, cost: bytes(served) - bytes(without) };
    });
    const carrying = priced.filter((row) => row.cost > 0);
    console.info(
      `write_board is served to ${carrying.map((row) => row.seat).join(", ") || "no seat"} at ${carrying[0]?.cost ?? 0} B`,
    );
    // ONE seat. The other six do not pay for a verb the spike measured them slower with.
    expect(carrying.map((row) => row.seat)).toEqual(["noise"]);
    // And what that one seat pays, once per session — the whole of #869's session cost.
    // 486 and not 485: the verb's own JSON is 485 B and the catalog's separator is the
    // other byte, which is what the seat is actually sent.
    expect(carrying[0]?.cost).toBe(486);
  });

  it("measures the schema the seat leg SENDS, not the one the pipeline holds", () => {
    // The guard on the operand: a raw `boardOutputSchema()` still carries its `$schema`
    // stamp, and the Codex seat's is a different schema again. If this file ever goes back
    // to measuring the raw one, these two are what say so.
    const raw = JSON.stringify(boardOutputSchema());
    expect(raw).toContain("$schema");
    const claudeSeat = SEATS.find((row) => row.seat === "sequence");
    const codexSeat = SEATS.find((row) => row.seat === "flagged-codex");
    if (claudeSeat === undefined || codexSeat === undefined) throw new Error("seat row missing");
    expect(JSON.stringify(retiredSchema(claudeSeat))).not.toContain("$schema");
    expect(bytes(retiredSchema(codexSeat))).toBeGreaterThan(bytes(retiredSchema(claudeSeat)));
  });
});

// ── What the round trip costs instead (3.2) ──────────────────────────────────

/**
 * The cost the schema's removal does NOT buy back: a seat that writes its board pays one
 * `tool_use` block and one `tool_result` block PER ELEMENT, on every turn, where a single
 * document return paid neither.
 *
 * This is the honest other half of the 2.7 figure, and it is measured on a fixture rather
 * than argued. The fixture is a small, ordinary Flagged board — one section, one citation,
 * one finding, one piece of prose — written through the REAL `BoardWriter` with the REAL
 * tool set, and each result rendered by the REAL `describeOutcome`. What is counted is the
 * bytes the model emits as tool inputs plus the bytes it reads back as tool results.
 *
 * Measured 2026-09-05 on the fixture below: 6 calls writing 4 elements cost 567 B of
 * `tool_use` and 33 B of `tool_result`, 600 B in all, against 838 B for the same board as
 * one document return.
 *
 * What this CANNOT catch, stated because no assertion here covers it: the per-block
 * framing overhead a provider adds around a `tool_use`/`tool_result` pair, and the
 * re-billing of the whole conversation on each round trip inside one turn — N round trips
 * mean the prefix is re-read N times, which is the real cost of writing over returning and
 * is not visible to any byte count taken here. Both are provider-side and only a live drive
 * shows them: that is task 7.1, and this file deliberately spawns no harness.
 */
const AUTHOR: Author = { kind: "lens-agent", id: "lens:flagged:claudeAgent" };

describe("what a tool-writing seat pays per turn that a document return did not (3.2)", () => {
  it("counts the tool_use and tool_result bytes of one ordinary board", () => {
    const writer = new BoardWriter({
      target: "flagged",
      author: AUTHOR,
      lint: {
        regions: [{ path: "src/auth.ts", side: "head", start: 10, end: 20 }],
        files: new Map([["src/auth.ts", 200]]),
        patchsetId: "ps-1",
      },
    });
    const calls: { name: string; input: Record<string, unknown> }[] = [
      {
        name: "set_document",
        input: { title: "Flagged", intro_markdown: "One concern requires attention." },
      },
      { name: "add_section", input: { title: "Findings" } },
      {
        name: "cite",
        input: { path: "src/auth.ts", side: "head", start_line: 11, end_line: 14 },
      },
      {
        name: "add_finding",
        input: {
          severity: "high",
          concern: "The refresh path retries before the token is replaced.",
        },
      },
      {
        name: "add_prose",
        input: { markdown: "The retry runs against the credential it was about to replace." },
      },
      { name: "finish", input: {} },
    ];

    let requestBytes = 0;
    let resultBytes = 0;
    let sectionId: string | undefined;
    let citationId: string | undefined;
    for (const call of calls) {
      const input: Record<string, unknown> = { ...call.input };
      // The references a real seat carries: the parent it names and the citation it cites,
      // both ids an earlier call returned. Counted in the request bytes like any other
      // field, because that is what the model emits.
      if (call.name === "cite" || call.name === "add_finding" || call.name === "add_prose") {
        if (sectionId !== undefined) input.parent_id = sectionId;
      }
      if (call.name === "add_finding" && citationId !== undefined) {
        input.code_ref_ids = [citationId];
      }
      requestBytes += textBytes(JSON.stringify({ name: call.name, input }));
      const result = writer.call(call.name, input);
      if (!result.ok) throw new Error(`fixture refused by \`${call.name}\`: ${result.refusal}`);
      resultBytes += textBytes(describeOutcome(result.outcome));
      if (result.outcome.kind === "element") {
        if (call.name === "add_section") sectionId = result.outcome.id;
        if (call.name === "cite") citationId = result.outcome.id;
      }
    }
    expect(writer.status(), "the fixture board did not settle").toBe("settled");

    const document = bytes(writer.board());
    console.info(
      [
        `board elements               ${writer.board().elements.length}`,
        `tool calls                   ${calls.length}`,
        `tool_use bytes (model → host) ${requestBytes}`,
        `tool_result bytes (host → model) ${resultBytes}`,
        `round trip total             ${requestBytes + resultBytes}`,
        `the same board as one document return ${document}`,
      ].join("\n"),
    );

    // ONE round trip per call, and every one of them is a block a document return did not
    // pay for. Asserted as a count rather than described, so a change that adds a
    // host-initiated call per element cannot land silently.
    expect(calls.length).toBe(6);
    // The tool RESULTS are the cheap half by construction: a successful call answers with
    // the id it minted and nothing else (`describeOutcome`). If this stops holding, a
    // result has started carrying prose the seat did not need.
    expect(
      resultBytes,
      `tool results averaged ${Math.round(resultBytes / calls.length)} B; they are meant to be an id`,
    ).toBeLessThan(requestBytes / 2);
    // And the request half is within a small factor of the document it replaces: the seat
    // sends each element's fields once either way, plus a verb name and a JSON envelope
    // per call. A blow-up here means a tool input has started carrying something the
    // element does not.
    expect(
      requestBytes / document,
      `${requestBytes} B of tool inputs against a ${document} B document`,
    ).toBeLessThan(1.5);
  });
});

// ── What a tool RESULT costs, on a board big enough to show it (#871) ────────

/**
 * A tool result is billed like a prompt and gets the same byte discipline.
 *
 * CLAUDE.md's harness section bounds every dynamic interpolation a PROMPT carries. Nobody
 * had written the equivalent for what a tool RESULT carries, and the provider charges for
 * both identically — worse, a result sits in the conversation prefix and is re-read on
 * every remaining round trip of that turn, which for a board seat is 60-121 of them (#867).
 *
 * It only shows on a large host-derived board, which is why no fixture caught it: the
 * boards in every other test hold a handful of elements. So this file builds the board #871
 * was sighted on — 1,252 elements, the Noise complement of a 95-file branch — drives the
 * REAL `BoardWriter` and the REAL `describeOutcome`, and measures every result that
 * interpolates a COLLECTION.
 *
 * Measured 2026-09-05, before and after the bound:
 *
 *   boundary refusal (300 danglers)   44,295 B  ->  1,489 B
 *   removal receipt (401 ids)          2,304 B  ->    116 B
 *   unheld-id refusal (1,252 ids)        144 B  ->    144 B  (already capped by `heldIds`)
 *
 * The unheld-id refusal — the one #871 quotes — was ALREADY bounded at twenty ids by
 * `heldIds()` when the issue was filed; the sighting predates that cap. What was not bounded
 * is the boundary tier's own refusal, which joins every violation the call introduced, and
 * the removal receipt, which names every id a subtree took with it.
 *
 * What this CANNOT catch, stated because no assertion here covers it: a result that is small
 * per call and issued thousands of times, and the provider's own framing around each
 * `tool_result` block. Neither is visible to a byte count taken here.
 */
const NOISE_REGIONS_LARGE = 626; // 1,252 elements — two per region (#871's board)
const NOISE_REGIONS_SMALL = 3;
const DANGLERS_LARGE = 300;
const DANGLERS_SMALL = 3;

/**
 * The declared ceiling on ONE PER-CALL tool result, whatever the board (#871). The worst
 * measured is the `finish` receipt at 3,220 B — twenty lint pointers, each a whole sentence,
 * bounded by `POINTER_SAMPLE`. Everything else is under 1.5 kB.
 *
 * `write_board` is deliberately not in this table: it answers for a whole BATCH, so its
 * envelope is `POINTER_SAMPLE` refusal sentences (each capped by `BATCH_SENTENCE_CAP`) plus
 * `CASCADE_SAMPLE` positions, which is larger than this by construction and declared at
 * those constants (#869).
 */
const TOOL_RESULT_CEILING = 4096;

/**
 * How much a result may grow between a small board and a large one. A bound is only a bound
 * if the growth stops; this is the assertion that reddens when one comes off. The pre-fix
 * boundary refusal grew ~98x across these same two fixtures and the removal receipt ~57x.
 */
const GROWTH_CEILING = 10;

const idOf = (result: ReturnType<BoardWriter["call"]>): string => {
  if (!result.ok || result.outcome.kind !== "element") {
    throw new Error(
      `expected an element, got: ${result.ok ? result.outcome.kind : result.refusal}`,
    );
  }
  return result.outcome.id;
};

const resultText = (result: ReturnType<BoardWriter["call"]>): string =>
  result.ok ? describeOutcome(result.outcome) : result.refusal;

const regionsFor = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index}.ts`,
    side: "head" as const,
    start: 1,
    end: 40,
  }));

/**
 * Every tool result a board hands back that interpolates a collection, at one scale.
 *
 * Each one is produced by DRIVING the writer into the state that yields it, never by
 * calling a formatter with a synthetic list: a formatter that stopped being reached would
 * otherwise still measure beautifully.
 */
function collectionResults(scale: { regions: number; danglers: number }): Record<string, string> {
  const regions = regionsFor(scale.regions);
  const noise = new BoardWriter({
    target: "noise",
    author: { kind: "lens-agent", id: "lens:noise:claudeAgent" },
    lint: { regions, files: new Map(regions.map((r) => [r.path, 200])), patchsetId: "ps-1" },
  });
  const members = noise.placeMembers("noise_verdict", regions);
  const overshoot = `e${noise.board().elements.length + 76}`;

  // The Flagged board that produces a boundary refusal: N findings citing one citation, then
  // the citation removed out from under them.
  const flagged = new BoardWriter({
    target: "flagged",
    author: AUTHOR,
    lint: {
      regions: regionsFor(1),
      files: new Map([["src/file-0.ts", 200]]),
      patchsetId: "ps-1",
    },
  });
  const section = idOf(flagged.call("add_section", { title: "Findings" }));
  const citation = idOf(
    flagged.call("cite", {
      parent_id: section,
      path: "src/file-0.ts",
      side: "head",
      start_line: 2,
      end_line: 6,
    }),
  );
  for (let index = 0; index < scale.danglers; index += 1) {
    flagged.call("add_finding", {
      parent_id: section,
      severity: "medium",
      concern: `The retry path number ${index} runs before the token is replaced.`,
      code_ref_ids: [citation],
    });
  }

  // A board whose whole content hangs off one section, so removing it succeeds and the
  // receipt names the subtree.
  const roomy = new BoardWriter({
    target: "flagged",
    author: AUTHOR,
    lint: {
      regions: regionsFor(1),
      files: new Map([["src/file-0.ts", 200]]),
      patchsetId: "ps-1",
    },
  });
  const doomed = idOf(roomy.call("add_section", { title: "Everything" }));
  for (let index = 0; index < scale.danglers; index += 1) {
    roomy.call("add_prose", { parent_id: doomed, markdown: `Note number ${index}.` });
  }

  return {
    // The #871 sighting itself: an id the board does not hold.
    "unheld id": resultText(
      noise.call("update_noise_verdict", { element_id: overshoot, reason: "x" }),
    ),
    // A parent the board does not hold — the same list, reached by a different verb.
    "unheld parent": resultText(noise.call("add_section", { title: "T", parent_id: overshoot })),
    // Removing a member the HOST derived: the refusal names what would go.
    "derived removal": resultText(noise.call("remove_element", { element_id: members[0] ?? "e2" })),
    // The unsettled `finish` receipt: every lint pointer the board still carries.
    finish: resultText(noise.call("finish", {})),
    // THE BOUNDARY REFUSAL: one violation per element that pointed at what the call removed.
    "boundary refusal": resultText(flagged.call("remove_element", { element_id: citation })),
    // The accepted removal's receipt: every id the subtree took with it.
    "removal receipt": resultText(roomy.call("remove_element", { element_id: doomed })),
  };
}

describe("what a board's tool RESULTS cost on a 1,252-element board (#871)", () => {
  it("bounds every result that interpolates a collection, and stops it growing with the board", () => {
    const small = collectionResults({ regions: NOISE_REGIONS_SMALL, danglers: DANGLERS_SMALL });
    const large = collectionResults({ regions: NOISE_REGIONS_LARGE, danglers: DANGLERS_LARGE });

    console.info(
      ["result             small   large  growth"]
        .concat(
          Object.keys(large).map((key) => {
            const from = textBytes(small[key] ?? "");
            const to = textBytes(large[key] ?? "");
            return `${key.padEnd(18)} ${String(from).padStart(5)}  ${String(to).padStart(6)}  ${(to / from).toFixed(1)}x`;
          }),
        )
        .join("\n"),
    );

    for (const [key, text] of Object.entries(large)) {
      expect(
        textBytes(text),
        `the ${key} result is ${textBytes(text)} B on a 1,252-element board`,
      ).toBeLessThan(TOOL_RESULT_CEILING);
      const from = textBytes(small[key] ?? "");
      expect(
        textBytes(text) / from,
        `the ${key} result grew ${(textBytes(text) / from).toFixed(1)}x with the board`,
      ).toBeLessThan(GROWTH_CEILING);
    }

    // The operand guard: the large fixture really is large, and the refusals really are
    // refusals. Without this the two assertions above would pass over a fixture that built
    // a three-element board twice, and over results that all said "ok".
    expect(large["boundary refusal"]).toContain("element-reference-resolves");
    expect(large["unheld id"]).toContain("This board holds no");
    expect(large["removal receipt"]).toContain("removed");
    expect(large.finish).toContain("to fix");
  });
});
