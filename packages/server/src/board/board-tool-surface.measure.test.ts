import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputSchemaFor } from "@rennet/adapters";
import { BoardWriter } from "@rennet/core";
import type { Author, BoardTarget, CommandName } from "@rennet/protocol";
import { boardToolsByName } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildAppTools } from "../agent-tools";
import {
  APP_TOOL_RESULT_MAX_BYTES,
  type AppMcpServer,
  servedAppToolCatalog,
  shapeAppToolResult,
  startAppMcpServer,
} from "../app/app-mcp-server";
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
 * ── Board seats, not targets ───────────────────────────────────────────────────────
 * After move two (`flagged-review-compile`) a generation seats EIGHT threads, but only SIX
 * of them carry a board tool surface. The Flagged lane runs three threads: two review legs
 * (`flagged-claude`, `flagged-codex`), which write a free-form findings FILE with the
 * harness's own file tools and so carry NO board tool surface and NO output schema, and one
 * compiler (`flagged-compile`), which reads both files and writes the whole flagged board.
 * The compiler is the only Flagged thread this measurement counts, because it is the only
 * one that replaced an output schema with a tool surface. Every board seat runs on the
 * harness the council routes it to, which is Claude in the default council — that is the
 * assumption in {@link SEATS}, and it is the only thing here that could drift without this
 * file noticing.
 */

interface SeatRow {
  readonly seat: string;
  readonly target: BoardTarget;
  readonly provider: "claudeAgent" | "codex";
}

