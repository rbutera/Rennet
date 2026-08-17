/**
 * The composition-root transport for the Codex adapter (adopt-codex-app-server):
 * the one place that spawns `codex app-server` and drives one JSON-RPC turn. This
 * is the real implementation of the injected `CodexTurnTransport` seam — the peer
 * of `claude-query.ts` for the agentic path.
 *
 * It composes the spawn (`codex app-server` + `-c` MCP overrides), locus-wraps it,
 * and hands the live connection to `runCodexTurn`, which speaks the newline-
 * delimited JSON-RPC protocol (initialize → initialized → thread/start →
 * turn/start → stream → turn/completed) and yields the notification stream plus one
 * synthetic terminal frame. The full-access sandbox + never-ask approval posture is
 * composed on the turn params (Rule Zero acting path); no scratch files touch the
 * turn path — the whole turn rides stdio.
 *
 * Locus-aware: a WSL-locus transport routes the spawn through `locusCommand`
 * (verbatim argv, no shell) and hands `turn/start` the distro-native repo `cwd`.
 * Stdio is locus-transparent (the JSON-RPC crosses the wsl boundary unchanged), so
 * no path translation is needed on the turn path. A host-locus transport spawns the
 * host binary directly.
 *
 * Never reads a credential: `codex` authenticates itself on the user's own
 * subscription (shared `~/.codex` auth home).
 */

import {
  HOST_LOCUS,
  type Locus,
  LocusPathUntranslatableError,
  locusCommand,
  runConformance,
  type SessionSpec,
  toDistroPath,
} from "@rennet/core";
import {
  CodexAdapter,
  type CodexAdapterConfig,
  type CodexTurnSpec,
  type CodexTurnTransport,
} from "./codex-adapter";
import {
  buildAppServerArgs,
  type CodexTurnResultFrame,
  defaultSpawnAppServer,
  runCodexTurn,
  type SpawnAppServer,
  spawnFailureFrame,
} from "./codex-app-server";
import { sanitizeSchemaForCodex } from "./codex-exec";
import {
  type DiscoveryDeps,
  type DiscoveryResult,
  defaultCodexDiscoveryDeps,
  discoverCodex,
} from "./harness-discovery";

/** The process effects the transport needs, injected so the wiring is testable. */
export interface CodexTransportEffects {
  /** Spawn a live `codex app-server` connection. */
  readonly spawn: SpawnAppServer;
}

export const defaultCodexTransportEffects: CodexTransportEffects = {
  spawn: defaultSpawnAppServer,
};

/**
 * Build the real `CodexTurnTransport`: for each turn, compose the `codex
 * app-server` spawn (locus-wrapped, with `-c` MCP overrides), open the connection,
 * and drive one JSON-RPC turn to a terminal frame. A WSL locus whose repo path is
 * untranslatable fails plainly here (never a silent host run).
 */
export function createCodexTurnTransport(
  bin: string,
  effects: CodexTransportEffects = defaultCodexTransportEffects,
  locus: Locus = HOST_LOCUS,
  runtimePath?: string,
): CodexTurnTransport {
  return (spec: CodexTurnSpec) => ({
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      // The cwd `turn/start` receives: distro-native for a WSL locus (its stdio is
      // locus-transparent), the host repo path otherwise. An untranslatable WSL
      // repo path fails plainly — never the old `?? spec.cwd` host fallback.
      let turnCwd = spec.cwd;
      if (locus.kind === "wsl") {
        const distroCwd = toDistroPath(spec.cwd, locus.distro);
        if (distroCwd === null) throw new LocusPathUntranslatableError(spec.cwd, locus.distro);
        turnCwd = distroCwd;
      }
      const args = buildAppServerArgs(spec.mcpServers);
      // A runtime-hosted codex (an asdf node JS launcher) runs as `<node> <codex>
      // app-server …`; a normal install runs `<codex> app-server …`.
      const program = runtimePath ?? bin;
      const programArgs = runtimePath === undefined ? args : [bin, ...args];
      const cmd = locusCommand(locus, program, programArgs, spec.cwd);
      let conn: ReturnType<SpawnAppServer>;
      try {
        conn = effects.spawn({ bin: cmd.file, args: cmd.args, cwd: cmd.cwd });
      } catch (error) {
        // A synchronous spawn throw must surface inside the event stream, not escape it.
        yield spawnFailureFrame(error);
        return;
      }
      yield* runCodexTurn(conn, {
        cwd: turnCwd,
        prompt: spec.prompt,
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.outputSchema === undefined
          ? {}
          : { outputSchema: sanitizeSchemaForCodex(spec.outputSchema) }),
        ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      });
    },
  });
}

