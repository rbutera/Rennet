import type { ComposableAsk, HostElement, RoundReportBoard } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { verifyRoundReportEvidence } from "./round-report-verification";

const author = { kind: "lens-agent" as const, id: "round-report" };
const sectionId = "rennet:host:round-report:section";
const statuses = ["addressed", "partial", "untouched", "beyond"] as const;
const diff = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -8,3 +8,4 @@",
  " keep",
  "+refresh();",
  " keep",
  "diff --git a/src/cache.ts b/src/cache.ts",
  "index 3333333..4444444 100644",
  "--- a/src/cache.ts",
  "+++ b/src/cache.ts",
  "@@ -20,2 +20,3 @@",
  " keep",
  "+invalidate();",
  "",
].join("\n");

function codeRef(id: string, path: string, start: number): HostElement {
  return {
    id,
    kind: "code_ref",
    data: {
      author,
      patchset_id: "ps-successor",
      path,
      side: "head",
      start_line: start,
      end_line: start,
    },
  };
}

function outcome(
  id: string,
  status: "addressed" | "partial" | "untouched" | "beyond",
  askRef: string,
  ref?: string,
): HostElement {
  return {
    id,
    kind: "round_outcome",
    data: {
      author,
      status,
      ask: { ref: askRef, text: askRef },
      note: `${status} evidence`,
      ...(ref === undefined ? {} : { code_ref: ref }),
    },
  };
}

function rawBoard(
  elements: readonly HostElement[],
  document: RoundReportBoard["document"] = {
    title: "Round report",
    introMarkdown: "Verified against the coding turn: 1 addressed.",
    measure: "reading",
  },
): RoundReportBoard {
  return {
    lens: "report",
    generation: "gen-successor",
    boardId: "report-board",
    document,
    sections: [
      {
        ref: sectionId,
        gist: "Round outcomes",
        counts: {
          outcomes: elements.filter((element) => element.kind === "round_outcome").length,
        },
      },
    ],
    elements: [...elements],
    skippedHunks: [],
  };
}

function board(elements: readonly HostElement[]): RoundReportBoard {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const outcomes = elements.filter(
    (element): element is Extract<HostElement, { kind: "round_outcome" }> =>
      element.kind === "round_outcome",
  );
  const canonicalElements: HostElement[] = [];
  const outcomeIds: string[] = [];
  for (const [index, current] of outcomes.entries()) {
    const outcomeId = `rennet:host:round-report:${index}:outcome`;
    const codeRefId = `rennet:host:round-report:${index}:code`;
    outcomeIds.push(outcomeId);
    const cited = current.data.code_ref === undefined ? undefined : byId.get(current.data.code_ref);
    if (cited?.kind === "code_ref") {
      canonicalElements.push({ ...cited, id: codeRefId });
    }
    canonicalElements.push({
      ...current,
      id: outcomeId,
      data: {
        ...current.data,
        ...(current.data.code_ref === undefined || cited?.kind !== "code_ref"
          ? {}
          : { code_ref: codeRefId }),
      },
    });
  }
  canonicalElements.unshift({
    id: sectionId,
    kind: "section",
    data: { author, title: "Round outcomes", children: outcomeIds },
  });
  const tally = statuses.flatMap((status) => {
    const count = outcomes.filter((current) => current.data.status === status).length;
    return count === 0 ? [] : [`${count} ${status}`];
  });
  return rawBoard(canonicalElements, {
    title: "Round report",
    introMarkdown: `Verified against the coding turn: ${tally.join(", ")}.`,
    measure: "reading",
  });
}

function ask(id = "ask-auth", path = "src/auth.ts", instruction = id): ComposableAsk {
  return { id, path, type: "request-change", instruction, context: "" };
}

function verify(elements: readonly HostElement[], asks: readonly ComposableAsk[] = [ask()]): void {
  verifyRoundReportEvidence({
    board: board(elements),
    dispatchedAsks: asks,
    expectedPatchsetId: "ps-successor",
    diff,
    changedPaths: ["src/auth.ts", "src/cache.ts"],
  });
}

