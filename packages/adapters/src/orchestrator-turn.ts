import { randomUUID } from "node:crypto";
import type { Query, Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";
import {
  buildContextSendRecord,
  type CanvasOpsBackend,
  createSeqCounter,
  type EnvelopeContext,
  type HarnessError,
  type HarnessPort,
  type Locus,
  type OrchestratorPrimerState,
  type OrchestratorSession,
  type RepoFreshness,
  type ReviewBackendState,
  type RunLedgerHeadline,
  renderOpenAssembledPrompt,
  summarizeCanvasCounts,
  type UserAct,
} from "@rennet/core";
import { renderLayer } from "@rennet/instructions";
import type { Canvas, ContextSendRecord } from "@rennet/types";
import { attachCodexOrchestratorSession } from "./canvas-ops-external";
import { CANVAS_OPS_SERVER_NAME, type LoadCanvasOpsSdk } from "./canvas-ops-server";
import { normalizeClaudeFrame } from "./claude-adapter";
import type { LiveSnapshotOutcome } from "./live-review-backend";
import { attachOrchestratorSession } from "./orchestrator-session-server";

// ─────────────────────────────────────────────────────────────────────────────
// The live orchestrator turn (issue #13, wave 2). This is the half that turns the
// wave-1 backend + the attachable session into a LIVE model turn:
//
//   deriveOrchestratorPrimerState(...)   ← the already-derived B1/B2/B3/B6 primer
//     ↓                                    state, read from the live review/backend
//   attachOrchestratorSession(backend)   ← the session + the in-process canvasOps@2
//     ↓                                    MCP server (#12)
//   query({ prompt, options })           ← the user's own `claude` (R2 subscription
//                                          OAuth) with THAT MCP server in mcpServers
//
// It does NOT ship a conversational UI loop (deferred). It ships the primitive a
// loop would call: drive ONE orchestrator turn over the live backend and surface
// the canvasOps@2 tool calls the model made. The SDK `query()` is loaded with a
// LAZY dynamic import (the same discipline `claude-query.ts` keeps), so importing
// `@rennet/adapters` never eagerly drags the SDK's native binary in, and a
// hermetic test drives the wiring with an injected fake `query()` — no model, no
// spend. A model is spawned ONLY when the returned turn actually iterates.
//
// KNOWN §7.2 DEVIATION (inherited from `wire-live-review-pipeline`, unchanged and
// NOT widened): the turn runs with `cwd` on the live mutable checkout rather than
// an immutable materialisation of the patchset. The immutable-materialisation
// isolation is #30 and deferred. Named here so it is not silently widened.
// ─────────────────────────────────────────────────────────────────────────────

/** The SDK's `query()` surface, narrowed to what this module calls. */
type SdkQuery = (params: { prompt: string; options?: SdkOptions }) => Query;

/** Loads the real SDK `query()`. Injectable so a hermetic test supplies a fake. */
export type LoadSdkQuery = () => Promise<SdkQuery>;

const loadRealQuery: LoadSdkQuery = async () => {
  const module = await import("@anthropic-ai/claude-agent-sdk");
  return module.query as unknown as SdkQuery;
};

// ── Primer derivation (B1/B2/B3/B6 from the live review + backend) ─────────────

/**
 * The B2 snapshot-freshness verdict, read from the LIVE backend rather than
 * assumed. The repo-map read (`context.map`) passes through the same fail-closed
 * snapshot gate the orchestrator will hit, so its verdict is the honest one:
 * `current` when the snapshot is served at the pinned OID, `stale` when the store
 * holds a snapshot for a different OID, and `failed` when there is no usable
 * snapshot at all (absent/corrupt) — never a fabricated "current".
 */
function snapshotFreshnessVerdict(backend: CanvasOpsBackend): RepoFreshness["verdict"] {
  const map = backend.projectMap();
  if (map.ok) return "current";
  switch (map.failure.reason) {
    case "stale":
      return "stale";
    default:
      // `absent` (no snapshot) and `corrupt` (integrity failure) both mean the map
      // is unavailable — the honest verdict is a failed snapshot, not "updating"
      // (generation is synchronous-on-open in this wave, never pending here).
      return "failed";
  }
}

/**
 * The B6 run-ledger headline, summed from the backend's recorded rows. In v1 the
 * ledger is distinguished-empty (`reviewBackendCore` records no fabricated row),
 * so this is honestly `0 fleet tasks` for a fresh review — never a faked count. A
 * follow-up that lights up the per-run ledger flows through here unchanged.
 */
function runLedgerHeadline(backend: CanvasOpsBackend): RunLedgerHeadline {
  const rows = backend.runLedger();
  let admitted = 0;
  let rejected = 0;
  let budgetSpent = 0;
  let budgetRemaining = 0;
  let sawBudget = false;
  for (const row of rows) {
    admitted += row.admitted;
    rejected += row.rejected;
    if (row.budgetSpent !== undefined || row.budgetRemaining !== undefined) {
      sawBudget = true;
      budgetSpent += row.budgetSpent ?? 0;
      budgetRemaining += row.budgetRemaining ?? 0;
    }
  }
  return {
    fleetTasks: rows.length,
    admitted,
    rejected,
    ...(sawBudget ? { budgetSpent, budgetRemaining } : {}),
  };
}

/**
 * Derive the orchestrator primer state (B1 identity, B2 freshness, B3 count-level
 * canvas state, B6 run-ledger headline) from the LIVE review + built pipeline +
 * composed backend + snapshot-on-open outcome. B5 (the tool index) is derived by
 * the session from the attached surface, so it is intentionally absent here. Every
 * field is read from the real state — the primer is a MAP of the review, and the
 * map is honest about what the live backend actually holds.
 */
export function deriveOrchestratorPrimerState(
  pipeline: ReviewBackendState["pipeline"],
  backend: CanvasOpsBackend,
  snapshot: LiveSnapshotOutcome,
): OrchestratorPrimerState {
  // Identity is read from the backend (which sources repo/reviewId/patchsetId from
  // the live review), so the review object itself is not needed here.
  const identity = backend.identity();
  // Residue is the decomposition's own residue length — exactly what the live
  // `canvas.describe` counts reply reports (canvas-ops.ts), so the primer's B3
  // count agrees with what the model sees when it zooms.
  const residue = pipeline.decomposition.residue.length;
  const canvasState = backendCanvasState(pipeline, backend.view().openCanvasId, residue);
  const freshness: readonly RepoFreshness[] = [
    {
      repoId: snapshot.repoKey,
      // The snapshot's identifier is the pinned base OID it targets; when no
      // snapshot was generated the verdict below already says `failed`, and the
      // pinned OID is still the honest "what would have been served".
      snapshotId: snapshot.baseOid,
      verdict: snapshotFreshnessVerdict(backend),
    },
  ];
  return {
    identity,
    freshness,
    canvasState,
    runLedger: runLedgerHeadline(backend),
  };
}

/**
 * Count-level state (B3) for the canvases that CARRY orientation: every canvas
 * with content (elements, cohorts, or dispositions) plus the active canvas even if
 * empty (so the model knows what it is looking at). Empty non-active canvases are
 * dropped — the primer is a LEAN map (≤ 4 KB), and an all-zero canvas line is pure
 * noise: the model discovers every angle (including the empty ones) via
 * `canvas.describe`, exactly as B4's card teaches. This keeps the map bounded for a
 * real review where `buildReviewCanvases` emits all six angle canvases but most are
 * empty for a focused change.
 */
function backendCanvasState(
  pipeline: ReviewBackendState["pipeline"],
  activeCanvasId: string | undefined,
  residue: number,
): OrchestratorPrimerState["canvasState"] {
  const canvases = Object.values(pipeline.canvases) as (Canvas | undefined)[];
  return canvases
    .filter((canvas): canvas is Canvas => canvas !== undefined)
    .map((canvas) => summarizeCanvasCounts(canvas, residue))
    .filter(
      (row) =>
        row.canvasId === activeCanvasId ||
        row.elements > 0 ||
        row.cohorts > 0 ||
        row.coverage.dispositioned > 0,
    );
}

// ── The live turn ─────────────────────────────────────────────────────────────

/** One canvasOps@2 tool call the model made during the turn. */
export interface OrchestratorToolCall {
  /** The SDK-namespaced wire tool name (`mcp__rennet-canvas-ops__context_map`). */
  readonly name: string;
  /** The canonical canvasOps@2 op (`context.map`), de-sanitized from the wire name. */
  readonly op: string;
  /** The arguments the model passed. */
  readonly input: Record<string, unknown>;
}

/** The inputs the composition root supplies to drive a live turn. */
export interface OrchestratorTurnDeps {
  /** The user's own discovered `claude` binary (R2: subscription OAuth, $0/token). */
  readonly claudePath: string;
  /** The harness cwd — the live checkout (the inherited §7.2 deviation). */
  readonly cwd: string;
  /** Base env the spawned `claude` inherits (the SDK replaces the child env wholesale). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Optional model override; default is the CLI default. */
  readonly model?: string;
  /** Cancels the turn. */
  readonly abortController?: AbortController;
  /** SDK `query()` loader; defaults to the real lazy import. Injectable for tests. */
  readonly loadQuery?: LoadSdkQuery;
  /** canvasOps@2 MCP-server SDK loader; defaults to the real lazy import. Injectable for tests. */
  readonly loadSdk?: LoadCanvasOpsSdk;
  /**
   * Token-stream sink (issue #251). Called with each `text.delta` as it arrives, so a
   * caller can stream the answer live. The frames already flow through this turn's
   * consume loop (the claude adapter decodes `content_block_delta`); without this hook
   * they were simply dropped. Optional — a non-streaming caller omits it and only reads
   * the final `finalText`. A throw here is not caught, so keep it total.
   */
  readonly onDelta?: (text: string) => void;
  readonly assembledContext?: string;
  readonly onSend?: (record: ContextSendRecord) => void;
  readonly userActs?: readonly UserAct[];
}

/** The outcome of one live orchestrator turn. */
export interface OrchestratorTurnResult {
  /** The booted session (its provenance carries the primer digest — "is it primed"). */
  readonly session: OrchestratorSession;
  /** The canvasOps@2 tool calls the model made, in order. */
  readonly toolCalls: readonly OrchestratorToolCall[];
  /** The model's final text (empty when it ended without one). */
  readonly finalText: string;
  /** Whether the turn reached a clean terminal result. */
  readonly outcome: "completed" | "failed";
  /** Present when the turn failed — the normalized harness error. */
  readonly error?: HarnessError;
}

export interface CodexOrchestratorTurnDeps {
  readonly cwd: string;
  readonly model?: string;
  readonly abortController?: AbortController;
  readonly onDelta?: (text: string) => void;
  readonly assembledContext?: string;
  readonly onSend?: (record: ContextSendRecord) => void;
  readonly userActs?: readonly UserAct[];
  /**
   * The executing codex's locus (#334). A WSL locus makes the canvasOps loopback
   * surface bind to a distro-reachable address; when no route exists the turn
   * settles failed rather than running host-side. Defaults to the host.
   */
  readonly locus?: Locus;
  /** Resolve the selected Codex adapter after the loopback MCP URL exists. */
  readonly resolvePort: (
    mcpServers: Readonly<Record<string, { readonly url: string }>>,
  ) => Promise<HarnessPort>;
}

/**
 * The omp orchestrator turn deps (#26). Structurally identical to
 * {@link CodexOrchestratorTurnDeps} — the omp slot rides the same external-MCP contract —
 * so it is an alias rather than a divergent shape.
 */
export type OmpOrchestratorTurnDeps = CodexOrchestratorTurnDeps;

/**
 * Drive ONE live orchestrator turn against `backend`. Boots the session + the
 * in-process canvasOps@2 MCP server, then runs the user's `claude` with that
 * server in `mcpServers`, the canvasOps@2 tools auto-approved (read-only,
 * in-process; `permissionMode` stays `default`, NEVER a bypass), and the lean
 * primer appended to Claude Code's system prompt. Returns the tool calls the model
 * made so a caller can prove the model reached the LIVE surface (never a fixture).
 *
 * `loadQuery`/`loadSdk` are injectable so a hermetic test drives the whole shape
 * with no SDK and no model; the real turn is exercised by the gated proof.
 */
export async function runOrchestratorTurn(
  backend: CanvasOpsBackend,
  primer: OrchestratorPrimerState,
  question: string,
  deps: OrchestratorTurnDeps,
): Promise<OrchestratorTurnResult> {
  const { session, mcpServer } = await attachOrchestratorSession(
    backend,
    { primer, harness: "claude", fresh: true },
    deps.loadSdk,
  );
  for (const act of deps.userActs ?? []) session.stream.push(act);
  const request = session.buildRequest(question, backend.view());
  const deixisContext = renderOpenAssembledPrompt(
    JSON.stringify(request.viewContext),
    request.contextEvents,
  );

  const serverPrefix = `mcp__${CANVAS_OPS_SERVER_NAME}`;
  const wiredOps = session.attachedToolNames();
  // Claude Code SANITIZES an MCP tool's name on the wire, replacing `.` with `_`
  // (a real turn calls `mcp__rennet-canvas-ops__context_map`, not `…context.map`),
  // so map every wire form back to its canonical canvasOps@2 op. Both the dotted and
  // underscored forms are registered so a caller reads the canonical op regardless
  // of how the harness spelled it.
  const canonicalByWire = new Map<string, string>();
  for (const op of wiredOps) {
    canonicalByWire.set(op, op);
    canonicalByWire.set(op.replace(/\./g, "_"), op);
  }
  // The permission gate is `canUseTool` ALONE (no `allowedTools`): a bare
  // `allowedTools` entry auto-approves BEFORE the callback runs, so listing the
  // canvasOps tools there would shadow the callback and emit a noisy per-turn
  // warning. Gating solely through `canUseTool` keeps one deterministic authority:
  // allow anything on the canvasOps@2 server (dotted OR the harness's sanitized
  // `_` form, both begin with the server prefix), deny everything else. So the
  // headless turn never blocks on a prompt AND a model that wanders off-surface is
  // denied cleanly rather than hanging (no TTY to prompt). `permissionMode` stays
  // `default` — never a bypass.
  const canUseTool: NonNullable<SdkOptions["canUseTool"]> = (toolName, input) =>
    Promise.resolve(
      toolName === serverPrefix || toolName.startsWith(`${serverPrefix}__`)
        ? { behavior: "allow", updatedInput: input }
        : {
            behavior: "deny",
            message: `Only the canvasOps@2 surface is available this turn (blocked ${toolName}).`,
          },
    );

  const systemAppend = [
    session.primer.text,
    ...(deps.assembledContext === undefined ? [] : [renderLayer("context", deps.assembledContext)]),
    deixisContext,
  ].join("\n\n");
  const options: SdkOptions = {
    cwd: deps.cwd,
    pathToClaudeCodeExecutable: deps.claudePath,
    // Read-only review posture (R2): never a bypass mode. The in-process canvasOps
    // tools are auto-approved by `allowedTools`; auth stays on subscription OAuth
    // via the user's own binary above.
    permissionMode: "default",
    // The SDK replaces the child env wholesale, so pass the full env (no key
    // injected — the adapter path DETECTS a metered key, it never forces one).
    env: { ...(deps.env ?? process.env) },
    mcpServers: { [CANVAS_OPS_SERVER_NAME]: mcpServer },
    canUseTool,
    // Append the lean primer to Claude Code's own system prompt (never replace it),
    // exactly as the harness adapter's append-mode does.
    systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend },
    ...(deps.model !== undefined ? { model: deps.model } : {}),
    ...(deps.abortController ? { abortController: deps.abortController } : {}),
  };

  const query = await (deps.loadQuery ?? loadRealQuery)();
  if (deps.onSend) {
    const record = buildContextSendRecord(
      systemAppend,
      {
        seat: "orchestrator",
        harness: "claude-code",
        channel: "system-append",
        attempt: 0,
      },
      deps.assembledContext,
    );
    try {
      deps.onSend(record);
    } catch {
      // Transcript observation must never block or alter the turn.
    }
  }
  const iterator = query({ prompt: question, options });

  const context: EnvelopeContext = {
    harness: "claude-code",
    sessionId: randomUUID(),
    turnId: randomUUID(),
    seq: createSeqCounter(),
    now: Date.now,
  };

  const toolCalls: OrchestratorToolCall[] = [];
  let finalText = "";
  let outcome: "completed" | "failed" = "failed";
  let error: HarnessError | undefined;

  for await (const frame of iterator) {
    for (const event of normalizeClaudeFrame(frame, context)) {
      if (event.kind === "tool.started") {
        const name = event.call.name;
        if (name.startsWith(`${serverPrefix}__`)) {
          const wire = name.slice(serverPrefix.length + 2);
          toolCalls.push({
            name,
            // Canonicalize the sanitized wire name (`context_map`) back to the
            // canvasOps@2 op (`context.map`); fall back to the raw suffix if the
            // op is not a known wired one (never silently invents a dot).
            op: canonicalByWire.get(wire) ?? wire,
            input: event.call.input,
          });
        }
      } else if (event.kind === "text.delta" && event.text) {
        // Stream the token as it arrives (#251). The FINAL text still comes from
        // `text.message`/`session.ended` below — deltas drive the live view, the
        // durable answer is the completed message, never a concatenation of deltas here.
        deps.onDelta?.(event.text);
      } else if (event.kind === "text.message" && event.text) {
        finalText = event.text;
      } else if (event.kind === "session.ended") {
        if (event.outcome.status === "completed") {
          outcome = "completed";
          if (event.outcome.finalText) finalText = event.outcome.finalText;
        } else if (event.outcome.status === "failed") {
          outcome = "failed";
          error = event.outcome.error;
        }
      } else if (event.kind === "error") {
        error = event.error;
      }
    }
  }

  return {
    session,
    toolCalls,
    finalText,
    outcome,
    ...(error ? { error } : {}),
  };
}

