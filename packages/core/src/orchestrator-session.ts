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

/**
 * Assert the attached surface IS the canvasOps@2 registry — the same tool names,
 * in the same order (spec: "a tool index equal to the live canvasOps@2
 * registry"). Equality is the whole guarantee: the registry contains no user-only
 * op (L2 sovereignty) and no engine-only op, so a surface that equals it cannot
 * leak one — and it also cannot silently OMIT, ADD, or REORDER an op, which a
 * per-op denylist misses (a bare-name denylist never matches a namespaced
 * `canvas.project`, and an empty surface trips nothing). A mis-composed surface
 * is a programming error, thrown at boot rather than discovered when the model
 * calls a tool the in-process server (built from the same registry) never
 * registered — so the session's tool index and the attached MCP server cannot
 * diverge.
 */
function assertRegistrySurface(tools: readonly CanvasOpsTool[]): void {
  const got = tools.map((t) => t.name);
  const want = CANVAS_OPS_TOOLS.map((t) => t.name);
  if (got.length === want.length && got.every((name, index) => name === want[index])) return;
  const wanted = new Set(want);
  const extras = got.filter((name) => !wanted.has(name));
  const userLeak = extras.find((name) =>
    (USER_CANVAS_COMMANDS as readonly string[]).includes(name),
  );
  if (userLeak) throw new Error(`orchestrator surface exposes a user-only op: ${userLeak}`);
  throw new Error(
    `orchestrator surface must equal the canvasOps@2 registry; got [${got.join(", ")}]`,
  );
}

/**
 * Boot a fresh orchestrator session: derive the B5 tool index from the attached
 * surface, assemble the primer, record its digest in provenance, and wire the
 * context-update stream. Pure and deterministic given its inputs.
 */
export function bootOrchestratorSession(config: OrchestratorSessionConfig): OrchestratorSession {
  const tools = config.tools ?? CANVAS_OPS_TOOLS;
  assertRegistrySurface(tools);
  const harness = config.harness ?? "claude";
  const fresh = config.fresh ?? true;

  // The index (and thus the primer's B5 menu) is derived from the canonical
  // registry, not from `config.tools`: `assertRegistrySurface` has already proven
  // they are equal, and the in-process MCP server is built from the same
  // `CANVAS_OPS_TOOLS`, so index == menu == attached server by construction.
  const toolIndex = toolIndexFromSurface(CANVAS_OPS_TOOLS);
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
    attachedToolNames: () => CANVAS_OPS_TOOLS.map((t) => t.name),
    buildRequest: (question, view) => {
      // Ask time IS the deixis boundary: drain any buffered `{viewing}` into the
      // log so "what is the user looking at now" reaches the orchestrator (nothing
      // else on the live path ever flushes the batcher). Then consume the
      // next-turn events. drain delivers the latest-seq viewings, so the log stays
      // seq-monotonic.
      stream.drainViewing();
      return buildOrchestratorRequest(question, view, stream.startTurn());
    },
    openAssembledPrompt: () => renderOpenAssembledPrompt(primer.text, stream.entries()),
  };
}
