import type { HostElement, RoundReportBoard } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { verifyRoundReportEvidence } from "./round-report-verification";

const author = { kind: "lens-agent" as const, id: "report-seat" };
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

function board(elements: readonly HostElement[]): RoundReportBoard {
  return {
    lens: "report",
    generation: "gen-successor",
    boardId: "report-board",
    document: { title: "Round report", introMarkdown: "Verified changes.", measure: "reading" },
    sections: [],
    elements: [...elements],
    skippedHunks: [],
  };
}

function verify(elements: readonly HostElement[], asks: readonly string[] = ["ask-auth"]): void {
  verifyRoundReportEvidence({
    board: board(elements),
    dispatchedAskIds: asks,
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
  });

  it("rejects a stale patchset identity even when the path and changed line match", () => {
    const stale = codeRef("stale", "src/auth.ts", 9);
    stale.data.patchset_id = "ps-before";
    expect(() =>
      verify([stale, outcome("stale-outcome", "addressed", "ask-auth", "stale")]),
    ).toThrow("cites patchset ps-before, not ps-successor");
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
        dispatchedAskIds: ["ask-auth"],
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
        dispatchedAskIds: ["ask-auth"],
        expectedPatchsetId: "ps-successor",
        diff: modeOnlyDiff,
        changedPaths: ["script.sh"],
      }),
    ).toThrow("has no line-addressable change");
  });

  it("accepts exact deletion-side evidence through a rename alias", () => {
    const renameDiff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 80%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -4,2 +4,1 @@",
      "-removed();",
      " keep",
      "",
    ].join("\n");
    const deleted = codeRef("deleted", "src/old.ts", 4);
    deleted.data.side = "base";
    expect(() =>
      verifyRoundReportEvidence({
        board: board([deleted, outcome("deleted-outcome", "addressed", "ask-auth", "deleted")]),
        dispatchedAskIds: ["ask-auth"],
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
        dispatchedAskIds: ["ask-auth"],
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
