/**
 * The composition-root transport for the omp adapter (#26): the one place that spawns
 * `omp --mode rpc` and streams its line-delimited JSON frames. This is the real
 * implementation of the injected `OmpTurnTransport` seam — the third instance of the
 * `claude-query.ts` / `codex-turn-transport.ts` pattern.
 *
 * The one honesty constraint (design): NO turn has ever been executed against `omp`.
 * The stdin/stdout protocol here is assembled from the installed `.d.ts` shapes, and it
 * is exercised ONLY behind `RENNET_LIVE_OMP=1` (the gated real conformance run) — the
 * default gate spawns NOTHING for this slot and spends nothing. A wrong guess about the
 * wire bytes therefore cannot overclaim: the hermetic run caps at `implementedByAdapter`,
 * every outer capability flag stays false, and the real run corrects the fake and
 * decoders against observed bytes before any tested range is recorded.
 *
 * Never reads a credential: `omp` authenticates itself on the user's own configuration.
 * Never bundles an `omp` or `bun` binary.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runConformance } from "@rennet/core";
import { execa } from "execa";
import {
  type DiscoveryDeps,
  type DiscoveryResult,
  defaultOmpDiscoveryDeps,
  discoverOmp,
} from "./harness-discovery";
import {
  buildOmpTurnArgs,
  encodeOmpPromptFrame,
  OmpAdapter,
  type OmpAdapterConfig,
  type OmpTurnResultFrame,
  type OmpTurnSpec,
  type OmpTurnTransport,
} from "./omp-adapter";

/**
 * Render the loopback MCP overlay omp loads via `--config`. omp configures MCP through a
 * config overlay (not per-key CLI flags), so the canvasOps@2 URL lands here rather than
 * in the wire mapping. YAML is `config.yml`-style; kept minimal and correctable on the
 * first real run.
 */
