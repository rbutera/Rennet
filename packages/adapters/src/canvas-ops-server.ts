import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CANVAS_OPS_TOOLS,
  CANVAS_OPS_VERSION,
  type CanvasOpsBackend,
  type CanvasOpsTool,
  type ToolArgs,
  type ToolParam,
} from "@rennet/core";
import { type ZodRawShape, type ZodTypeAny, z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// canvasOps@2 — the SDK transport (issue #12)
//
// The Claude orchestrator slot reaches the pure `canvasOps@2` surface
// (`@rennet/core`) as an IN-PROCESS MCP server built with the Agent SDK's
// `createSdkMcpServer` + `tool()`. This module is transport only: it compiles
// each descriptor's neutral param spec into a Zod input schema, wraps the pure
// handler into a `CallToolResult`, and applies the (structurally L2-free) effects
// through the backend. The contract lives in core; codex/omp reach the SAME
// descriptors as external MCP later — one contract, no `if (harness === X)`.
//
// Two markings ride the transport: read-only tools carry `readOnlyHint` (letting
// the harness parallelise them), and the hot trio (`canvas.describe`,
// `canvas.view`) is `alwaysLoad` so the core loop never pays a tool-search
// round-trip; every other schema stays deferred (§2.5).
//
// The SDK is loaded with a LAZY dynamic `import()`, never a static one — the same
// discipline `claude-query.ts` keeps. A static import drags the SDK's per-platform
// native binary into every bundle that touches `@rennet/adapters` (the Electron
// main build panics Rolldown on it), so these builder functions are async and pull
// the SDK only when the server is actually constructed. The loader is injectable
// so a test can supply a fake without the SDK.
// ─────────────────────────────────────────────────────────────────────────────

/** The two SDK primitives this transport needs, lazily loaded. */
type CanvasOpsSdk = {
  createSdkMcpServer: typeof import("@anthropic-ai/claude-agent-sdk").createSdkMcpServer;
  tool: typeof import("@anthropic-ai/claude-agent-sdk").tool;
};

/** Loads the SDK primitives. Injectable so a hermetic test can supply a fake. */
export type LoadCanvasOpsSdk = () => Promise<CanvasOpsSdk>;

const loadRealSdk: LoadCanvasOpsSdk = async () => {
  const module = await import("@anthropic-ai/claude-agent-sdk");
  return { createSdkMcpServer: module.createSdkMcpServer, tool: module.tool };
};

/**
 * The protocol-card semantics (§4), as the server's MCP `instructions`. Short by
 * design — the schemas carry the per-tool detail; this teaches the semantics a
 * schema cannot: cite evidence, surface staleness, respect cursors.
 */
export const CANVAS_OPS_INSTRUCTIONS = [
  "You are the orchestrator for a Rennet review. Your context holds a MAP of the review, not the review — the state is one tool call away and always fresher than your memory of it.",
  "Zoom: canvas.describe (counts → cohorts → elements) then canvas.read of one thing. canvas.view is what the user is looking at.",
  "The code: diff.read, diff.search (anchors, then zoom), diff.structure (the reading-order DAG). What ran and what it cost: run.ledger, run.provenance.",
  "The project (base branch, model-free): context.map (structure), context.file (one file's facts), context.novelty (the change vs the baseline). NAVIGATE THE CODE SYMBOLICALLY BEFORE DUMPING WHOLE FILES: context.overview lists a file's exported symbols so you learn its shape without reading it, context.symbol resolves an exported symbol NAME to its definition site(s) so you jump straight to where something is defined, and context.references finds every occurrence site of an identifier NAME for blast radius (where is this used?) — name-based and textual, so it is honest about not being semantic. Reach for these to pull the symbol or lines you need — do not read an entire file to find one thing.",
  "You may focus, annotate (ephemeral), propose (the user decides — accepting a proposal is a user act and only then a disposition), and recompute (explicit, budget-gated). You cannot mark anything read, edit analysis, or reorder cohorts.",
  "Every reply is {data, evidence, freshness, total/cursor}: cite the evidence; if freshness is not 'current', say so before relying on it; a cursor means more exists — never present a page as the whole. 'Nothing found' (total 0, scope named) is a real answer, not a failure.",
].join("\n");

/** Compile one neutral param into a Zod type, carrying its description. */
function paramToZod(param: ToolParam): ZodTypeAny {
  let base: ZodTypeAny;
  switch (param.type) {
    case "string":
      base = z.string();
      break;
    case "string[]":
      base = z.array(z.string());
      break;
    case "number":
      base = z.number();
      break;
    case "boolean":
      base = z.boolean();
      break;
    case "enum": {
      const values = param.enum ?? [];
      base = values.length > 0 ? z.enum([...values] as [string, ...string[]]) : z.string();
      break;
    }
  }
  const described = base.describe(param.description);
  return param.optional ? described.optional() : described;
}

/** Compile a descriptor's param list into a Zod raw shape for the SDK. */
export function toZodShape(params: readonly ToolParam[]): ZodRawShape {
  const shape: Record<string, ZodTypeAny> = {};
  for (const param of params) shape[param.name] = paramToZod(param);
  return shape;
}

/** Wrap a pure core handler into an SDK `CallToolResult` handler over `backend`. */
export function toSdkHandler(descriptor: CanvasOpsTool, backend: CanvasOpsBackend) {
  return async (args: Record<string, unknown>): Promise<CallToolResult> => {
    // Almost every handler is synchronous; `context.ask` returns a Promise. Await
    // covers both — a plain value passes through unchanged.
    const outcome = await descriptor.handle(args as ToolArgs, backend);
    if (!outcome.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: outcome.error }) }],
        isError: true,
      };
    }
    // The host applies the (L3 / presentational / recompute) effects; the
    // envelope is the model-facing payload, carried as text plus structured
    // content for programmatic consumers.
    backend.applyEffects(outcome.effects);
    return {
      content: [{ type: "text", text: JSON.stringify(outcome.envelope) }],
      structuredContent: outcome.envelope as unknown as { [key: string]: unknown },
    };
  };
}

