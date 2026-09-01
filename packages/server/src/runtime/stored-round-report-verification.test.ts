import type { HostElement, RoundOperation } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  type StoredRoundReportVerificationDeps,
  verifyStoredRoundReport,
} from "./stored-round-report-verification";

const author = { kind: "lens-agent" as const, id: "round-report" };
const elements: HostElement[] = [
  {
    id: "rennet:host:round-report:section",
    kind: "section",
    data: {
      author,
      title: "Round outcomes",
      children: ["rennet:host:round-report:0:outcome"],
    },
  },
  {
    id: "rennet:host:round-report:0:code",
    kind: "code_ref",
    data: {
      author,
      patchset_id: "ps-successor",
      path: "src/auth.ts",
      side: "head",
      start_line: 2,
      end_line: 2,
    },
  },
  {
    id: "rennet:host:round-report:0:outcome",
    kind: "round_outcome",
    data: {
      author,
      status: "addressed",
      ask: { ref: "ask-auth", text: "Refresh auth" },
      note: "Refreshes auth on the successor.",
      code_ref: "rennet:host:round-report:0:code",
    },
  },
];
const operation = {
  reviewId: "review-1",
  sessionId: "session-1",
  repoRoot: "/repo",
  askOccurrences: [{ id: "ask-auth", revision: 1 }],
  state: {
    phase: "report-verifying",
    worker: {
      diff: [
        "diff --git a/src/auth.ts b/src/auth.ts",
        "--- a/src/auth.ts",
        "+++ b/src/auth.ts",
        "@@ -1,1 +1,2 @@",
        " keep",
        "+refresh();",
        "",
      ].join("\n"),
      changedPaths: ["src/auth.ts"],
    },
  },
} as unknown as RoundOperation;

function deps(activePatchsetId: string): StoredRoundReportVerificationDeps {
  return {
    reviewById: vi.fn(() => ({ activePatchsetId }) as never),
    loadGeneration: vi.fn(() => ({ id: "gen-successor", patchsetId: "ps-successor" }) as never),
    loadBoardElements: vi.fn(async () => elements),
    loadBoardMeta: vi.fn(
      () =>
        ({
          boardId: "report-board",
          lens: "report",
          session: "session-1",
          generation: "gen-successor",
          document: {
            title: "Round report",
            introMarkdown: "Verified against the coding turn: 1 addressed.",
            measure: "reading",
          },
          skippedHunks: [],
        }) as never,
    ),
    loadDispatchedAsks: vi.fn(() => [
      {
        id: "ask-auth",
        path: "src/auth.ts",
        type: "request-change" as const,
        instruction: "Refresh auth",
        context: "",
      },
    ]),
  };
}

describe("verifyStoredRoundReport", () => {
  it("requires the live successor identity before committing the report", async () => {
    await expect(
      verifyStoredRoundReport(deps("ps-later"), operation, {
        point: "precommit",
        reportBoardId: "report-board",
        generation: "gen-successor",
        expectedPatchsetId: "ps-successor",
      }),
    ).rejects.toThrow("lost its exact successor patchset");
  });

  it("recovers immutable persisted evidence after the live review advances", async () => {
    const advanced = deps("ps-later");
    await expect(
      verifyStoredRoundReport(advanced, operation, {
        point: "persisted",
        reportBoardId: "report-board",
        generation: "gen-successor",
        expectedPatchsetId: "ps-successor",
      }),
    ).resolves.toBeUndefined();
    expect(advanced.reviewById).not.toHaveBeenCalled();
    expect(advanced.loadGeneration).toHaveBeenCalledWith("gen-successor");
  });

  it("rejects schema-valid persisted elements the deterministic host builder cannot emit", async () => {
    const corrupted = {
      ...deps("ps-later"),
      loadBoardElements: vi.fn(async () => [
        ...elements,
        {
          id: "extra-prose",
          kind: "prose",
          data: { author, markdown: "A persisted classifier must not author board prose." },
        },
      ]),
    };

    await expect(
      verifyStoredRoundReport(corrupted, operation, {
        point: "persisted",
        reportBoardId: "report-board",
        generation: "gen-successor",
        expectedPatchsetId: "ps-successor",
      }),
    ).rejects.toThrow("only permits section, round_outcome, and code_ref elements");
  });
});
