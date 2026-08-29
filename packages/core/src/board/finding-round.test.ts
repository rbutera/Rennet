import {
  type AskProjection,
  type ComposableAsk,
  type DraftBoard,
  type FindingDisposition,
  type FindingRef,
  findingRefKey,
  parseDraft,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { applyAskEvent, emptyAskProjection } from "../exits/ask-projection";
import {
  composeFindingRound,
  type FindingResolution,
  findingDispositionMigrationEvents,
} from "./finding-round";

const AUTHOR = { kind: "lens-agent", id: "seat" } as const;
const FLAGGED_BOARD_1 = "board:flagged:gen-1";
const FLAGGED_BOARD_2 = "board:flagged:gen-2";

function ref(generation: string, findingId: string, boardId = FLAGGED_BOARD_1): FindingRef {
  return { generation, boardId, findingId };
}

function draft(elements: unknown[]): DraftBoard {
  const parsed = parseDraft({ elements });
  if (!parsed.ok) throw new Error(`invalid fixture: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

function section(id: string, title: string, children: readonly string[]) {
  return { id, kind: "section", data: { author: AUTHOR, title, children: [...children] } };
}

function orderStep(id: string, title: string, children: readonly string[]) {
  return {
    id,
    kind: "order_step",
    data: { author: AUTHOR, title, span: "src/auth.ts", children: [...children] },
  };
}

function codeRef(id: string, patchsetId = "ps-1", line = 10) {
  return {
    id,
    kind: "code_ref",
    data: {
      author: AUTHOR,
      patchset_id: patchsetId,
      path: "src/auth.ts",
      side: "head",
      start_line: line,
      end_line: line + 2,
    },
  };
}

function finding(
  id: string,
  concern: string,
  code: readonly string[] = [],
  status: "open" | "addressed" | "dismissed" = "open",
) {
  return {
    id,
    kind: "finding",
    data: {
      author: AUTHOR,
      severity: "high",
      concern,
      code: [...code],
      concurrence: [],
      status,
    },
  };
}

function outcome(
  id: string,
  ref: string,
  status: "addressed" | "partial" | "untouched" | "beyond",
  note = `${status} note`,
  codeRefId?: string,
) {
  return {
    id,
    kind: "round_outcome",
    data: {
      author: AUTHOR,
      status,
      ask: { ref, text: `Ask ${ref}` },
      note,
      ...(codeRefId === undefined ? {} : { code_ref: codeRefId }),
    },
  };
}

function ask(id: string, findingRef?: FindingRef): ComposableAsk {
  return {
    id,
    path: "src/auth.ts",
    type: "request-change",
    instruction: `Fix ${id}`,
    context: "finding context",
    ...(findingRef === undefined ? {} : { finding: findingRef }),
  };
}

function dispositions(...refs: readonly FindingRef[]): Record<string, FindingDisposition> {
  const entries: Record<string, FindingDisposition> = {};
  for (const ref of refs) {
    entries[findingRefKey(ref)] = { finding: ref, disposition: "dismissed" };
  }
  return entries;
}

function findingIds(board: DraftBoard): string[] {
  return board.elements.flatMap((element) => (element.kind === "finding" ? [element.id] : []));
}

function chapterTitles(board: DraftBoard): string[] {
  return board.elements.flatMap((element) =>
    element.kind === "section" && element.id.startsWith("rennet:host:round-addressed:")
      ? [element.data.title]
      : [],
  );
}

describe("composeFindingRound — Flagged", () => {
  it("hides only verified addressed and dismissed findings, preserving tombstones", () => {
    const addressedRef = ref("gen-1", "f-addressed");
    const partialRef = ref("gen-1", "f-partial");
    const untouchedRef = ref("gen-1", "f-untouched");
    const dismissedRef = ref("gen-1", "f-dismissed");
    const elements = [
      section("findings", "Findings", ["f-addressed", "f-partial", "f-untouched", "f-dismissed"]),
      finding("f-addressed", "Address this"),
      finding("f-partial", "Only partly addressed"),
      finding("f-untouched", "Still untouched"),
      finding("f-dismissed", "Reviewer dismissed this"),
    ];
    const previous = draft(elements);
    const current = draft(elements);
    const report = draft([
      outcome("o-addressed", "a-addressed", "addressed"),
      outcome("o-partial", "a-partial", "partial"),
      outcome("o-untouched", "a-untouched", "untouched"),
    ]);

    const result = composeFindingRound({
      lens: "flagged",
      current,
      previous,
      previousGeneration: "gen-1",
      previousBoardId: FLAGGED_BOARD_1,
      report,
      roundNumber: 1,
      dispatchedAsks: [
        ask("a-addressed", addressedRef),
        ask("a-partial", partialRef),
        ask("a-untouched", untouchedRef),
      ],
      findingDispositions: dispositions(dismissedRef),
    });

    expect(findingIds(result.board)).toEqual([
      "f-addressed",
      "f-partial",
      "f-untouched",
      "f-dismissed",
    ]);
    const findingsSection = result.board.elements.find((element) => element.id === "findings");
    expect(findingsSection?.kind === "section" ? findingsSection.data.children : []).toEqual([
      "f-partial",
      "f-untouched",
    ]);
    expect(result.resolutions).toEqual([
      {
        kind: "reattached",
        finding: addressedRef,
        currentFindingId: "f-addressed",
        match: "stable-id",
      },
      {
        kind: "reattached",
        finding: dismissedRef,
        currentFindingId: "f-dismissed",
        match: "stable-id",
      },
    ]);
    expect(current).toEqual(draft(elements));
    expect(previous).toEqual(draft(elements));
  });

  it("isolates same-id dispositions by the frozen source generation", () => {
    const sameIdWrongGeneration = ref("gen-0", "f-same");
    const board = draft([section("s", "Findings", ["f-same"]), finding("f-same", "Concern")]);

    const result = composeFindingRound({
      lens: "flagged",
      current: board,
      previous: board,
      previousGeneration: "gen-1",
      previousBoardId: FLAGGED_BOARD_1,
      report: draft([]),
      roundNumber: 1,
      dispatchedAsks: [],
      findingDispositions: dispositions(sameIdWrongGeneration),
    });

    expect(findingIds(result.board)).toEqual(["f-same"]);
    expect(result.resolutions).toEqual([
      {
        kind: "detached",
        finding: sameIdWrongGeneration,
        reason: "source-generation-mismatch",
      },
    ]);
  });

  it("detaches a disposition from an abandoned draft attempt", () => {
    const abandoned = ref("gen-1", "f-same", "board:flagged:abandoned");
    const board = draft([section("s", "Findings", ["f-same"]), finding("f-same", "Concern")]);

    const result = composeFindingRound({
      lens: "flagged",
      current: board,
      previous: board,
      previousGeneration: "gen-1",
      previousBoardId: FLAGGED_BOARD_1,
      report: draft([]),
      roundNumber: 1,
      dispatchedAsks: [],
      findingDispositions: dispositions(abandoned),
    });

    expect(result.resolutions).toEqual([
      {
        kind: "detached",
        finding: abandoned,
        reason: "source-board-mismatch",
      },
    ]);
    expect(findingIds(result.board)).toEqual(["f-same"]);
  });

  it("does not reattach a reused finding id when its semantic identity changed", () => {
    const findingRef = ref("gen-1", "f-reused");
    const previous = draft([
      section("s", "Findings", ["f-reused"]),
      finding("f-reused", "Refresh can lose its terminal record", ["old-code"]),
      codeRef("old-code", "ps-old", 10),
    ]);
    const current = draft([
      section("s", "Findings", ["f-reused"]),
      finding("f-reused", "Refresh can lose its terminal record", ["new-code"]),
      codeRef("new-code", "ps-new", 40),
    ]);

    const result = composeFindingRound({
      lens: "flagged",
      current,
      previous,
      previousGeneration: "gen-1",
      previousBoardId: FLAGGED_BOARD_1,
      report: draft([]),
      roundNumber: 1,
      dispatchedAsks: [],
      findingDispositions: dispositions(findingRef),
    });

    expect(findingIds(result.board)).toEqual(["f-reused"]);
    expect(result.resolutions).toEqual([
      {
        kind: "detached",
        finding: findingRef,
        reason: "current-finding-not-uniquely-matched",
      },
    ]);
  });

  it.each([
    {
      name: "duplicate addressed outcomes",
      outcomes: [
        outcome("o-addressed-1", "a-finding", "addressed"),
        outcome("o-addressed-2", "a-finding", "addressed"),
      ],
    },
    {
      name: "contradictory addressed and partial outcomes",
      outcomes: [
        outcome("o-addressed", "a-finding", "addressed"),
        outcome("o-partial", "a-finding", "partial"),
      ],
    },
  ])("does not resolve a finding from $name", ({ outcomes }) => {
    const findingRef = ref("gen-1", "f-finding");
    const board = draft([
      section("s", "Findings", ["f-finding"]),
      finding("f-finding", "Still needs work"),
    ]);

    const result = composeFindingRound({
      lens: "flagged",
      current: board,
      previous: board,
      previousGeneration: "gen-1",
      previousBoardId: FLAGGED_BOARD_1,
      report: draft(outcomes),
      roundNumber: 1,
      dispatchedAsks: [ask("a-finding", findingRef)],
      findingDispositions: {},
    });

    expect(findingIds(result.board)).toEqual(["f-finding"]);
    expect(result.resolutions).toEqual([]);
  });

  it("has a visibility assertion whose dropped-overlay positive control fails", () => {
    const findingRef = ref("gen-1", "f-dismissed");
    const current = draft([
      section("findings", "Findings", ["f-dismissed"]),
      finding("f-dismissed", "Reviewer dismissed this"),
    ]);
    const composed = composeFindingRound({
      lens: "flagged",
      current,
      previous: current,
      previousGeneration: "gen-1",
      previousBoardId: FLAGGED_BOARD_1,
      report: draft([]),
      roundNumber: 1,
      dispatchedAsks: [],
      findingDispositions: dispositions(findingRef),
    }).board;
    const assertDismissedFindingIsGone = (board: DraftBoard): void => {
      const findingsSection = board.elements.find((element) => element.id === "findings");
      expect(
        findingsSection?.kind === "section" ? findingsSection.data.children : [],
      ).not.toContain("f-dismissed");
    };

    expect(() => assertDismissedFindingIsGone(current)).toThrow();
    assertDismissedFindingIsGone(composed);
  });

  it("reattaches a changed id only through a unique semantic identity and detaches the rest", () => {
    const reattachedRef = ref("gen-1", "old-unique");
    const detachedRef = ref("gen-1", "old-detached");
    const previous = draft([
      section("s", "Findings", ["old-unique", "old-detached"]),
      finding("old-unique", "Refresh can lose its terminal record", ["old-code"]),
      codeRef("old-code", "ps-old", 10),
      finding("old-detached", "A different concern", ["old-other-code"]),
      codeRef("old-other-code", "ps-old", 30),
    ]);
    const current = draft([
      section("s", "Findings", ["new-unique", "new-unrelated"]),
      finding("new-unique", "Refresh can lose its terminal record", ["new-code"]),
      codeRef("new-code", "ps-new", 10),
      finding("new-unrelated", "A changed concern", ["new-other-code"]),
      codeRef("new-other-code", "ps-new", 31),
    ]);

    const result = composeFindingRound({
      lens: "flagged",
      current,
      previous,
      previousGeneration: "gen-1",
      previousBoardId: FLAGGED_BOARD_1,
      report: draft([]),
      roundNumber: 1,
      dispatchedAsks: [],
      findingDispositions: dispositions(reattachedRef, detachedRef),
    });

    expect(findingIds(result.board)).toEqual(["new-unique", "new-unrelated"]);
    const findingsSection = result.board.elements.find((element) => element.id === "s");
    expect(findingsSection?.kind === "section" ? findingsSection.data.children : []).toEqual([
      "new-unrelated",
    ]);
    expect(result.resolutions).toEqual([
      {
        kind: "detached",
        finding: detachedRef,
        reason: "current-finding-not-uniquely-matched",
      },
      {
        kind: "reattached",
        finding: reattachedRef,
        currentFindingId: "new-unique",
        match: "unique-semantic",
      },
    ]);
  });

  it.each(["dismissed", "addressed"] as const)(
    "ignores identical orphan findings when reattaching a visible %s finding",
    (resolutionSource) => {
      const findingRef = ref("gen-1", "previous-visible");
      const previous = draft([
        section("previous-section", "Findings", ["previous-visible"]),
        finding("previous-visible", "Refresh can lose its terminal record", [
          "previous-visible-code",
        ]),
        codeRef("previous-visible-code", "ps-old", 10),
        finding("previous-orphan", "Refresh can lose its terminal record", [
          "previous-orphan-code",
        ]),
        codeRef("previous-orphan-code", "ps-old", 10),
      ]);
      const current = draft([
        section("current-section", "Findings", ["current-visible"]),
        finding("current-visible", "Refresh can lose its terminal record", [
          "current-visible-code",
        ]),
        codeRef("current-visible-code", "ps-new", 10),
        finding("current-orphan", "Refresh can lose its terminal record", ["current-orphan-code"]),
        codeRef("current-orphan-code", "ps-new", 10),
      ]);
      const addressed = resolutionSource === "addressed";

      const result = composeFindingRound({
        lens: "flagged",
        current,
        previous,
        previousGeneration: "gen-1",
        previousBoardId: FLAGGED_BOARD_1,
        report: draft(addressed ? [outcome("outcome", "ask", "addressed")] : []),
        roundNumber: 1,
        dispatchedAsks: addressed ? [ask("ask", findingRef)] : [],
        findingDispositions: addressed ? {} : dispositions(findingRef),
      });

      expect(result.resolutions).toEqual([
        {
          kind: "reattached",
          finding: findingRef,
          currentFindingId: "current-visible",
          match: "unique-semantic",
        },
      ]);
      const currentSection = result.board.elements.find(
        (element) => element.id === "current-section",
      );
      expect(currentSection?.kind === "section" ? currentSection.data.children : []).toEqual([]);
      expect(findingIds(result.board)).toEqual(["current-visible", "current-orphan"]);
    },
  );

  it("keeps a dismissed finding reattachable across three renamed generations", () => {
    const originalRef = ref("gen-1", "finding-1");
    const generation1 = draft([
      section("s-1", "Findings", ["finding-1"]),
      finding("finding-1", "Refresh can lose its terminal record", ["code-1"]),
      codeRef("code-1", "ps-1", 10),
    ]);
    const generation2Fresh = draft([
      section("s-2", "Findings", ["step-2"]),
      orderStep("step-2", "Inspect retry accounting", ["finding-2"]),
      finding("finding-2", "Refresh can lose its terminal record", ["code-2"]),
      codeRef("code-2", "ps-2", 10),
    ]);

    const generation2 = composeFindingRound({
      lens: "flagged",
      current: generation2Fresh,
      previous: generation1,
      previousGeneration: "gen-1",
      previousBoardId: FLAGGED_BOARD_1,
      report: draft([]),
      roundNumber: 1,
      dispatchedAsks: [],
      findingDispositions: dispositions(originalRef),
    });

    expect(findingIds(generation2.board)).toEqual(["finding-2"]);
    const generation2Section = generation2.board.elements.find((element) => element.id === "s-2");
    expect(generation2Section?.kind === "section" ? generation2Section.data.children : []).toEqual([
      "step-2",
    ]);
    const generation2Step = generation2.board.elements.find((element) => element.id === "step-2");
    expect(generation2Step?.kind === "order_step" ? generation2Step.data.children : []).toEqual([]);
    expect(generation2.resolutions).toEqual([
      {
        kind: "reattached",
        finding: originalRef,
        currentFindingId: "finding-2",
        match: "unique-semantic",
      },
    ]);

    const successorRef = ref("gen-2", "finding-2", FLAGGED_BOARD_2);
    const generation3Fresh = draft([
      section("s-3", "Findings", ["finding-3"]),
      finding("finding-3", "Refresh can lose its terminal record", ["code-3"]),
      codeRef("code-3", "ps-3", 10),
    ]);
    const generation3 = composeFindingRound({
      lens: "flagged",
      current: generation3Fresh,
      previous: generation2.board,
      previousGeneration: "gen-2",
      previousBoardId: FLAGGED_BOARD_2,
      report: draft([]),
      roundNumber: 2,
      dispatchedAsks: [],
      findingDispositions: dispositions(successorRef),
    });

    expect(findingIds(generation3.board)).toEqual(["finding-3"]);
    const generation3Section = generation3.board.elements.find((element) => element.id === "s-3");
    expect(generation3Section?.kind === "section" ? generation3Section.data.children : []).toEqual(
      [],
    );
    expect(generation3.resolutions).toEqual([
      {
        kind: "reattached",
        finding: successorRef,
        currentFindingId: "finding-3",
        match: "unique-semantic",
      },
    ]);
  });
});

describe("findingDispositionMigrationEvents", () => {
  const predecessor = ref("gen-1", "finding-1");
  const successor = ref("gen-2", "finding-2", FLAGGED_BOARD_2);
  const addressedOnly = ref("gen-1", "addressed-only");
  const detached = ref("gen-1", "detached");
  const resolutions: FindingResolution[] = [
    {
      kind: "reattached",
      finding: addressedOnly,
      currentFindingId: "addressed-successor",
      match: "unique-semantic",
    },
    {
      kind: "detached",
      finding: detached,
      reason: "current-finding-not-uniquely-matched",
    },
    {
      kind: "reattached",
      finding: predecessor,
      currentFindingId: successor.findingId,
      match: "unique-semantic",
    },
    {
      kind: "reattached",
      finding: predecessor,
      currentFindingId: successor.findingId,
      match: "unique-semantic",
    },
  ];

  function projection(...refs: readonly FindingRef[]): AskProjection {
    return { ...emptyAskProjection(), findingDispositions: dispositions(...refs) };
  }

  it("clones each live predecessor dismissal once and is idempotent", () => {
    const current = projection(predecessor);
    const events = findingDispositionMigrationEvents({
      findingDispositions: current.findingDispositions,
      successorGeneration: successor.generation,
      successorBoardId: successor.boardId,
      resolutions,
    });

    expect(events).toEqual([{ kind: "finding-dismiss", finding: successor }]);
    const migrated = events.reduce(applyAskEvent, current);
    expect(Object.keys(migrated.findingDispositions).sort()).toEqual(
      [findingRefKey(predecessor), findingRefKey(successor)].sort(),
    );
    expect(
      findingDispositionMigrationEvents({
        findingDispositions: migrated.findingDispositions,
        successorGeneration: successor.generation,
        successorBoardId: successor.boardId,
        resolutions,
      }),
    ).toEqual([]);
  });

  it("emits nothing when predecessor and successor dismissals both exist", () => {
    expect(
      findingDispositionMigrationEvents({
        findingDispositions: projection(predecessor, successor).findingDispositions,
        successorGeneration: successor.generation,
        successorBoardId: successor.boardId,
        resolutions,
      }),
    ).toEqual([]);
  });
});

describe("composeFindingRound — Sequence", () => {
  const sequenceDraft = () =>
    draft([
      section("walk", "The Walk", ["walk-prose"]),
      {
        id: "walk-prose",
        kind: "prose",
        data: { author: AUTHOR, markdown: "Read the change from the data shape outward." },
      },
    ]);

  function composeRound(roundNumber: number, previous: DraftBoard): DraftBoard {
    const reportCode = codeRef(`report-code-${roundNumber}`, `ps-${roundNumber + 1}`, 20);
    return composeFindingRound({
      lens: "sequence",
      current: sequenceDraft(),
      previous,
      previousGeneration: `gen-${roundNumber}`,
      report: draft([
        outcome(
          `outcome-${roundNumber}`,
          `ask-${roundNumber}`,
          "addressed",
          `Round ${roundNumber} fixed it.`,
          reportCode.id,
        ),
        reportCode,
        outcome(`partial-${roundNumber}`, `partial-ask-${roundNumber}`, "partial"),
        outcome(`invented-${roundNumber}`, `not-dispatched-${roundNumber}`, "addressed"),
      ]),
      roundNumber,
      dispatchedAsks: [ask(`ask-${roundNumber}`), ask(`partial-ask-${roundNumber}`)],
      findingDispositions: {},
    }).board;
  }

  it("carries addressed chapters chronologically and appends exactly one newest chapter", () => {
    const round1 = composeRound(1, sequenceDraft());
    const poisonedFresh = draft([
      ...sequenceDraft().elements,
      section("rennet:host:round-addressed:99:section", "Round 99 · Addressed", []),
      orderStep("spoofed-step", "Spoofed addressed content", [
        "rennet:host:round-addressed:99:prose",
      ]),
      {
        id: "rennet:host:round-addressed:99:prose",
        kind: "prose",
        data: { author: AUTHOR, markdown: "Spoofed host prose" },
      },
    ]);
    const round2 = composeFindingRound({
      lens: "sequence",
      current: poisonedFresh,
      previous: round1,
      previousGeneration: "gen-2",
      report: draft([outcome("outcome-2", "ask-2", "addressed", "Round 2 fixed it.")]),
      roundNumber: 2,
      dispatchedAsks: [ask("ask-2")],
      findingDispositions: {},
    }).board;

    expect(chapterTitles(round2)).toEqual(["Round 1 · Addressed", "Round 2 · Addressed"]);
    expect(chapterTitles(round2)).not.toContain("Round 99 · Addressed");
    expect(round2.elements.filter((element) => element.kind === "round_outcome")).toEqual([]);
    const spoofedStep = round2.elements.find((element) => element.id === "spoofed-step");
    expect(spoofedStep?.kind === "order_step" ? spoofedStep.data.children : []).toEqual([]);

    const round2Section = round2.elements.find(
      (element) => element.id === "rennet:host:round-addressed:2:section",
    );
    expect(round2Section?.kind === "section" ? round2Section.data.children : []).toEqual([
      "rennet:host:round-addressed:2:0:prose",
    ]);
    const round2Prose = round2.elements.find(
      (element) => element.id === "rennet:host:round-addressed:2:0:prose",
    );
    expect(round2Prose?.kind === "prose" ? round2Prose.data.markdown : "").toBe(
      "**Fix ask-2**\n\nRound 2 fixed it.",
    );
  });

  it("has an order assertion whose reversed-chapter positive control fails", () => {
    const round1 = composeRound(1, sequenceDraft());
    const round2 = composeRound(2, round1);
    const assertChronological = (board: DraftBoard): void => {
      expect(chapterTitles(board)).toEqual(["Round 1 · Addressed", "Round 2 · Addressed"]);
    };
    const reversed = {
      ...round2,
      elements: [
        ...round2.elements.filter(
          (element) => !element.id.startsWith("rennet:host:round-addressed:"),
        ),
        ...round2.elements.filter((element) =>
          element.id.startsWith("rennet:host:round-addressed:2:"),
        ),
        ...round2.elements.filter((element) =>
          element.id.startsWith("rennet:host:round-addressed:1:"),
        ),
      ],
    };

    expect(() => assertChronological(reversed)).toThrow();
    assertChronological(round2);
  });

  it("does not append an empty chapter without a unique verified addressed outcome", () => {
    const previous = composeRound(1, sequenceDraft());

    const result = composeFindingRound({
      lens: "sequence",
      current: sequenceDraft(),
      previous,
      previousGeneration: "gen-2",
      report: draft([
        outcome("duplicate-1", "ask-2", "addressed"),
        outcome("duplicate-2", "ask-2", "addressed"),
        outcome("invented", "not-dispatched", "addressed"),
      ]),
      roundNumber: 2,
      dispatchedAsks: [ask("ask-2")],
      findingDispositions: {},
    }).board;

    expect(chapterTitles(result)).toEqual(["Round 1 · Addressed"]);
    expect(
      result.elements.some((element) => element.id.startsWith("rennet:host:round-addressed:2:")),
    ).toBe(false);
  });
});
