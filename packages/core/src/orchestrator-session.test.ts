import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { USER_CANVAS_COMMANDS } from "./canvas";
import type { ViewState } from "./canvas-ops";
import { CANVAS_OPS_TOOLS, CANVAS_OPS_VERSION } from "./canvas-ops";
import { PRIMER_MAX_BYTES } from "./orchestrator-primer";
import { bootOrchestratorSession, type OrchestratorPrimerState } from "./orchestrator-session";

function primerState(): OrchestratorPrimerState {
  return {
    identity: { reviewId: "rv_1", patchsetId: "ps_1", mode: "own-branch-handoff" },
    freshness: [{ repoId: "app", snapshotId: "snap_01", verdict: "current" }],
    canvasState: CANVAS_ANGLES.map((angle, index) => ({
      angle,
      canvasId: `cv_${angle}`,
      elements: 10 + index,
      cohorts: angle === "decisions" ? 4 : 0,
      residue: 0,
      coverage: { paths: 20, dispositioned: 8, unread: 12, approved: 6, requestChanged: 2 },
    })),
    runLedger: { fleetTasks: 4, admitted: 12, rejected: 1 },
  };
}

describe("bootOrchestratorSession", () => {
  it("boots a fresh session by default with a ≤4 KB primer whose digest is in provenance", () => {
    const session = bootOrchestratorSession({ primer: primerState() });
    expect(session.fresh).toBe(true);
    expect(session.harness).toBe("claude");
    expect(session.primer.bytes).toBeLessThanOrEqual(PRIMER_MAX_BYTES);
    expect(session.provenance.primerDigest).toBe(session.primer.digest);
    expect(session.provenance.primerDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(session.provenance.surfaceVersion).toBe(CANVAS_OPS_VERSION);
    expect(session.provenance.primerVersion).toBe(session.primer.version);
    expect(session.provenance.cardVersion).toBe(session.primer.cardVersion);
  });

  it("attaches a tool index equal to the canvasOps@2 registry, with no user-only/engine-only op", () => {
    const session = bootOrchestratorSession({ primer: primerState() });
    const registryNames = CANVAS_OPS_TOOLS.map((t) => t.name);
    expect(session.attachedToolNames()).toEqual(registryNames);
    expect(session.toolIndex.map((e) => e.name)).toEqual(registryNames);
    for (const userOp of USER_CANVAS_COMMANDS) {
      expect(registryNames).not.toContain(userOp);
    }
    for (const engineOp of ["project", "invalidate", "carry", "order"]) {
      expect(registryNames).not.toContain(engineOp);
    }
  });

  it("refuses to boot a surface that leaks a user-only op", () => {
    const leaked = [
      ...CANVAS_OPS_TOOLS,
      {
        name: "canvas.disposition",
        description: "leak",
        kind: "interaction" as const,
        readOnly: false,
        alwaysLoad: false,
        params: [],
        handle: () => ({
          ok: false as const,
          error: { code: "unknown-tool" as const, message: "x" },
        }),
      },
    ];
    expect(() => bootOrchestratorSession({ primer: primerState(), tools: leaked })).toThrow(
      /user-only op/,
    );
  });

  it("answers 'where are we / what have I not looked at' from the primer with no tool call", () => {
    const session = bootOrchestratorSession({ primer: primerState() });
    // The unread + coverage counts are IN the primer text — orientation needs no call.
    expect(session.primer.text).toContain("12 unread");
    expect(session.primer.text).toContain("8/20 dispositioned");
  });

  it("buildRequest injects the current decisions-lens view at request time", () => {
    const session = bootOrchestratorSession({ primer: primerState() });
    const view: ViewState = {
      openCanvasId: "cv_decisions",
      angle: "decisions",
      expandedCohorts: ["coh_a"],
      selection: "dec_1",
    };
    const request = session.buildRequest("does this change the auth path?", view);
    expect(request.viewContext.angle).toBe("decisions");
    expect(request.viewContext.canvasId).toBe("cv_decisions");
  });

  it("buildRequest consumes next-turn events and the open panel carries them verbatim", () => {
    const session = bootOrchestratorSession({ primer: primerState() });
    session.stream.push({ kind: "selected", anchor: "app/x.ts#L1", elementSummary: "x", seq: 1 });
    const view: ViewState = { expandedCohorts: [] };
    const request = session.buildRequest("what is this?", view);
    expect(request.contextEvents).toHaveLength(1);
    // The open-assembled-prompt panel is the primer text plus every pushed event.
    const panel = session.openAssembledPrompt();
    expect(panel.startsWith(session.primer.text)).toBe(true);
    expect(panel).toContain('"anchor":"app/x.ts#L1"');
  });

  it("assembles the same primer bytes across two boots of the same state (deterministic)", () => {
    const a = bootOrchestratorSession({ primer: primerState() });
    const b = bootOrchestratorSession({ primer: primerState() });
    expect(b.primer.digest).toBe(a.primer.digest);
    expect(b.primer.text).toBe(a.primer.text);
  });
});
