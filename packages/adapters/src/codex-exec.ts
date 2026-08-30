/**
 * The real `CodexExecutor` (issue #66): the one place that runs a one-shot
 * structured-output `codex` turn for the utility port.
 *
 * adopt-codex-app-server (D7): this moved off `codex exec --json` onto the SAME
 * `codex app-server` turn runner the agentic transport uses — ONE native surface,
 * no prompt-flag drift, no `codex exec` composition. Usage now arrives IN-PROTOCOL
 * (`thread/tokenUsage/updated`), so the on-disk session-log correlation is gone
 * from this path; the final structured message rides `outputSchema` on the turn and
 * the completed agent message, with NO scratch files at all.
 *
 * `@rennet/core`'s `CodexUtilityPort` owns all RSP knowledge (docType → schema,
 * envelope, validation, retry) and depends only on the injected `CodexExecutor`
 * seam, so `core` stays node-free. This module is that seam's real implementation.
 *
 * Never reads a credential: `codex` authenticates itself on the user's own
 * subscription (shared `~/.codex` auth home).
 */

import {
  type CodexExecRequest,
  type CodexExecResult,
  type CodexExecutor,
  HOST_LOCUS,
  type Locus,
  locusCommand,
} from "@rennet/core";
import { execa } from "execa";
import {
  buildAppServerArgs,
  type CodexTurnResultFrame,
  defaultSpawnAppServer,
  runCodexTurn,
  type SpawnAppServer,
  spawnFailureFrame,
} from "./codex-app-server";
import type { CodexSessionReadResult } from "./codex-session-usage";

/** The `codex` binary invoked for a utility call. */
export const CODEX_EXEC_BIN = "codex";

/**
 * Wrap a subschema so the model may emit `null` for it — the OpenAI-idiomatic way
 * to express an OPTIONAL field under strict structured outputs, where every
 * property must be listed in `required` (an absent-from-`required` property 400s).
 * Idempotent: a subschema already admitting null is returned untouched.
 */
function nullableSubschema(sub: unknown): unknown {
  if (sub !== null && typeof sub === "object" && !Array.isArray(sub)) {
    const s = sub as Record<string, unknown>;
    if (Array.isArray(s.anyOf)) {
      const hasNull = (s.anyOf as unknown[]).some(
        (branch) =>
          branch !== null &&
          typeof branch === "object" &&
          (branch as Record<string, unknown>).type === "null",
      );
      return hasNull ? sub : { ...s, anyOf: [...(s.anyOf as unknown[]), { type: "null" }] };
    }
    if (s.type === "null") return sub;
  }
  return { anyOf: [sub, { type: "null" }] };
}

/**
 * The Codex analogue of `bodyJsonSchema`'s `$schema` strip for the Claude CLI.
 *
 * The `outputSchema` turn parameter feeds the schema to OpenAI structured outputs,
 * which is STRICT in two ways this transform reconciles the Zod projection with:
 *
 *   1. Every object must set `additionalProperties: false`. Zod's `.loose()`
 *      projects `additionalProperties: {}` (a typeless node), which 400s. We flip
 *      every empty-object `additionalProperties` to `false` (a typed subschema is
 *      kept and recursed into), and set `additionalProperties: false` on any object
 *      with `properties` that omits it.
 *   2. Every object's `required` must list EVERY key in `properties`. Zod's
 *      `.optional()` projects a property ABSENT from `required`, which 400s. We add
 *      each previously-optional property to `required` but make it NULLABLE (`anyOf`
 *      with `{type:null}`) so the model can still signal absence; `stripNullDeep`
 *      then removes the emitted nulls, restoring the original optional semantics.
 *   3. OpenAI structured outputs rejects `oneOf`. We weaken it to the supported
 *      `anyOf` for generation; the original Zod schema still validates the emitted
 *      body at the core boundary, preserving exclusive-union semantics.
 *
 * Pure, deep, non-mutating.
 */
export function sanitizeSchemaForCodex(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForCodex);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "oneOf" && Array.isArray(value)) {
      out.anyOf = value.map(sanitizeSchemaForCodex);
      continue;
    }
    if (
      key === "additionalProperties" &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length === 0
    ) {
      out[key] = false; // OpenAI strict structured outputs demand a boolean here
      continue;
    }
    out[key] = sanitizeSchemaForCodex(value);
  }
  const props = out.properties;
  if (props !== null && typeof props === "object" && !Array.isArray(props)) {
    const propObj = props as Record<string, unknown>;
    const keys = Object.keys(propObj);
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    for (const key of keys) {
      if (!required.has(key)) propObj[key] = nullableSubschema(propObj[key]);
    }
    out.required = keys;
    if (out.additionalProperties === undefined) out.additionalProperties = false;
  }
  return out;
}

