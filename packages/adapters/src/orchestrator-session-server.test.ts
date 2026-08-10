import {
  CANVAS_OPS_TOOLS,
  type CanvasOpsBackend,
  type CanvasOpsEffect,
  type OrchestratorPrimerState,
} from "@rennet/core";
import {
  CANVAS_ANGLES,
  type CanvasAngle,
  type Decomposition,
  type RoutePlanResult,
} from "@rennet/types";
import { describe, expect, it } from "vitest";
import { CANVAS_OPS_SERVER_NAME, type LoadCanvasOpsSdk } from "./canvas-ops-server";
import { attachOrchestratorSession } from "./orchestrator-session-server";

/** A minimal backend: enough for the surface to compile into a server, no round-trip. */
function stubBackend(): CanvasOpsBackend {
  const decomposition: Decomposition = {
    patchsetId: "ps_1",
    hunks: [],
    classifications: [],
    chunks: [],
    edges: [],
    readingOrder: [],
    residue: [],
  };
  const plan: RoutePlanResult = {
    refused: false,
    invocations: [],
    harnessInvocationCount: 0,
    maxHarnessInvocations: 5,
  };
  return {
    identity: () => ({ reviewId: "rv_1", patchsetId: "ps_1" }),
    freshness: () => "current",
    angles: () => CANVAS_ANGLES,
    canvas: () => undefined,
    view: () => ({ expandedCohorts: [] }),
    element: () => undefined,
    thread: () => undefined,
    hunk: () => undefined,
    searchDiff: () => [],
    decomposition: () => decomposition,
    runLedger: () => [],
    provenance: () => undefined,
    planRecompute: () => plan,
    projectMap: () => ({ ok: false as const, failure: { reason: "absent" as const } }),
    fileContext: () => ({ ok: false as const, reason: "not-found" as const, path: "x" }),
    novelty: () => ({ ok: false as const, failure: { reason: "absent" as const } }),
    applyEffects: (effects: readonly CanvasOpsEffect[]) => {
      void effects;
    },
  };
}

/** A hermetic fake SDK loader: proves injectability, spawns no model. `unknown` params, no `any`. */
const fakeLoadSdk: LoadCanvasOpsSdk = async () =>
  ({
    tool: (
      name: string,
      description: string,
      _schema: unknown,
      handler: unknown,
      opts?: { annotations?: unknown; alwaysLoad?: boolean },
    ) => ({
      name,
      description,
      handler,
      annotations: opts?.annotations,
      _meta: opts?.alwaysLoad ? { "anthropic/alwaysLoad": true } : {},
    }),
    createSdkMcpServer: (config: { name: string; tools: unknown; instructions: string }) => ({
      type: "sdk",
      name: config.name,
      instance: { name: config.name, tools: config.tools, instructions: config.instructions },
    }),
  }) as unknown as Awaited<ReturnType<LoadCanvasOpsSdk>>;

function primerState(): OrchestratorPrimerState {
  return {
    identity: { reviewId: "rv_1", patchsetId: "ps_1", mode: "own-branch-handoff" },
    freshness: [{ repoId: "app", snapshotId: "snap_01", verdict: "current" }],
    canvasState: CANVAS_ANGLES.map((angle: CanvasAngle) => ({
      angle,
      canvasId: `cv_${angle}`,
      elements: 5,
      cohorts: 0,
      residue: 0,
      coverage: { paths: 10, dispositioned: 4, unread: 6, approved: 3, requestChanged: 1 },
    })),
    runLedger: { fleetTasks: 2, admitted: 6, rejected: 0 },
  };
}

describe("attachOrchestratorSession", () => {
  it("returns a session whose tool index equals the canvasOps@2 registry and an MCP server for it", async () => {
    const { session, mcpServer } = await attachOrchestratorSession(
      stubBackend(),
      { primer: primerState() },
      fakeLoadSdk,
    );
    // The session's attached surface IS the canvasOps@2 registry (#49 item 3).
    expect(session.attachedToolNames()).toEqual(CANVAS_OPS_TOOLS.map((t) => t.name));
    expect(session.toolIndex.map((e) => e.name)).toEqual(CANVAS_OPS_TOOLS.map((t) => t.name));
    // The MCP server registers exactly that tool set, built without spawning a model.
    expect(mcpServer.type).toBe("sdk");
    expect(mcpServer.name).toBe(CANVAS_OPS_SERVER_NAME);
    const instance = mcpServer.instance as unknown as { tools: Array<{ name: string }> };
    expect(instance.tools.map((t) => t.name)).toEqual(CANVAS_OPS_TOOLS.map((t) => t.name));
  });

  it("boots fresh by default and records the primer digest in provenance", async () => {
    const { session } = await attachOrchestratorSession(
      stubBackend(),
      { primer: primerState() },
      fakeLoadSdk,
    );
    expect(session.fresh).toBe(true);
    expect(session.provenance.primerDigest).toBe(session.primer.digest);
  });
});