/** The six BOARD seats of one generation, and the provider each one's schema is shaped for. */
const SEATS: readonly SeatRow[] = [
  { seat: "design", target: "design", provider: "claudeAgent" },
  { seat: "sequence", target: "sequence", provider: "claudeAgent" },
  { seat: "decisions", target: "decisions", provider: "claudeAgent" },
  { seat: "flagged-compile", target: "flagged", provider: "claudeAgent" },
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
 * bound at its call site"). RE-MEASURED 2026-09-09 with both operands as-sent, after move
 * two (`flagged-review-compile`) reshaped the Flagged lane: the worst seat is Design at
 * 1.37x the schema it replaces, and a generation's SIX board seats together are 1.032x
 * (61,385 B of tools against 59,496 B of schema) — the tool surface is now slightly LARGER
 * in aggregate than the output schema it replaces, and this note and the PR say so.
 *
 * Why the aggregate crossed parity, told apart from the earlier moves it inherits:
 *
 * - Before move two the Flagged lane ran two board seats (one per provider), each counted
 *   here with the flagged tool surface and the flagged output schema — a near-parity pair
 *   counted twice. Move two makes the two review legs write a findings FILE, not a board, so
 *   they carry no board tool surface and leave this population entirely. What remains is one
 *   Flagged thread, the compiler, and the population drops 7 → 6 board seats.
 * - The compiler is the sole writer of its board and compiles the whole thing in one pass,
 *   so it carries `write_board` (D9) — the same +486 B verb #869 measured on Noise, now on a
 *   second seat — plus its `add_finding`/`update_finding` each carry the two authored enums
 *   `origin` + `agreement` (D10). Its surface is 10,604 B against the 9,916 B schema, 1.069x.
 * - Removing a near-parity duplicate and leaving the heavier seats (Design at 1.37x, the
 *   compiler at 1.069x) is what lifts the aggregate from the old 0.984x to 1.032x. No single
 *   seat's turn crosses the per-seat bound; the aggregate crosses the parity bound, which is
 *   the disclosed cost of giving the compiler a bulk-write verb.
 *
 * Re-run the test — it prints the table — rather than copying a number forward, which is
 * this file's whole point.
 *
 * The generation bound is set just above the measured aggregate, so it stays a tripwire: a
 * change that grows a board seat's surface further trips it, and the PR that makes it has to
 * say so, exactly as this one does. That is why this is a test and not a script somebody
 * once ran.
 */
const PER_SEAT_CEILING = 1.4;
const GENERATION_CEILING = 1.05;

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
      `a generation's six board seats carry ${surface} B of tools against ${schemas} B of output schema`,
    ).toBeLessThan(GENERATION_CEILING);
  });

  it("prices `write_board` where it is served, and it is served to two seats (#869, D9)", () => {
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
      `write_board is served to ${carrying.map((row) => row.seat).join(", ") || "no seat"} at ${carrying.map((row) => row.cost).join(", ")} B`,
    );
    // TWO seats: the Noise seat, which bulk-writes its derived board (#869), and the Flagged
    // compiler, the sole writer of its board, which compiles the whole thing from the two
    // review files in one pass (D9). The four reasoning lenses and the report do not pay for
    // a verb the spike measured them slower with.
    expect(carrying.map((row) => row.seat).sort()).toEqual(["flagged-compile", "noise"]);
    // What each seat pays, once per session — the whole of #869's session cost, now on two
    // seats. 486 and not 485: the verb's own JSON is 485 B and the catalog's separator is
    // the other byte. Both seats pay the SAME: `write_board` carries one opaque `board_json`
    // field, whose size does not move with the target's finding schema.
    const noiseCost = carrying.find((row) => row.seat === "noise")?.cost;
    const flaggedCost = carrying.find((row) => row.seat === "flagged-compile")?.cost;
    expect(noiseCost).toBe(486);
    expect(flaggedCost).toBe(486);
  });

  it("measures the schema the seat leg SENDS, not the one the pipeline holds", () => {
    // The guard on the operand: a raw `boardOutputSchema()` still carries its `$schema`
    // stamp, and the Codex-shaped schema is a different schema again. If this file ever goes
    // back to measuring the raw one, these two are what say so. Taken from the providers
    // directly, not a seat row: the default council routes every board seat to Claude, so no
    // seat here is Codex-shaped — but the shaping is a property of the provider leg, which is
    // still what a Codex-routed compiler would send.
    const raw = JSON.stringify(boardOutputSchema());
    expect(raw).toContain("$schema");
    const claudeShaped = outputSchemaFor("claudeAgent", boardOutputSchema());
    const codexShaped = outputSchemaFor("codex", boardOutputSchema());
    expect(JSON.stringify(claudeShaped)).not.toContain("$schema");
    expect(bytes(codexShaped)).toBeGreaterThan(bytes(claudeShaped));
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
          // The compiler attributes every finding: `origin` names the model that raised it,
          // `agreement` how the two reviews landed. Both are required on the flagged board.
          origin: "claude",
          agreement: "solo",
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
      // The compiler attributes every flagged finding; both enums are required on the board.
      origin: "claude",
      agreement: "solo",
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

// ── What the SESSION THREAD's app tools cost (session-thread-briefing 3.3) ────

/**
 * The other tool surface a turn can carry, measured on the same terms as the board's.
 *
 * The session thread holds `rennet_app`: the whole `exposure.agent` projection, served over
 * loopback MCP. Two costs, and they are different animals:
 *
 * - the CATALOG is fixed at the provider session's construction and sits in the prefix for
 *   the thread's life — one price, paid on every turn of that thread;
 * - a RESULT is billed like a prompt and is re-read on every remaining round trip of the
 *   turn it lands in (#871), which is why every collection-carrying result is paged.
 *
 * Both operands are the real ones: `servedAppToolCatalog` is what `tools/list` answers with,
 * and `shapeAppToolResult` is the function the wire calls — not a rebuild of either. The
 * board fixture is the REAL `BoardWriter`'s 1,252-element Noise board, the same one #871 was
 * sighted on. The session, transcript and evidence fixtures are synthetic rows shaped like
 * their projections; what they carry is the BOUND, which holds whatever the rows are,
 * because the byte budget is measured on the rows as serialized.
 *
 * What this CANNOT catch: how many calls a turn makes. Paging bounds one result, not a model
 * that pages through a 1,252-element board twenty times. Only a live drive shows that.
 */

const noiseBoardOf = (regions: number) => {
  const all = regionsFor(regions);
  const writer = new BoardWriter({
    target: "noise",
    author: { kind: "lens-agent", id: "lens:noise:claudeAgent" },
    lint: { regions: all, files: new Map(all.map((r) => [r.path, 200])), patchsetId: "ps-1" },
  });
  writer.placeMembers("noise_verdict", all);
  return writer.board();
};

const sessionRows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    projectId: "project-1",
    title: `Review the authentication refresh path, attempt ${index}`,
    updatedAt: "2026-09-12T10:00:00.000Z",
    pinned: false,
    archived: false,
    branch: `feat/branch-number-${index}`,
    repositoryRoot: `/Users/someone/dev/repo-${index}`,
  }));

const transcriptRows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    kind: index % 2 === 0 ? "user" : "assistant",
    at: "2026-09-12T10:00:00.000Z",
    text: `Turn number ${index}: ${"the round said something about the change. ".repeat(4)}`,
  }));

