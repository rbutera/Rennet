import { BOARD_TARGETS, boardToolsByName } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boardOutputSchema, designDraftOutputSchema } from "../runtime/lens-pipeline";

/**
 * Task 2.7 — how big the tool surface each seat now receives is, beside the output schema
 * it replaces.
 *
 * This file is a MEASUREMENT, not coverage. Its one assertion is the fact the PR states,
 * and it exists so a reader can re-run the figure rather than trust a number typed into a
 * description; do not read its green bar as proof that anything else about the board
 * server works. The bytes are what actually travels: the `tools` array exactly as
 * `tools/list` serves it, and the JSON Schema exactly as it reaches the provider as
 * `outputFormat`.
 */

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The `tools` array as the board server serves it: name, description, rendered input. */
const toolSurface = (target: (typeof BOARD_TARGETS)[number]): unknown =>
  [...boardToolsByName(target).values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: "input" }),
  }));

/** What that seat's turn carries today: one board schema, or Design's board-or-absence. */
const outputSchemaFor = (target: (typeof BOARD_TARGETS)[number]): unknown =>
  target === "design" ? designDraftOutputSchema() : boardOutputSchema();

/**
 * The declared bounds (token discipline: "every dynamic interpolation declares a byte
 * bound at its call site"). Measured 2026-09-05: the worst seat is Design at 1.44x its
 * schema, and a generation's seven seats together are 1.07x. A change that pushes past
 * these has grown what every seat sends on every request, and the PR that makes it has to
 * say so — which is why this is a test and not a script somebody once ran.
 */
const PER_SEAT_CEILING = 1.5;
const GENERATION_CEILING = 1.15;

describe("the tool surface a seat receives, beside the output schema it replaces (2.7)", () => {
  it("stays inside the declared bound against the board schema it replaces", () => {
    const rows = BOARD_TARGETS.map((target) => ({
      target,
      tools: boardToolsByName(target).size,
      toolSurfaceBytes: bytes(toolSurface(target)),
      outputSchemaBytes: bytes(outputSchemaFor(target)),
    }));
    console.info(
      ["target        tools  tool surface  output schema"]
        .concat(
          rows.map(
            (row) =>
              `${row.target.padEnd(13)} ${String(row.tools).padStart(5)}  ${String(row.toolSurfaceBytes).padStart(12)}  ${String(row.outputSchemaBytes).padStart(13)}`,
          ),
        )
        .join("\n"),
    );
    for (const row of rows) {
      expect(
        row.toolSurfaceBytes / row.outputSchemaBytes,
        `${row.target}: tool surface ${row.toolSurfaceBytes} B against an output schema of ${row.outputSchemaBytes} B`,
      ).toBeLessThan(PER_SEAT_CEILING);
    }
    // A generation seats Flagged TWICE, so its surface is counted twice — this is what one
    // generation's seats actually carry between them.
    const flagged = rows.find((row) => row.target === "flagged");
    const seatRows = flagged === undefined ? rows : [...rows, flagged];
    const surface = seatRows.reduce((sum, row) => sum + row.toolSurfaceBytes, 0);
    const schemas = seatRows.reduce((sum, row) => sum + row.outputSchemaBytes, 0);
    expect(
      surface / schemas,
      `a generation's seven seats carry ${surface} B of tools against ${schemas} B of output schema`,
    ).toBeLessThan(GENERATION_CEILING);
  });
});
