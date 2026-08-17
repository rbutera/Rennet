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
 * Render the loopback MCP declaration in omp's supported `mcp.json` shape. The file is
 * placed at the root of a scratch extension and that directory is passed via
 * `--extension`; `--config` is only a settings overlay and is not an MCP source.
 */
export function renderOmpMcpConfig(
  mcpServers: Readonly<Record<string, { readonly url: string }>>,
): string {
  const entries = Object.entries(mcpServers).map(([name, server]) => [
    name,
    { type: "http", url: server.url },
  ]);
  return `${JSON.stringify({ mcpServers: Object.fromEntries(entries) }, null, 2)}\n`;
}

/** The process effects the transport needs, injected so the wiring is testable. */
export interface OmpTransportEffects {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
  /** Spawn the proven Bun runtime with the omp script and args, then yield raw frames. */
  readonly spawn: (
    bin: string,
    args: readonly string[],
    cwd: string,
    prompt: string,
    signal?: AbortSignal,
  ) => AsyncIterable<unknown>;
}

const MAX_FRAME_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 65_536;

interface OmpProtocolFailureFrame {
  readonly rennet: "protocol-failure";
  readonly reason: "malformed-frame" | "oversized-frame" | "unterminated-frame";
  readonly message: string;
  readonly raw?: string;
  readonly byteLength?: number;
}

function protocolFailure(
  reason: OmpProtocolFailureFrame["reason"],
  message: string,
  evidence: Pick<OmpProtocolFailureFrame, "raw" | "byteLength"> = {},
): OmpProtocolFailureFrame {
  return { rennet: "protocol-failure", reason, message, ...evidence };
}

async function* decodeOmpNdjson(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncIterable<unknown> {
  let pending = Buffer.alloc(0);
  let discardingOversized = false;

  const decodeLine = (line: Buffer): unknown | null => {
    const raw = line.toString("utf8").trim();
    if (raw.length === 0) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return protocolFailure("malformed-frame", "omp emitted a malformed JSON RPC frame", { raw });
    }
  };

  for await (const rawChunk of chunks) {
    const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : Buffer.from(rawChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (!discardingOversized) {
        const nextLength = pending.length + segment.length;
        if (nextLength > MAX_FRAME_BYTES) {
          yield protocolFailure(
            "oversized-frame",
            `omp RPC frame exceeded ${MAX_FRAME_BYTES} bytes`,
            { byteLength: nextLength },
          );
          pending = Buffer.alloc(0);
          discardingOversized = true;
        } else if (segment.length > 0) {
          pending = pending.length === 0 ? Buffer.from(segment) : Buffer.concat([pending, segment]);
        }
      }
      if (newline === -1) break;
      if (discardingOversized) {
        discardingOversized = false;
      } else {
        const frame = decodeLine(pending);
        if (frame !== null) yield frame;
      }
      pending = Buffer.alloc(0);
      offset = newline + 1;
    }
  }

  if (!discardingOversized && pending.length > 0) {
    yield protocolFailure(
      "unterminated-frame",
      "omp stdout ended with an unterminated JSON RPC frame",
      { raw: pending.toString("utf8"), byteLength: pending.length },
    );
  }
}

