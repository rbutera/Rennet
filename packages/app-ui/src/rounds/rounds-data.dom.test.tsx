// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { fixtureCompletedRoundsSource, reportBoardFixture } from "../test/fixtures/rounds";
import {
  type RoundsSource,
  RoundsSourceProvider,
  resolveReportBoard,
  useReportBoard,
  useRoundDispatch,
  useRoundRecords,
  useRoundState,
} from "./rounds-data";

// The rounds-data seam resolves its three reads through a RoundsSource on context
// (Reconciliation 1), mirroring the board-data seam. The rounds runtime IS live — the app
// binds `useLiveRoundsSource` — so what this file covers is the SEAM: the honest-absent
// context default and a fixture source, never the transport. The fixtures live behind the
// import fence and reach the seam only via the provider here.

function RoundsProbe({ slug, reportId }: { slug: string; reportId: string }) {
  const state = useRoundState(slug);
  const records = useRoundRecords(slug);
  const report = useReportBoard(reportId);
  const dispatch = useRoundDispatch();
  return (
    <div>
      <span>state:{state.phase}</span>
      <span>records:{records.length}</span>
      <span>report:{report.status === "valid" ? report.board.boardId : report.status}</span>
      <span>dispatch:{dispatch ? "present" : "absent"}</span>
    </div>
  );
}

describe("rounds-data seam — the single rounds resolution point", () => {
  it("is honest-absent by default: no round, an empty ledger, no report, no dispatch", () => {
    // No provider ⇒ the default context. The truth of a build with no live rounds.
    const { getByText } = mount(<RoundsProbe slug="s-1" reportId="anything" />);
    expect(getByText("state:absent")).toBeTruthy();
    expect(getByText("records:0")).toBeTruthy();
    expect(getByText("report:missing")).toBeTruthy();
    expect(getByText("dispatch:absent")).toBeTruthy();
  });

  it("resolves a completed round from a fixture source — state, ledger, and report board", () => {
    const { getByText } = mount(
      <RoundsSourceProvider value={fixtureCompletedRoundsSource}>
        <RoundsProbe slug="s-1" reportId="report-round-1" />
      </RoundsSourceProvider>,
    );
    expect(getByText("state:composed")).toBeTruthy();
    expect(getByText("records:1")).toBeTruthy();
    // The report board carries `round_outcome` items — a lens board would reject that
    // as excluded-kind, but the report surface widens to render it, so it resolves valid.
    expect(getByText("report:report-round-1")).toBeTruthy();
  });

  it("resolves an unknown report id as missing (absent-not-disabled), never a crash", () => {
    const { getByText } = mount(
      <RoundsSourceProvider value={fixtureCompletedRoundsSource}>
        <RoundsProbe slug="s-1" reportId="no-such-report" />
      </RoundsSourceProvider>,
    );
    expect(getByText("report:missing")).toBeTruthy();
  });

  it("rejects a malformed report board as invalid DATA, never a thrown render or 'no round'", () => {
    const brokenSource: RoundsSource = {
      roundState: () => ({ phase: "reporting", reportBoardId: "bad" }),
      roundRecords: () => [],
      reportBoard: () => ({ lens: "design", nope: true }),
    };
    // Mounting at all proves the rejection is data, not an exception escaping render.
    const { getByText } = mount(
      <RoundsSourceProvider value={brokenSource}>
        <RoundsProbe slug="s-1" reportId="bad" />
      </RoundsSourceProvider>,
    );
    expect(getByText("report:invalid")).toBeTruthy();
    // …and it is NOT mistaken for a missing round: the machine state still reads.
    expect(getByText("state:reporting")).toBeTruthy();
  });

  // Finding 4: `resolveReportBoard` is the runtime boundary. `LensBoardSchema` is a structural
  // shape — it does not check the board's IDENTITY against the requested id, nor reject a
  // `review_comment` (a schema-valid HostKind outside the report domain that THROWS in
  // `ReportElement`). Both must resolve `invalid` DATA, never render as the selected report.
  describe("resolveReportBoard runtime boundary (finding 4)", () => {
    it("valid when the resolved board's id matches the requested report id", () => {
      const res = resolveReportBoard(reportBoardFixture, reportBoardFixture.boardId);
      expect(res.status).toBe("valid");
    });

    it("rejects a cross-wired board whose id does not match the requested id", () => {
      // A source answering the WRONG board (right shape, wrong id) is invalid, not rendered as
      // the selected report.
      const res = resolveReportBoard(reportBoardFixture, "some-other-report-id");
      expect(res.status).toBe("invalid");
    });

    it("rejects a schema-valid board carrying a review_comment (outside ReportKind)", () => {
      const anchor = {
        id: "rc-anchor",
        kind: "code_ref",
        data: {
          author: { kind: "human", id: "reviewer" },
          patchset_id: "ps-438",
          path: "packages/adapters/src/github-auth.ts",
          side: "head",
          start_line: 1,
          end_line: 1,
        },
      };
      const reviewComment = {
        id: "rc-1",
        kind: "review_comment",
        data: {
          author: { kind: "human", id: "reviewer" },
          body: "please fix",
          code_ref: "rc-anchor",
          status: "draft",
          covers: ["greeting-prose"],
        },
      };
      const withComment = {
        ...reportBoardFixture,
        boardId: "report-with-comment",
        elements: [...reportBoardFixture.elements, anchor, reviewComment],
      };
      const res = resolveReportBoard(withComment, "report-with-comment"); // id matches — kind is why
      expect(res.status).toBe("invalid");
      if (res.status === "invalid") expect(String(res.detail)).toContain("review comments");
    });
  });

  it("exposes dispatch when the source binds one (cluster 4's Dispatch wiring)", () => {
    let dispatched = 0;
    const dispatchable: RoundsSource = {
      ...fixtureCompletedRoundsSource,
      dispatch: async () => {
        dispatched += 1;
        return { status: "accepted" };
      },
    };
    const { getByText } = mount(
      <RoundsSourceProvider value={dispatchable}>
        <RoundsProbe slug="s-1" reportId="report-round-1" />
      </RoundsSourceProvider>,
    );
    expect(getByText("dispatch:present")).toBeTruthy();
    expect(dispatched).toBe(0); // reading the hook never dispatches (the double-dispatch guard's half)
  });
});