describe("verifyRoundReportEvidence", () => {
  it("accepts one evidence-backed outcome per ask plus uniquely identified beyond work", () => {
    expect(() =>
      verify([
        codeRef("auth-ref", "src/auth.ts", 9),
        outcome("auth-outcome", "addressed", "ask-auth", "auth-ref"),
        codeRef("cache-ref", "src/cache.ts", 21),
        outcome("cache-outcome", "beyond", "beyond:cache", "cache-ref"),
      ]),
    ).not.toThrow();
  });

  it("rejects omitted, duplicate, and invented dispatched ask accounts", () => {
    expect(() => verify([])).toThrow("omitted dispatched asks: ask-auth");
    expect(() =>
      verify([outcome("one", "untouched", "ask-auth"), outcome("two", "untouched", "ask-auth")]),
    ).toThrow("repeats dispatched asks: ask-auth");
    expect(() => verify([outcome("invented", "untouched", "ask-other")])).toThrow(
      "unknown dispatched ask ask-other",
    );
  });

  it("rejects a claimed change without a code_ref or with a missing reference", () => {
    expect(() => verify([outcome("no-ref", "addressed", "ask-auth")])).toThrow(
      "has no diff evidence anchor",
    );
    expect(() => verify([outcome("bad-ref", "partial", "ask-auth", "absent")])).toThrow(
      "cites missing code_ref absent",
    );
  });

  it("rejects an anchor outside the worker diff path or changed lines", () => {
    expect(() =>
      verify([
        codeRef("other", "src/other.ts", 9),
        outcome("wrong-path", "addressed", "ask-auth", "other"),
      ]),
    ).toThrow("src/other.ts, which is absent from the round diff");
    expect(() =>
      verify([
        codeRef("outside", "src/auth.ts", 90),
        outcome("wrong-line", "addressed", "ask-auth", "outside"),
      ]),
    ).toThrow("outside the changed lines in the round diff");
    expect(() =>
      verify([
        codeRef("context", "src/auth.ts", 8),
        outcome("unchanged-context", "addressed", "ask-auth", "context"),
      ]),
    ).toThrow("outside the changed lines in the round diff");
    const spanning = codeRef("spanning", "src/auth.ts", 8);
    spanning.data.end_line = 9;
    expect(() =>
      verify([spanning, outcome("spanning-outcome", "addressed", "ask-auth", "spanning")]),
    ).toThrow("must cite one exact changed line");
  });

  it("rejects any report vocabulary or topology the deterministic host builder cannot emit", () => {
    const valid = board([
      codeRef("auth-ref", "src/auth.ts", 9),
      outcome("auth-outcome", "addressed", "ask-auth", "auth-ref"),
    ]);
    const section = valid.elements[0];
    const code = valid.elements[1];
    const reportOutcome = valid.elements[2];
    const projectedSection = valid.sections[0];
    if (
      section?.kind !== "section" ||
      code?.kind !== "code_ref" ||
      reportOutcome?.kind !== "round_outcome" ||
      projectedSection === undefined
    ) {
      throw new Error("invalid canonical report fixture");
    }

    expect(() =>
      verifyRoundReportEvidence({
        board: rawBoard([
          ...valid.elements,
          { id: "extra", kind: "prose", data: { author, markdown: "not host-owned" } },
        ]),
        dispatchedAsks: [ask()],
        expectedPatchsetId: "ps-successor",
        diff,
        changedPaths: ["src/auth.ts", "src/cache.ts"],
      }),
    ).toThrow("only permits section, round_outcome, and code_ref elements");

    expect(() =>
      verifyRoundReportEvidence({
        board: rawBoard([
          { ...section, data: { ...section.data, children: [reportOutcome.id, reportOutcome.id] } },
          code,
          reportOutcome,
        ]),
        dispatchedAsks: [ask()],
        expectedPatchsetId: "ps-successor",
        diff,
        changedPaths: ["src/auth.ts", "src/cache.ts"],
      }),
    ).toThrow("must contain every outcome exactly once");

    expect(() =>
      verifyRoundReportEvidence({
        board: rawBoard([section, code, reportOutcome, { ...code, id: "uncited-code" }]),
        dispatchedAsks: [ask()],
        expectedPatchsetId: "ps-successor",
        diff,
        changedPaths: ["src/auth.ts", "src/cache.ts"],
      }),
    ).toThrow("must cite every code_ref exactly once");
  });

  it("rejects drift from deterministic ids, authors, document, and tally", () => {
    const valid = board([
      codeRef("auth-ref", "src/auth.ts", 9),
      outcome("auth-outcome", "addressed", "ask-auth", "auth-ref"),
    ]);
    const section = valid.elements[0];
    const code = valid.elements[1];
    const reportOutcome = valid.elements[2];
    const projectedSection = valid.sections[0];
    if (
      section?.kind !== "section" ||
      code?.kind !== "code_ref" ||
      reportOutcome?.kind !== "round_outcome" ||
      projectedSection === undefined
    ) {
      throw new Error("invalid canonical report fixture");
    }
    const input = (candidate: RoundReportBoard) => ({
      board: candidate,
      dispatchedAsks: [ask()],
      expectedPatchsetId: "ps-successor",
      diff,
      changedPaths: ["src/auth.ts", "src/cache.ts"],
    });

    expect(() =>
      verifyRoundReportEvidence(
        input(
          rawBoard([
            section,
            { ...code, id: "renamed-code" },
            { ...reportOutcome, data: { ...reportOutcome.data, code_ref: "renamed-code" } },
          ]),
        ),
      ),
    ).toThrow("deterministic id");

    expect(() =>
      verifyRoundReportEvidence(
        input(
          rawBoard([
            section,
            { ...code, data: { ...code.data, author: { kind: "lens-agent", id: "other" } } },
            reportOutcome,
          ]),
        ),
      ),
    ).toThrow("canonical host author");

    // Whiteboard persistence topologically creates references before their owners, so
    // durable Map order differs from the builder array. Section children own reading order.
    expect(() =>
      verifyRoundReportEvidence(input(rawBoard([code, reportOutcome, section]))),
    ).not.toThrow();

    expect(() =>
      verifyRoundReportEvidence(
        input(rawBoard(valid.elements, { ...valid.document, introMarkdown: "Looks good." })),
      ),
    ).toThrow("deterministic document");

    expect(() =>
      verifyRoundReportEvidence(
        input({ ...valid, sections: [{ ...projectedSection, counts: { outcomes: 2 } }] }),
      ),
    ).toThrow("deterministic section tally");
  });

  it("rejects a stale patchset identity even when the path and changed line match", () => {
    const stale = codeRef("stale", "src/auth.ts", 9);
    stale.data.patchset_id = "ps-before";
    expect(() =>
      verify([stale, outcome("stale-outcome", "addressed", "ask-auth", "stale")]),
    ).toThrow("cites patchset ps-before, not ps-successor");
  });

  it("binds each persisted outcome to the exact durable ask text and owned path", () => {
    const rewritten = outcome("rewritten", "untouched", "ask-auth");
    if (rewritten.kind !== "round_outcome") throw new Error("expected round outcome fixture");
    rewritten.data.ask.text = "A rewritten instruction";
    expect(() => verify([rewritten])).toThrow("rewrites dispatched ask ask-auth");

    expect(() =>
      verify([
        codeRef("cache-ref", "src/cache.ts", 21),
        outcome("wrong-file", "addressed", "ask-auth", "cache-ref"),
      ]),
    ).toThrow("cites src/cache.ts, not the asked path src/auth.ts");
  });

  it("rejects change evidence on an untouched ask", () => {
    expect(() =>
      verify([
        codeRef("auth-ref", "src/auth.ts", 9),
        outcome("untouched-with-ref", "untouched", "ask-auth", "auth-ref"),
      ]),
    ).toThrow("marks untouched ask ask-auth with change evidence");
  });

  it("rejects binary and no-hunk file paths as line evidence", () => {
    const binaryDiff = [
      "diff --git a/image.png b/image.png",
      "index 1111111..2222222 100644",
      "Binary files a/image.png and b/image.png differ",
      "",
    ].join("\n");
    expect(() =>
      verifyRoundReportEvidence({
        board: board([
          codeRef("binary", "image.png", 1),
          outcome("binary-outcome", "addressed", "ask-auth", "binary"),
        ]),
        dispatchedAsks: [ask("ask-auth", "image.png")],
        expectedPatchsetId: "ps-successor",
        diff: binaryDiff,
        changedPaths: ["image.png"],
      }),
    ).toThrow("has no line-addressable change");

    const modeOnlyDiff = [
      "diff --git a/script.sh b/script.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");
    expect(() =>
      verifyRoundReportEvidence({
        board: board([
          codeRef("mode", "script.sh", 1),
          outcome("mode-outcome", "addressed", "ask-auth", "mode"),
        ]),
        dispatchedAsks: [ask("ask-auth", "script.sh")],
        expectedPatchsetId: "ps-successor",
        diff: modeOnlyDiff,
        changedPaths: ["script.sh"],
      }),
    ).toThrow("has no line-addressable change");
  });

  it("accepts exact changed-line evidence through a rename alias", () => {
    const renameDiff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 80%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -4,2 +4,2 @@",
      "-removed();",
      "+replacement();",
      " keep",
      "",
    ].join("\n");
    const renamed = codeRef("renamed", "src/new.ts", 4);
    expect(() =>
      verifyRoundReportEvidence({
        board: board([renamed, outcome("renamed-outcome", "addressed", "ask-auth", "renamed")]),
        dispatchedAsks: [ask("ask-auth", "src/old.ts")],
        expectedPatchsetId: "ps-successor",
        diff: renameDiff,
        changedPaths: ["src/new.ts"],
      }),
    ).not.toThrow();
  });

  it("keeps exact changed-line evidence beyond the normal display truncation cap", () => {
    const largeDiff = [
      "diff --git a/src/large.ts b/src/large.ts",
      "index 1111111..2222222 100644",
      "--- a/src/large.ts",
      "+++ b/src/large.ts",
      "@@ -1,2 +1,3 @@",
      ` ${"x".repeat(270_000)}`,
      "+changed();",
      " tail",
      "",
    ].join("\n");
    expect(() =>
      verifyRoundReportEvidence({
        board: board([
          codeRef("large", "src/large.ts", 2),
          outcome("large-outcome", "addressed", "ask-auth", "large"),
        ]),
        dispatchedAsks: [ask("ask-auth", "src/large.ts")],
        expectedPatchsetId: "ps-successor",
        diff: largeDiff,
        changedPaths: ["src/large.ts"],
      }),
    ).not.toThrow();
  });

  it("rejects duplicate beyond references and a dispatched ask relabelled as beyond", () => {
    expect(() =>
      verify([
        outcome("ask", "untouched", "ask-auth"),
        codeRef("cache", "src/cache.ts", 21),
        outcome("beyond-one", "beyond", "beyond:cache", "cache"),
        outcome("beyond-two", "beyond", "beyond:cache", "cache"),
      ]),
    ).toThrow("repeats beyond-ask reference beyond:cache");
    expect(() =>
      verify([
        outcome("ask", "untouched", "ask-auth"),
        codeRef("auth", "src/auth.ts", 9),
        outcome("mislabelled", "beyond", "ask-auth", "auth"),
      ]),
    ).toThrow("marks dispatched ask ask-auth as beyond");
  });
});
