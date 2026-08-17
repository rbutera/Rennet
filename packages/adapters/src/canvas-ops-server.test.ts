import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ElementDetail, OpsEnvelope } from "@rennet/core";
import { describe, expect, it } from "vitest";
import {
  buildCanvasOpsTools,
  CANVAS_OPS_INSTRUCTIONS,
  CANVAS_OPS_SERVER_NAME,
  createCanvasOpsServer,
} from "./canvas-ops-server";
import { makeCanvasOpsTestBackend, PATCHSET_ID } from "./canvas-ops-test-backend";

/** Parse the envelope out of an SDK CallToolResult's text content. */
function envelopeOf(result: CallToolResult): OpsEnvelope {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("expected a text content block");
  return JSON.parse(first.text) as OpsEnvelope;
}

type SdkToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

/**
 * Invoke a compiled SDK tool by name. Each `tool()` def carries its own inferred
 * Zod schema, so the heterogeneous array's `handler` arg type collapses to
 * `never`; this casts past that to exercise the real handler with concrete args.
 */
function callTool(
  defs: Awaited<ReturnType<typeof buildCanvasOpsTools>>,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`missing tool def: ${name}`);
  return (def.handler as unknown as SdkToolHandler)(args, {});
}

describe("canvasOps@2 SDK server", () => {
  it("registers an in-process SDK MCP server with the canvasOps@2 tool set", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    const config = await createCanvasOpsServer(backend);
    expect(config.type).toBe("sdk");
    expect(config.name).toBe(CANVAS_OPS_SERVER_NAME);
    expect(config.instance).toBeDefined();
    expect(CANVAS_OPS_INSTRUCTIONS).toContain("MAP of the review");
  });

  it("compiles every descriptor with the right readOnlyHint and alwaysLoad markings", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    const defs = await buildCanvasOpsTools(backend);
    const names = defs.map((d) => d.name);
    expect(names).toEqual([
      "canvas.describe",
      "canvas.view",
      "canvas.focus",
      "canvas.annotate",
      "canvas.propose",
      "canvas.recompute",
      "canvas.read",
      "canvas.thread",
      "diff.read",
      "diff.search",
      "diff.structure",
      "run.ledger",
      "run.provenance",
      "context.map",
      "context.file",
      "context.novelty",
      "context.overview",
      "context.symbol",
      "context.references",
      "context.knowledge",
      "context.ask",
    ]);
    const byName = new Map(defs.map((d) => [d.name, d]));
    // Hot trio is always-loaded (SDK stores it under _meta).
    for (const hot of ["canvas.describe", "canvas.view"]) {
      expect(byName.get(hot)?._meta?.["anthropic/alwaysLoad"]).toBe(true);
    }
    // A non-hot tool is deferred (no always-load meta flag).
    expect(byName.get("run.ledger")?._meta?.["anthropic/alwaysLoad"]).not.toBe(true);
    // readOnlyHint tracks the descriptor: reads true, writers false.
    expect(byName.get("canvas.read")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("diff.search")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.map")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.file")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.novelty")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.overview")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.symbol")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.references")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.knowledge")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("canvas.propose")?.annotations?.readOnlyHint).toBe(false);
    // Structural: no user-only op is exposed as a tool.
    for (const userOp of [
      "canvas.disposition",
      "canvas.adjudicateProposal",
      "canvas.pinAnnotation",
      "canvas.select",
    ]) {
      expect(names).not.toContain(userOp);
    }
  });

  it("round-trips describe(counts) → describe(cohorts) → read(one element) through the SDK handlers", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    const defs = await buildCanvasOpsTools(backend);

    const counts = envelopeOf(await callTool(defs, "canvas.describe", { depth: "counts" }));
    expect((counts.data as { elements: number }).elements).toBe(3);
    expect(counts.freshness).toBe("current");

    const cohorts = envelopeOf(await callTool(defs, "canvas.describe", { depth: "cohorts" }));
    expect(cohorts.total).toBe(2);

    const elements = envelopeOf(await callTool(defs, "canvas.describe", { depth: "elements" }));
    const firstKey = (elements.data as Array<{ elementKey: string }>)[0]?.elementKey ?? "";

    const element = envelopeOf(await callTool(defs, "canvas.read", { ref: firstKey }));
    const detail = element.data as ElementDetail;
    expect(detail.ref).toBe(firstKey);
    expect(detail.element?.elementKey).toBe(firstKey);
  });

  it("round-trips context.map / context.file through the SDK handlers", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    const defs = await buildCanvasOpsTools(backend);

    const map = envelopeOf(await callTool(defs, "context.map", {}));
    expect(map.freshness).toBe("current");
    expect((map.data as { baseOid: string }).baseOid).toBe("a".repeat(40));

    const file = envelopeOf(await callTool(defs, "context.file", { path: "src/c1.ts" }));
    expect(file.freshness).toBe("current");
    expect((file.data as { path: string }).path).toBe("src/c1.ts");

    // context.file with no path → malformed call, isError.
    const bad = await callTool(defs, "context.file", {});
    expect(bad.isError).toBe(true);
  });

  it("round-trips context.novelty through the SDK handler", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    const defs = await buildCanvasOpsTools(backend);

    const novelty = envelopeOf(await callTool(defs, "context.novelty", {}));
    expect(novelty.freshness).toBe("current");
    const ledger = novelty.data as { baseOid: string; entries: Array<{ classification: string }> };
    expect(ledger.baseOid).toBe("a".repeat(40));
    expect(ledger.entries[0]?.classification).toBe("novel");
    expect(novelty.evidence).toEqual(["a".repeat(40), "fp", PATCHSET_ID]);
  });

  it("returns isError on a malformed call, distinguishable from a nothing-found reply", async () => {
    const { backend } = makeCanvasOpsTestBackend();
    const defs = await buildCanvasOpsTools(backend);

    // Malformed: canvas.read with no ref → isError.
    const bad = await callTool(defs, "canvas.read", {});
    expect(bad.isError).toBe(true);

    // Nothing-found: diff.search matches nothing → ok envelope, total 0, scope named.
    const empty = envelopeOf(await callTool(defs, "diff.search", { query: "no-match" }));
    expect(empty.total).toBe(0);
    expect((empty.data as { scope: string }).scope).toContain("no-match");
  });

  it("applies a write op's effect through the backend (annotate ⇒ L3, never L2)", async () => {
    const { backend, applied } = makeCanvasOpsTestBackend();
    const defs = await buildCanvasOpsTools(backend);
    await callTool(defs, "canvas.annotate", {
      target: "rennet:chunk/c1",
      kind: "highlight",
      body: "note",
    });
    expect(applied.length).toBe(1);
    expect(applied[0]?.kind).toBe("annotate");
    // No effect a canvasOps handler can produce is an L2 disposition write.
    expect(applied.map((e) => e.kind)).not.toContain("disposition");
  });
});
