// @vitest-environment happy-dom
import type { LensKind } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { FIXTURE_BOARDS, fixtureBoardSource } from "../test/fixtures/boards";
import { type BoardSource, BoardSourceProvider, useBoardData } from "./board-data";

// The board-fetch seam resolves fixture boards through a BoardSource on context (no
// board command exists yet — Reconciliation 1), the same not-yet-a-command pattern
// C3 used for its session projection. The fixtures live behind the import fence and
// reach the seam only via the provider here — a surface never imports them.

function BoardProbe({ generation, lens }: { generation: string; lens: LensKind }) {
  const r = useBoardData(generation, lens);
  if (r.status === "invalid") return <span>invalid:{r.reason}</span>;
  if (r.status === "missing") return <span>missing</span>;
  return (
    <span>
      board:{r.board.lens}/{r.board.sections[0]?.ref}/{r.board.elements.length}
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

  it("rejects a shape that fails LensBoardSchema as invalid DATA, never a thrown render", () => {
    const brokenSource: BoardSource = () => ({ lens: "design", nope: true });
    // Mounting at all proves the rejection is data, not an exception escaping render.
    const { getByText } = mount(
      <BoardSourceProvider value={brokenSource}>
        <BoardProbe generation="gen1" lens="design" />
      </BoardSourceProvider>,
    );
    expect(getByText("invalid:shape")).toBeTruthy();
  });

  it("rejects a well-formed board whose LENS is not the one asked for (stale/cross-wired read)", () => {
    // The source hands back the sequence board when design is requested — a shape that
    // passes LensBoardSchema but is NOT the design board. Pre-fix this rendered as the
    // wrong board; now it is invalid:identity, never silently shown or reported missing.
    const wrongLens: BoardSource = () => FIXTURE_BOARDS.gen1?.sequence;
    const { getByText } = mount(
      <BoardSourceProvider value={wrongLens}>
        <BoardProbe generation="gen1" lens="design" />
      </BoardSourceProvider>,
    );
    expect(getByText("invalid:identity")).toBeTruthy();
  });

  it("rejects a board stamped with a different GENERATION than requested (stale generation)", () => {
    // Requesting gen1 but the source returns the gen0 design board (generation: "gen0").
    const staleGen: BoardSource = () => FIXTURE_BOARDS.gen0?.design;
    const { getByText } = mount(
      <BoardSourceProvider value={staleGen}>
        <BoardProbe generation="gen1" lens="design" />
      </BoardSourceProvider>,
    );
    expect(getByText("invalid:identity")).toBeTruthy();
  });

  it("rejects a board carrying an excluded host kind (round_outcome) as invalid data (finding 4)", () => {
    // LensBoardSchema admits every host kind; the seam is where round_outcome/review_comment
    // are refused, so the spike's silent-hole defect cannot render as an empty board.
    const withExcluded: BoardSource = () => {
      const base = FIXTURE_BOARDS.gen1?.design;
      if (!base) throw new Error("fixture missing");
      return {
        ...base,
        elements: [
          ...base.elements,
          {
            id: "ro-1",
            kind: "round_outcome",
            data: {
              author: { kind: "orchestrator", id: "o1" },
              status: "addressed",
              ask: { ref: "a", text: "t" },
              note: "",
            },
          },
        ],
      };
    };
    const { getByText } = mount(
      <BoardSourceProvider value={withExcluded}>
        <BoardProbe generation="gen1" lens="design" />
      </BoardSourceProvider>,
    );
    expect(getByText("invalid:excluded-kind")).toBeTruthy();
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
