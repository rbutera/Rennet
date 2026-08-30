import type { CommandOutput, Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createRennetStore } from "../store";
import {
  composeReviewDraft,
  modeHasExits,
  resolveEntryMode,
  selectLivingDraft,
} from "./handoff-data";

const postTarget: NonNullable<Review["postTarget"]> = {
  repo: { forge: "github", owner: "o", name: "r" },
  number: 1,
  forgeRef: "PR_node",
  headOid: "deadbeef",
};

describe("handoff/handoff-data", () => {
  describe("resolveEntryMode", () => {
    it("resolves a teammate PR from a present post-target the viewer did NOT author", () => {
      expect(resolveEntryMode({ postTarget })).toBe("teammate-pr"); // absent ⇒ teammate (legacy-safe)
      expect(resolveEntryMode({ postTarget: { ...postTarget, viewerDidAuthor: false } })).toBe(
        "teammate-pr",
      );
    });

    it("resolves your OWN branch for a post-target the viewer authored — never Post-review", () => {
      // The C14 §6 fix: an OWN pull request carries an ownership fact, so it routes the
      // own-branch lane (Continue / rounds), NOT the teammate Post-review lane. If the
      // `viewerDidAuthor` branch is removed, this reddens (the mode falls back to teammate-pr).
      const mode = resolveEntryMode({ postTarget: { ...postTarget, viewerDidAuthor: true } });
      expect(mode).toBe("own-branch");
      expect(mode).not.toBe("teammate-pr");
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
      reviewActions.stageAsk({
        id: "the opener prose",
        anchor: "the opener prose",
        type: "comment",
        body: "opener",
      });
      reviewActions.stageAsk({
        id: "src/a.ts:3",
        anchor: "src/a.ts:3",
        type: "request-change",
        body: "one",
      });
      reviewActions.stageAsk({
        id: "src/b.ts:9",
        anchor: "src/b.ts:9",
        type: "comment",
        body: "two",
      });
      reviewActions.stageAsk({
        id: "src/a.ts:20",
        anchor: "src/a.ts:20",
        type: "comment",
        body: "three",
      });

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

    it("uses canonical side-qualified positions before legacy anchors", () => {
      const store = createRennetStore();
      const { stageAsk } = store.getState().reviewActions;
      stageAsk({
        id: "base",
        anchor: "src/wrong.ts:999",
        type: "request-change",
        body: "base concern",
        side: "RIGHT",
        codeRef: {
          patchsetId: "patchset-1",
          path: "src/shared.ts",
          side: "base",
          startLine: 7,
          endLine: 9,
        },
      });
      stageAsk({
        id: "head",
        anchor: "src/wrong.ts:999",
        type: "comment",
        body: "head concern",
        codeRef: {
          patchsetId: "patchset-1",
          path: "src/shared.ts",
          side: "head",
          startLine: 7,
          endLine: 7,
        },
      });

      const draft = selectLivingDraft(store.getState());
      expect(draft.lineGroups).toHaveLength(1);
      expect(
        draft.lineGroups[0]?.comments.map(({ path, line, side }) => ({ path, line, side })),
      ).toEqual([
        { path: "src/shared.ts", line: 7, side: "LEFT" },
        { path: "src/shared.ts", line: 7, side: "RIGHT" },
      ]);
    });
  });

  it("carries the artifact, exact post descriptor, and ledger onto the signing draft", () => {
    const composed: Extract<CommandOutput<"publish.compose">, { status: "review" }> = {
      status: "review",
      artifact: {
        opener: "The review opener, byte preserved.",
        comments: [],
        bodyNotes: [
          {
            id: "ask-overall",
            anchor: "Design · Retry policy",
            type: "comment",
            body: "the policy matches its documented boundary",
          },
        ],
      },
      post: {
        event: "COMMENT",
        body: "The exact daemon-built review body.",
        threads: [],
      },
      ledger: [
        {
          kind: "body-note",
          path: "Design · Retry policy",
          detail: "Included in the review body.",
        },
      ],
      payload: "canonical-review-bytes",
      destination: "acme/orbital#7",
      title: "acme/orbital#7",
      compositionId: "composition-1",
    };

    const draft = composeReviewDraft(composed);
    expect(draft.artifact).toBe(composed.artifact);
    expect(draft.post).toBe(composed.post);
    expect(draft.ledger).toBe(composed.ledger);
  });

  it("counts request-change and non-request review-body notes in verdict arithmetic", () => {
    const composed: Extract<CommandOutput<"publish.compose">, { status: "review" }> = {
      status: "review",
      artifact: {
        opener: "The review opener.",
        comments: [],
        bodyNotes: [
          {
            id: "ask-blocking",
            anchor: "Correctness · Retry policy",
            type: "request-change",
            body: "bound the retry loop",
          },
          {
            id: "ask-question",
            anchor: "Design · Retry policy",
            type: "question",
            body: "what owns the retry budget?",
          },
        ],
      },
      post: { event: "REQUEST_CHANGES", body: "Exact body.", threads: [] },
      ledger: [],
      payload: "canonical-review-bytes",
      destination: "acme/orbital#7",
      title: "acme/orbital#7",
      compositionId: "composition-1",
    };

    const draft = composeReviewDraft(composed);

    expect(draft.proposed).toBe("REQUEST_CHANGES");
    expect(draft.arithmetic).toEqual({ requestChanges: 1, comments: 1 });
  });

  it("preserves an approval descriptor with zero asks", () => {
    const composed: Extract<CommandOutput<"publish.compose">, { status: "review" }> = {
      status: "review",
      artifact: { opener: "Ship it exactly as written.", comments: [], bodyNotes: [] },
      post: {
        event: "APPROVE",
        body: "Ship it exactly as written.\n\n<!-- rennet:review:zero-asks -->",
        threads: [],
      },
      ledger: [],
      payload: "canonical-zero-ask-approval",
      destination: "acme/orbital#7",
      title: "acme/orbital#7",
      compositionId: "composition-approval",
    };

    const draft = composeReviewDraft(composed);

    expect(draft.post).toBe(composed.post);
    expect(draft.post.event).toBe("APPROVE");
    expect(draft.post.threads).toEqual([]);
    expect(draft.proposed).toBe("APPROVE");
    expect(draft.arithmetic).toEqual({ requestChanges: 0, comments: 0 });
  });
});