// ── Large, plausible fixtures for the universal ceiling (item 1, both reviewers' finding
// 1): only four commands (`board.read`, `session.list`, `session.transcript`,
// `patchset.readEvidence`) ever bounded their result — every OTHER exposed command fell
// through `shapeAppToolResult`'s default branch to a raw, unbounded `JSON.stringify(output)`.
// The sighting was `ask.read` on a 400-ask projection: 144,611 B, riding the wire whole.
// `APP_TOOL_RESULT_MAX_BYTES` (8,192 B) now bounds the COMPLETE serialised result of EVERY
// exposed command, behind whichever per-command paging above already ran; over the ceiling,
// `applyResultCeiling` spills the full result to a file and returns an honest envelope. This
// section prices all 29, not a chosen four.

/** A 400-entry `stagedAsks` projection — `ask.read`'s own #871-shaped sighting. */
function stagedAsksOf(count: number): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `ask-${index}`,
      {
        id: `ask-${index}`,
        anchor: `src/file-${index % 40}.ts:${index + 1}`,
        type: "comment",
        body: `Consider tightening the error handling here — ask ${index} of a long projection that must not ride the wire unbounded.`,
      },
    ]),
  );
}

/** A rounds ledger with real-sized diffs (#571's round-diff surface), not empty rows. */
function roundLedgerOf(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    reviewId: "review-1",
    id: `round-${index}`,
    startedAt: "2026-09-12T10:00:00.000Z",
    workerCommitRange: { from: `oid-${index}-a`, to: `oid-${index}-b` },
    boardGeneration: `gen-${index}`,
    reportBoard: `board-${index}`,
    outcome: "completed",
    // ~1.25 KB of diff per round × 40 rounds ≈ 50 KB.
    diff: `diff --git a/src/file-${index}.ts b/src/file-${index}.ts\n${"+const line = 1;\n".repeat(80)}`,
    changedPaths: [`src/file-${index}.ts`],
  }));
}

/** A composed handoff bundle's task list — shared by `review.handoff.compose` and
 *  `round.dispatch`'s `workOrder` (the ORDERING CONTRACT: compose once, run that bundle). */
function handoffTasksOf(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `Task ${index}: address the reviewer's asks on file-${index}.ts`,
    sourceDispositions: [`disposition-${index}`],
    asks: [
      {
        path: `src/file-${index}.ts`,
        type: "comment",
        instruction: `Address ask ${index}: tighten validation and add a regression test.`,
        context: "the surrounding function, three lines of context above and below",
        id: `ask-${index}`,
      },
    ],
  }));
}

const handoffBundle = {
  reviewId: "review-1",
  patchsetId: "ps-1",
  tasks: handoffTasksOf(30),
  prompt: "Work the following tasks in order, one commit per task.",
  digest: "digest-abc123",
  composed: true,
  traceMap: {},
};

/**
 * The commands this task named explicit large fixtures for, keyed by `CommandName`. Every
 * OTHER exposed command (settings, pairing-free acts, `projects.list`, etc.) is priced
 * against {@link GENERIC_LARGE_BLOB} instead — not because any of them would really return
 * this shape, but because the point of the universal ceiling is that it catches an oversized
 * result from ANY of the 29 rows, not only ones a fixture author remembered to name. If the
 * ceiling only worked for the seven named here, this file would have reproduced the exact
 * defect it is fixing: coverage as an allowlist.
 */
const LARGE_FIXTURES: Partial<Record<CommandName, unknown>> = {
  "board.read": { board: noiseBoardOf(NOISE_REGIONS_LARGE) },
  "session.list": { sessions: sessionRows(400) },
  "session.transcript": { trail: { branch: "feat/x" }, rows: transcriptRows(400) },
  "patchset.readEvidence": {
    path: "src/auth.ts",
    counterparts: [],
    // ~200 KB of unified diff text.
    patch: `@@ -1,4 +1,4 @@\n${"-const a = 1;\n+const a = 2;\n".repeat(8_000)}`,
  },
  "ask.read": {
    projection: {
      stagedAsks: stagedAsksOf(400),
      findingDispositions: {},
      lineComments: {},
      quoteThreads: {},
      retired: {},
      verdictOverride: null,
    },
  },
  "session.rounds": { records: roundLedgerOf(40) },
  "review.handoff.compose": { bundle: handoffBundle },
  "round.dispatch": { workOrder: handoffBundle, dispatched: true },
};

