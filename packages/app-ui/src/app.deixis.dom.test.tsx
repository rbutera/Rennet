// @vitest-environment happy-dom
import type { CommandInput, RennetBridge, ReviewAskStreamEvent } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { fireEvent, mount, waitFor } from "./test/dom";

const review: Review = {
  id: "review",
  repositoryRoot: "/code/rennet",
  activePatchsetId: "patch-one",
  dispositions: [],
  status: "current",
  patchsets: [
    {
      id: "patch-one",
      createdAt: "2026-08-15T00:00:00.000Z",
      repository: {
        id: "repository",
        root: "/code/rennet",
        commonDir: "/code/rennet/.git",
        baseRef: "main",
        baseOid: "1111111111111111",
        headOid: "2222222222222222",
      },
      files: [
        {
          path: "src/focus.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: "+pointed",
        },
      ],
      rawDiff: "+pointed",
      byteLength: 8,
      truncated: false,
    },
  ],
};

function focusDiff(lines: number): string {
  const rows = [`@@ -10,1 +10,${lines} @@`, " context", "+pointed"];
  for (let index = 2; index <= lines - 1; index += 1) rows.push(`+pointed ${index}`);
  return rows.join("\n");
}

function harness() {
  const asks: CommandInput<"review.ask">[] = [];
  const listeners = new Set<(event: ReviewAskStreamEvent) => void>();
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    if (name === "app.bootstrap") return { review, repositoryPresent: true };
    if (name === "settings.get") return { scheme: "dark" };
    if (name === "review.canvases") {
      return {
        canvases: demoCanvases(),
        elementDiffs: {
          "dec-1-1": {
            path: "src/focus.ts",
            paths: ["src/focus.ts"],
            diff: focusDiff(240),
            hunkOccurrences: [
              [{ id: "c1-h1", oldStart: 10, oldLines: 1, newStart: 10, newLines: 240 }],
            ],
          },
        },
      };
    }
    if (name === "review.reattach") return { threads: [], inFlight: [] };
    if (name === "review.ask") {
      asks.push(input as CommandInput<"review.ask">);
      return {
        mode: "orchestrator",
        primary: { model: "Claude", answer: "answer" },
      };
    }
    return { review };
  };
  const bridge: RennetBridge = {
    invoke: invoke as RennetBridge["invoke"],
    onAskStream: (_reviewId, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    asks,
    bridge,
    emit(event: ReviewAskStreamEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("RennetApp — two-way deixis routing (#79)", () => {
  it("routes ask-focus to the workspace and carries then clears the user's span selection", async () => {
    const h = harness();
    const { container, getByRole } = mount(<RennetApp bridge={h.bridge} />);
    await waitFor(() => expect(container.querySelector(".review-heart-split")).not.toBeNull());

    const focus = {
      kind: "ask-focus" as const,
      anchor: "rennet:hunk/c1-h1#L1@additions",
    };
    h.emit(focus);
    await waitFor(() => expect(container.querySelector(".cv-focus")).not.toBeNull());
    expect(container.querySelector(".cv-focus")?.getAttribute("data-focus-nonce")).toBe("1");
    h.emit(focus);
    await waitFor(() =>
      expect(container.querySelector(".cv-focus")?.getAttribute("data-focus-nonce")).toBe("2"),
    );

    const addition = container.querySelector<HTMLButtonElement>(
      '[data-cv-discuss-side="additions"]',
    );
    if (!addition) throw new Error("focused diff did not expose its addition row");
    fireEvent.click(addition);
    // The diff discuss glyph auto-opens a thread in the aligned margin; its cluster owns
    // the composer that carries the span selection into the turn.
    const cluster = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(".conversation-cluster");
      if (!found) throw new Error("conversation thread did not open in the margin");
      return found;
    });
    const composer = () => ({
      input: cluster.querySelector<HTMLTextAreaElement>(".conversation-composer-input"),
      send: cluster.querySelector<HTMLButtonElement>(".conversation-composer-send"),
    });
    const first = composer();
    if (!first.input || !first.send) throw new Error("thread composer did not mount");
    fireEvent.change(first.input, { target: { value: "is this safe?" } });
    fireEvent.click(first.send);
    await waitFor(() => expect(h.asks).toHaveLength(1));
    expect(h.asks[0]?.selection).toEqual({
      anchor: "rennet:hunk/c1-h1#L1@additions",
      excerpt: "pointed",
    });

    fireEvent.click(getByRole("tab", { name: "Sequence" }));
    const second = composer();
    if (!second.input || !second.send) throw new Error("thread composer did not persist");
    fireEvent.change(second.input, { target: { value: "and now?" } });
    fireEvent.click(second.send);
    await waitFor(() => expect(h.asks).toHaveLength(2));
    expect(h.asks[1]).not.toHaveProperty("selection");
  });

  it("consumes focus once across Files/Canvases remounts and accepts a new delivery", async () => {
    const h = harness();
    const { container, getByRole } = mount(<RennetApp bridge={h.bridge} />);
    await waitFor(() => expect(container.querySelector(".review-heart-split")).not.toBeNull());

    h.emit({ kind: "ask-focus", anchor: "rennet:hunk/c1-h1#L200@additions" });
    await waitFor(() => expect(container.querySelector(".code-view-scroll")).not.toBeNull());
    const initialScroll = container.querySelector<HTMLElement>(".code-view-scroll");
    if (!initialScroll) throw new Error("canvas diff did not mount");
    await waitFor(() => expect(initialScroll.scrollTop).toBeGreaterThan(150 * 18));

    fireEvent.click(getByRole("tab", { name: "Files" }));
    expect(container.querySelector(".code-view-scroll")).toBeNull();
    fireEvent.click(getByRole("tab", { name: "Canvases" }));

    const remountedScroll = container.querySelector<HTMLElement>(".code-view-scroll");
    if (!remountedScroll) throw new Error("canvas diff did not remount");
    expect(remountedScroll.scrollTop).toBe(0);

    h.emit({ kind: "ask-focus", anchor: "rennet:hunk/c1-h1#L200@additions" });
    await waitFor(() => expect(remountedScroll.scrollTop).toBeGreaterThan(150 * 18));
  });
});
