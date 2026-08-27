import { describe, expect, it } from "vitest";
import { createRennetStore } from "../store";
import {
  parseLineAnchor,
  selectBodyVsLineAsks,
  selectExitPipCount,
  selectProposedVerdict,
  selectVerdictArithmetic,
} from "./selectors";

describe("handoff/selectors", () => {
  describe("parseLineAnchor", () => {
    it("reads a path:line code anchor and rejects a prose span", () => {
      expect(parseLineAnchor("src/store.ts:42")).toEqual({ path: "src/store.ts", line: 42 });
      expect(parseLineAnchor("This holds up.")).toBeNull();
    });
  });

  describe("selectExitPipCount", () => {
    it("sums staged asks, unclaimed line comments, and unclaimed quote threads", () => {
      const store = createRennetStore();
      const { reviewActions } = store.getState();
      reviewActions.stageAsk({
        id: "the prose span",
        anchor: "the prose span",
        type: "comment",
        body: "a note",
      });
      reviewActions.setCodeComment("src/a.ts", 3, "inline note");
      reviewActions.addQuoteComment("some span", "a thought", "comment");
      // 1 ask + 1 line comment + 1 thread
      expect(selectExitPipCount(store.getState())).toBe(3);
    });

    it("counts a claimed thread ONCE via its ask (the highlight request-change rule)", () => {
      const store = createRennetStore();
      const { reviewActions } = store.getState();
      const threadId = reviewActions.addQuoteComment("highlighted span", "fix this", "comment");
      reviewActions.stageAsk({
        id: threadId,
        anchor: "highlighted span",
        type: "request-change",
        body: "fix this",
        threadId,
      });
      // The ask claims the thread — counted once, not twice. (Positive control 9.3:
      // remove the claim rule and this becomes 2.)
      expect(selectExitPipCount(store.getState())).toBe(1);
    });

    it("counts a code comment ONCE when a staged ask claims its path:line", () => {
      const store = createRennetStore();
      const { reviewActions } = store.getState();
      reviewActions.setCodeComment("src/a.ts", 12, "note");
      reviewActions.stageAsk({
        id: "src/a.ts:12",
        anchor: "src/a.ts:12",
        type: "request-change",
        body: "note",
      });
      expect(selectExitPipCount(store.getState())).toBe(1);
    });

    it("the DUAL-CLAIM rule: one ask claiming both a thread and a code anchor counts once (finding 8)", () => {
      // An ask that names BOTH a quote thread (threadId) AND a code position (its path:line anchor),
      // with a matching thread and a matching code comment present. The ask claims both sources and
      // counts once — it is ONE thing the reviewer wants, not three. This is the intended rule, not
      // a miscount: 1 ask + 0 unclaimed threads + 0 unclaimed comments = 1.
      const store = createRennetStore();
      const { reviewActions } = store.getState();
      const threadId = reviewActions.addQuoteComment("some span", "look here", "comment");
      reviewActions.setCodeComment("src/a.ts", 5, "and here");
      reviewActions.stageAsk({
        id: "dual",
        anchor: "src/a.ts:5",
        type: "request-change",
        body: "one intent, two anchors",
        threadId,
      });
      expect(selectExitPipCount(store.getState())).toBe(1);
    });

    it("excludes Explain threads from the count", () => {
      const store = createRennetStore();
      const { reviewActions } = store.getState();
      reviewActions.addQuoteComment("a span", "why here?", "explain");
      expect(selectExitPipCount(store.getState())).toBe(0);
    });

    it("decrements when a staged ask is undone", () => {
      const store = createRennetStore();
      const { reviewActions } = store.getState();
      reviewActions.stageAsk({ id: "a1", anchor: "a1", type: "comment", body: "x" });
      expect(selectExitPipCount(store.getState())).toBe(1);
      reviewActions.unstageAsk("a1");
      expect(selectExitPipCount(store.getState())).toBe(0);
    });
  });

  describe("verdict arithmetic", () => {
    it("proposes Approve when nothing is staged", () => {
      const store = createRennetStore();
      expect(selectVerdictArithmetic(store.getState())).toEqual({
        proposed: "APPROVE",
        requestChanges: 0,
        comments: 0,
      });
      expect(selectProposedVerdict(store.getState())).toBe("APPROVE");
    });

    it("proposes Comment when only non-request-change asks are staged", () => {
      const store = createRennetStore();
      store
        .getState()
        .reviewActions.stageAsk({ id: "a1", anchor: "a1", type: "comment", body: "x" });
      store
        .getState()
        .reviewActions.stageAsk({ id: "a2", anchor: "a2", type: "question", body: "y" });
      expect(selectVerdictArithmetic(store.getState())).toEqual({
        proposed: "COMMENT",
        requestChanges: 0,
        comments: 2,
      });
    });

    it("proposes Request Changes when any request-change ask is staged", () => {
      const store = createRennetStore();
      store
        .getState()
        .reviewActions.stageAsk({ id: "a1", anchor: "a1", type: "comment", body: "x" });
      store
        .getState()
        .reviewActions.stageAsk({ id: "a2", anchor: "a2", type: "request-change", body: "y" });
      expect(selectVerdictArithmetic(store.getState())).toEqual({
        proposed: "REQUEST_CHANGES",
        requestChanges: 1,
        comments: 1,
      });
    });
  });

  describe("selectBodyVsLineAsks", () => {
    it("routes a code anchor to line comments and a prose anchor to the body", () => {
      const store = createRennetStore();
      const { reviewActions } = store.getState();
      reviewActions.stageAsk({
        id: "the opener prose",
        anchor: "the opener prose",
        type: "comment",
        body: "b",
      });
      reviewActions.stageAsk({
        id: "src/a.ts:12",
        anchor: "src/a.ts:12",
        type: "request-change",
        body: "l",
      });
      const { body, line } = selectBodyVsLineAsks(store.getState());
      expect(body.map((a) => a.anchor)).toEqual(["the opener prose"]);
      expect(line.map((a) => a.anchor)).toEqual(["src/a.ts:12"]);
    });
  });
});
