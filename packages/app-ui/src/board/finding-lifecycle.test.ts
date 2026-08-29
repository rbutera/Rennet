import { type FindingDisposition, findingRefKey } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { flaggedBoard, flaggedGen2Board } from "../test/fixtures/boards";
import {
  countOpenFindings,
  type FindingLifecycleSource,
  findingAskId,
  findingLifecycle,
  findingRef,
} from "./finding-lifecycle";

const EMPTY: FindingLifecycleSource = {
  stagedAsks: {},
  findingDispositions: {},
};

function dismissed(ref: ReturnType<typeof findingRef>): FindingDisposition {
  return { finding: ref, disposition: "dismissed" };
}

describe("finding lifecycle projection", () => {
  it("derives dismiss, undo, request, and unstage from one projected source", () => {
    const f1 = flaggedBoard.elements.find(
      (element) => element.kind === "finding" && element.id === "f1",
    );
    if (f1?.kind !== "finding") throw new Error("missing f1 fixture");
    const ref = findingRef(flaggedBoard.generation, flaggedBoard.boardId, f1.id);
    const key = findingRefKey(ref);

    expect(countOpenFindings(flaggedBoard, EMPTY)).toBe(2);

    const withDismissal: FindingLifecycleSource = {
      ...EMPTY,
      findingDispositions: { [key]: dismissed(ref) },
    };
    expect(
      findingLifecycle(f1, flaggedBoard.generation, flaggedBoard.boardId, withDismissal),
    ).toMatchObject({
      status: "dismissed",
      dismissedByReviewer: true,
      requested: false,
      open: false,
    });
    expect(countOpenFindings(flaggedBoard, withDismissal)).toBe(1);

    expect(countOpenFindings(flaggedBoard, EMPTY)).toBe(2);

    const askId = findingAskId(ref);
    const withRequest: FindingLifecycleSource = {
      ...EMPTY,
      stagedAsks: {
        [askId]: {
          id: askId,
          anchor: "github-auth.ts:244",
          type: "request-change",
          body: "write a terminal record",
          finding: ref,
        },
      },
    };
    expect(
      findingLifecycle(f1, flaggedBoard.generation, flaggedBoard.boardId, withRequest),
    ).toMatchObject({
      status: "open",
      dismissedByReviewer: false,
      requested: true,
      open: false,
    });
    expect(countOpenFindings(flaggedBoard, withRequest)).toBe(1);
    expect(countOpenFindings(flaggedBoard, EMPTY)).toBe(2);
  });

  it("does not attach a disposition or legacy unscoped ask to another generation", () => {
    const otherRef = findingRef("gen2", "board:other", "f1");
    const source: FindingLifecycleSource = {
      stagedAsks: {
        f1: {
          id: "f1",
          anchor: "github-auth.ts:244",
          type: "request-change",
          body: "legacy request without a generation",
        },
      },
      findingDispositions: {
        [findingRefKey(otherRef)]: dismissed(otherRef),
      },
    };

    expect(countOpenFindings(flaggedBoard, source)).toBe(2);
  });

  it("does not apply an abandoned attempt's disposition to a retry board", () => {
    const abandoned = findingRef(flaggedBoard.generation, "board:abandoned", "f1");
    const source: FindingLifecycleSource = {
      stagedAsks: {},
      findingDispositions: {
        [findingRefKey(abandoned)]: dismissed(abandoned),
      },
    };

    expect(countOpenFindings(flaggedBoard, source)).toBe(2);
  });

  it("never counts a board-authored addressed finding as open", () => {
    expect(countOpenFindings(flaggedGen2Board, EMPTY)).toBe(0);
  });

  it("does not count a valid flat-pool finding the board never renders", () => {
    const sourceFinding = flaggedBoard.elements.find(
      (element) => element.kind === "finding" && element.id === "f1",
    );
    if (sourceFinding?.kind !== "finding") throw new Error("missing f1 fixture");
    const boardWithOrphan = {
      ...flaggedBoard,
      elements: [...flaggedBoard.elements, { ...sourceFinding, id: "orphan-finding" }],
    };

    expect(countOpenFindings(boardWithOrphan, EMPTY)).toBe(2);
  });
});