/**
 * Remove every `null`-valued object property, deeply. `sanitizeSchemaForCodex`
 * forces an optional field to be `required` + nullable so OpenAI strict accepts the
 * schema; the model then emits `null` for a field it would otherwise omit. Stripping
 * those nulls restores the original optional semantics. Array elements are preserved
 * (indices are load-bearing); only object keys are dropped.
 */
export function stripNullDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullDeep);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner === null) continue;
    out[key] = stripNullDeep(inner);
  }
  return out;
}

// ── The injectable process boundary ───────────────────────────────────────────

/** The process effects the executor needs, injected so the wiring is unit-testable
 *  without a real `codex` on PATH. */
export interface CodexExecEffects {
  /** Spawn a live `codex app-server` connection. */
  readonly spawn: SpawnAppServer;
}

/** The real effects: one `codex app-server` child over piped stdio. */
export const defaultCodexExecEffects: CodexExecEffects = {
  spawn: defaultSpawnAppServer,
};

export interface CreateCodexExecutorOptions {
  readonly bin?: string;
  /** The discovered `codex` version, stamped onto the exec result's provenance. */
  readonly harnessVersion?: string;
  /**
   * The runtime a runtime-hosted codex (an asdf node JS launcher) must run through
   * (`<node> <codex> app-server …`). Absent for a normal install.
   */
  readonly runtimePath?: string;
  /**
   * Observability hook fired once per run with the in-protocol usage outcome
   * (measured / unmeasured) — the honest surface a cost harness reads to report REAL
   * Codex tokens or an honest "unmeasured" reason. Never affects the run; keep it
   * total (a throw is not caught here).
   */
  readonly onUsageMeasurement?: (measurement: CodexSessionReadResult) => void;
  /** Wall clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** The project's execution locus. For a WSL locus the spawn routes through the
   *  distro via `locusCommand`; host composition spawns the binary directly. */
  readonly locus?: Locus;
  /**
   * The locus-native checkout every turn from this executor roots at. REQUIRED:
   * Rennet reviews git repositories, so a utility seat always has one, and the
   * composition root binds one executor per review (`codexExecutorForRepo`). There
   * is no no-repo utility call and no temp-dir fallback (W5) — the repo root used
   * to be handed to the composition seam and dropped one frame later, which is how
   * a Codex seat ended up reasoning about a change from an empty directory while
   * the Claude leg of the same job ran in the checkout.
   */
  readonly repoRoot: string;
  /**
   * Loopback MCP servers (canvasOps@2) to pin for the turn, as a FULL-TABLE
   * override. Absent ⇒ no `mcp_servers` override at all, so the seat keeps the
   * user's own configured servers rather than being handed an empty table.
   */
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
}

/**
 * Build the real `CodexExecutor`: run one structured-output `codex app-server`
 * turn, parse the completed agent message, and return the parsed body with the
 * in-protocol token usage. A non-completed turn or non-JSON output is a throw (the
 * port records it as an exec-failed attempt).
 */
