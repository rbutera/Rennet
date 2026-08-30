import { type AskProjection, findingRefKey } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
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
      store
        .getState()
        .reviewActions.stageAsk({ id: "a1", anchor: "a1", type: "comment", body: "x" });
      expect(selectStagedAskCount(store.getState())).toBe(1);
      store.getState().reviewActions.setCodeComment("src/a.ts", 12, "note");
      expect(selectCodeComment("src/a.ts", 12)(store.getState())).toBe("note");
      store.getState().reviewActions.unstageAsk("a1");
      expect(selectStagedAskCount(store.getState())).toBe(0);
      store.getState().reviewActions.clearCodeComment("src/a.ts", 12);
      expect(selectCodeComment("src/a.ts", 12)(store.getState())).toBeUndefined();
    });

    it("two asks on the SAME anchor coexist — identity is the id, not the anchor (finding 6)", () => {
      const store = createRennetStore();
      const a = store.getState().reviewActions;
      // Two distinct intents sharing one anchor (a board finding and a manual line comment on the
      // same line). Anchor-keyed, the second overwrote the first; id-keyed, both stand.
      a.stageAsk({
        id: "finding-7",
        anchor: "src/a.ts:5",
        type: "request-change",
        body: "guard it",
      });
      a.stageAsk({
        id: "src/a.ts:5",
        anchor: "src/a.ts:5",
        type: "comment",
        body: "also note this",
      });
      expect(selectStagedAskCount(store.getState())).toBe(2);
      const bodies = Object.values(store.getState().review.stagedAsks).map((x) => x.body);
      expect(bodies).toContain("guard it");
      expect(bodies).toContain("also note this");
    });

    it("a deleted ask's durable edit never haunts a later ask at the same anchor", () => {
      const store = createRennetStore();
      const a = store.getState().reviewActions;
      a.stageAsk({ id: "src/a.ts:5", anchor: "src/a.ts:5", type: "request-change", body: "orig" });
      a.editAsk("src/a.ts:5", "MY EDIT");
      expect(store.getState().review.stagedAsks["src/a.ts:5"]?.body).toBe("MY EDIT");
      a.retire(
        { id: "src/a.ts:5", anchor: "src/a.ts:5", type: "request-change", body: "MY EDIT" },
        "deleted",
      );
      a.unstageAsk("src/a.ts:5");
      a.stageAsk({
        id: "src/a.ts:5",
        anchor: "src/a.ts:5",
        type: "request-change",
        body: "brand new",
      });
      expect(store.getState().review.stagedAsks["src/a.ts:5"]?.body).toBe("brand new");
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

    it("mints around a persisted quote-thread id after hydration", () => {
      const ids: `${string}-${string}-${string}-${string}-${string}`[] = [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ];
      const randomUUID = vi
        .spyOn(crypto, "randomUUID")
        .mockImplementation(() => ids.shift() ?? "00000000-0000-4000-8000-000000000003");
      const store = createRennetStore();
      const actions = store.getState().reviewActions;
      const first = actions.addQuoteComment("probe", "probe");
      const numeric = /^qt-(\d+)$/.exec(first);
      const persistedId = numeric === null ? first : `qt-${Number(numeric[1]) + 1}`;
      const projection: AskProjection = {
        stagedAsks: {},
        findingDispositions: {},
        lineComments: {},
        quoteThreads: {
          [persistedId]: {
            anchor: "persisted passage",
            messages: [{ author: "user", text: "persisted question" }],
          },
        },
        retired: {},
        verdictOverride: null,
      };

      actions.resetReview();
      actions.hydrateAsks(projection);
      const mintedId = actions.addQuoteComment("new passage", "new question");

      expect(mintedId).not.toBe(persistedId);
      expect(store.getState().review.quoteThreads[persistedId]?.messages[0]?.text).toBe(
        "persisted question",
      );
      expect(Object.keys(store.getState().review.quoteThreads)).toHaveLength(2);
      randomUUID.mockRestore();
    });

    it("writes reversible finding dispositions and restores them from hydration", () => {
      const store = createRennetStore();
      const writes: { name: string; input: unknown }[] = [];
      const actions = store.getState().reviewActions;
      actions.setAskWriter((name, input) => writes.push({ name, input }));
      const finding = { generation: "gen-1", boardId: "board:flagged:1", findingId: "f-1" };
      const key = findingRefKey(finding);

      actions.dismissFinding(finding);
      expect(store.getState().review.findingDispositions[key]).toEqual({
        finding,
        disposition: "dismissed",
      });
      actions.restoreFinding(finding);
      expect(store.getState().review.findingDispositions[key]).toBeUndefined();
      expect(writes).toEqual([
        { name: "ask.dismissFinding", input: { finding } },
        { name: "ask.restoreFinding", input: { finding } },
      ]);

      actions.resetReview();
      actions.hydrateAsks({
        stagedAsks: {},
        findingDispositions: {
          [key]: { finding, disposition: "dismissed" },
        },
        lineComments: {},
        quoteThreads: {},
        retired: {},
        verdictOverride: null,
      });
      expect(store.getState().review.findingDispositions[key]?.finding).toEqual(finding);
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
      a.stageAsk({ id: "src/x.ts:3", anchor: "src/x.ts:3", type: "request-change", body: "fix" });
      a.setCodeComment("src/x.ts", 3, "note");
      a.retire(
        { id: "ask-old", anchor: "ask-old", type: "comment", body: "old note" },
        "dropped by you",
      );
      a.setVerdictOverride("REQUEST_CHANGES");
      a.editAsk("src/x.ts:3", "draft text");
      a.setFocusedThread("qt-existing");
      const seeded = store.getState().review;
      const snapshot = {
        stagedAsks: seeded.stagedAsks,
        codeComments: seeded.codeComments,
        retired: seeded.retired,
        verdictOverride: seeded.verdictOverride,
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
    first.getState().reviewActions.stageAsk({ id: "a1", anchor: "a1", type: "comment", body: "x" });
    first.getState().runActions.setRoundProgress(0.9);
    // A brand-new store (the "reload") shares NO state with the first — no persist.
    const second = createRennetStore();
    expect(second.getState().ui.sidebarOpen).toBe(true);
    expect(selectStagedAskCount(second.getState())).toBe(0);
    expect(second.getState().run.roundProgress).toBeNull();
  });

  it("derive-don't-store: the staged-ask count is computed, unmoved by unrelated actions", () => {
    const store = createRennetStore();
    store.getState().reviewActions.stageAsk({ id: "a1", anchor: "a1", type: "comment", body: "x" });
    store
      .getState()
      .reviewActions.stageAsk({ id: "a2", anchor: "a2", type: "question", body: "y" });
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
