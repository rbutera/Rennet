import type { PatchFile, Patchset, RspCapabilitySnapshot } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { buildOfferedManifest } from "./angle-generation";
import { decompose } from "./decomposition";
import { type RunDualFindingReviewInput, runDualFindingReview } from "./dual-finding-review";
import type { DualSeat } from "./dual-seat";
import type { FindingProvenanceSeed } from "./finding-generation";
import type { HarnessTurnResult } from "./harness-run-turn";
import { createInvocationBudget } from "./invocation-budget";

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: null, deletions: null, binary: false, patch };
}
function patch(path: string, lines: string[]): string {
  const oldCount = lines.filter((l) => l[0] === "-" || l[0] === " ").length;
  const newCount = lines.filter((l) => l[0] === "+" || l[0] === " ").length;
  return (
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
    `@@ -1,${oldCount} +1,${newCount} @@\n${lines.join("\n")}\n`
  );
}

const PATCHSET: Patchset = {
  id: "ps_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "origin/main",
    baseOid: "0".repeat(40),
    headOid: "1".repeat(40),
  },
  files: [file("src/a.ts", patch("src/a.ts", ["+export const a = 1;", "+export const b = 2;"]))],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

const DECOMPOSITION = decompose(PATCHSET);
const MANIFEST = buildOfferedManifest(DECOMPOSITION);
const OFFERED_HUNK = MANIFEST.occurrences[0]?.id ?? "h1";

const CAPABILITY: RspCapabilitySnapshot = {
  structuredOutput: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
  perCallModelSelection: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
};
const SEED: FindingProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "unknown",
  adapterVersion: "0.0.0",
  model: "unknown",
  modelReportedBy: "unknown",
  capability: CAPABILITY,
};

/** A turn that emits the given findings body on attempt 0, then fails. */
function emits(findings: unknown[]): (p: string, a: number) => Promise<HarnessTurnResult> {
  return (_p, attempt) =>
    Promise.resolve(
      attempt === 0
        ? { status: "emitted", body: { findings } }
        : { status: "failed", message: "no scripted body" },
    );
}
const alwaysFails = async (): Promise<HarnessTurnResult> => ({
  status: "failed",
  message: "seat down",
});
const alwaysThrows = async (): Promise<HarnessTurnResult> => {
  throw new Error("codex spawn exploded");
};

function finding(summary: string, severity: "high" | "medium" | "low"): Record<string, unknown> {
  return { anchor: `rennet:hunk/${OFFERED_HUNK}`, summary, severity };
}

function seat(
  provider: "claude-code" | "codex",
  label: string,
  runTurn: (p: string, a: number) => Promise<HarnessTurnResult>,
): DualSeat {
  return { provider, label, seed: SEED, runTurn };
}

function baseInput(seats: DualSeat[], deepReview: boolean): RunDualFindingReviewInput {
  return {
    deepReview,
    patchsetId: PATCHSET.id,
    manifest: MANIFEST,
    seats,
    makeBudget: () => createInvocationBudget(5),
  };
}