const GENERIC_LARGE_BLOB = {
  note: "a generic large payload, standing in for any exposed command's real output",
  blob: "x".repeat(40_000),
};

/**
 * The named fixtures whose result is over the ceiling even AFTER whatever shaping they have,
 * so the operand guard below can assert each really spills — a fixture that quietly shrank
 * cannot leave the spill path unexercised.
 *
 * The three COUNT-paged tools are not here, and that is round 5's item 1: the page budget
 * was the evidence read's 16 kB, double the 8 kB ceiling, so a full page was over the
 * ceiling on arrival and every one of them spilled — paging decided how much got written to
 * disk rather than what the model reads. At 5 kB their pages ride INLINE with their cursors
 * ({@link PAGED_TOOLS_INLINE}). `patchset.readEvidence` stays here on purpose: its own
 * declared cap is 16 kB of patch text, which is a deliberate "this page is genuinely big",
 * and it therefore still answers with a path.
 */
const NAMED_LARGE_FIXTURE_TOOLS = [
  "app_patchset_readEvidence",
  "app_ask_read",
  "app_session_rounds",
  "app_review_handoff_compose",
  "app_round_dispatch",
];

/** The paged tools whose page is expected to RIDE INLINE at the 5 kB page budget. */
const PAGED_TOOLS_INLINE = ["app_board_read", "app_session_list", "app_session_transcript"];

function fixtureFor(commandId: CommandName): unknown {
  return LARGE_FIXTURES[commandId] ?? GENERIC_LARGE_BLOB;
}

const MEASURE_BEARER = "board-tool-surface measure bearer";
const MEASURE_THREAD = "measure-thread";

/**
 * One `tools/call`, over the REAL wire (a test-gap fix, both reviewers' P1's own point):
 * measuring `shapeAppToolResult` and `applyResultCeiling` directly — the buggy version of
 * this test — rebuilds exactly the pair `applyResultCeiling` composes internally, so a
 * regression in how they are WIRED TOGETHER (item 1's own defect: the ceiling measuring the
 * inner text instead of the complete `content` envelope) could never fail this measurement,
 * only the assertion an unrelated wire-level test happened to also carry. Driving the actual
 * HTTP listener and reading the actual response body is what makes a future regression here
 * red.
 */