export function createCodexExecutor(
  effects: CodexExecEffects = defaultCodexExecEffects,
  options: CreateCodexExecutorOptions,
): CodexExecutor {
  const bin = options.bin ?? CODEX_EXEC_BIN;
  const locus = options.locus ?? HOST_LOCUS;
  const runtimePath = options.runtimePath;
  return async (req: CodexExecRequest): Promise<CodexExecResult> => {
    const reportFailure = (reason: string): void => {
      options.onUsageMeasurement?.({
        status: "unmeasured",
        usage: null,
        sessionFile: null,
        reason,
        scanned: 0,
        matched: 0,
      });
    };
    // W5 — a utility seat roots at the REPOSITORY it is reasoning about. Delta
    // digest, refine-comment and draft-PR-body are all reading a change, and the
    // Claude legs of those same council-routed jobs already get the repo root; a
    // Codex leg dropped into an empty temp dir was blind for no reason other than
    // which model the council picked. Rennet reviews git repos, so there is no
    // no-repo case to serve and no temp fallback to keep — `req.cwd` remains only
    // as a NARROWING override for a caller that means a specific other checkout
    // (the swarm's evidence-reading seats).
    const cwd = req.cwd ?? options.repoRoot;
    const args = buildAppServerArgs(options.mcpServers);
    const program = runtimePath ?? bin;
    const programArgs = runtimePath === undefined ? args : [bin, ...args];
    const cmd = locusCommand(locus, program, programArgs, cwd);
    let conn: ReturnType<SpawnAppServer>;
    try {
      conn = effects.spawn({ bin: cmd.file, args: cmd.args, cwd: cmd.cwd });
    } catch (error) {
      const frame = spawnFailureFrame(error);
      const reason = frame.error?.message ?? "codex app-server failed to spawn";
      reportFailure(reason);
      throw new Error(reason, { cause: error });
    }
    let terminal: CodexTurnResultFrame | null = null;
    for await (const frame of runCodexTurn(conn, {
      cwd,
      prompt: req.prompt,
      model: req.model,
      effort: req.effort,
      ...(req.outputSchema === undefined
        ? {}
        : { outputSchema: sanitizeSchemaForCodex(req.outputSchema) }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
      // #585: every utility-executor turn is Rennet's internal one-shot work, so
      // no rollout file lands in the user's `~/.codex/sessions/`. This is the one
      // choke point all CodexExecutor callers route through; the agentic transport
      // (codex-turn-transport) deliberately does NOT set it.
      ephemeral: true,
    })) {
      if ((frame as { rennet?: unknown }).rennet === "turn-result") {
        terminal = frame as CodexTurnResultFrame;
      }
    }

    if (terminal === null || terminal.status !== "completed") {
      const reason =
        terminal?.error?.message ??
        `codex app-server turn did not complete (${terminal?.status ?? "no terminal frame"})`;
      reportFailure(reason);
      throw new Error(reason);
    }
    if (terminal.finalMessage === null) {
      const reason = "codex app-server completed the turn but emitted no final message";
      reportFailure(reason);
      throw new Error(reason);
    }
    let output: unknown;
    try {
      output = JSON.parse(terminal.finalMessage);
    } catch {
      const reason = `codex app-server output was not valid JSON: ${terminal.finalMessage.slice(0, 200)}`;
      reportFailure(reason);
      throw new Error(reason);
    }
    // Undo the schema's optional→required-nullable rewrite so a forced-null field
    // becomes an ABSENT field, the shape the RSP body validator expects.
    output = stripNullDeep(output);
    const tokens = terminal.usage;
    const observedModel = terminal.model;
    options.onUsageMeasurement?.(
      tokens
        ? {
            status: "measured",
            usage: tokens,
            model: observedModel ?? null,
            sessionFile: null,
            scanned: 0,
            matched: 1,
          }
        : {
            status: "unmeasured",
            usage: null,
            sessionFile: null,
            reason: "codex app-server reported no token usage for the turn",
            scanned: 0,
            matched: 0,
          },
    );
    return {
      output,
      ...(tokens === undefined ? {} : { tokens }),
      ...(observedModel === undefined ? {} : { model: observedModel }),
      ...(options.harnessVersion === undefined ? {} : { harnessVersion: options.harnessVersion }),
    };
  };
}

// ── Codex availability probe (issue #69, bead workspace-sglle) ─────────────────

/** The result of a `codex --version` availability probe. */
export interface CodexAvailability {
  /** True when the `codex` binary is installed and answered `--version` cleanly. */
  readonly available: boolean;
  /** The parsed version, or `null` when unavailable or unparseable. */
  readonly version: string | null;
}

/** One `codex --version` probe: exit code + stdout (where `--version` prints). */
export type CodexVersionProbe = (bin: string) => Promise<{
  readonly exitCode: number;
  readonly stdout: string;
}>;

/** The real probe: one `codex --version` spawn with closed stdin, never throwing
 *  on a non-zero exit (a missing binary throws ENOENT, caught by the caller). */
export const defaultCodexVersionProbe: CodexVersionProbe = async (bin) => {
  const result = await execa(bin, ["--version"], { reject: false, stdin: "ignore" });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout == null ? "" : String(result.stdout),
  };
};

/** Extract the first semver-shaped token from `codex --version` output. */
function parseCodexVersion(stdout: string): string | null {
  const match = stdout.match(/(\d+\.\d+\.\d+[^\s]*)/);
  return match?.[1] ?? null;
}

/**
 * Determine whether `codex` is installed by running `codex --version` through an
 * injected probe seam, returning `{ available, version }`. A non-zero exit or a
 * throw (no `codex` on PATH) is `available: false` — fail-closed toward "no Codex
 * seat" rather than a crash.
 */
export async function discoverCodexAvailability(
  probe: CodexVersionProbe = defaultCodexVersionProbe,
  bin: string = CODEX_EXEC_BIN,
): Promise<CodexAvailability> {
  try {
    const { exitCode, stdout } = await probe(bin);
    if (exitCode !== 0) return { available: false, version: null };
    return { available: true, version: parseCodexVersion(stdout) };
  } catch {
    return { available: false, version: null };
  }
}