export function renderOmpMcpConfig(
  mcpServers: Readonly<Record<string, { readonly url: string }>>,
): string {
  const lines = ["mcpServers:"];
  for (const [name, server] of Object.entries(mcpServers)) {
    lines.push(`  ${name}:`, `    transport: http`, `    url: ${server.url}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The process effects the transport needs, injected so the wiring is testable. */
export interface OmpTransportEffects {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
  /** Spawn `omp --mode rpc`, write the prompt command to stdin, yield raw JSONL frames. */
  readonly spawn: (
    bin: string,
    args: readonly string[],
    cwd: string,
    prompt: string,
    signal?: AbortSignal,
  ) => AsyncIterable<unknown>;
}

/** Tolerantly scan a frame for a session-stats USD cost (omp `SessionStats.cost`). */
function frameCost(frame: unknown): number | null {
  if (frame === null || typeof frame !== "object") return null;
  const record = frame as Record<string, unknown>;
  const data = record.data;
  const cost =
    data && typeof data === "object" ? (data as Record<string, unknown>).cost : undefined;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
}

/**
 * Write the prompt as one `{ type: "prompt" }` RPC command on stdin, then read stdout
 * lines and yield each JSON frame, then the synthetic terminal frame. Stdin is ended
 * after the prompt so the `--no-session` single-turn `omp` winds down when the turn is
 * done. The observed cost rides the terminal frame (top-level) so the conformance
 * `costUsd` check can find it; finalText/usage the adapter also tracks from the stream.
 */
async function* realSpawn(
  bin: string,
  args: readonly string[],
  cwd: string,
  prompt: string,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  const child = execa(bin, [...args], {
    cwd,
    stdin: "pipe",
    reject: false,
    buffer: false,
    killDescendants: true,
    forceKillAfterDelay: 1_000,
    ...(signal === undefined ? {} : { cancelSignal: signal }),
  });
  child.stdin?.write(encodeOmpPromptFrame(prompt));
  child.stdin?.end();
  let stderr = "";
  child.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  let cost: number | null = null;
  const stdout = child.stdout;
  if (stdout) {
    const lines = createInterface({ input: stdout });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const frame = JSON.parse(trimmed);
        const seen = frameCost(frame);
        if (seen !== null) cost = seen;
        yield frame;
      } catch {
        // A non-JSON line (a stray log line) — skip; nothing modelled is a partial line.
      }
    }
  }
  const result = await child;
  const aborted = result.isCanceled === true || signal?.aborted === true;
  const terminal: OmpTurnResultFrame = {
    rennet: "turn-result",
    exitCode: result.exitCode ?? 1,
    finalText: null,
    usage: null,
    cost,
    aborted,
    stderr,
  };
  yield terminal;
}

export const defaultOmpTransportEffects: OmpTransportEffects = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  rm: (path) => rm(path, { recursive: true, force: true }),
  spawn: (bin, args, cwd, prompt, signal) => realSpawn(bin, args, cwd, prompt, signal),
};

/**
 * Build the real `OmpTurnTransport`: for each turn, write the loopback MCP overlay (when
 * the spec carries servers) into a scratch temp dir, spawn `omp --mode rpc` in the
 * session's REAL cwd with the prompt written to stdin, stream its frames, and always
 * clean up.
 */
export function createOmpTurnTransport(
  bin: string,
  effects: OmpTransportEffects = defaultOmpTransportEffects,
): OmpTurnTransport {
  return (spec: OmpTurnSpec) => ({
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      const dir = await effects.mkdtemp(join(tmpdir(), "rennet-omp-turn-"));
      try {
        let configPath: string | undefined;
        if (spec.mcpServers !== undefined && Object.keys(spec.mcpServers).length > 0) {
          configPath = join(dir, "omp-mcp.yml");
          await effects.writeFile(configPath, renderOmpMcpConfig(spec.mcpServers));
        }
        const args = buildOmpTurnArgs({
          cwd: spec.cwd,
          ...(spec.model === undefined ? {} : { model: spec.model }),
          ...(configPath === undefined ? {} : { configPath }),
        });
        for await (const frame of effects.spawn(bin, args, spec.cwd, spec.prompt, spec.signal)) {
          yield frame;
        }
      } finally {
        await effects.rm(dir);
      }
    },
  });
}

// ── Self-conformance: the descriptor's implementedByAdapter evidence ──────────
//
// To earn the `implementedByAdapter` layer honestly, the composition runs the hermetic
// conformance suite against an OmpAdapter wired to a CANNED fake transport that exercises
// exactly the DOCUMENTED frames the real adapter maps. The passing checks ARE the
// implemented capabilities: structuredOutput, textDeltas, and interrupt pass; `costUsd`
// stays false (the terminal frame carries no cost until a real run confirms omp's unit)
// and `reportsContextWindow` stays false (omp reports usage, not the window capacity).

const SELF_CONFORMANCE_TRANSPORT: OmpTurnTransport = (spec: OmpTurnSpec) => ({
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    yield { type: "ready", protocolVersion: 1 };
    if (spec.prompt.includes("remain active until interrupted")) {
      if (!spec.signal?.aborted) {
        await new Promise<void>((resolve) =>
          spec.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      yield {
        rennet: "turn-result",
        exitCode: 0,
        finalText: null,
        usage: null,
        cost: null,
        aborted: true,
      } satisfies OmpTurnResultFrame;
      return;
    }
    yield { type: "agent_start" };
    yield {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: '{"ok', contentIndex: 0 },
    };
    yield {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: '{"ok":true}' }] },
    };
    yield {
      type: "response",
      command: "get_session_stats",
      success: true,
      data: {
        sessionId: "self-conformance",
        tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
    };
    yield {
      rennet: "turn-result",
      exitCode: 0,
      finalText: '{"ok":true}',
      usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      // No cost: costUsd stays false until a real run confirms omp's cost unit.
      cost: null,
      aborted: spec.signal?.aborted ?? false,
    } satisfies OmpTurnResultFrame;
  },
});

/**
 * Run the hermetic conformance suite against a canned OmpAdapter to derive the
 * `implementedByAdapter` capability evidence. Pure, no spend, no spawn — the same
 * mechanism the gated `.real` test uses against the live binary for the outer layers.
 */
export async function deriveOmpImplementedEvidence(
  binaryPath: string,
): Promise<OmpAdapterConfig["capabilityEvidence"]> {
  const selfAdapter = new OmpAdapter({ binaryPath, transport: SELF_CONFORMANCE_TRANSPORT });
  const report = await runConformance(selfAdapter);
  return report.evidence;
}

// ── Composition root ──────────────────────────────────────────────────────────

export interface OmpHarnessDeps {
  readonly discoveryDeps?: DiscoveryDeps;
  /** Operator override for the omp binary path (composition passes RENNET_OMP_BIN). */
  readonly explicitBin?: string;
  /** Loopback canvasOps@2 (and future) MCP servers for every session. */
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
}

export interface OmpHarnessResult {
  /** An OmpAdapter wired to the real spawn transport, or null when no runnable slot. */
  readonly adapter: OmpAdapter | null;
  readonly discovery: DiscoveryResult;
}

/**
 * Compose a runnable omp harness end to end: discover the user's installed `omp` AND a
 * runnable Bun, and if both are present, build an `OmpAdapter` wired to the REAL `omp
 * --mode rpc` transport with an evidence-derived descriptor. Returns `adapter: null`
 * (with the Bun-aware discovery health) when omp is missing or Bun is absent, so a caller
 * surfaces an honest unavailable state rather than crashing at first spawn.
 */
export async function createOmpHarness(deps: OmpHarnessDeps = {}): Promise<OmpHarnessResult> {
  const discoveryDeps = deps.discoveryDeps ?? defaultOmpDiscoveryDeps();
  const discovery = await discoverOmp(discoveryDeps, {
    ...(deps.explicitBin === undefined ? {} : { explicitBin: deps.explicitBin }),
  });
  if (!discovery.chosen) {
    return { adapter: null, discovery };
  }
  const binaryPath = discovery.chosen.path;
  const capabilityEvidence = await deriveOmpImplementedEvidence(binaryPath);
  const adapter = new OmpAdapter({
    binaryPath,
    transport: createOmpTurnTransport(binaryPath),
    version: discovery.chosen.version,
    ...(capabilityEvidence === undefined ? {} : { capabilityEvidence }),
    ...(deps.mcpServers === undefined ? {} : { mcpServers: deps.mcpServers }),
  });
  return { adapter, discovery };
}
