// @vitest-environment happy-dom
import type { LensBoard, LensKind } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { mount } from "../test/dom";
import { FIXTURE_BOARDS, fixtureBoardRead } from "../test/fixtures/boards";
import { MemoryBridge } from "../test/memory-bridge";
import {
  type LensBoardResolutions,
  lensBoardsFromResolutions,
  lensReadsSettled,
  useBoardData,
} from "./board-data";

// The board-fetch seam resolves boards through the registered `board.read` command
// (C18). The fixtures live behind the import fence and reach the seam only as a
// MemoryBridge handler — a surface never imports them.

const REVIEW = "rev-1";

function BoardProbe({ generation, lens }: { generation: string; lens: LensKind }) {
  const r = useBoardData(REVIEW, generation, lens);
  if (r.status === "invalid") return <span>invalid:{r.reason}</span>;
  if (r.status === "absent") return <span>absent:{r.reason}</span>;
  if (r.status === "failed") return <span>failed:{r.reason}</span>;
  if (r.status === "missing") return <span>missing</span>;
  if (r.status === "pending") return <span>pending</span>;
  return (
    <span>
      board:{r.board.lens}/{r.board.sections[0]?.ref}/{r.board.elements.length}
    </span>
  );
}

/** Mount the probe over a bridge whose `board.read` answers with `served`. */
function probe(
  generation: string,
  lens: LensKind,
  served: (input: { generation: string; lens: LensKind }) => {
    board: LensBoard | null;
    absence?: "no-material";
    failure?: string;
  },
) {
  return mount(
    <BridgeProvider bridge={new MemoryBridge({ "board.read": served })}>
      <BoardProbe generation={generation} lens={lens} />
    </BridgeProvider>,
  );
}

/** A served answer the schema will reject — the client's own validation is the subject,
 *  so the stub deliberately hands back a shape the wire type does not admit. */
const serving = (board: unknown) => () => ({ board }) as { board: LensBoard | null };

describe("board-data seam — the single board resolution point", () => {
  it("treats durable absence as settled, while a missing board remains pollable", () => {
    const absent = { status: "absent", reason: "no-material" } as const;
    const resolutions = {
      design: absent,
      sequence: absent,
      decisions: absent,
      flagged: absent,
      noise: absent,
    };
    expect(lensReadsSettled(resolutions)).toBe(true);
    expect(lensReadsSettled({ ...resolutions, design: { status: "missing" } })).toBe(false);
  });

  it("omits an absent Design lane from the lens list when the branch has no spec", () => {
    // session-bound-workspace D6: `no-spec` means this branch has no specification, so
    // there is no Design tab and no empty board — every other absence stays selectable
    // so its reason is still reachable, including Design's legacy `no-material`.
    const valid = { status: "valid", board: FIXTURE_BOARDS.gen1?.sequence } as never;
    const resolutions = (designReason: "no-spec" | "no-material"): LensBoardResolutions =>
      ({
        design: { status: "absent", reason: designReason },
        sequence: valid,
        decisions: { status: "absent", reason: "no-decisions" },
        flagged: { status: "failed", reason: "The structured response did not validate." },
        noise: { status: "absent", reason: "no-noise" },
      }) as unknown as LensBoardResolutions;

    const withoutSpec = lensBoardsFromResolutions(resolutions("no-spec"));
    expect(withoutSpec.map(({ lens }) => lens)).toEqual([
      "sequence",
      "decisions",
      "flagged",
      "noise",
    ]);
    // Control for the omission: only the `no-spec` pairing is dropped. A Design lane
    // carrying any other absence — or a board — is still in the list, so this cannot
    // pass by dropping Design (or every absence) wholesale.
    const legacy = lensBoardsFromResolutions(resolutions("no-material"));
    expect(legacy.map(({ lens }) => lens)).toContain("design");
    expect(legacy.find(({ lens }) => lens === "design")?.absence).toBe("no-material");
    expect(withoutSpec.map(({ absence }) => absence)).toContain("no-decisions");
  });

  it("renders a durable lens failure instead of polling it as an empty board", async () => {
    const { findByText } = probe("gen1", "flagged", () => ({
      board: null,
      failure: "The structured response did not validate.",
    }));
    expect(await findByText("failed:The structured response did not validate.")).toBeTruthy();
  });

  it("resolves a board for a (generation, lens) pair, validated against LensBoardSchema", async () => {
    const { findByText } = probe("gen1", "design", fixtureBoardRead);
    // The design board's first section is `change`; its element pool is non-empty —
    // a shape that got past LensBoardSchema, not one the client invented.
    expect(await findByText(/^board:design\/change\/\d+$/)).toBeTruthy();
  });

  it("rejects a shape that fails LensBoardSchema as invalid DATA, never a thrown render", async () => {
    // Mounting at all proves the rejection is data, not an exception escaping render.
    const { findByText } = probe("gen1", "design", serving({ lens: "design", nope: true }));
    expect(await findByText("invalid:shape")).toBeTruthy();
  });

  it("rejects a well-formed board whose LENS is not the one asked for (stale/cross-wired read)", async () => {
    // The host hands back the sequence board when design is requested — a shape that
    // passes LensBoardSchema but is NOT the design board. Pre-fix this rendered as the
    // wrong board; now it is invalid:identity, never silently shown or reported missing.
    const { findByText } = probe("gen1", "design", serving(FIXTURE_BOARDS.gen1?.sequence));
    expect(await findByText("invalid:identity")).toBeTruthy();
  });

  it("rejects a board stamped with a different GENERATION than requested (stale generation)", async () => {
    // Requesting gen1 but the host returns the gen0 design board (generation: "gen0").
    const { findByText } = probe("gen1", "design", serving(FIXTURE_BOARDS.gen0?.design));
    expect(await findByText("invalid:identity")).toBeTruthy();
  });

  it("rejects a board carrying an excluded host kind (round_outcome) as invalid data (finding 4)", async () => {
    // LensBoardSchema admits every host kind; the seam is where round_outcome/review_comment
    // are refused, so the spike's silent-hole defect cannot render as an empty board.
    const base = FIXTURE_BOARDS.gen1?.design;
    if (!base) throw new Error("fixture missing");
    const { findByText } = probe(
      "gen1",
      "design",
      serving({
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
      }),
    );
    expect(await findByText("invalid:excluded-kind")).toBeTruthy();
  });

  it("surfaces a FAILED read as invalid:unreadable, never as 'no board yet'", async () => {
    // The host could not serve this board. That is not absence — folding it into
    // `missing` is the lie the seam exists to prevent.
    const { findByText } = probe("gen1", "design", () => {
      throw new Error("board store unreachable");
    });
    expect(await findByText("invalid:unreadable")).toBeTruthy();
  });

  it("reports a lens with no board this generation as missing (absent-not-disabled)", async () => {
    // gen2 carries only sequence + flagged — design is absent that generation, and the
    // host says so with `board: null`.
    const { findByText } = probe("gen2", "design", fixtureBoardRead);
    expect(await findByText("missing")).toBeTruthy();
  });

  it("resolves a successful no-spec result separately from a board still missing", async () => {
    const { findByText } = probe("gen2", "design", () => ({
      board: null,
      absence: "no-material",
    }));
    expect(await findByText("absent:no-material")).toBeTruthy();
  });

  it("drills into a frozen generation's board through the same seam", async () => {
    // gen0 is the propose-time frozen Design board — resolved by passing its id.
    const { findByText } = probe("gen0", "design", fixtureBoardRead);
    expect(await findByText(/^board:design\/change\/\d+$/)).toBeTruthy();
  });
});
