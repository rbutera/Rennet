// @vitest-environment happy-dom

import type { RennetBridge } from "@rennet/protocol";
import type { FlaggedReview, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { act, fireEvent, mount } from "./test/dom";

async function flush(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

const review: Review = {
  id: "review",
  repositoryRoot: "/code/rennet",
  activePatchsetId: "patch-one",
  dispositions: [],
  status: "current",
  patchsets: [
    {
      id: "patch-one",
      createdAt: "2026-08-17T00:00:00.000Z",
      repository: {
        id: "repository",
        root: "/code/rennet",
        commonDir: "/code/rennet/.git",
        baseRef: "main",
        baseOid: "1".repeat(40),
        headOid: "2".repeat(40),
      },
      files: [
        {
          path: "src/loop.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          binary: false,
          patch: "-i < items.length\n+i <= items.length",
        },
      ],
      rawDiff: "-i < items.length\n+i <= items.length",
      byteLength: 39,
      truncated: false,
    },
  ],
};

const pending: FlaggedReview = {
  status: "ok",
  patchsetId: review.activePatchsetId,
  findings: [
    {
      findingId: "f1",
      anchor: "rennet:hunk/h1",
      summary: "the loop overruns the array",
      severity: "high",
      agreement: {
        kind: "disagree",
        answers: [
          { model: "Claude", answer: "the <= condition overruns the array" },
          { model: "Codex", answer: "no concern raised here" },
        ],
      },
    },
  ],
};

describe("RennetApp — late adjudication enrichment (#41)", () => {
  it("renders pending rows immediately and applies the keyed enrichment later", async () => {
    const pendingFinding = pending.findings[0];
    if (!pendingFinding) throw new Error("expected pending finding");
    let resolveRead: ((value: { status: "complete"; review: FlaggedReview }) => void) | undefined;
    const adjudicationRead = new Promise<{ status: "complete"; review: FlaggedReview }>(
      (resolve) => {
        resolveRead = resolve;
      },
    );
    const invoke = async (name: string): Promise<unknown> => {
      switch (name) {
        case "app.bootstrap":
          return { review: structuredClone(review), repositoryPresent: true };
        case "review.checkFreshness":
          return { review: structuredClone(review) };
        case "review.canvases":
          return { canvases: demoCanvases(), elementDiffs: {} };
        case "flagged.review":
          return pending;
        case "flagged.adjudication":
          return adjudicationRead;
        case "noise.review":
          return { status: "ok", groups: [] };
        default:
          return {};
      }
    };
    const bridge: RennetBridge = {
      invoke: invoke as unknown as RennetBridge["invoke"],
    };

    let handle!: ReturnType<typeof mount>;
    await act(async () => {
      handle = mount(<RennetApp bridge={bridge} />);
      await flush();
    });
    await act(async () => {
      fireEvent.click(handle.getByRole("tab", { name: "Flagged" }));
      await flush();
    });

    expect(handle.container.textContent).toContain("the loop overruns the array");
    expect(handle.container.querySelector("[data-adjudication]")).toBeNull();
    expect(resolveRead).toBeDefined();

    await act(async () => {
      resolveRead?.({
        status: "complete",
        review: {
          ...pending,
          findings: [
            {
              ...pendingFinding,
              agreement: {
                kind: "disagree",
                answers: [
                  { model: "Claude", answer: "the <= condition overruns the array" },
                  { model: "Codex", answer: "no concern raised here" },
                ],
                adjudication: {
                  verdict: "supported",
                  evidence: "line 4 reads items[items.length]",
                  adjudicatedBy: "opus-4.8 (claude-code)",
                },
              },
            },
          ],
        },
      });
      await flush();
    });

    expect(handle.container.querySelector('[data-adjudication="supported"]')).not.toBeNull();
    expect(handle.container.textContent).toContain("line 4 reads items[items.length]");
  });

  it("polls scheduled verify-ui enrichment for an all-concur empty review", async () => {
    const immediate: FlaggedReview = {
      status: "ok",
      findings: [],
      patchsetId: review.activePatchsetId,
      uiVerification: { status: "pending", classifierVersion: 1 },
      lateEnrichmentScheduled: true,
    };
    let resolveRead: ((value: { status: "complete"; review: FlaggedReview }) => void) | undefined;
    const lateRead = new Promise<{ status: "complete"; review: FlaggedReview }>((resolve) => {
      resolveRead = resolve;
    });
    let lateReads = 0;
    const invoke = async (name: string): Promise<unknown> => {
      switch (name) {
        case "app.bootstrap":
          return { review: structuredClone(review), repositoryPresent: true };
        case "review.checkFreshness":
          return { review: structuredClone(review) };
        case "review.canvases":
          return { canvases: demoCanvases(), elementDiffs: {} };
        case "flagged.review":
          return immediate;
        case "flagged.adjudication":
          lateReads += 1;
          return lateRead;
        case "noise.review":
          return { status: "ok", groups: [] };
        default:
          return {};
      }
    };
    const bridge: RennetBridge = { invoke: invoke as unknown as RennetBridge["invoke"] };

    let handle!: ReturnType<typeof mount>;
    await act(async () => {
      handle = mount(<RennetApp bridge={bridge} />);
      await flush();
    });
    await act(async () => {
      fireEvent.click(handle.getByRole("tab", { name: "Flagged" }));
      await flush();
    });

    expect(handle.container.textContent).toContain("UI check still running");
    expect(handle.container.textContent).not.toContain("ran clean");
    expect(resolveRead).toBeDefined();
    expect(lateReads).toBe(1);

    await act(async () => {
      resolveRead?.({
        status: "complete",
        review: {
          status: "ok",
          findings: [],
          patchsetId: review.activePatchsetId,
          uiVerification: {
            status: "ran",
            classifierVersion: 1,
            mounted: false,
            observationCount: 0,
            screenshots: [],
          },
        },
      });
      await flush();
    });

    expect(handle.container.querySelector(".ui-verification-ran")).not.toBeNull();
    expect(handle.container.textContent).not.toContain("UI check still running");
  });
});
