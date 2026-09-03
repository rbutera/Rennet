import type { AskProjection, LensBoard } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { inlineContextViolation } from "./harness-run-turn";
import {
  buildReviewOpenerContext,
  buildReviewOpenerPrompt,
  draftReviewOpener,
  type ReviewOpenerDraftInput,
  reviewOpenerContextFiles,
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

  it("NAMES the context files and carries no fact inline (session-context-files 3.7)", () => {
    const prompt = buildReviewOpenerPrompt("review-7");
    // The paths, relative to the turn's cwd, which is the session's bound root.
    expect(prompt).toContain(".rennet/context/review-7/opener/voice-rules.md");
    expect(prompt).toContain(".rennet/context/review-7/opener/review-facts.json");
    expect(prompt).toContain(".rennet/context/review-7/opener/asks.json");
    expect(prompt).toContain(".rennet/context/review-7/opener/dispositions.json");
    expect(prompt).toContain(".rennet/context/review-7/opener/boards/");
    expect(prompt).toContain(".rennet/context/review-7/README.md");
    // The instructions survive; the material does not travel with them.
    expect(prompt).toContain("Do not claim the reviewer viewed or walked every section");
    expect(prompt).not.toContain("REQUEST_CHANGES");
    expect(prompt).not.toContain("Do not retry an unknown outcome.");
    expect(prompt).not.toContain("An ambiguous send must not be retried blindly.");
    // The mechanical rule, on the same reading the send tap applies.
    expect(inlineContextViolation(prompt)).toBeUndefined();
  });

  it("writes the boards per lens, the asks, the dismissals, the facts and the voice rules", () => {
    const files = reviewOpenerContextFiles(input(), "Write in the reviewer's own voice.");
    const byName = new Map(files.map((entry) => [entry.name, entry]));

    // The board splits per lens, so the seat can open the one it is writing about.
    const board = byName.get("opener/boards/design.json");
    expect(JSON.parse(board?.body ?? "null")).toMatchObject({
      lens: "design",
      document: { title: "Design" },
      sections: [{ title: "Retry ownership", gist: expect.any(String) }],
    });

    // The asks and line comments, verbatim, in one file.
    expect(JSON.parse(byName.get("opener/asks.json")?.body ?? "null")).toEqual({
      stagedAsks: [
        expect.objectContaining({ id: "ask-a", body: "Do not retry an unknown outcome." }),
        expect.objectContaining({ id: "ask-b", body: "Keep this visible." }),
      ],
      lineComments: [
        { path: "src/a.ts", line: 3, body: "Name the invariant." },
        { path: "src/z.ts", line: 8, body: "Extract this." },
      ],
    });

    // The dismissed finding resolves to its concern and severity.
    expect(JSON.parse(byName.get("opener/dispositions.json")?.body ?? "null")).toEqual([
      expect.objectContaining({
        concern: "An ambiguous send must not be retried blindly.",
        severity: "high",
      }),
    ]);

    expect(JSON.parse(byName.get("opener/review-facts.json")?.body ?? "null")).toEqual({
      verdict: "REQUEST_CHANGES",
      changedPaths: ["src/retry.ts", "src/z.ts"],
    });

    // The voice rules live inside the installed prompts bundle, which the seat's cwd
    // cannot reach — so they travel as a file, not as a prompt layer.
    expect(byName.get("opener/voice-rules.md")?.body).toBe("Write in the reviewer's own voice.");

    // Every file carries the two index lines a reader who has never seen Rennet needs.
    for (const entry of files) {
      expect(entry.holds.length).toBeGreaterThan(10);
      expect(entry.readWhen.length).toBeGreaterThan(5);
    }
  });
});

describe("draftReviewOpener", () => {
  it("trims emitted prose and reports the model that actually ran", async () => {
    await expect(
      draftReviewOpener(
        "review-7",
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
        "review-7",
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
        "review-7",
        async () => ({ status: "unavailable", reason: "no seat" }),
        "gpt-5.6-luna",
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "no seat" });
    await expect(
      draftReviewOpener(
        "review-7",
        async () => ({ status: "failed", reason: "turn failed" }),
        "gpt-5.6-luna",
      ),
    ).resolves.toEqual({ status: "failed", reason: "turn failed" });
  });
});
