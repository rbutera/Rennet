import type { Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createRennetStore } from "../store";
import { modeHasExits, resolveEntryMode, selectLivingDraft } from "./handoff-data";

const postTarget: NonNullable<Review["postTarget"]> = {
  repo: { forge: "github", owner: "o", name: "r" },
  number: 1,
  forgeRef: "PR_node",
  headOid: "deadbeef",
};

describe("handoff/handoff-data", () => {
  describe("resolveEntryMode", () => {
    it("resolves a teammate PR from a present post-target", () => {
      expect(resolveEntryMode({ postTarget })).toBe("teammate-pr");
    });

    it("resolves your own branch when there is no post-target", () => {
      expect(resolveEntryMode({})).toBe("own-branch");
    });

    it("resolves retrospective, which wins over any post-target and offers no exits", () => {
      expect(resolveEntryMode({ retrospective: true })).toBe("retrospective");
      expect(resolveEntryMode({ retrospective: true, postTarget })).toBe("retrospective");
      expect(modeHasExits("retrospective")).toBe(false);
      expect(modeHasExits("teammate-pr")).toBe(true);
      expect(modeHasExits("own-branch")).toBe(true);
    });
  });

  describe("selectLivingDraft", () => {
    it("orders body asks and groups line comments by file path", () => {
      const store = createRennetStore();
      const { reviewActions } = store.getState();
      reviewActions.stageAsk({ anchor: "the opener prose", type: "comment", body: "opener" });
      reviewActions.stageAsk({ anchor: "src/a.ts:3", type: "request-change", body: "one" });
      reviewActions.stageAsk({ anchor: "src/b.ts:9", type: "comment", body: "two" });
      reviewActions.stageAsk({ anchor: "src/a.ts:20", type: "comment", body: "three" });

      const draft = selectLivingDraft(store.getState());
      expect(draft.body.map((a) => a.body)).toEqual(["opener"]);
      expect(draft.lineGroups.map((g) => g.path)).toEqual(["src/a.ts", "src/b.ts"]);
      const aGroup = draft.lineGroups.find((g) => g.path === "src/a.ts");
      expect(aGroup?.comments.map((c) => c.line)).toEqual([3, 20]);
    });

    it("is empty for a clean review", () => {
      const store = createRennetStore();
      expect(selectLivingDraft(store.getState())).toEqual({ body: [], lineGroups: [] });
    });
  });
});
