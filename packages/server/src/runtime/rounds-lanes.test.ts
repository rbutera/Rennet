import type { LensLane } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createRegenerationLanes } from "./rounds";

// The regeneration lanes hold SEATS, not one thread per lane. Flagged runs a Claude seat
// and a Codex seat on the same lane (`runFlaggedDual`), and before this the second seat's
// thread overwrote the first's and the lane's live line flipped between the two speakers.
//
// POSITIVE CONTROL, run 2026-09-03: `thread()` rewritten to `lanes.set(lens, {...current,
// thread})` (the pre-fix body, no `seats`) → every test in the first describe fails: the
// Codex thread is the only one left, `seats` is undefined. Restored.

const ENV = "env-1";
const CLAUDE = { environmentId: ENV, threadId: "thread-flagged-claude" };
const CODEX = { environmentId: ENV, threadId: "thread-flagged-codex" };

function harness() {
  const frames: (readonly LensLane[])[] = [];
  const lanes = createRegenerationLanes((rows) => frames.push(rows));
  const flagged = (): LensLane => {
    const row = frames.at(-1)?.find((lane) => lane.id === "flagged");
    if (row === undefined) throw new Error("no flagged lane in the last frame");
    return row;
  };
  return { lanes, frames, flagged };
}

describe("a lane holds one entry per seat", () => {
  it.each([
    ["Claude first", ["flagged-claude", "flagged-codex"] as const],
    ["Codex first", ["flagged-codex", "flagged-claude"] as const],
  ])("keeps both Flagged threads whichever arrives first (%s)", (_name, order) => {
    const { lanes, flagged } = harness();
    lanes.start();
    for (const seat of order) {
      lanes.thread(
        seat,
        seat === "flagged-claude" ? "claudeAgent" : "codex",
        seat === "flagged-claude" ? CLAUDE : CODEX,
      );
    }
    const row = flagged();
    expect(row.seats?.map((entry) => entry.seat)).toEqual([...order]);
    expect(row.seats?.find((entry) => entry.seat === "flagged-claude")).toEqual({
      seat: "flagged-claude",
      provider: "claudeAgent",
      thread: CLAUDE,
    });
    expect(row.seats?.find((entry) => entry.seat === "flagged-codex")).toEqual({
      seat: "flagged-codex",
      provider: "codex",
      thread: CODEX,
    });
    // The lane's own thread is the PRIMARY seat's — the first to arrive — and stays put
    // when the second arrives.
    expect(row.thread).toEqual(order[0] === "flagged-claude" ? CLAUDE : CODEX);
  });

  it("routes a live line to its own seat, and the lane's line follows the primary only", () => {
    const { lanes, flagged } = harness();
    lanes.start();
    lanes.thread("flagged-claude", "claudeAgent", CLAUDE);
    lanes.thread("flagged-codex", "codex", CODEX);

    lanes.progress("flagged-codex", { kind: "tool", text: "running git diff", at: 1 });
    let row = flagged();
    expect(row.status === "running" && row.latest).toBeUndefined();
    expect(row.seats?.[1]?.latest?.text).toBe("running git diff");
    expect(row.seats?.[0]?.latest).toBeUndefined();

    lanes.progress("flagged-claude", { kind: "text", text: "The retry path is wrong.", at: 2 });
    row = flagged();
    expect(row.status === "running" && row.latest?.text).toBe("The retry path is wrong.");
    // The Codex line did not flip: it is still on its own seat.
    expect(row.seats?.[1]?.latest?.text).toBe("running git diff");
  });

  it("carries both seats through settlement and drops their lines", () => {
    const { lanes, flagged } = harness();
    lanes.start();
    lanes.thread("flagged-claude", "claudeAgent", CLAUDE);
    lanes.thread("flagged-codex", "codex", CODEX);
    lanes.progress("flagged-claude", { kind: "tool", text: "reading a.ts", at: 1 });
    lanes.progress("flagged-codex", { kind: "tool", text: "reading b.ts", at: 1 });
    lanes.drafted("flagged");
    lanes.arrived("flagged", false);
    const row = flagged();
    expect(row.status).toBe("done");
    expect(row.seats).toEqual([
      { seat: "flagged-claude", provider: "claudeAgent", thread: CLAUDE },
      { seat: "flagged-codex", provider: "codex", thread: CODEX },
    ]);
    expect(row.thread).toEqual(CLAUDE);
    expect(row).not.toHaveProperty("latest");
  });

  it("re-announcing the same thread is silent; the report seat has no lane", () => {
    const { lanes, frames } = harness();
    lanes.start();
    lanes.thread("design", "claudeAgent", { environmentId: ENV, threadId: "t-design" });
    const before = frames.length;
    lanes.thread("design", "claudeAgent", { environmentId: ENV, threadId: "t-design" });
    lanes.thread("round-report", "claudeAgent", { environmentId: ENV, threadId: "t-report" });
    expect(frames.length).toBe(before);
  });
});
