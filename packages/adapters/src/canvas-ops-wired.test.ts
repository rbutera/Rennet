import { type CanvasOpsBackend, ORCHESTRATOR_CANVAS_OPS, USER_CANVAS_COMMANDS } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { buildCanvasOpsTools } from "./canvas-ops-server";
import { attachOrchestratorSession } from "./orchestrator-session-server";

// ─────────────────────────────────────────────────────────────────────────────
// #49 item 3 — the WIRED canvasOps@2 registry is L2-free by construction.
//
// The model-level proof (canvas.test.ts) asserts `ORCHESTRATOR_CANVAS_OPS` carries
// no disposition writer. This closes the remaining gap: the WIRED surface — the
// SDK tool defs `buildCanvasOpsTools` actually produces and hands to the in-process
// MCP server the model calls — cannot expose an L2 disposition writer either.
//
// The invariant is over the EFFECT-CAPABLE (write) wired tools: every wired tool
// whose `readOnlyHint` is false is a member of `ORCHESTRATOR_CANVAS_OPS`, and that
// set is a STRICT subset (the read-only orchestrator ops describe/view are in the
// vocabulary but not in the write set). A wired `canvas.disposition` (an L2 writer,
// readOnlyHint false, absent from `ORCHESTRATOR_CANVAS_OPS`) would break the subset
// — so it is impossible by construction, not by prompt. Red-provable.
// ─────────────────────────────────────────────────────────────────────────────

/** The registry inspection never CALLS a handler, so a minimal backend stub suffices. */
const backend = {} as CanvasOpsBackend;

const ORCHESTRATOR_OPS = new Set<string>(ORCHESTRATOR_CANVAS_OPS);
const USER_OPS = new Set<string>(USER_CANVAS_COMMANDS);

describe("the wired canvasOps@2 registry is L2-free (#49 item 3)", () => {
  it("its effect-capable tools are a STRICT subset of ORCHESTRATOR_CANVAS_OPS", async () => {
    const defs = await buildCanvasOpsTools(backend);
    const wiredWriteOps = defs
      .filter((def) => def.annotations?.readOnlyHint === false)
      .map((def) => def.name);

    // Non-empty: the wired surface really does carry write ops (focus/annotate/
    // propose/recompute) — this is not a vacuous subset over an empty set.
    expect(wiredWriteOps.length).toBeGreaterThan(0);
    // Subset: every effect-capable wired op is a sanctioned orchestrator op.
    for (const op of wiredWriteOps) expect(ORCHESTRATOR_OPS.has(op)).toBe(true);
    // STRICT: the read-only orchestrator ops (describe/view) are in the vocabulary
    // but not in the write set, so the write set is properly smaller.
    expect(wiredWriteOps.length).toBeLessThan(ORCHESTRATOR_CANVAS_OPS.length);
  });

  it("wires NO user-only op — no L2 disposition writer reaches the model", async () => {
    const defs = await buildCanvasOpsTools(backend);
    const wiredNames = defs.map((def) => def.name);
    for (const name of wiredNames) expect(USER_OPS.has(name)).toBe(false);
    // The specific L2 writer the sovereignty proof names is absent from the wire.
    expect(wiredNames).not.toContain("canvas.disposition");
  });

  it("the wired names EQUAL the session's attached tool index (cannot diverge)", async () => {
    const defs = await buildCanvasOpsTools(backend);
    const wiredNames = defs.map((def) => def.name);
    const { session } = await attachOrchestratorSession(backend, {
      primer: {
        identity: { reviewId: "r", patchsetId: "p" },
        freshness: [],
        canvasState: [],
        runLedger: { fleetTasks: 0, admitted: 0, rejected: 0 },
      },
      harness: "claude",
      fresh: true,
    });
    // The session's tool index and the wired MCP server are built from the SAME
    // registry, so a mis-composed surface is a boot-time throw, never a divergence
    // discovered when the model calls a tool the server never registered.
    expect([...session.attachedToolNames()]).toEqual(wiredNames);
  });

  it("is red-provable: a wired canvas.disposition writer breaks the subset", () => {
    // The predicate the green test asserts, applied to a SYNTHETIC wired set that
    // adds an L2 disposition writer (readOnlyHint false). The predicate MUST reject
    // it — proving the assertion can go red, not merely that today it is green.
    const predicate = (writeOps: readonly string[]): boolean =>
      writeOps.length > 0 && writeOps.every((op) => ORCHESTRATOR_OPS.has(op));

    const sanctioned = ["canvas.focus", "canvas.annotate", "canvas.propose", "canvas.recompute"];
    expect(predicate(sanctioned)).toBe(true);

    const withL2Writer = [...sanctioned, "canvas.disposition"];
    expect(predicate(withL2Writer)).toBe(false);
  });
});
