import { describe, expect, it } from "vitest";
import {
  createRennetStore,
  selectCodeComment,
  selectDialogOpen,
  selectRoundRunning,
  selectRunningLaneCount,
  selectSignalAnimating,
  selectStagedAskCount,
} from "./index";

describe("rennet store", () => {
  describe("ui slice", () => {
    it("toggles sidebar and folds nodes", () => {
      const store = createRennetStore();
      expect(store.getState().ui.sidebarOpen).toBe(true);
      store.getState().uiActions.toggleSidebar();
      expect(store.getState().ui.sidebarOpen).toBe(false);
      store.getState().uiActions.toggleFold("node-a");
      expect(store.getState().ui.sidebarFolds["node-a"]).toBe(true);
    });

    it("opens the command menu with a mode; an omitted mode is search", () => {
      const store = createRennetStore();
      expect(store.getState().ui.commandMenuOpen).toBe(false);
      expect(store.getState().ui.commandMenuMode).toBe("search");
      // ⌘K opens command-first.
      store.getState().uiActions.setCommandMenuOpen(true, "command");
      expect(store.getState().ui.commandMenuOpen).toBe(true);
      expect(store.getState().ui.commandMenuMode).toBe("command");
      // The sidebar Search row (no mode) opens search-first.
      store.getState().uiActions.setCommandMenuOpen(true);
      expect(store.getState().ui.commandMenuMode).toBe("search");
      // The mode can also be set independently of open state.
      store.getState().uiActions.setCommandMenuMode("command");
      expect(store.getState().ui.commandMenuMode).toBe("command");
      store.getState().uiActions.setCommandMenuOpen(false);
      expect(store.getState().ui.commandMenuOpen).toBe(false);
    });

    it("tracks a dialog stack via the selector", () => {
      const store = createRennetStore();
      store.getState().uiActions.openDialog("settings");
      expect(selectDialogOpen("settings")(store.getState())).toBe(true);
      store.getState().uiActions.closeDialog("settings");
      expect(selectDialogOpen("settings")(store.getState())).toBe(false);
    });
  });

  describe("review slice", () => {
    it("stages and unstages asks; per-line comments", () => {
      const store = createRennetStore();
      store.getState().reviewActions.stageAsk({ anchor: "a1", type: "comment", body: "x" });
      expect(selectStagedAskCount(store.getState())).toBe(1);
      store.getState().reviewActions.setCodeComment("src/a.ts", 12, "note");
      expect(selectCodeComment("src/a.ts", 12)(store.getState())).toBe("note");
      store.getState().reviewActions.unstageAsk("a1");
      expect(selectStagedAskCount(store.getState())).toBe(0);
      store.getState().reviewActions.clearCodeComment("src/a.ts", 12);
      expect(selectCodeComment("src/a.ts", 12)(store.getState())).toBeUndefined();
    });

    it("mints quote threads, appends replies, and removes them; explain carries its kind", () => {
      const store = createRennetStore();
      const id = store
        .getState()
        .reviewActions.addQuoteComment("the quoted span", "why here?", "explain");
      expect(store.getState().review.quoteThreads[id]).toEqual({
        anchor: "the quoted span",
        kind: "explain",
        messages: [{ author: "user", text: "why here?" }],
      });
      store.getState().reviewActions.addQuoteReply(id, "orchestrator", "because X");
      expect(store.getState().review.quoteThreads[id]?.messages).toEqual([
        { author: "user", text: "why here?" },
        { author: "orchestrator", text: "because X" },
      ]);
      // A reply to a missing thread is a no-op, never a throw.
      store.getState().reviewActions.addQuoteReply("qt-nope", "user", "ignored");
      store.getState().reviewActions.removeQuoteComment(id);
      expect(store.getState().review.quoteThreads[id]).toBeUndefined();
    });

    it("a missing-thread reply is a proven no-op — review state is byte-identical", () => {
      const store = createRennetStore();
      store.getState().reviewActions.addQuoteComment("span", "opener");
      const before = store.getState().review;
      store.getState().reviewActions.addQuoteReply("qt-does-not-exist", "user", "dropped");
      // Same reference: the no-op never produced a new review object.
      expect(store.getState().review).toBe(before);
    });

    it("the new quote actions never disturb any pre-C04 review field (invariant)", () => {
      const store = createRennetStore();
      const a = store.getState().reviewActions;
      // Seed EVERY pre-C04 field with a distinct value.
      a.stageAsk({ anchor: "src/x.ts:3", type: "request-change", body: "fix" });
      a.setCodeComment("src/x.ts", 3, "note");
      a.retire({ anchor: "ask-old", type: "comment", body: "old note" }, "dropped by you");
      a.setVerdictOverride("REQUEST_CHANGES");
      a.setDraftEdit("pr-body", "draft text");
      a.setFocusedThread("qt-existing");
      const seeded = store.getState().review;
      const snapshot = {
        stagedAsks: seeded.stagedAsks,
        codeComments: seeded.codeComments,
        retired: seeded.retired,
        verdictOverride: seeded.verdictOverride,
        draftEdits: seeded.draftEdits,
        focusedThreadId: seeded.focusedThreadId,
      };
      // Exercise every NEW (C04) quote action.
      const id = a.addQuoteComment("quoted span", "opener", "comment");
      a.addQuoteReply(id, "orchestrator", "reply");
      a.removeQuoteComment(id);
      // Every pre-C04 field is untouched — same references, not merely equal values.
      const after = store.getState().review;
      expect(after.stagedAsks).toBe(snapshot.stagedAsks);
      expect(after.codeComments).toBe(snapshot.codeComments);
      expect(after.retired).toBe(snapshot.retired);
      expect(after.verdictOverride).toBe(snapshot.verdictOverride);
      expect(after.draftEdits).toBe(snapshot.draftEdits);
      expect(after.focusedThreadId).toBe(snapshot.focusedThreadId);
    });
  });

  describe("run slice", () => {
    it("derives running state from round progress and lane status", () => {
      const store = createRennetStore();
      expect(selectRoundRunning(store.getState())).toBe(false);
      store.getState().runActions.setRoundProgress(0.5);
      expect(selectRoundRunning(store.getState())).toBe(true);
      store.getState().runActions.setLaneStatus("lane-1", "running");
      store.getState().runActions.setLaneStatus("lane-2", "done");
      expect(selectRunningLaneCount(store.getState())).toBe(1);
    });
  });

  describe("signal slice", () => {
    it("batches pips in flight and landed", () => {
      const store = createRennetStore();
      store.getState().signalActions.launch(3);
      expect(selectSignalAnimating(store.getState())).toBe(true);
      store.getState().signalActions.land(3);
      expect(store.getState().signal.inFlight).toBe(0);
      expect(store.getState().signal.landed).toBe(3);
      store.getState().signalActions.clearLanded();
      expect(store.getState().signal.landed).toBe(0);
    });
  });

  it("reload semantics: a fresh store is clean, nothing rehydrated", () => {
    const first = createRennetStore();
    first.getState().uiActions.toggleSidebar();
    first.getState().reviewActions.stageAsk({ anchor: "a1", type: "comment", body: "x" });
    first.getState().runActions.setRoundProgress(0.9);
    // A brand-new store (the "reload") shares NO state with the first — no persist.
    const second = createRennetStore();
    expect(second.getState().ui.sidebarOpen).toBe(true);
    expect(selectStagedAskCount(second.getState())).toBe(0);
    expect(second.getState().run.roundProgress).toBeNull();
  });

  it("derive-don't-store: the staged-ask count is computed, unmoved by unrelated actions", () => {
    const store = createRennetStore();
    store.getState().reviewActions.stageAsk({ anchor: "a1", type: "comment", body: "x" });
    store.getState().reviewActions.stageAsk({ anchor: "a2", type: "question", body: "y" });
    const before = selectStagedAskCount(store.getState());
    // Arbitrary unrelated mutations across other slices must not move a DERIVED count.
    store.getState().uiActions.toggleSidebar();
    store.getState().uiActions.setChatWidth(500);
    store.getState().runActions.armGreeting(true);
    store.getState().signalActions.launch(2);
    const after = selectStagedAskCount(store.getState());
    expect(after).toBe(before);
    expect(after).toBe(Object.keys(store.getState().review.stagedAsks).length);
  });
});
