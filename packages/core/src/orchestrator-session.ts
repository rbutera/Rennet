import { USER_CANVAS_COMMANDS } from "./canvas";
import type { CanvasChangeFeed } from "./canvas-change-feed";
import {
  CANVAS_OPS_TOOLS,
  CANVAS_OPS_VERSION,
  type CanvasOpsTool,
  type ViewState,
} from "./canvas-ops";
import {
  buildOrchestratorRequest,
  ContextUpdateStream,
  type OrchestratorRequest,
  renderOpenAssembledPrompt,
  ViewingBatcher,
} from "./context-update-stream";
import {
  assemblePrimer,
  type PrimerInputs,
  type PrimerManifest,
  type PrimerToolEntry,
  toolIndexFromSurface,
} from "./orchestrator-primer";

// ─────────────────────────────────────────────────────────────────────────────
// The orchestrator session (issue #13) — ONE user-picked harness+session, FRESH
// BY DEFAULT (OQ9), primed as a MAP and taught to ask. It ties three pure pieces
// together: the lean primer (digest recorded in provenance), the attached
// canvasOps@2 tool surface (#12), and the context-update stream (§3.2). The SDK
// wiring that turns the attached surface into a live in-process MCP server lives
// in `@rennet/adapters` (`attachOrchestratorSession`); this module is harness-
// agnostic and node-free.
//
// The B5 tool index is DERIVED from the attached surface here, not trusted from
// the caller, so the primer's menu and the attachable surface agree by
// construction — the "attached tool index equals the canvasOps@2 registry"
// property is structural (#49 item 3).
// ─────────────────────────────────────────────────────────────────────────────

/** The orchestrator harness slot (user-picked; OQ9). */
export type OrchestratorHarness = "claude" | "codex" | "omp";

/** The already-derived primer state MINUS the tool index (the session derives B5). */
export type OrchestratorPrimerState = Omit<PrimerInputs, "toolIndex">;

export interface OrchestratorSessionConfig {
  /** The primer's already-derived state (B1/B2/B3/B6); B5 is derived from the surface. */
  primer: OrchestratorPrimerState;
  /** The harness slot. Default "claude". */
  harness?: OrchestratorHarness;
  /** Fresh session (the default and the only shape OQ9 ships). */
  fresh?: boolean;
  /** The attached canvasOps@2 surface. Default: the live `CANVAS_OPS_TOOLS` registry. */
  tools?: readonly CanvasOpsTool[];
  /** Optional #10 change feed the stream consumes. */
  changeFeed?: CanvasChangeFeed;
  /** Canvases to subscribe on the feed. */
  canvasIds?: readonly string[];
  /** The injected clock for the viewing batcher (default `Date.now`). */
  clock?: () => number;
  /** The viewing-batch window in ms. */
  windowMs?: number;
}

/** The session's provenance — the digest that makes "the orchestrator is primed" checkable. */
export interface OrchestratorSessionProvenance {
  fresh: boolean;
  harness: OrchestratorHarness;
  surfaceVersion: string;
  primerVersion: string;
  cardVersion: string;
  primerDigest: string;
  primerBytes: number;
}

/** A booted orchestrator session. */
export interface OrchestratorSession {
  harness: OrchestratorHarness;
  fresh: boolean;
  primer: PrimerManifest;
  provenance: OrchestratorSessionProvenance;
  stream: ContextUpdateStream;
  /** B5 — the tool index (name + when-to-use), derived from the attached surface. */
  toolIndex: readonly PrimerToolEntry[];
  /** The attached surface's tool names, in registry order. */
  attachedToolNames(): readonly string[];
  /** Build a request at ask time: injects the current view + consumes next-turn events. */
  buildRequest(question: string, view: ViewState): OrchestratorRequest;
  /** The byte-for-byte inspectable open-assembled-prompt panel (primer + pushed events). */
  openAssembledPrompt(): string;
}

/** The user-only and engine-only op names that must NEVER appear on the surface. */
const ENGINE_ONLY_OPS: readonly string[] = ["project", "invalidate", "carry", "order"];

/**
 * Assert the attached surface is a valid orchestrator surface: it contains no
 * user-only op (L2 sovereignty) and no engine-only op. Thrown at boot rather than
 * discovered at runtime — a mis-composed surface is a programming error.
 */
function assertActorPartition(tools: readonly CanvasOpsTool[]): void {
  const names = new Set(tools.map((t) => t.name));
  for (const userOp of USER_CANVAS_COMMANDS) {
    if (names.has(userOp))
      throw new Error(`orchestrator surface exposes a user-only op: ${userOp}`);
  }
  for (const engineOp of ENGINE_ONLY_OPS) {
    if (names.has(engineOp))
      throw new Error(`orchestrator surface exposes an engine-only op: ${engineOp}`);
  }
}

/**
 * Boot a fresh orchestrator session: derive the B5 tool index from the attached
 * surface, assemble the primer, record its digest in provenance, and wire the
 * context-update stream. Pure and deterministic given its inputs.
 */
export function bootOrchestratorSession(config: OrchestratorSessionConfig): OrchestratorSession {
  const tools = config.tools ?? CANVAS_OPS_TOOLS;
  assertActorPartition(tools);
  const harness = config.harness ?? "claude";
  const fresh = config.fresh ?? true;

  const toolIndex = toolIndexFromSurface(tools);
  const primer = assemblePrimer({ ...config.primer, toolIndex });

  const batcher = new ViewingBatcher({
    now: config.clock ?? Date.now,
    ...(config.windowMs !== undefined ? { windowMs: config.windowMs } : {}),
  });
  const streamOptions: ConstructorParameters<typeof ContextUpdateStream>[0] = { batcher };
  if (config.changeFeed) streamOptions.changeFeed = config.changeFeed;
  if (config.canvasIds) streamOptions.canvasIds = config.canvasIds;
  const stream = new ContextUpdateStream(streamOptions);

  const provenance: OrchestratorSessionProvenance = {
    fresh,
    harness,
    surfaceVersion: CANVAS_OPS_VERSION,
    primerVersion: primer.version,
    cardVersion: primer.cardVersion,
    primerDigest: primer.digest,
    primerBytes: primer.bytes,
  };

  return {
    harness,
    fresh,
    primer,
    provenance,
    stream,
    toolIndex,
    attachedToolNames: () => tools.map((t) => t.name),
    buildRequest: (question, view) => buildOrchestratorRequest(question, view, stream.startTurn()),
    openAssembledPrompt: () => renderOpenAssembledPrompt(primer.text, stream.entries()),
  };
}
