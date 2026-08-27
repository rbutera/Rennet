// @vitest-environment happy-dom
import type { LensKind } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { fixtureBoardSource } from "../test/fixtures/boards";
import { type BoardSource, BoardSourceProvider, useBoardData } from "./board-data";

// The board-fetch seam resolves fixture boards through a BoardSource on context (no
// board command exists yet — Reconciliation 1), the same not-yet-a-command pattern
// C3 used for its session projection. The fixtures live behind the import fence and
// reach the seam only via the provider here — a surface never imports them.

function BoardProbe({ generation, lens }: { generation: string; lens: LensKind }) {
  const { board, missing, error } = useBoardData(generation, lens);
  if (error) return <span>invalid-shape</span>;
  if (missing) return <span>missing</span>;
  if (!board) return <span>idle</span>;
  return (
    <span>
      board:{board.lens}/{board.sections[0]?.ref}/{board.elements.length}
    </span>
  );
}

describe("board-data seam — the single board resolution point", () => {
  it("resolves a fixture board for a (generation, lens) pair, validated against LensBoardSchema", () => {
    const { getByText } = mount(
      <BoardSourceProvider value={fixtureBoardSource}>
        <BoardProbe generation="gen1" lens="design" />
      </BoardSourceProvider>,
    );
    // The design board's first section is `change`; its element pool is non-empty —
    // a shape that got past LensBoardSchema, not one the client invented.
    expect(getByText(/^board:design\/change\/\d+$/)).toBeTruthy();
  });

  it("rejects a shape that fails LensBoardSchema as ERROR data, never a thrown render", () => {
    const brokenSource: BoardSource = () => ({ lens: "design", nope: true });
    // Mounting at all proves the rejection is data, not an exception escaping render.
    const { getByText } = mount(
      <BoardSourceProvider value={brokenSource}>
        <BoardProbe generation="gen1" lens="design" />
      </BoardSourceProvider>,
    );
    expect(getByText("invalid-shape")).toBeTruthy();
  });

  it("reports a lens with no board this generation as missing (absent-not-disabled)", () => {
    const { getByText } = mount(
      <BoardSourceProvider value={fixtureBoardSource}>
        {/* gen2 carries only sequence + flagged — design is absent that generation. */}
        <BoardProbe generation="gen2" lens="design" />
      </BoardSourceProvider>,
    );
    expect(getByText("missing")).toBeTruthy();
  });

  it("drills into a frozen generation's board through the same seam", () => {
    const { getByText } = mount(
      <BoardSourceProvider value={fixtureBoardSource}>
        <BoardProbe generation="gen0" lens="design" />
      </BoardSourceProvider>,
    );
    // gen0 is the propose-time frozen Design board — resolved by passing its id.
    expect(getByText(/^board:design\/change\/\d+$/)).toBeTruthy();
  });
});