async function callOverWire(
  server: AppMcpServer,
  name: string,
  // The request's own JSON-RPC id (round 4, Codex): defaults to `1` for every existing
  // caller, but a probe that wants to prove the CEILING counts the envelope — not just the
  // bare result — has to send an id whose own size is part of what gets measured, since
  // `{jsonrpc, id, result}` is the complete wire body and `id` is the caller's to pick.
  requestId: number | string = 1,
): Promise<{ readonly status: number; readonly text: string; readonly wireBytes: number }> {
  const response = await fetch(server.addressFor(MEASURE_THREAD).url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      authorization: `Bearer ${MEASURE_BEARER}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
  const text = await response.text();
  return { status: response.status, text, wireBytes: Buffer.byteLength(text, "utf8") };
}

describe("what the session thread's app tools cost (session-thread-briefing)", () => {
  it("prices the catalog the thread's every turn carries", () => {
    const catalog = servedAppToolCatalog(async () => undefined);
    const rows = catalog
      .map((tool) => ({ name: tool.name, size: bytes(tool) }))
      .sort((a, b) => b.size - a.size);
    const total = bytes(catalog);
    console.info(
      [`app tool catalog: ${catalog.length} tools, ${total} B`]
        .concat(rows.slice(0, 5).map((row) => `  ${row.name.padEnd(30)} ${row.size}`))
        .join("\n"),
    );
    // Measured 2026-09-12: 29 tools, 13,070 B — the whole `exposure.agent` projection, fixed
    // at the provider session's construction and re-read on every turn of the thread. The
    // bound is set just above it so a row that grows the surface materially trips this and
    // the PR that adds it has to say so. Re-run the test rather than copy the number forward.
    expect(total, `the app tool catalog is ${total} B across ${catalog.length} tools`).toBeLessThan(
      16_000,
    );
    // The heaviest row is `ask.stage`'s: its input embeds the whole `StagedAskSchema`, which
    // (item 4, both reviewers' finding 4) gained an optional `author` field so a client's
    // own claim of authorship can be told apart from the server's stamp — a few more bytes
    // of schema than `projects.add`'s `DiscoveryResult` payload, the previous heaviest row.
    // Named so a reader can see where the surface's bytes are.
    expect(rows[0]?.name).toBe("app_ask_stage");
  });

  it("bounds EVERY agent-exposed command's complete wire result to APP_TOOL_RESULT_MAX_BYTES, spilling the full result to a file when it doesn't fit (item 1)", async () => {
    // A test-gap fix (Codex, second reviewer): the version this replaces called
    // `shapeAppToolResult` and `applyResultCeiling` directly — the exact pair the wire's own
    // `callTool` composes — so a regression in how those two are WIRED TOGETHER (item 1's
    // own defect: the ceiling comparing `result.text` instead of the complete serialised
    // `{content, isError?}` object) could never make this measurement red; it would only
    // fail an unrelated assertion in a different file. This version drives the real HTTP
    // listener, for every exposed tool, and measures the exact response bytes the wire sent.
    const dir = mkdtempSync(join(tmpdir(), "app-tool-ceiling-"));
    const server = await startAppMcpServer({
      bearer: () => MEASURE_BEARER,
      dispatch: () => async (commandId: CommandName) => fixtureFor(commandId),
      stateDir: dir,
    });
    try {
      const tools = buildAppTools(async () => undefined);
      // The operand guard: this really is the whole `AGENT_EXPOSED` surface, not a stale
      // local list — if a row is ever added to or removed from that set, this count moves
      // and says so, rather than silently exercising a smaller population than the task.
      expect(tools.length, "the agent-exposed command count moved — update this fixture").toBe(29);

      const rows: {
        readonly name: string;
        readonly commandId: CommandName;
        readonly wireBytes: number;
        readonly spilled: string | undefined;
      }[] = [];
      for (const tool of tools) {
        const answer = await callOverWire(server, tool.name);
        expect(answer.status, `${tool.name} returned HTTP ${answer.status}`).toBe(200);
        const body = JSON.parse(answer.text) as {
          result?: { content?: { type: string; text: string }[] };
        };
        const contentText = body.result?.content?.[0]?.text ?? "{}";
        const envelope = JSON.parse(contentText) as { truncated?: boolean; path?: string };
        rows.push({
          name: tool.name,
          commandId: tool.commandId,
          wireBytes: answer.wireBytes,
          spilled: envelope.truncated === true ? envelope.path : undefined,
        });
      }

      const maxWireBytes = Math.max(...rows.map((row) => row.wireBytes));
      console.info(
        ["app tool                          wire B  spilled"]
          .concat(
            [...rows]
              .sort((a, b) => b.wireBytes - a.wireBytes)
              .map(
                (row) =>
                  `${row.name.padEnd(34)} ${String(row.wireBytes).padStart(7)}  ${row.spilled === undefined ? "no" : "yes"}`,
              ),
          )
          .concat([`max complete-result bytes across all ${rows.length} tools: ${maxWireBytes}`])
          .join("\n"),
      );

      for (const row of rows) {
        // The LITERAL 8,192, not the exported `APP_TOOL_RESULT_MAX_BYTES` constant: a future
        // edit that raised the constant without meaning to raise the ceiling would move the
        // two together, and comparing against the constant would stay green over a real
        // regression. This is what a change to the constant is required to notice (pinned
        // again, standalone, below).
        expect(
          row.wireBytes,
          `${row.name}'s complete wire result is ${row.wireBytes} B, over the 8,192 B universal ceiling`,
        ).toBeLessThanOrEqual(8_192);
        if (row.spilled !== undefined) {
          // The exact body production actually wrote — `shapeAppToolResult` is the real
          // per-command shaping function the wire calls before the ceiling ever runs, not a
          // rebuild of the ceiling itself, so this still checks the spilled file is the
          // FULL result rather than trusting the envelope's own `bytes` field.
          const shaped = shapeAppToolResult(row.commandId, fixtureFor(row.commandId));
          const rawBody =
            shaped.marker === undefined ? shaped.text : `${shaped.text}\n\n${shaped.marker}`;
          const onDisk = readFileSync(row.spilled, "utf8");
          expect(
            textBytes(onDisk),
            `${row.name}'s spilled file should hold its FULL result, not a truncated copy`,
          ).toBe(textBytes(rawBody));
        }
      }

      // The operand guard: every command this task named an explicit large fixture for
      // really did exceed the ceiling and really did spill (proving the fixtures are large
      // enough to exercise the path, not accidentally small), AND at least one command
      // running only the GENERIC fallback also spilled — proving the ceiling is universal
      // rather than an allowlist of the seven names above (both reviewers' finding 1).
      const spilledNames = new Set(
        rows.filter((row) => row.spilled !== undefined).map((row) => row.name),
      );
      for (const name of NAMED_LARGE_FIXTURE_TOOLS) {
        expect(spilledNames.has(name), `${name}'s named large fixture should have spilled`).toBe(
          true,
        );
      }
      // ...and the count-paged tools, whose pages now FIT, come back in the reply with
      // their cursors rather than as paths to files (round 5, item 1). A page of the
      // 1,252-element Noise board is the case that was sighted.
      for (const name of PAGED_TOOLS_INLINE) {
        expect(
          rows.find((row) => row.name === name)?.spilled,
          `${name}'s page should ride inline at the 5 kB page budget, not spill`,
        ).toBeUndefined();
      }

      const genericSpilled = rows.some(
        (row) => row.spilled !== undefined && !NAMED_LARGE_FIXTURE_TOOLS.includes(row.name),
      );
      expect(
        genericSpilled,
        "at least one command running only the generic fallback should also have spilled — otherwise the ceiling only ever fires for the named seven",
      ).toBe(true);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins APP_TOOL_RESULT_MAX_BYTES to the literal 8,192 every measurement above is checked against (item 1)", () => {
    // The test above asserts every tool's complete wire result against the LITERAL `8_192`,
    // deliberately never this constant, so a change that raises the constant cannot also
    // silently raise what the test above accepts. This assertion is what makes THAT change
    // visible: it fails the moment the constant and the literal disagree, which is the only
    // place in this file the constant is checked against anything but itself.
    expect(APP_TOOL_RESULT_MAX_BYTES).toBe(8_192);
  });

  // ── Round 4 (Codex): the ceiling has to count the ENVELOPE, not just the result ──────
  //
  // All 29 tools above landed at 8,212-8,226 B on the real wire even with the shrink loop
  // running, because both the initial comparison and every shrink iteration measured the
  // bare `{content, isError?}` object — never the `{jsonrpc:"2.0", id, result}` `reply()`
  // actually sends. The `jsonrpc`/`id`/`result` wrapper keys and the request's OWN id (a
  // client's to pick, and a large numeric one is real bytes) are overhead a bare-`result`
  // measurement never saw. These three probes are chosen to be right at that edge: each
  // pairs a payload that inflates hard under JSON escaping with a 7-digit request id, so a
  // ceiling that is off by even the envelope's own overhead reads as a wire body over the
  // literal 8,192 — never the exported constant, for the same reason the test above pins
  // it standalone.
  const ROUND_4_REQUEST_ID = 9_999_999;

  it("holds a quote-heavy success under the literal 8,192 once the request's own id is counted (round 4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-tool-ceiling-quote-"));
    const server = await startAppMcpServer({
      bearer: () => MEASURE_BEARER,
      // Every double-quote in the raw payload text becomes `\"` once shaped to JSON, and
      // THAT string is itself a JSON value inside `content[0].text` — so it escapes a
      // second time. 2,034 quotes is enough to push the complete wire body right up
      // against the ceiling once the `{jsonrpc, id, result}` wrapper is added.
      dispatch: () => async () => ({ blob: '"'.repeat(2034) }),
      stateDir: dir,
    });
    try {
      const tools = buildAppTools(async () => undefined);
      const tool = tools.find((candidate) => candidate.commandId === "projects.list");
      if (tool === undefined) throw new Error("projects.list is no longer agent-exposed");
      const answer = await callOverWire(server, tool.name, ROUND_4_REQUEST_ID);
      expect(answer.status, `quote-heavy probe returned HTTP ${answer.status}`).toBe(200);
      console.info(`round 4 quote-heavy success: ${answer.wireBytes} B`);
      expect(
        answer.wireBytes,
        `quote-heavy success's complete wire body is ${answer.wireBytes} B, over the 8,192 B universal ceiling`,
      ).toBeLessThanOrEqual(8_192);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds a NUL-heavy error under the literal 8,192 once the request's own id is counted (round 4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-tool-ceiling-nul-"));
    const server = await startAppMcpServer({
      bearer: () => MEASURE_BEARER,
      // A NUL character (`\x00`, never a raw NUL byte in this source) escapes to the
      // six-byte literal `\u0000` once shaped to JSON — this refusal's 1,359-byte raw
      // message (under `REFUSAL_TEXT_CAP`'s 2,000 B, so `refusalText` passes it through
      // whole) becomes well over 8 KB once escaped and wrapped.
      dispatch: () => async () => {
        throw new Error(`${"\x00".repeat(1353)}aaaaaa`);
      },
      stateDir: dir,
    });
    try {
      const tools = buildAppTools(async () => undefined);
      const tool = tools.find((candidate) => candidate.commandId === "projects.list");
      if (tool === undefined) throw new Error("projects.list is no longer agent-exposed");
      const answer = await callOverWire(server, tool.name, ROUND_4_REQUEST_ID);
      expect(answer.status, `NUL-heavy probe returned HTTP ${answer.status}`).toBe(200);
      const body = JSON.parse(answer.text) as { result?: { isError?: boolean } };
      expect(
        body.result?.isError,
        "the NUL-heavy dispatch throw should answer as a tool-result refusal, not a JSON-RPC error",
      ).toBe(true);
      console.info(`round 4 NUL-heavy error: ${answer.wireBytes} B`);
      expect(
        answer.wireBytes,
        `NUL-heavy error's complete wire body is ${answer.wireBytes} B, over the 8,192 B universal ceiling`,
      ).toBeLessThanOrEqual(8_192);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds an emoji/CJK success under the literal 8,192 once the request's own id is counted (round 4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-tool-ceiling-emoji-"));
    const server = await startAppMcpServer({
      bearer: () => MEASURE_BEARER,
      // Astral-plane emoji and CJK ideographs are multi-byte in UTF-8 but each still counts
      // as ONE code point for `headAtCodePointBoundary`'s boundary math — this fixture
      // exercises the shrink loop's UTF-8-safety on non-ASCII content, not just its byte
      // counting.
      dispatch: () => async () => ({ blob: `${"😀漢".repeat(1162)}aaaa` }),
      stateDir: dir,
    });
    try {
      const tools = buildAppTools(async () => undefined);
      const tool = tools.find((candidate) => candidate.commandId === "projects.list");
      if (tool === undefined) throw new Error("projects.list is no longer agent-exposed");
      const answer = await callOverWire(server, tool.name, ROUND_4_REQUEST_ID);
      expect(answer.status, `emoji/CJK probe returned HTTP ${answer.status}`).toBe(200);
      console.info(`round 4 emoji/CJK success: ${answer.wireBytes} B`);
      expect(
        answer.wireBytes,
        `emoji/CJK success's complete wire body is ${answer.wireBytes} B, over the 8,192 B universal ceiling`,
      ).toBeLessThanOrEqual(8_192);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Round 5, item 6 (Codex): the FIXED envelope has to fit too ─────────────────────
  //
  // The shrink loop gave up when `head` reached zero and returned the candidate ANYWAY, so an
  // envelope whose fixed parts were already over budget rode the wire: an 8,000-byte request
  // id reproduced 8,499 B, a long spill path 8,599 B. Both of those parts are the CALLER's,
  // not Rennet's to shrink — the id is echoed in every response and the path is where the
  // result had to be written — so the honest answer is a reply whose size Rennet does control:
  // a bounded JSON-RPC error with `id: null`.
  it("answers a bounded `id: null` error when the request's own id leaves no room (round 5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-tool-ceiling-bigid-"));
    const server = await startAppMcpServer({
      bearer: () => MEASURE_BEARER,
      dispatch: () => async () => ({ blob: "x".repeat(20_000) }),
      stateDir: dir,
    });
    try {
      const tools = buildAppTools(async () => undefined);
      const tool = tools.find((candidate) => candidate.commandId === "projects.list");
      if (tool === undefined) throw new Error("projects.list is no longer agent-exposed");
      // A 8,000-byte JSON-RPC id. Legal (the spec allows a string id of any length) and the
      // caller's to pick, so the ceiling has to survive it.
      const answer = await callOverWire(server, tool.name, `${"i".repeat(8_000)}`);
      expect(answer.status).toBe(200);
      const body = JSON.parse(answer.text) as {
        id: unknown;
        error?: { message?: string };
        result?: unknown;
      };
      // `id: null` — echoing an 8,000-byte id is the thing that cannot fit.
      expect(body.id).toBeNull();
      expect(body.result).toBeUndefined();
      expect(body.error?.message).toContain("cannot be answered within");
      expect(body.error?.message).toContain("short request id");
      console.info(`round 5 oversized request id: ${answer.wireBytes} B`);
      expect(
        answer.wireBytes,
        `the oversized-id reply is ${answer.wireBytes} B, over the 8,192 B universal ceiling`,
      ).toBeLessThanOrEqual(8_192);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers a bounded `id: null` error when the SPILL PATH leaves no room (round 5)", async () => {
    // The other fixed part. A deep bound root — a worktree under a long home, under a long
    // project name — makes the tier-1 relative path long; the `stateDir` fallback tier can be
    // longer still. Either way the path is in the envelope and Rennet cannot shorten it.
    const deep = join(
      tmpdir(),
      `app-tool-ceiling-deep-${"a".repeat(120)}`,
      "b".repeat(200),
      "c".repeat(200),
      "d".repeat(200),
    );
    mkdirSync(deep, { recursive: true });
    try {
      const server = await startAppMcpServer({
        bearer: () => MEASURE_BEARER,
        dispatch: () => async () => ({ blob: "x".repeat(20_000) }),
        stateDir: deep,
      });
      try {
        const tools = buildAppTools(async () => undefined);
        const tool = tools.find((candidate) => candidate.commandId === "projects.list");
        if (tool === undefined) throw new Error("projects.list is no longer agent-exposed");
        // A 7,400-byte id plus a ~750-byte path: neither alone is fatal, together they are,
        // which is the point — the budget is on the envelope, not on any one field.
        const answer = await callOverWire(server, tool.name, `${"i".repeat(7_400)}`);
        expect(answer.status).toBe(200);
        const body = JSON.parse(answer.text) as { id: unknown; error?: { message?: string } };
        expect(body.id).toBeNull();
        expect(body.error?.message).toContain("cannot be answered within");
        console.info(`round 5 oversized spill path: ${answer.wireBytes} B`);
        expect(
          answer.wireBytes,
          `the oversized-path reply is ${answer.wireBytes} B, over the 8,192 B universal ceiling`,
        ).toBeLessThanOrEqual(8_192);
      } finally {
        await server.close();
      }
    } finally {
      rmSync(deep, { recursive: true, force: true });
    }
  });

  it("still answers a NORMALLY-sized id with a spill envelope, not a refusal (round 5 control)", async () => {
    // The control for both above: the `id: null` arm is the last resort, and an ordinary
    // oversized result still gets its envelope with the head, the path and the cursor.
    const dir = mkdtempSync(join(tmpdir(), "app-tool-ceiling-normal-"));
    const server = await startAppMcpServer({
      bearer: () => MEASURE_BEARER,
      dispatch: () => async () => ({ blob: "x".repeat(20_000) }),
      stateDir: dir,
    });
    try {
      const tools = buildAppTools(async () => undefined);
      const tool = tools.find((candidate) => candidate.commandId === "projects.list");
      if (tool === undefined) throw new Error("projects.list is no longer agent-exposed");
      const answer = await callOverWire(server, tool.name, 42);
      const body = JSON.parse(answer.text) as {
        id: unknown;
        result?: { content?: { text?: string }[] };
      };
      expect(body.id).toBe(42);
      const envelope = JSON.parse(body.result?.content?.[0]?.text ?? "{}") as {
        truncated?: boolean;
        head?: string;
      };
      expect(envelope.truncated).toBe(true);
      expect((envelope.head ?? "").length).toBeGreaterThan(100);
      expect(answer.wireBytes).toBeLessThanOrEqual(8_192);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("positive control: ask.read's own #871-shaped fixture exceeds the ceiling on its own, unceilinged (item 1)", () => {
    // Proves the assertion above is not vacuous: the RAW shaper output (no
    // `applyResultCeiling` in front of it) for the exact fixture #871 was sighted on really
    // does blow through `APP_TOOL_RESULT_MAX_BYTES` by itself. Delete `applyResultCeiling`
    // from the wire path in `callTool` and the "bounds EVERY…" test above reddens on this
    // exact row — this is what proves that redness, without editing production code to watch
    // it happen.
    const raw = shapeAppToolResult("ask.read", LARGE_FIXTURES["ask.read"]);
    expect(
      raw.marker,
      "ask.read has no paging of its own — every byte rides the default branch",
    ).toBeUndefined();
    expect(
      textBytes(raw.text),
      "the ask.read fixture must itself exceed the ceiling for the ceiling to be doing real work",
    ).toBeGreaterThan(APP_TOOL_RESULT_MAX_BYTES);
  });
});