/** Drive the same orchestrator session through the Codex HarnessPort. */
export function runCodexOrchestratorTurn(
  backend: CanvasOpsBackend,
  primer: OrchestratorPrimerState,
  question: string,
  deps: CodexOrchestratorTurnDeps,
): Promise<OrchestratorTurnResult> {
  return runExternalMcpOrchestratorTurn(backend, primer, question, deps, "codex");
}

/**
 * Drive the same orchestrator session through the omp HarnessPort (#26). The omp slot
 * reaches canvasOps@2 through the identical external loopback MCP transport the Codex
 * path uses — same descriptors, same contract, no `if (harness === X)` in the canvasOps
 * layer. A faithful mirror of {@link runCodexOrchestratorTurn}: only the harness label
 * differs.
 */
export function runOmpOrchestratorTurn(
  backend: CanvasOpsBackend,
  primer: OrchestratorPrimerState,
  question: string,
  deps: OmpOrchestratorTurnDeps,
): Promise<OrchestratorTurnResult> {
  return runExternalMcpOrchestratorTurn(backend, primer, question, deps, "omp");
}

/**
 * The shared external-MCP orchestrator turn behind both the Codex and omp slots. The
 * only harness-specific input is the session label; the canvasOps transport, the tool
 * collection, and the normalized result are identical (the point of #25's generalisation).
 */