/**
 * Write the prompt as one `{ type: "prompt" }` RPC command on stdin, then read stdout
 * lines through byte-bounded decoding, then the synthetic terminal frame. Stdin is
 * ended after the prompt so the `--no-session` single-turn `omp` winds down when the
 * turn is done. Usage/cost are intentionally absent until a real stats request is
 * implemented; a fake-only surface would overstate the real transport.
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
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  let stderrTruncated = false;
  child.stderr?.on("data", (chunk: unknown) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = MAX_STDERR_BYTES - stderrBytes;
    if (remaining > 0) {
      const kept = bytes.subarray(0, remaining);
      stderrChunks.push(kept);
      stderrBytes += kept.length;
    }
    if (bytes.length > remaining) stderrTruncated = true;
  });
  const stdout = child.stdout;
  if (stdout) {
    for await (const frame of decodeOmpNdjson(
      stdout as unknown as AsyncIterable<Uint8Array | string>,
    ))
      yield frame;
  }
  const result = await child;
  const aborted = result.isCanceled === true || signal?.aborted === true;
  const stderr = `${Buffer.concat(stderrChunks).toString("utf8")}${
    stderrTruncated ? `\n[stderr truncated at ${MAX_STDERR_BYTES} bytes]` : ""
  }`;
  const terminal: OmpTurnResultFrame = {
    rennet: "turn-result",
    exitCode: result.exitCode ?? 1,
    finalText: null,
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
  ompBin: string,
  bunBin: string,
  effects: OmpTransportEffects = defaultOmpTransportEffects,
): OmpTurnTransport {
  return (spec: OmpTurnSpec) => ({
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      let dir: string | undefined;
      let terminal: unknown;
      let failure: unknown;
      try {
        dir = await effects.mkdtemp(join(tmpdir(), "rennet-omp-turn-"));
        let extensionPath: string | undefined;
        if (spec.mcpServers !== undefined && Object.keys(spec.mcpServers).length > 0) {
          extensionPath = dir;
          await effects.writeFile(join(dir, "mcp.json"), renderOmpMcpConfig(spec.mcpServers));
        }
        const args = buildOmpTurnArgs({
          cwd: spec.cwd,
          ...(spec.model === undefined ? {} : { model: spec.model }),
          ...(extensionPath === undefined ? {} : { extensionPath }),
        });
        for await (const frame of effects.spawn(
          bunBin,
          [ompBin, ...args],
          spec.cwd,
          spec.prompt,
          spec.signal,
        )) {
          const record =
            frame !== null && typeof frame === "object" ? (frame as Record<string, unknown>) : null;
          if (record?.rennet === "turn-result") {
            if (terminal !== undefined)
              throw new Error("omp transport emitted multiple terminal frames");
            terminal = frame;
          } else {
            yield frame;
          }
        }
      } catch (error) {
        failure = error;
      } finally {
        if (dir !== undefined) {
          try {
            await effects.rm(dir);
          } catch (error) {
            failure ??= error;
          }
        }
      }
      if (failure !== undefined) {
        yield {
          rennet: "turn-result",
          exitCode: 1,
          finalText: null,
          stderr: failure instanceof Error ? failure.message : String(failure),
          failure,
        } satisfies OmpTurnResultFrame;
      } else if (terminal !== undefined) {
        yield terminal;
      } else {
        yield {
          rennet: "turn-result",
          exitCode: 1,
          finalText: null,
          stderr: "omp spawn ended without a terminal frame",
        } satisfies OmpTurnResultFrame;
      }
    },
  });
}

// ── Self-conformance: the descriptor's implementedByAdapter evidence ──────────
//
// To earn the `implementedByAdapter` layer honestly, the composition runs the hermetic
// conformance suite against an OmpAdapter wired to a CANNED fake transport that exercises
// exactly the DOCUMENTED frames the real adapter maps. The passing checks ARE the
// implemented capabilities: textDeltas and interrupt pass. `structuredOutput` stays
// false because omp's RPC prompt accepts no schema, and cost/context reporting stays
// absent until the real transport implements and exercises a stats request.

const SELF_CONFORMANCE_TRANSPORT: OmpTurnTransport = (spec: OmpTurnSpec) => ({
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    yield { type: "ready", protocolVersion: 1 };
    if (spec.prompt.includes("remain active until interrupted")) {
      if (!spec.signal?.aborted) {
        await new Promise<void>((resolve) =>
          spec.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      }
      yield {
        rennet: "turn-result",
        exitCode: 0,
        finalText: null,
        aborted: true,
      } satisfies OmpTurnResultFrame;
      return;
    }
    yield { type: "agent_start" };
    yield {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: '{"ok',
        contentIndex: 0,
      },
    };
    yield {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: '{"ok":true}' }],
      },
    };
    yield {
      rennet: "turn-result",
      exitCode: 0,
      finalText: '{"ok":true}',
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
  const selfAdapter = new OmpAdapter({
    binaryPath,
    transport: SELF_CONFORMANCE_TRANSPORT,
  });
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
  const runtimePath = discovery.chosen.runtimePath;
  if (runtimePath === undefined) {
    return { adapter: null, discovery };
  }
  const capabilityEvidence = await deriveOmpImplementedEvidence(binaryPath);
  const adapter = new OmpAdapter({
    binaryPath,
    transport: createOmpTurnTransport(binaryPath, runtimePath),
    version: discovery.chosen.version,
    ...(capabilityEvidence === undefined ? {} : { capabilityEvidence }),
    ...(deps.mcpServers === undefined ? {} : { mcpServers: deps.mcpServers }),
  });
  return { adapter, discovery };
}
