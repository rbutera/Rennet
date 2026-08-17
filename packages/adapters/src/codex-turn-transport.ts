/**
 * The composition-root transport for the Codex adapter (#25): the one place that
 * spawns `codex exec --json` and streams its JSONL frames. This is the real
 * implementation of the injected `CodexTurnTransport` seam — the peer of
 * `claude-query.ts` for the agentic path.
 *
 * It reuses `codex-exec.ts`'s proven spawn discipline (closed stdin, the
 * full-access posture, `--ignore-user-config`, `-o` last-message capture, the
 * `sanitizeSchemaForCodex` schema transform) with the agentic deltas: a REAL repo
 * cwd via `-C` (no `--skip-git-repo-check`) and loopback MCP overrides for
 * canvasOps@2. Host locus only — the WSL codex locus is #334's seam (see the
 * spawn site).
 *
 * Never reads a credential: `codex` authenticates itself on the user's own
 * subscription. `--ignore-user-config` skips `~/.codex/config.toml` but, per the
 * codex CLI's own docs, "auth still uses CODEX_HOME" — we never touch `auth.json`.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runConformance, type SessionSpec } from "@rennet/core";
import { execa } from "execa";
import {
  buildCodexTurnArgs,
  CodexAdapter,
  type CodexAdapterConfig,
  type CodexTurnResultFrame,
  type CodexTurnSpec,
  type CodexTurnTransport,
} from "./codex-adapter";
import { sanitizeSchemaForCodex } from "./codex-exec";
import {
  type DiscoveryDeps,
  type DiscoveryResult,
  defaultDiscoveryDeps,
  discoverCodex,
} from "./harness-discovery";

/** The process effects the transport needs, injected so the wiring is testable. */
export interface CodexTransportEffects {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly rm: (path: string) => Promise<void>;
  /** Spawn `codex exec --json`, yielding raw JSONL frames then a terminal result. */
  readonly spawn: (
    bin: string,
    args: readonly string[],
    cwd: string,
    outPath: string,
    signal?: AbortSignal,
  ) => AsyncIterable<unknown>;
}

/** Read stdout lines, yield each JSON frame, then the synthetic terminal frame. */
async function* realSpawn(
  bin: string,
  args: readonly string[],
  cwd: string,
  outPath: string,
  readOut: (path: string) => Promise<string>,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  // #334 seam: this is a plain HOST spawn. WSL codex lands here as a `Locus`
  // parameter wrapping bin/args with `locusCommand`, exactly as checkpoint-store
  // does — explicitly out of scope for #25.
  const child = execa(bin, [...args], {
    cwd,
    stdin: "ignore", // closed stdin (codex-exec gotcha 2): else it waits on stdin
    reject: false,
    buffer: false,
    ...(signal === undefined ? {} : { cancelSignal: signal }),
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  const stdout = child.stdout;
  if (stdout) {
    const lines = createInterface({ input: stdout });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // A non-JSON line on stdout (a stray log line) — skip; the adapter never
        // sees it, and nothing modelled is lost (real frames are one-per-line JSON).
      }
    }
  }
  const result = await child;
  const aborted = result.isCanceled === true || signal?.aborted === true;
  let lastMessage: string | null;
  try {
    lastMessage = (await readOut(outPath)).trim() || null;
  } catch {
    lastMessage = null; // no `-o` file: codex emitted no final message
  }
  const terminal: CodexTurnResultFrame = {
    rennet: "turn-result",
    exitCode: result.exitCode ?? 1,
    lastMessage,
    aborted,
    stderr,
  };
  yield terminal;
}

export const defaultCodexTransportEffects: CodexTransportEffects = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  readFile: (path) => readFile(path, "utf8"),
  rm: (path) => rm(path, { recursive: true, force: true }),
  spawn: (bin, args, cwd, outPath, signal) =>
    realSpawn(bin, args, cwd, outPath, (p) => readFile(p, "utf8"), signal),
};