async function runExternalMcpOrchestratorTurn(
  backend: CanvasOpsBackend,
  primer: OrchestratorPrimerState,
  question: string,
  deps: CodexOrchestratorTurnDeps,
  harness: "codex" | "omp",
): Promise<OrchestratorTurnResult> {
  const attached = await attachCodexOrchestratorSession(
    backend,
    { primer, harness, fresh: true },
    deps.locus ? { locus: deps.locus } : {},
  );
  let harnessSession: Awaited<ReturnType<HarnessPort["createSession"]>> | null = null;
  try {
    // No distro-reachable canvas route (#334): settle failed with the plain reason,
    // naming the unreachable surface — never a silent host-codex substitute.
    if (attached.url === null) {
      return {
        session: attached.session,
        toolCalls: [],
        finalText: "",
        outcome: "failed",
        error: {
          class: "harness-unavailable",
          origin: "adapter",
          message:
            attached.unreachableReason ?? "the canvasOps surface is not reachable from the distro",
          retryable: false,
          retryableSource: "inferred",
          nativeCode: null,
        },
      };
    }
    const canvasUrl = attached.url;
    for (const act of deps.userActs ?? []) attached.session.stream.push(act);
    const request = attached.session.buildRequest(question, backend.view());
    const deixisContext = renderOpenAssembledPrompt(
      JSON.stringify(request.viewContext),
      request.contextEvents,
    );
    const prompt = [
      attached.session.primer.text,
      ...(deps.assembledContext === undefined
        ? []
        : [renderLayer("context", deps.assembledContext)]),
      deixisContext,
      question,
    ].join("\n\n");

    if (deps.onSend) {
      const record = buildContextSendRecord(
        prompt,
        { seat: "orchestrator", harness, channel: "prompt", attempt: 0 },
        deps.assembledContext,
      );
      try {
        deps.onSend(record);
      } catch {
        // Transcript observation must never block or alter the turn.
      }
    }

    const port = await deps.resolvePort({ canvasops: { url: canvasUrl } });
    harnessSession = await port.createSession({
      cwd: deps.cwd,
      ...(deps.model === undefined ? {} : { model: deps.model }),
      ...(deps.abortController === undefined ? {} : { signal: deps.abortController.signal }),
    });
    await harnessSession.send({ prompt });

    const toolCalls: OrchestratorToolCall[] = [];
    let finalText = "";
    let outcome: "completed" | "failed" = "failed";
    let error: HarnessError | undefined;
    for await (const event of harnessSession.events) {
      if (event.kind === "tool.started" && event.call.kind === "mcp") {
        toolCalls.push({ name: event.call.name, op: event.call.name, input: event.call.input });
      } else if (event.kind === "text.delta" && event.text) {
        deps.onDelta?.(event.text);
      } else if (event.kind === "text.message" && event.text) {
        finalText = event.text;
      } else if (event.kind === "session.ended") {
        if (event.outcome.status === "completed") {
          outcome = "completed";
          if (event.outcome.finalText) finalText = event.outcome.finalText;
        } else if (event.outcome.status === "failed") {
          error = event.outcome.error;
        }
      } else if (event.kind === "error") {
        error = event.error;
      }
    }

    return {
      session: attached.session,
      toolCalls,
      finalText,
      outcome,
      ...(error ? { error } : {}),
    };
  } finally {
    await harnessSession?.close();
    await attached.close();
  }
}
