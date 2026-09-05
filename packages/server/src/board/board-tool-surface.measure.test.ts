import { outputSchemaFor } from "@rennet/adapters";
import type { BoardTarget } from "@rennet/protocol";
import { boardToolsByName } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { boardOutputSchema, designDraftOutputSchema } from "../runtime/lens-pipeline";
import { servedToolCatalog } from "./board-mcp-server";

/**
 * Task 2.7 — how big the tool surface each seat receives is, beside the output schema it
 * replaces.
 *
 * This file is a MEASUREMENT, not coverage. Its assertions are the facts the PR states,
 * and it exists so a reader can re-run the figure rather than trust a number typed into a
 * description; do not read its green bar as proof that anything else about the board
 * server works.
 *
 * ── Both operands are the real ones, and that took three goes ────────────────────
 * BOTH sides are now taken from the code production uses: `servedToolCatalog` is what
 * `tools/list` answers with, and `outputSchemaFor` is what `t3-seat-turn.ts` hands the
 * provider. Neither is reconstructed here.
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

/** The output schema this seat's turn actually carries, shaped by the leg that sends it. */
const sentSchema = (row: SeatRow): unknown =>
  outputSchemaFor(
    row.provider,
    row.target === "design" ? designDraftOutputSchema() : boardOutputSchema(),
  );

/**
 * The declared bounds (token discipline: "every dynamic interpolation declares a byte
 * bound at its call site"). Measured 2026-09-05 with both operands as-sent: the worst seat
 * is Design at 1.34x its schema, and a generation's seven seats together are 0.96x — the
 * tool surface is SMALLER in aggregate than the output schema it replaces.
 *
 * The generation bound is therefore set at parity, which makes it a claim rather than
 * slack: a change that takes a generation's seats past what they replace has grown what
 * every seat sends on every request, and the PR that makes it has to say so. That is why
 * this is a test and not a script somebody once ran.
 */
const PER_SEAT_CEILING = 1.4;
const GENERATION_CEILING = 1.0;

describe("the tool surface a seat receives, beside the output schema it replaces (2.7)", () => {
  it("stays inside the declared bound against the board schema it replaces", () => {
    const rows = SEATS.map((row) => ({
      seat: row.seat,
      tools: boardToolsByName(row.target).size,
      toolSurfaceBytes: bytes(servedToolCatalog(row.target)),
      outputSchemaBytes: bytes(sentSchema(row)),
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

  it("measures the schema the seat leg SENDS, not the one the pipeline holds", () => {
    // The guard on the operand: a raw `boardOutputSchema()` still carries its `$schema`
    // stamp, and the Codex seat's is a different schema again. If this file ever goes back
    // to measuring the raw one, these two are what say so.
    const raw = JSON.stringify(boardOutputSchema());
    expect(raw).toContain("$schema");
    const claudeSeat = SEATS.find((row) => row.seat === "sequence");
    const codexSeat = SEATS.find((row) => row.seat === "flagged-codex");
    if (claudeSeat === undefined || codexSeat === undefined) throw new Error("seat row missing");
    expect(JSON.stringify(sentSchema(claudeSeat))).not.toContain("$schema");
    expect(bytes(sentSchema(codexSeat))).toBeGreaterThan(bytes(sentSchema(claudeSeat)));
  });
});
