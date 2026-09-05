// @vitest-environment happy-dom
import type { LensBoard, LensKind, LensLane } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { mount } from "../test/dom";
import { FIXTURE_BOARDS, fixtureBoardRead } from "../test/fixtures/boards";
import { MemoryBridge } from "../test/memory-bridge";
import {
  type LensBoardResolutions,
  lensBoardsFromResolutions,
  lensesWithResult,
  lensReadsSettled,
  useBoardData,
} from "./board-data";
import { lensSeatStates, waitingOnLine } from "./lens-seats";

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

  it("lists every lens, result or none, and never drops one as it settles", () => {
    // lens-board-tools 5.1/D12. The rail is the bench now, so it must carry all five from
    // the first frame — INCLUDING a lens whose board has not arrived (`missing`) and a
    // Design lane that settled `no-spec`. The `no-spec` omission that
    // `session-bound-workspace` D6 introduced is what this reverses, and the reason is the
    // other half of the same spec: "nothing navigates when a lane settles". A tab that
    // exists while its lane runs and VANISHES when the lane settles `no-spec` moves the
    // reviewer's selection out from under them.
    const resolutions = (designReason: "no-spec" | "no-material"): LensBoardResolutions =>
      ({
        design: { status: "absent", reason: designReason },
        sequence: { status: "valid", board: FIXTURE_BOARDS.gen1?.sequence },
        decisions: { status: "absent", reason: "no-decisions" },
        flagged: { status: "failed", reason: "The structured response did not validate." },
        // No answer at all: the case the old list dropped silently.
        noise: { status: "missing" },
      }) as unknown as LensBoardResolutions;
    // Two lanes still running, so Noise's own entry is derived rather than read.
    const seats = lensSeatStates(
      [
        { id: "design", label: "Design", status: "absent", reason: "No spec found." },
        { id: "sequence", label: "Sequence", status: "running" },
        { id: "decisions", label: "Decisions", status: "running" },
        { id: "flagged", label: "Flagged", status: "failed", reason: "boom" },
        { id: "noise", label: "Noise", status: "queued" },
      ] as LensLane[],
      resolutions("no-spec"),
    );

    const withoutSpec = lensBoardsFromResolutions(resolutions("no-spec"), seats);
    // POSITION, not membership: canonical lens order, all five, every time.
    expect(withoutSpec.map(({ lens }) => lens)).toEqual([
      "design",
      "sequence",
      "decisions",
      "flagged",
      "noise",
    ]);
    // Each still carries the result it has, so nothing was flattened to make the list
    // total: an absence keeps its reason, a failure keeps its message, a board keeps its
    // board, and the result-less lens carries none of the three.
    expect(withoutSpec.find(({ lens }) => lens === "design")?.absence).toBe("no-spec");
    expect(withoutSpec.find(({ lens }) => lens === "decisions")?.absence).toBe("no-decisions");
    expect(withoutSpec.find(({ lens }) => lens === "flagged")?.failure).toContain("validate");
    expect(withoutSpec.find(({ lens }) => lens === "sequence")?.board).toBeTruthy();
    const noise = withoutSpec.find(({ lens }) => lens === "noise");
    expect(noise?.board).toBeUndefined();
    expect(noise?.absence).toBeUndefined();
    expect(noise?.failure).toBeUndefined();

    // …and the FALLBACK set is the one that still discriminates, which is why the rail
    // going total does not make an empty Design board the fallback target for a missing
    // selection. `no-spec` Design has a reason to show, so it is in it; `missing` Noise
    // has nothing at all, so it is not.
    expect(lensesWithResult(withoutSpec).map(({ lens }) => lens)).toEqual([
      "design",
      "sequence",
      "decisions",
      "flagged",
    ]);
    // The legacy absence reads exactly the same way — the list never depended on WHICH
    // absence a lens settled with.
    const legacy = lensBoardsFromResolutions(resolutions("no-material"), seats);
    expect(legacy.find(({ lens }) => lens === "design")?.absence).toBe("no-material");
  });

  it("derives each lens's seat state from the lanes, and Noise's from its siblings", () => {
    // 5.1/5.7 and D16c. Three facts in one derivation, because they are one derivation:
    // a running lane is `working`, a lane the daemon has not opened is `waiting`, and
    // NOISE names the lanes it is waiting on rather than reading as working or failed.
    const missing = { status: "missing" } as const;
    const reads = {
      design: missing,
      sequence: missing,
      decisions: missing,
      flagged: missing,
      noise: missing,
    } as unknown as LensBoardResolutions;
    const seats = lensSeatStates(
      [
        { id: "design", label: "Design", status: "done", verdict: "reworked" },
        { id: "sequence", label: "Sequence", status: "running" },
        { id: "decisions", label: "Decisions", status: "running" },
        { id: "flagged", label: "Flagged", status: "queued" },
        { id: "noise", label: "Noise", status: "queued" },
      ] as LensLane[],
      reads,
    );
    expect(seats.design.register).toBe("settled");
    expect(seats.design.cut).toBe("seamed");
    expect(seats.sequence.register).toBe("working");
    expect(seats.sequence.cut).toBe("open");
    expect(seats.noise.register).toBe("waiting");
    // The lanes it names are exactly the un-settled ones — Flagged is queued and so is
    // still owed, Design has settled and so is not.
    expect(seats.noise.waitingOn).toEqual(["sequence", "decisions", "flagged"]);
    expect(waitingOnLine(seats.noise.waitingOn)).toBe("waiting on Sequence, Decisions and Flagged");
    // Waiting is not working and is not failed — the two things D16c forbids it reading as.
    expect(seats.noise.voices.some((voice) => voice.speech.quiet)).toBe(true);
  });

  it("tells a live generation with no lanes yet from a settled one with no boards", () => {
    // The capture frame. `[]` is a generation IN FLIGHT whose lanes are not open (so every
    // lens is waiting); `undefined` is no generation in flight at all (so a lens with no
    // board is `none`, not a promise of one that is never coming). Collapsing the two is
    // the whole reason this argument is `readonly LensLane[] | undefined`.
    const missing = { status: "missing" } as const;
    const reads = {
      design: missing,
      sequence: missing,
      decisions: missing,
      flagged: missing,
      noise: missing,
    } as unknown as LensBoardResolutions;
    expect(lensSeatStates([], reads).design.register).toBe("waiting");
    expect(lensSeatStates([], reads).design.drafting).toBe(true);
    expect(lensSeatStates(undefined, reads).design.register).toBe("none");
    expect(lensSeatStates(undefined, reads).design.drafting).toBe(false);
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
