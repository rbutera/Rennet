// @vitest-environment happy-dom
//
// The PR-body draft REGENERATE staleness trap (#74 HIGH: input-identity binding),
// proven end-to-end over the whole RennetApp. A regenerate activates a NEW patchset
// under the SAME review id — so a reviewId-keyed reset never fires. A draft turn
// started against patchset A, still in flight when B activates, must NOT land A's
// body on B. The fix binds the draft generation to `activePatchsetId` (via the
// drafting-input fingerprint): the patchset change bumps the generation, so A's turn
// is dropped on arrival. Red-provable against a build that omits the bump.
import type { CommandInput, CommandOutput, RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { act, fireEvent, mount } from "./test/dom";

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const enriched = { canvases: demoCanvases(), elementDiffs: {} };

function reviewAt(patchsetId: string): Review {
  return {
    id: "review",
    repositoryRoot: "/code/rennet",
    activePatchsetId: patchsetId,
    dispositions: [],
    status: "current",
    patchsets: [
      {
        id: patchsetId,
        createdAt: "2026-08-08T00:00:00.000Z",
        repository: {
          id: "repository",
          root: "/code/rennet",
          commonDir: "/code/rennet/.git",
          baseRef: "main",
          baseOid: "1111111111111111",
          headOid: `${patchsetId}-head`,
        },
        files: [
          {
            path: "src/x.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            binary: false,
            patch: "+const reviewed = true;",
          },
        ],
        rawDiff: "+const reviewed = true;",
        byteLength: 24,
        truncated: false,
      },
    ],
  };
}

type DraftOutput = CommandOutput<"review.draftPrBody">;

const STALE: DraftOutput = {
  status: "drafted",
  title: "STALE_TITLE::drafted-against-patchset-A",
  body: "STALE_BODY::must-not-land-on-patchset-B",
  model: "gpt-5.6-luna",
};

/** A bridge over a mutable `current` review (mutate it, advance the freshness poll to
 *  regenerate) with a DEFERRED `review.draftPrBody` (resolve via `release`). */
function harness() {
  let current = reviewAt("patch-one");
  const calls: CommandInput<"review.draftPrBody">[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    switch (name) {
      case "app.bootstrap":
        return { review: structuredClone(current), repositoryPresent: true };
      case "review.checkFreshness":
        return { review: structuredClone(current) };
      case "review.canvases":
        return enriched;
      case "review.draftPrBody":
        calls.push(input as CommandInput<"review.draftPrBody">);
        await gate;
        return STALE;
      default:
        return { review: structuredClone(current) };
    }
  };
  return {
    bridge: { invoke: invoke as unknown as RennetBridge["invoke"] },
    calls,
    regenerate: () => {
      current = reviewAt("patch-two");
    },
    release: () => release(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RennetApp — a PR-body draft never lands on the wrong patchset after regenerate (#74 HIGH)", () => {
  it("a turn drafted against patchset A is dropped when B activates before it resolves", async () => {
    const { bridge, calls, regenerate, release } = harness();
    let handle!: ReturnType<typeof mount>;
    await act(async () => {
      handle = mount(<RennetApp bridge={bridge} />);
    });
    await act(async () => {
      await flush();
    });
    const { container } = handle;
    expect(container.querySelector(".destination-frame")).not.toBeNull();

    // Stage a note to ink so the draft turn has an input.
    await act(async () => {
      fireEvent.click(handle.getByRole("tab", { name: "Files" }));
      await flush();
    });
    await act(async () => {
      fireEvent.click(handle.getByRole("button", { name: "Mark read" }));
      await flush();
    });
    await act(async () => {
      const open = container.querySelector<HTMLButtonElement>(".destination-open-draft");
      if (!open) throw new Error("open-draft control missing");
      fireEvent.click(open);
      await flush();
    });
    await act(async () => {
      const stage = container.querySelector<HTMLInputElement>(".collation-item-stage-box");
      if (!stage) throw new Error("stage toggle missing");
      fireEvent.click(stage);
      await flush();
    });

    // Start the draft against patchset A — in flight (deferred).
    await act(async () => {
      const btn = container.querySelector<HTMLButtonElement>(".collation-pr-draft-btn");
      if (!btn) throw new Error("Draft with AI button missing");
      fireEvent.click(btn);
      await flush();
    });
    expect(calls).toHaveLength(1);

    // Regenerate: patchset B activates under the same review id (the freshness poll
    // picks it up). This bumps the draft generation — A's turn is now stale.
    regenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
      await flush();
    });

    // A's turn resolves — but its generation no longer matches, so it is DROPPED and
    // its body never lands on patchset B's composer.
    await act(async () => {
      release();
      await flush();
    });

    const composerBody = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="pr-draft-body"]',
    );
    // The composer (if the draft canvas is still mounted) never carries A's body; the
    // status never claims a completed draft for the superseded turn. RED-proof: drop
    // the generation bump in the fingerprint effect (app.tsx) and A's body lands here.
    expect(composerBody?.value ?? "").not.toContain("STALE_BODY");
    expect(
      container.querySelector('[data-testid="pr-draft-status"]')?.textContent ?? "",
    ).not.toContain("gpt-5.6-luna");
  });
});