// ── Self-conformance: the descriptor's implementedByAdapter evidence ──────────
//
// The descriptor is evidence-derived (never declared). To earn the
// `implementedByAdapter` layer honestly, the composition runs the hermetic
// conformance suite against a CodexAdapter wired to a CANNED fake transport that
// emits exactly the app-server frames the real adapter maps. The passing checks
// ARE the implemented capabilities — codex reports no cost, so `costUsd` stays
// false.

const SELF_CONFORMANCE_TRANSPORT: CodexTurnTransport = (spec: CodexTurnSpec) => ({
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    yield { method: "turn/started", params: { threadId: "self", turn: { id: "turn-self" } } };
    if (spec.prompt.includes("remain active until interrupted")) {
      if (!spec.signal?.aborted) {
        await new Promise<void>((resolve) =>
          spec.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      yield {
        rennet: "turn-result",
        status: "cancelled",
        finalMessage: null,
      } satisfies CodexTurnResultFrame;
      return;
    }
    yield {
      method: "item/agentMessage/delta",
      params: { delta: '{"ok":', itemId: "i", threadId: "self", turnId: "turn-self" },
    };
    yield {
      method: "item/completed",
      params: { item: { id: "i", type: "agentMessage", text: '{"ok":true}' } },
    };
    yield {
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          total: {
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 2,
          },
        },
      },
    };
    yield {
      method: "turn/completed",
      params: {
        threadId: "self",
        turn: {
          id: "turn-self",
          status: "completed",
          items: [{ id: "i", type: "agentMessage", text: '{"ok":true}' }],
        },
      },
    };
    yield {
      rennet: "turn-result",
      status: "completed",
      finalMessage: '{"ok":true}',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2 },
    } satisfies CodexTurnResultFrame;
  },
});

/**
 * Run the hermetic conformance suite against a canned CodexAdapter to derive the
 * `implementedByAdapter` capability evidence. Pure, no spend.
 */
export async function deriveCodexImplementedEvidence(
  binaryPath: string,
): Promise<CodexAdapterConfig["capabilityEvidence"]> {
  const selfAdapter = new CodexAdapter({ binaryPath, transport: SELF_CONFORMANCE_TRANSPORT });
  const report = await runConformance(selfAdapter);
  return report.evidence;
}

// ── Composition root ──────────────────────────────────────────────────────────

export interface CodexHarnessDeps {
  readonly discoveryDeps?: DiscoveryDeps;
  /** Operator override for the codex binary path (composition passes RENNET_CODEX_BIN). */
  readonly explicitBin?: string;
  /** Loopback canvasOps@2 (and future) MCP servers for every session. */
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
  /** The project's execution locus. A WSL locus runs the distro's codex. */
  readonly locus?: Locus;
}

export interface CodexHarnessResult {
  /** A CodexAdapter wired to the real spawn transport, or null when no binary found. */
  readonly adapter: CodexAdapter | null;
  readonly discovery: DiscoveryResult;
}

/**
 * Compose a runnable Codex harness end to end: discover the user's `codex`, and if
 * found, build a `CodexAdapter` wired to the REAL `codex app-server` transport with
 * an evidence-derived descriptor. Returns `adapter: null` (with the discovery
 * health) when no binary is found, so a caller surfaces an unavailable state
 * rather than crashing.
 */
export async function createCodexHarness(deps: CodexHarnessDeps = {}): Promise<CodexHarnessResult> {
  const discoveryDeps = deps.discoveryDeps ?? defaultCodexDiscoveryDeps();
  const discovery = await discoverCodex(discoveryDeps, {
    ...(deps.explicitBin === undefined ? {} : { explicitBin: deps.explicitBin }),
  });
  if (!discovery.chosen) {
    return { adapter: null, discovery };
  }
  const binaryPath = discovery.chosen.path;
  const capabilityEvidence = await deriveCodexImplementedEvidence(binaryPath);
  const adapter = new CodexAdapter({
    binaryPath,
    transport: createCodexTurnTransport(
      binaryPath,
      defaultCodexTransportEffects,
      deps.locus,
      discovery.chosen.runtimePath,
    ),
    version: discovery.chosen.version,
    ...(capabilityEvidence === undefined ? {} : { capabilityEvidence }),
    ...(deps.mcpServers === undefined ? {} : { mcpServers: deps.mcpServers }),
  });
  return { adapter, discovery };
}

/** Re-export for tests that build a session spec against the adapter. */
export type { SessionSpec };
