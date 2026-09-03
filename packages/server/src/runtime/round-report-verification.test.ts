import type { ComposableAsk, HostElement, RoundReportBoard } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildRoundEvidenceManifest } from "./round-evidence-manifest";
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

/** The manifest ids the host would mint for `diff`, by path — the classifier cites
 *  these, so the fixtures must too. */
const evidenceIdFor = (source: string, path: string): string => {
  const unit = buildRoundEvidenceManifest(source).find((current) => current.path === path);
  if (unit === undefined) throw new Error(`no manifest evidence for ${path}`);
  return unit.id;
};
const authEvidence = evidenceIdFor(diff, "src/auth.ts");
const cacheEvidence = evidenceIdFor(diff, "src/cache.ts");

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
  options: { readonly ref?: string; readonly evidenceIds?: readonly string[] } = {},
): HostElement {
  return {
    id,
    kind: "round_outcome",
    data: {
      author,
      status,
      ask: { ref: askRef, text: askRef },
      note: `${status} evidence`,
      ...(options.evidenceIds === undefined ? {} : { evidence_ids: [...options.evidenceIds] }),
      ...(options.ref === undefined ? {} : { code_ref: options.ref }),
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

/** The whole-diff partition the two-hunk `diff` demands: the ask owns its hunk, a
 *  beyond entry owns the other. Every case below starts from this and breaks one thing. */
const wholePartition = (): HostElement[] => [
  codeRef("auth-ref", "src/auth.ts", 9),
  outcome("auth-outcome", "addressed", "ask-auth", {
    ref: "auth-ref",
    evidenceIds: [authEvidence],
  }),
  codeRef("cache-ref", "src/cache.ts", 21),
  outcome("cache-outcome", "beyond", "beyond:cache", {
    ref: "cache-ref",
    evidenceIds: [cacheEvidence],
  }),
];

describe("verifyRoundReportEvidence", () => {
  it("accepts one evidence-backed outcome per ask plus uniquely identified beyond work", () => {
    expect(() => verify(wholePartition())).not.toThrow();
  });

  it("rejects an evidence partition that is not exactly once over the round", () => {
    expect(() =>
      verify([
        codeRef("auth-ref", "src/auth.ts", 9),
        outcome("auth-outcome", "addressed", "ask-auth", {
          ref: "auth-ref",
          evidenceIds: [authEvidence],
        }),
      ]),
    ).toThrow(`leaves evidence unplaced: ${cacheEvidence}`);

    expect(() =>
      verify([
        codeRef("auth-ref", "src/auth.ts", 9),
        outcome("auth-outcome", "addressed", "ask-auth", {
          ref: "auth-ref",
          evidenceIds: [authEvidence],
        }),
        codeRef("cache-ref", "src/cache.ts", 21),
        outcome("cache-outcome", "beyond", "beyond:cache", {
          ref: "cache-ref",
          evidenceIds: [cacheEvidence, authEvidence],
        }),
      ]),
    ).toThrow(`places evidence id ${authEvidence} in more than one bucket`);

    expect(() =>
      verify([
        codeRef("auth-ref", "src/auth.ts", 9),
        outcome("auth-outcome", "addressed", "ask-auth", {
          ref: "auth-ref",
          evidenceIds: [authEvidence, "ev-invented"],
        }),
        codeRef("cache-ref", "src/cache.ts", 21),
        outcome("cache-outcome", "beyond", "beyond:cache", {
          ref: "cache-ref",
          evidenceIds: [cacheEvidence],
        }),
      ]),
    ).toThrow("cites unknown evidence id ev-invented");
  });

  it("rejects omitted, duplicate, and invented dispatched ask accounts", () => {
    expect(() => verify([])).toThrow(`leaves evidence unplaced: ${authEvidence}`);
    expect(() =>
      verify([
        outcome("one", "untouched", "ask-auth"),
        outcome("two", "untouched", "ask-auth"),
        codeRef("all", "src/auth.ts", 9),
        outcome("beyond-all", "beyond", "beyond:all", {
          ref: "all",
          evidenceIds: [authEvidence, cacheEvidence],
        }),
      ]),
    ).toThrow("repeats dispatched asks: ask-auth");
    expect(() =>
      verify([
        outcome("invented", "untouched", "ask-other"),
        outcome("kept", "untouched", "ask-auth"),
        codeRef("all", "src/auth.ts", 9),
        outcome("beyond-all", "beyond", "beyond:all", {
          ref: "all",
          evidenceIds: [authEvidence, cacheEvidence],
        }),
      ]),
    ).toThrow("unknown dispatched ask ask-other");
  });

  it("rejects a claimed change with no evidence ids or a missing code_ref reference", () => {
    expect(() =>
      verify([
        outcome("no-ids", "addressed", "ask-auth"),
        codeRef("all", "src/auth.ts", 9),
        outcome("beyond-all", "beyond", "beyond:all", {
          ref: "all",
          evidenceIds: [authEvidence, cacheEvidence],
        }),
      ]),
    ).toThrow("cites no round evidence");

    expect(() =>
      verify([
        outcome("bad-ref", "partial", "ask-auth", { ref: "absent", evidenceIds: [authEvidence] }),
        codeRef("cache-ref", "src/cache.ts", 21),
        outcome("cache-outcome", "beyond", "beyond:cache", {
          ref: "cache-ref",
          evidenceIds: [cacheEvidence],
        }),
      ]),
    ).toThrow("cites missing code_ref absent");
  });

  it("rejects an anchor that is not the one the host derives from the cited evidence", () => {
    const drifted = (mutate: (ref: Extract<HostElement, { kind: "code_ref" }>) => void) => {
      const anchor = codeRef("auth-ref", "src/auth.ts", 9);
      if (anchor.kind !== "code_ref") throw new Error("expected code_ref fixture");
      mutate(anchor);
      return [
        anchor,
        outcome("auth-outcome", "addressed", "ask-auth", {
          ref: "auth-ref",
          evidenceIds: [authEvidence],
        }),
        codeRef("cache-ref", "src/cache.ts", 21),
        outcome("cache-outcome", "beyond", "beyond:cache", {
          ref: "cache-ref",
          evidenceIds: [cacheEvidence],
        }),
      ];
    };

    // An unchanged context line, a line outside the hunk, a spanning range, and the
    // wrong side are all the same defect now: not the derived anchor.
    expect(() =>
      verify(drifted((ref) => Object.assign(ref.data, { start_line: 8, end_line: 8 }))),
    ).toThrow("not the derived head src/auth.ts:9");
    expect(() =>
      verify(drifted((ref) => Object.assign(ref.data, { start_line: 90, end_line: 90 }))),
    ).toThrow("not the derived head src/auth.ts:9");
    expect(() => verify(drifted((ref) => Object.assign(ref.data, { end_line: 10 })))).toThrow(
      "not the derived head src/auth.ts:9",
    );
    expect(() => verify(drifted((ref) => Object.assign(ref.data, { side: "base" })))).toThrow(
      "not the derived head src/auth.ts:9",
    );
  });

  it("rejects any report vocabulary or topology the deterministic host builder cannot emit", () => {
    const valid = board(wholePartition());
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
          ...valid.elements.slice(1),
        ]),
        dispatchedAsks: [ask()],
        expectedPatchsetId: "ps-successor",
        diff,
        changedPaths: ["src/auth.ts", "src/cache.ts"],
      }),
    ).toThrow("must contain every outcome exactly once");

    expect(() =>
      verifyRoundReportEvidence({
        board: rawBoard([...valid.elements, { ...code, id: "uncited-code" }]),
        dispatchedAsks: [ask()],
        expectedPatchsetId: "ps-successor",
        diff,
        changedPaths: ["src/auth.ts", "src/cache.ts"],
      }),
    ).toThrow("must cite every code_ref exactly once");
  });

  it("rejects drift from deterministic ids, authors, document, and tally", () => {
    const valid = board(wholePartition());
    const [section, code, reportOutcome] = valid.elements;
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
            ...valid.elements.slice(3),
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
            ...valid.elements.slice(2),
          ]),
        ),
      ),
    ).toThrow("canonical host author");

    // Whiteboard persistence topologically creates references before their owners, so
    // durable Map order differs from the builder array. Section children own reading order.
    expect(() =>
      verifyRoundReportEvidence(
        input(rawBoard([...valid.elements.slice(1), section], valid.document)),
      ),
    ).not.toThrow();

    expect(() =>
      verifyRoundReportEvidence(
        input(rawBoard(valid.elements, { ...valid.document, introMarkdown: "Looks good." })),
      ),
    ).toThrow("deterministic document");

    expect(() =>
      verifyRoundReportEvidence(
        input({ ...valid, sections: [{ ...projectedSection, counts: { outcomes: 5 } }] }),
      ),
    ).toThrow("deterministic section tally");
  });

  it("rejects a stale patchset identity even when the derived anchor matches", () => {
    const stale = codeRef("auth-ref", "src/auth.ts", 9);
    stale.data.patchset_id = "ps-before";
    expect(() =>
      verify([
        stale,
        outcome("auth-outcome", "addressed", "ask-auth", {
          ref: "auth-ref",
          evidenceIds: [authEvidence],
        }),
        codeRef("cache-ref", "src/cache.ts", 21),
        outcome("cache-outcome", "beyond", "beyond:cache", {
          ref: "cache-ref",
          evidenceIds: [cacheEvidence],
        }),
      ]),
    ).toThrow("cites patchset ps-before, not ps-successor");
  });

  it("binds each persisted outcome to the exact durable ask text and owned path", () => {
    const rewritten = outcome("rewritten", "untouched", "ask-auth");
    if (rewritten.kind !== "round_outcome") throw new Error("expected round outcome fixture");
    rewritten.data.ask.text = "A rewritten instruction";
    expect(() =>
      verify([
        rewritten,
        codeRef("all", "src/auth.ts", 9),
        outcome("beyond-all", "beyond", "beyond:all", {
          ref: "all",
          evidenceIds: [authEvidence, cacheEvidence],
        }),
      ]),
    ).toThrow("rewrites dispatched ask ask-auth");

    expect(() =>
      verify([
        codeRef("cache-ref", "src/cache.ts", 21),
        outcome("wrong-file", "addressed", "ask-auth", {
          ref: "cache-ref",
          evidenceIds: [cacheEvidence],
        }),
        codeRef("auth-ref", "src/auth.ts", 9),
        outcome("beyond-auth", "beyond", "beyond:auth", {
          ref: "auth-ref",
          evidenceIds: [authEvidence],
        }),
      ]),
    ).toThrow("cites no evidence on the asked path src/auth.ts");
  });

  it("verifies a prose-anchored ask, whose `path` is quoted text and names no file", () => {
    // A quote-of-board / body-stratum ask carries the QUOTED TEXT in `path`. Requiring
    // evidence "on the asked path" made every such outcome permanently unverifiable —
    // no manifest unit can sit on a sentence — which stalled the whole round.
    const proseAsk: ComposableAsk = {
      id: "ask-prose",
      path: "the retry loop should not swallow the abort",
      type: "request-change",
      instruction: "ask-prose",
      context: "",
    };
    expect(() =>
      verify(
        [
          codeRef("auth-ref", "src/auth.ts", 9),
          outcome("prose-outcome", "addressed", "ask-prose", {
            ref: "auth-ref",
            evidenceIds: [authEvidence],
          }),
          codeRef("cache-ref", "src/cache.ts", 21),
          outcome("cache-outcome", "beyond", "beyond:cache", {
            ref: "cache-ref",
            evidenceIds: [cacheEvidence],
          }),
        ],
        [proseAsk],
      ),
    ).not.toThrow();
  });

  it("still rejects a real-path ask whose outcome cites a different file", () => {
    // The positive control for the gate above, kept beside it: relaxing the check for
    // prose must not relax it for an ask that DOES name a file — including a spanless
    // path-only ask, which is the shape a frozen code ref composes to.
    expect(() =>
      verify(
        [
          codeRef("cache-ref", "src/cache.ts", 21),
          outcome("wrong-file", "addressed", "ask-auth", {
            ref: "cache-ref",
            evidenceIds: [cacheEvidence],
          }),
          codeRef("auth-ref", "src/auth.ts", 9),
          outcome("beyond-auth", "beyond", "beyond:auth", {
            ref: "auth-ref",
            evidenceIds: [authEvidence],
          }),
        ],
        [ask("ask-auth", "src/auth.ts")],
      ),
    ).toThrow("cites no evidence on the asked path src/auth.ts");
  });

  it("rejects change evidence on an untouched ask", () => {
    expect(() =>
      verify([
        outcome("untouched-with-ids", "untouched", "ask-auth", { evidenceIds: [authEvidence] }),
        codeRef("cache-ref", "src/cache.ts", 21),
        outcome("cache-outcome", "beyond", "beyond:cache", {
          ref: "cache-ref",
          evidenceIds: [cacheEvidence],
        }),
      ]),
    ).toThrow("marks untouched ask ask-auth with change evidence");
  });

  it("accepts binary and mode-only evidence with no anchor, and rejects one that invents a line", () => {
    const binaryDiff = [
      "diff --git a/image.png b/image.png",
      "index 1111111..2222222 100644",
      "Binary files a/image.png and b/image.png differ",
      "",
    ].join("\n");
    const binaryEvidence = evidenceIdFor(binaryDiff, "image.png");
    const binaryInput = (elements: readonly HostElement[]) => ({
      board: board(elements),
      dispatchedAsks: [ask("ask-auth", "image.png")],
      expectedPatchsetId: "ps-successor",
      diff: binaryDiff,
      changedPaths: ["image.png"],
    });

    // The change is real and the ask is addressed by it; there is simply no line to
    // cite. The old contract could not express this and rejected the round.
    expect(() =>
      verifyRoundReportEvidence(
        binaryInput([
          outcome("binary-outcome", "addressed", "ask-auth", { evidenceIds: [binaryEvidence] }),
        ]),
      ),
    ).not.toThrow();

    expect(() =>
      verifyRoundReportEvidence(
        binaryInput([
          codeRef("binary", "image.png", 1),
          outcome("binary-outcome", "addressed", "ask-auth", {
            ref: "binary",
            evidenceIds: [binaryEvidence],
          }),
        ]),
      ),
    ).toThrow("has no line-addressable change");

    const modeOnlyDiff = [
      "diff --git a/script.sh b/script.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");
    const modeEvidence = evidenceIdFor(modeOnlyDiff, "script.sh");
    expect(() =>
      verifyRoundReportEvidence({
        board: board([
          outcome("mode-outcome", "addressed", "ask-auth", { evidenceIds: [modeEvidence] }),
        ]),
        dispatchedAsks: [ask("ask-auth", "script.sh")],
        expectedPatchsetId: "ps-successor",
        diff: modeOnlyDiff,
        changedPaths: ["script.sh"],
      }),
    ).not.toThrow();
  });

  it("accepts a derived anchor through a rename alias", () => {
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
    const units = buildRoundEvidenceManifest(renameDiff);
    const renameUnit = units.find((unit) => unit.kind === "rename");
    const hunkUnit = units.find((unit) => unit.kind === "text-hunk");
    if (renameUnit === undefined || hunkUnit === undefined) {
      throw new Error("expected a rename and a hunk in the rename fixture");
    }
    expect(() =>
      verifyRoundReportEvidence({
        board: board([
          codeRef("renamed", "src/new.ts", 4),
          outcome("renamed-outcome", "addressed", "ask-auth", {
            ref: "renamed",
            evidenceIds: [renameUnit.id, hunkUnit.id],
          }),
        ]),
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
          outcome("large-outcome", "addressed", "ask-auth", {
            ref: "large",
            evidenceIds: [evidenceIdFor(largeDiff, "src/large.ts")],
          }),
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
        outcome("beyond-one", "beyond", "beyond:cache", {
          ref: "cache",
          evidenceIds: [cacheEvidence],
        }),
        outcome("beyond-two", "beyond", "beyond:cache", { evidenceIds: [authEvidence] }),
      ]),
    ).toThrow("repeats beyond-ask reference beyond:cache");
    expect(() =>
      verify([
        outcome("ask", "untouched", "ask-auth"),
        codeRef("auth", "src/auth.ts", 9),
        outcome("mislabelled", "beyond", "ask-auth", {
          ref: "auth",
          evidenceIds: [authEvidence, cacheEvidence],
        }),
      ]),
    ).toThrow("marks dispatched ask ask-auth as beyond");
  });
});
