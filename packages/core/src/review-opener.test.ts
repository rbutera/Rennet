import type { AskProjection, LensBoard } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  buildReviewOpenerContext,
  buildReviewOpenerPrompt,
  draftReviewOpener,
  type ReviewOpenerDraftInput,
  reviewOpenerSourceId,
} from "./review-opener";

const author = { kind: "lens-agent" as const, id: "design" };
const designBoard: LensBoard = {
  lens: "design",
  generation: "gen:patch-1",
  boardId: "board-design",
  document: {
    title: "Design",
    introMarkdown: "The retry boundary owns ambiguous sends.",
    measure: "structured",
  },
  sections: [
    {
      ref: "retry-ownership",
      gist: "The transport is the single owner of replay-safe retry.",
      counts: { findings: 1, decisions: 1 },
    },
  ],
  elements: [
    {
      id: "retry-ownership",
      kind: "section",
      data: { author, title: "Retry ownership", children: ["finding-1"] },
    },
    {
      id: "finding-1",
      kind: "finding",
      data: {
        author,
        severity: "high",
        concern: "An ambiguous send must not be retried blindly.",
        code: [],
        concurrence: [],
        status: "dismissed",
      },
    },
  ],
};

function projection(reverse = false): AskProjection {
  const asks = [
    [
      "ask-b",
      {
        id: "ask-b",
        anchor: "Design · retry",
        type: "comment" as const,
        body: "Keep this visible.",
      },
    ],
    [
      "ask-a",
      {
        id: "ask-a",
        anchor: "src/retry.ts:42",
        type: "request-change" as const,
        body: "Do not retry an unknown outcome.",
      },
    ],
  ] as const;
  const ordered = reverse ? [...asks].reverse() : asks;
  return {
    stagedAsks: Object.fromEntries(ordered),
    findingDispositions: {
      dismissed: {
        finding: {
          generation: designBoard.generation,
          boardId: designBoard.boardId,
          findingId: "finding-1",
        },
        disposition: "dismissed",
      },
    },
    lineComments: reverse
      ? { "src/z.ts": { "8": "Extract this." }, "src/a.ts": { "3": "Name the invariant." } }
      : { "src/a.ts": { "3": "Name the invariant." }, "src/z.ts": { "8": "Extract this." } },
    quoteThreads: {},
    retired: {},
    verdictOverride: null,
  };
}

function input(reverse = false): ReviewOpenerDraftInput {
  return {
    verdict: "REQUEST_CHANGES",
    boards: reverse ? [designBoard] : [designBoard],
    projection: projection(reverse),
    changedPaths: reverse ? ["src/z.ts", "src/retry.ts"] : ["src/retry.ts", "src/z.ts"],
  };
}

describe("review opener context", () => {
  it("carries the verdict, active board facts, durable asks, line comments, and resolved dismissals", () => {
    const context = buildReviewOpenerContext(input());
    expect(context.verdict).toBe("REQUEST_CHANGES");
    expect(context.boards[0]).toMatchObject({
      lens: "design",
      document: { title: "Design" },
      sections: [
        {
          title: "Retry ownership",
          gist: "The transport is the single owner of replay-safe retry.",
        },
      ],
    });
    expect(context.stagedAsks.map((ask) => ask.id)).toEqual(["ask-a", "ask-b"]);
    expect(context.lineComments.map(({ path, line }) => `${path}:${line}`)).toEqual([
      "src/a.ts:3",
      "src/z.ts:8",
    ]);
    expect(context.dismissedFindings[0]).toMatchObject({
      concern: "An ambiguous send must not be retried blindly.",
      severity: "high",
    });
  });

  it("has stable source identity across record and path insertion order", () => {
    expect(reviewOpenerSourceId("review-1", "patch-1", input())).toBe(
      reviewOpenerSourceId("review-1", "patch-1", input(true)),
    );
  });

  it("changes source identity when a verdict, ask, or persisted board fact changes", () => {
    const base = reviewOpenerSourceId("review-1", "patch-1", input());
    expect(
      reviewOpenerSourceId("review-1", "patch-1", { ...input(), verdict: "COMMENT" }),
    ).not.toBe(base);
    expect(
      reviewOpenerSourceId("review-1", "patch-1", {
        ...input(),
        projection: {
          ...projection(),
          stagedAsks: {
            ...projection().stagedAsks,
            "ask-a": {
              id: "ask-a",
              anchor: "src/retry.ts:42",
              type: "request-change",
              body: "Changed ask.",
            },
          },
        },
      }),
    ).not.toBe(base);
    expect(
      reviewOpenerSourceId("review-1", "patch-1", {
        ...input(),
        boards: [
          {
            ...designBoard,
            sections: designBoard.sections.map((section) => ({
              ...section,
              gist: "Changed persisted board gist.",
            })),
          },
        ],
      }),
    ).not.toBe(base);
  });

  it("layers the shared review voice with opener-specific rules and exact persisted facts", () => {
    const prompt = buildReviewOpenerPrompt(input(), "Write in the reviewer's own voice.");
    expect(prompt).toContain("Write in the reviewer's own voice.");
    expect(prompt).toContain("REQUEST_CHANGES");
    expect(prompt).toContain("Retry ownership");
    expect(prompt).toContain("Do not retry an unknown outcome.");
    expect(prompt).toContain("Name the invariant.");
    expect(prompt).toContain("An ambiguous send must not be retried blindly.");
    expect(prompt).toContain("Do not claim the reviewer viewed or walked every supplied section");
  });
});

describe("draftReviewOpener", () => {
  it("trims emitted prose and reports the model that actually ran", async () => {
    await expect(
      draftReviewOpener(
        input(),
        "voice",
        async () => ({
          status: "emitted",
          opener: "  The retry boundary still needs an outcome-unknown path.  ",
          model: "gpt-5.6-luna-runtime",
        }),
        "gpt-5.6-luna",
      ),
    ).resolves.toEqual({
      status: "drafted",
      opener: "The retry boundary still needs an outcome-unknown path.",
      model: "gpt-5.6-luna-runtime",
    });
  });

  it("fails honestly on a missing or blank opener", async () => {
    for (const opener of [undefined, "   "]) {
      const result = await draftReviewOpener(
        input(),
        "voice",
        async () => ({ status: "emitted", ...(opener === undefined ? {} : { opener }) }),
        "gpt-5.6-luna",
      );
      expect(result).toEqual({
        status: "failed",
        reason: "the review-opener drafter returned an empty opener",
        retryable: true,
      });
    }
  });

  it("preserves failed and unavailable turn outcomes without fabricating prose", async () => {
    await expect(
      draftReviewOpener(
        input(),
        "voice",
        async () => ({ status: "unavailable", reason: "no seat" }),
        "gpt-5.6-luna",
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "no seat" });
    await expect(
      draftReviewOpener(
        input(),
        "voice",
        async () => ({ status: "failed", reason: "turn failed" }),
        "gpt-5.6-luna",
      ),
    ).resolves.toEqual({ status: "failed", reason: "turn failed" });
  });
});