/**
 * Build the SDK tool definitions for the whole `canvasOps@2` surface, bound to a
 * backend. Exposed separately from the server so a caller can inspect the
 * compiled defs (name, `readOnlyHint`, `alwaysLoad`) and round-trip a handler
 * without constructing a live MCP server. Async because the SDK is lazily loaded.
 */
export async function buildCanvasOpsTools(
  backend: CanvasOpsBackend,
  loadSdk: LoadCanvasOpsSdk = loadRealSdk,
): Promise<SdkMcpToolDefinition<ZodRawShape>[]> {
  const { tool } = await loadSdk();
  return CANVAS_OPS_TOOLS.map((descriptor) =>
    tool(
      descriptor.name,
      descriptor.description,
      toZodShape(descriptor.params),
      toSdkHandler(descriptor, backend),
      {
        annotations: { readOnlyHint: descriptor.readOnly },
        alwaysLoad: descriptor.alwaysLoad,
      },
    ),
  );
}

/** The SDK server version derived from `canvasOps@2` (semver form for MCP). */
export const CANVAS_OPS_SERVER_VERSION = "2.0.0";

/** The MCP server name for the canvasOps@2 surface. */
export const CANVAS_OPS_SERVER_NAME = "rennet-canvas-ops";

/**
 * Create the in-process MCP server that exposes `canvasOps@2` to the Claude
 * orchestrator slot. Pass its result in `query()`'s `mcpServers` option. The
 * server holds no state of its own — every call reads/writes through `backend`.
 * Async because the SDK is lazily loaded (see the module header).
 */
export async function createCanvasOpsServer(
  backend: CanvasOpsBackend,
  loadSdk: LoadCanvasOpsSdk = loadRealSdk,
): Promise<McpSdkServerConfigWithInstance> {
  // `CANVAS_OPS_VERSION` ("canvasOps@2") is the surface's contract version; the
  // MCP `version` field is semver, so it rides in the instructions, not here.
  void CANVAS_OPS_VERSION;
  const { createSdkMcpServer } = await loadSdk();
  return createSdkMcpServer({
    name: CANVAS_OPS_SERVER_NAME,
    version: CANVAS_OPS_SERVER_VERSION,
    instructions: CANVAS_OPS_INSTRUCTIONS,
    tools: await buildCanvasOpsTools(backend, loadSdk),
  });
}
