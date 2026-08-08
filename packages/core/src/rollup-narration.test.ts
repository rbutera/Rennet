import { ROLLUP_NARRATION_CONTRACT } from "@rennet/instructions";
import type {
  Canvas,
  CanvasAngle,
  Decomposition,
  Hunk,
  RollupNarrationBody,
  RspCapabilitySnapshot,
} from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import type { HarnessTurnResult } from "./harness-run-turn";
import { createInvocationBudget } from "./invocation-budget";
import {
  buildReviewNarration,
  type NarrationNode,
  offeredNarrationNodes,
  ROLLUP_NARRATION_ANCHOR,
  runRollupNarration,
} from "./rollup-narration";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CAP: RspCapabilitySnapshot = {
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

const SEED = {
  harness: "codex",
  harnessVersion: "1.0.0",
  adapterVersion: "0.1.0",
  model: "gpt-5.6-luna",
  modelReportedBy: "config" as const,
  capability: CAP,
  effort: "low",
};

function hunk(id: string): Hunk {
  return {
    id,
    filePath: "src/a.ts",
    fileStatus: "modified",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 2,
    addedLines: ["line one", "line two"],
    deletedLines: [],
    contextLines: [],
    changedLoc: 2,
  };
}

function decomposition(): Decomposition {
  return {
    patchsetId: "ps_1",
    hunks: [hunk("h1")],
    classifications: [{ hunkId: "h1", kind: "substantive", mechanical: null, enclosingSymbol: "" }],
    chunks: [
      {
        chunkId: "c1",
        kind: "substantive",
        title: "core",
        layer: 0,
        filePaths: ["src/a.ts"],
        hunkIds: ["h1"],
        changedLoc: 2,
      },
    ],
    edges: [],
    readingOrder: ["c1"],
    residue: [],
  };
}

function canvas(angle: CanvasAngle, cohorts: { cohortKey: string; title: string }[]): Canvas {
  return {
    canvasId: `r\0p\0${angle}`,
    reviewId: "r",
    patchsetId: "ps_1",
    angle,
    layers: {
      substrate: { chunks: [] },
      analysis: {
        elements: [],
        cohorts: cohorts.map((c) => ({ ...c, elementKeys: [] })),
        readingOrder: [],
      },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [],
  };
}

/** A demo canvas set: the decisions canvas carries two cohorts, the rest none. */
function canvases(): Record<CanvasAngle, Canvas> {
  const set = {} as Record<CanvasAngle, Canvas>;
  for (const angle of CANVAS_ANGLES) {
    set[angle] =
      angle === "decisions"
        ? canvas(angle, [
            { cohortKey: "cohort:c1", title: "The store schema" },
            { cohortKey: "cohort:c2", title: "The callers" },
          ])
        : canvas(angle, []);
  }
  return set;
}

/** A well-formed narration body covering exactly the offered nodes. */
function bodyFor(nodes: NarrationNode[]): RollupNarrationBody {
  return {
    narrations: nodes.map((node) => ({
      altitude: node.altitude,
      anchor: node.anchor,
      oneLine: `one-line for ${node.anchor}`,
      paragraph: `a paragraph account for ${node.anchor}`,
    })),
  };
}

function emit(body: unknown): HarnessTurnResult {
  return { status: "emitted", body };
}

// ── offeredNarrationNodes ─────────────────────────────────────────────────────

describe("offeredNarrationNodes", () => {
  it("offers the roll-up node plus every cohort (deduped)", () => {
    const nodes = offeredNarrationNodes(canvases());
    const rollup = nodes.filter((n) => n.altitude === "rollup");
    const cohorts = nodes.filter((n) => n.altitude === "cohort").map((n) => n.anchor);
    expect(rollup).toHaveLength(1);
    expect(rollup[0]?.anchor).toBe(ROLLUP_NARRATION_ANCHOR);
    expect(cohorts).toEqual(["cohort:c1", "cohort:c2"]);
  });

  it("always offers at least the roll-up node, even with no cohorts", () => {
    const bare = {} as Record<CanvasAngle, Canvas>;
    for (const angle of CANVAS_ANGLES) bare[angle] = canvas(angle, []);
    const nodes = offeredNarrationNodes(bare);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.altitude).toBe("rollup");
  });
});

// ── runRollupNarration: the happy path ────────────────────────────────────────

describe("runRollupNarration — admission", () => {
  it("admits a well-formed batch and returns the account per node", async () => {
    const nodes = offeredNarrationNodes(canvases());
    const result = await runRollupNarration({
      nodes,
      decomposition: decomposition(),
      patchsetId: "ps_1",
      contract: ROLLUP_NARRATION_CONTRACT,
      provenance: SEED,
      runTurn: async () => emit(bodyFor(nodes)),
      budget: createInvocationBudget(10), // explicit budget: absent now fails closed (#95)
    });
    expect(result.outcome).toBe("narrated");
    expect(result.document?.docType).toBe("rollup-narration");
    for (const node of nodes) {
      expect(result.narrations.get(node.anchor)?.oneLine).toBe(`one-line for ${node.anchor}`);
    }
  });
});

// ── THE MONEY CIRCUIT: the narration turn is budget-gated (red-provable) ───────

describe("runRollupNarration — budget gate (Rule 75, the money circuit)", () => {
  it("refuses to spend a turn when the shared budget is exhausted", async () => {
    const nodes = offeredNarrationNodes(canvases());
    const turn = vi.fn(async () => emit(bodyFor(nodes)));
    const budget = createInvocationBudget(0); // no invocations permitted
    const result = await runRollupNarration({
      nodes,
      decomposition: decomposition(),
      patchsetId: "ps_1",
      contract: ROLLUP_NARRATION_CONTRACT,
      provenance: SEED,
      runTurn: turn,
      budget,
    });
    // The gate must have stopped the turn BEFORE it ran — if narration bypassed the
    // budget, `turn` would have been called and the outcome would be "narrated".
    expect(turn).not.toHaveBeenCalled();
    expect(result.budgetRefused).toBe(true);
    expect(result.outcome).toBe("pending");
    expect(result.document).toBeUndefined();
  });

  it("POSITIVE CONTROL — the SAME turn narrates when the budget permits it", async () => {
    const nodes = offeredNarrationNodes(canvases());
    const turn = vi.fn(async () => emit(bodyFor(nodes)));
    const budget = createInvocationBudget(5);
    const result = await runRollupNarration({
      nodes,
      decomposition: decomposition(),
      patchsetId: "ps_1",
      contract: ROLLUP_NARRATION_CONTRACT,
      provenance: SEED,
      runTurn: turn,
      budget,
    });
    expect(turn).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("narrated");
    expect(budget.consumed).toBe(1); // exactly one turn drew from the shared ceiling
  });

  it("ABSENT budget fails CLOSED — no turn runs (#95, the fail-open hole)", async () => {
    // The #95 defect: when NO budget is threaded, the old gate (`if (budget !==
    // undefined)`) skipped entirely and the turn ran UNGATED. An absent budget is
    // not authorization to spend — it must be a refusal, exactly like a zero
    // ceiling. This is the red-provable proof: restore the old skip and this reds.
    const nodes = offeredNarrationNodes(canvases());
    const turn = vi.fn(async () => emit(bodyFor(nodes)));
    const result = await runRollupNarration({
      nodes,
      decomposition: decomposition(),
      patchsetId: "ps_1",
      contract: ROLLUP_NARRATION_CONTRACT,
      provenance: SEED,
      runTurn: turn,
      // budget deliberately omitted — an absent budget must fail closed.
    });
    expect(turn).not.toHaveBeenCalled();
    expect(result.budgetRefused).toBe(true);
    expect(result.outcome).toBe("pending");
    expect(result.document).toBeUndefined();
    // The refusal carries the honest reason, not a fabricated exhaustion.
    expect(result.attempts.at(-1)?.outcome).toBe("budget-refused");
    expect(result.attempts.at(-1)?.budgetRefusal?.reason).toContain("no invocation budget");
  });

  it("a non-finite ceiling fails CLOSED (no narration turn runs)", async () => {
    const nodes = offeredNarrationNodes(canvases());
    const turn = vi.fn(async () => emit(bodyFor(nodes)));
    const budget = createInvocationBudget(Number.POSITIVE_INFINITY);
    const result = await runRollupNarration({
      nodes,
      decomposition: decomposition(),
      patchsetId: "ps_1",
      contract: ROLLUP_NARRATION_CONTRACT,
      provenance: SEED,
      runTurn: turn,
      budget,
    });
    expect(turn).not.toHaveBeenCalled();
    expect(result.outcome).toBe("pending");
  });
});

// ── The node-coverage floor (the runner enforces what the validator cannot) ────

describe("runRollupNarration — node coverage floor", () => {
  it("rejects a batch that omits an offered node, then falls to the honest failed state", async () => {
    const nodes = offeredNarrationNodes(canvases());
    // Emit a body that narrates only the rollup, dropping both cohorts, every time.
    const partial: RollupNarrationBody = {
      narrations: [
        { altitude: "rollup", anchor: ROLLUP_NARRATION_ANCHOR, oneLine: "x", paragraph: "y" },
      ],
    };
    const result = await runRollupNarration({
      nodes,
      decomposition: decomposition(),
      patchsetId: "ps_1",
      contract: ROLLUP_NARRATION_CONTRACT,
      provenance: SEED,
      runTurn: async () => emit(partial),
      maxRetries: 1,
      budget: createInvocationBudget(10), // explicit budget: absent now fails closed (#95)
    });
    expect(result.outcome).toBe("failed");
    expect(result.document).toBeUndefined();
    // Every attempt was rejected on coverage (not admitted).
    expect(result.attempts.every((a) => a.outcome === "rejected")).toBe(true);
    expect(
      result.attempts.some((a) => a.report?.errors.some((e) => e.code === "NARRATION_COVERAGE")),
    ).toBe(true);
  });

  it("rejects a batch narrating a node that was never offered (minted node)", async () => {
    const nodes = offeredNarrationNodes(canvases());
    const minted: RollupNarrationBody = {
      narrations: [
        ...bodyFor(nodes).narrations,
        { altitude: "cohort", anchor: "cohort:GHOST", oneLine: "x", paragraph: "y" },
      ],
    };
    const result = await runRollupNarration({
      nodes,
      decomposition: decomposition(),
      patchsetId: "ps_1",
      contract: ROLLUP_NARRATION_CONTRACT,
      provenance: SEED,
      runTurn: async () => emit(minted),
      maxRetries: 0,
      budget: createInvocationBudget(10), // explicit budget: absent now fails closed (#95)
    });
    expect(result.outcome).toBe("failed");
    expect(
      result.attempts.some((a) => a.report?.errors.some((e) => e.code === "NARRATION_MINTED_NODE")),
    ).toBe(true);
  });
});

// ── A turn failure (budget threaded) yields the honest "failed" state ──────────

describe("runRollupNarration — honest failure, never fabrication", () => {
  it("returns failed (not a fabricated account) when every turn fails", async () => {
    const nodes = offeredNarrationNodes(canvases());
    const result = await runRollupNarration({
      nodes,
      decomposition: decomposition(),
      patchsetId: "ps_1",
      contract: ROLLUP_NARRATION_CONTRACT,
      provenance: SEED,
      runTurn: async () => ({ status: "failed", message: "model unavailable" }),
      maxRetries: 1,
      budget: createInvocationBudget(10), // explicit budget: absent now fails closed (#95)
    });
    expect(result.outcome).toBe("failed");
    expect(result.narrations.size).toBe(0);
  });
});

// ── buildReviewNarration: never a silent blank ────────────────────────────────

describe("buildReviewNarration", () => {
  it("places a narrated account at every node on a narrated outcome", async () => {
    const nodes = offeredNarrationNodes(canvases());
    const result = await runRollupNarration({
      nodes,
      decomposition: decomposition(),
      patchsetId: "ps_1",
      contract: ROLLUP_NARRATION_CONTRACT,
      provenance: SEED,
      runTurn: async () => emit(bodyFor(nodes)),
      budget: createInvocationBudget(10), // explicit budget: absent now fails closed (#95)
    });
    const narration = buildReviewNarration(nodes, result);
    expect(narration.rollup.status).toBe("narrated");
    expect(narration.cohorts["cohort:c1"]?.status).toBe("narrated");
    expect(narration.cohorts["cohort:c2"]?.status).toBe("narrated");
  });

  it("places an honest PENDING at every node when the pass did not run (undefined result)", () => {
    const nodes = offeredNarrationNodes(canvases());
    const narration = buildReviewNarration(nodes, undefined);
    expect(narration.rollup.status).toBe("pending");
    expect(narration.cohorts["cohort:c1"]?.status).toBe("pending");
    expect(narration.cohorts["cohort:c2"]?.status).toBe("pending");
  });

  it("places an honest FAILED at every node on a failed outcome — never a silent blank", async () => {
    const nodes = offeredNarrationNodes(canvases());
    const result = await runRollupNarration({
      nodes,
      decomposition: decomposition(),
      patchsetId: "ps_1",
      contract: ROLLUP_NARRATION_CONTRACT,
      provenance: SEED,
      runTurn: async () => ({ status: "failed", message: "down" }),
      maxRetries: 0,
      budget: createInvocationBudget(10), // explicit budget: absent now fails closed (#95)
    });
    const narration = buildReviewNarration(nodes, result);
    expect(narration.rollup.status).toBe("failed");
    expect(narration.cohorts["cohort:c1"]?.status).toBe("failed");
  });
});