describe("runDualFindingReview — dual-model Flagged orchestration (#41)", () => {
  it("QUICK review runs ONLY the Claude seat (no second turn, no dual note)", async () => {
    const claude = vi.fn(emits([finding("only claude", "high")]));
    const codex = vi.fn(alwaysFails);
    const seats = [seat("claude-code", "Claude", claude), seat("codex", "Codex", codex)];
    const { review, seatRuns } = await runDualFindingReview(baseInput(seats, false));
    expect(review.status).toBe("ok");
    if (review.status !== "ok") throw new Error("unreachable");
    expect(review.dual).toBeUndefined(); // byte-identical to pre-#41
    expect(review.findings).toHaveLength(1);
    expect(codex).not.toHaveBeenCalled(); // the second seat never ran
    expect(seatRuns).toHaveLength(1);
  });

  it("DEEP review runs BOTH seats independently and reconciles a concur", async () => {
    const claude = vi.fn(emits([finding("off-by-one bound", "high")]));
    const codex = vi.fn(emits([finding("loop overruns by one", "high")]));
    const seats = [seat("claude-code", "Claude", claude), seat("codex", "Codex", codex)];
    const { review, seatRuns } = await runDualFindingReview(baseInput(seats, true));
    if (review.status !== "ok") throw new Error("expected ok");
    expect(claude).toHaveBeenCalledTimes(1);
    expect(codex).toHaveBeenCalledTimes(1);
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]?.agreement).toEqual({ kind: "concur", agree: 2, total: 2 });
    expect(review.dual).toEqual({ seats: ["Claude", "Codex"] });
    expect(seatRuns).toHaveLength(2);
  });

  it("DEEP review with a clean second seat surfaces the raiser as a SOLO disagree", async () => {
    const claude = vi.fn(emits([finding("claude alone flags this", "medium")]));
    const codex = vi.fn(emits([])); // ran clean, flagged nothing
    const seats = [seat("claude-code", "Claude", claude), seat("codex", "Codex", codex)];
    const { review } = await runDualFindingReview(baseInput(seats, true));
    if (review.status !== "ok") throw new Error("expected ok");
    expect(review.findings[0]?.agreement.kind).toBe("disagree");
    expect(review.dual).toEqual({ seats: ["Claude", "Codex"] });
  });

  it("GRACEFULLY degrades to Claude when the Codex seat FAILS (honest marker, no fabricated concur)", async () => {
    const claude = vi.fn(emits([finding("real concern", "high")]));
    const codex = vi.fn(alwaysFails);
    const seats = [seat("claude-code", "Claude", claude), seat("codex", "Codex", codex)];
    const { review, seatRuns } = await runDualFindingReview(baseInput(seats, true));
    if (review.status !== "ok") throw new Error("expected ok");
    // The surviving seat's OWN finding, its honest 1/1 vote — not a faked 2/2.
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]?.agreement).toEqual({ kind: "concur", agree: 1, total: 1 });
    expect(review.dual?.seats).toEqual(["Claude"]);
    expect(review.dual?.secondSeatUnavailable).toContain("Codex");
    expect(seatRuns).toHaveLength(2);
  });

  it("GRACEFULLY degrades to Codex when the FIRST seat fails but the second succeeds", async () => {
    const claude = vi.fn(alwaysFails);
    const codex = vi.fn(emits([finding("codex saw it", "medium")]));
    const seats = [seat("claude-code", "Claude", claude), seat("codex", "Codex", codex)];
    const { review } = await runDualFindingReview(baseInput(seats, true));
    if (review.status !== "ok") throw new Error("expected ok");
    expect(review.findings).toHaveLength(1);
    expect(review.dual?.seats).toEqual(["Codex"]);
    expect(review.dual?.secondSeatUnavailable).toContain("Claude");
  });

  it("does NOT hang or crash when a seat THROWS — a throw degrades to a failed seat", async () => {
    const claude = vi.fn(emits([finding("real concern", "high")]));
    const codex = vi.fn(alwaysThrows);
    const seats = [seat("claude-code", "Claude", claude), seat("codex", "Codex", codex)];
    const { review } = await runDualFindingReview(baseInput(seats, true));
    if (review.status !== "ok") throw new Error("expected ok");
    expect(review.dual?.seats).toEqual(["Claude"]);
    expect(review.dual?.secondSeatUnavailable).toContain("Codex");
  });

  it("resolves to the LOUD failed state when BOTH seats fail", async () => {
    const seats = [seat("claude-code", "Claude", alwaysFails), seat("codex", "Codex", alwaysFails)];
    const { review } = await runDualFindingReview(baseInput(seats, true));
    expect(review.status).toBe("failed");
  });

  it("DEEP review with only one provider installed notes the single provider honestly", async () => {
    const seats = [seat("claude-code", "Claude", emits([finding("x", "low")]))];
    const { review } = await runDualFindingReview(baseInput(seats, true));
    if (review.status !== "ok") throw new Error("expected ok");
    expect(review.dual?.seats).toEqual(["Claude"]);
    expect(review.dual?.secondSeatUnavailable).toContain("one provider");
  });

  it("fails loudly with NO seats available", async () => {
    const { review, seatRuns } = await runDualFindingReview(baseInput([], true));
    expect(review.status).toBe("failed");
    expect(seatRuns).toHaveLength(0);
  });

  it("feeds the hypothesis to BOTH seats (both prompts carry the disconfirmation layer)", async () => {
    let promptA = "";
    let promptB = "";
    const claude = vi.fn((p: string, a: number) => {
      promptA = p;
      return emits([finding("x", "high")])(p, a);
    });
    const codex = vi.fn((p: string, a: number) => {
      promptB = p;
      return emits([finding("y", "high")])(p, a);
    });
    const seats = [seat("claude-code", "Claude", claude), seat("codex", "Codex", codex)];
    await runDualFindingReview({
      ...baseInput(seats, true),
      hypothesis: {
        domain: "the change should add a UNIQUEBOUNDCHECK before the loop",
        scope: { inScope: ["src/a.ts"], outOfScope: [] },
        designExpectation: "a guard before the loop",
        risks: [
          {
            riskId: "R1",
            statement: "no bound check",
            severity: "high",
            disconfirmer: "did they add one",
          },
        ],
        repoContextPresent: false,
      },
      makeBudget: () => createInvocationBudget(5),
    });
    // Both independent prompts carry the hypothesis layer — the disconfirmers reached each seat.
    expect(promptA).toContain("UNIQUEBOUNDCHECK");
    expect(promptB).toContain("UNIQUEBOUNDCHECK");
  });
});