/**
 * Build the real `CodexTurnTransport`: for each turn, write the (sanitized) schema
 * and allocate a last-message capture path in a scratch temp dir, spawn `codex
 * exec --json` in the session's REAL cwd, stream its frames, and always clean up.
 */
export function createCodexTurnTransport(
  bin: string,
  effects: CodexTransportEffects = defaultCodexTransportEffects,
): CodexTurnTransport {
  return (spec: CodexTurnSpec) => ({
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      const dir = await effects.mkdtemp(join(tmpdir(), "rennet-codex-turn-"));
      const outPath = join(dir, "last-message.txt");
      try {
        let schemaPath: string | undefined;
        if (spec.outputSchema !== undefined) {
          schemaPath = join(dir, "schema.json");
          await effects.writeFile(
            schemaPath,
            JSON.stringify(sanitizeSchemaForCodex(spec.outputSchema)),
          );
        }
        const args = buildCodexTurnArgs({
          cwd: spec.cwd,
          prompt: spec.prompt,
          ...(spec.model === undefined ? {} : { model: spec.model }),
          ...(spec.effort === undefined ? {} : { effort: spec.effort }),
          ...(schemaPath === undefined ? {} : { schemaPath }),
          outPath,
          ...(spec.mcpServers === undefined ? {} : { mcpServers: spec.mcpServers }),
        });
        for await (const frame of effects.spawn(bin, args, spec.cwd, outPath, spec.signal)) {
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
// The descriptor is evidence-derived (never declared). To earn the
// `implementedByAdapter` layer honestly, the composition runs the hermetic
// conformance suite against a CodexAdapter wired to a CANNED fake transport that
// exercises exactly the frames the real adapter maps. The passing checks ARE the
// implemented capabilities — codex reports no cost, so `costUsd` stays false.

const SELF_CONFORMANCE_TRANSPORT: CodexTurnTransport = (spec: CodexTurnSpec) => ({
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    yield { type: "thread.started", thread_id: "self-conformance" };
    yield { type: "turn.started" };
    yield { type: "item.updated", item: { item_type: "agent_message", text: "{" } };
    yield { type: "item.completed", item: { item_type: "agent_message", text: '{"ok":true}' } };
    yield {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    };
    yield {
      rennet: "turn-result",
      exitCode: 0,
      lastMessage: '{"ok":true}',
      aborted: spec.signal?.aborted ?? false,
    } satisfies CodexTurnResultFrame;
  },
});

/**
 * Run the hermetic conformance suite against a canned CodexAdapter to derive the
 * `implementedByAdapter` capability evidence. Pure, no spend — the same
 * mechanism the gated `.real` test uses against the live binary for the outer
 * layers.
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
}

export interface CodexHarnessResult {
  /** A CodexAdapter wired to the real spawn transport, or null when no binary found. */
  readonly adapter: CodexAdapter | null;
  readonly discovery: DiscoveryResult;
}

/**
 * Compose a runnable Codex harness end to end: discover the user's installed
 * `codex`, and if found, build a `CodexAdapter` wired to the REAL `codex exec
 * --json` transport with an evidence-derived descriptor. Returns `adapter: null`
 * (with the discovery health) when no binary is found, so a caller surfaces an
 * unavailable state rather than crashing.
 */
export async function createCodexHarness(deps: CodexHarnessDeps = {}): Promise<CodexHarnessResult> {
  const discoveryDeps = deps.discoveryDeps ?? defaultDiscoveryDeps();
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
    transport: createCodexTurnTransport(binaryPath),
    version: discovery.chosen.version,
    ...(capabilityEvidence === undefined ? {} : { capabilityEvidence }),
    ...(deps.mcpServers === undefined ? {} : { mcpServers: deps.mcpServers }),
  });
  return { adapter, discovery };
}

/** Re-export for tests that build a session spec against the adapter. */
export type { SessionSpec };
