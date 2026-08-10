/**
 * The real `CodexExecutor` (issue #66): the one place that shells `codex exec`.
 *
 * `@rennet/core`'s `CodexUtilityPort` owns all RSP knowledge (docType → schema,
 * envelope, validation, retry) and depends only on the injected `CodexExecutor`
 * seam, so `core` stays node-free. This module is that seam's real implementation
 * — the process boundary — mirroring how `claude-query.ts` is the one place that
 * spawns the real Claude transport for the agentic path.
 *
 * All four load-bearing gotchas from the go/no-go spike are baked in, each one a
 * two-minute hang or a stale read otherwise:
 *   1. `--ignore-user-config` — else `codex exec` loads the heavy ~/.codex config
 *      (plugins/MCP/hooks) and STALLS. Also correct: a one-shot utility call must
 *      not inherit the user's full agent config.
 *   2. stdin closed (`stdin: "ignore"`, the execa equivalent of `< /dev/null`) —
 *      else it waits on stdin and hangs.
 *   3. `--skip-git-repo-check` — utility calls run in a scratch (non-repo) cwd.
 *   4. `-o <file>` — capture the final structured message cleanly instead of
 *      parsing the JSONL stream.
 *
 * `buildCodexExecArgs` is pure so the argv (and thus flags 1, 3, 4) is asserted
 * without spawning; flag 2 is asserted via the injected `run` spec.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexExecRequest,
  type CodexExecResult,
  type CodexExecutor,
  type CodexUtilityPort,
  type CodexUtilitySeed,
  createCodexUtilityPort,
} from "@rennet/core";
import { execa } from "execa";
import {
  type CodexSessionReadResult,
  type CodexSessionUsageReader,
  defaultCodexSessionUsageReader,
} from "./codex-session-usage";

/** The `codex` binary invoked for a utility call. */
export const CODEX_EXEC_BIN = "codex";

/**
 * The Codex analogue of `bodyJsonSchema`'s `$schema` strip for the Claude CLI.
 *
 * `codex exec --output-schema` feeds the schema to OpenAI structured outputs,
 * which requires `additionalProperties: false` on every object and rejects a
 * typeless `additionalProperties: {}` node with a 400 (`invalid_json_schema`,
 * "schema must have a 'type' key"). Zod's `z.toJSONSchema` projects the RSP body
 * schemas' loose objects as `additionalProperties: {}`, so WITHOUT this the Codex
 * seat NEVER completes a structured emission — it 400s on every attempt, degrades
 * to a single seat, and its token cost is unmeasurable because it never runs.
 *
 * This pure, deep, non-mutating transform rewrites every empty-object
 * `additionalProperties` to `false` (a typed additionalProperties subschema is
 * kept and recursed into). It is applied only on the Codex path; the Claude path
 * tolerates `{}` and is untouched.
 */
export function sanitizeSchemaForCodex(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForCodex);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
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
  return out;
}

/**
 * Pure argv assembly. Flags 1, 3, and 4 live here; the model/effort knobs, the
 * optional `--output-schema`, and the positional prompt (last) round it out.
 */
export function buildCodexExecArgs(
  req: { readonly model: string; readonly effort: string; readonly prompt: string },
  paths: { readonly schemaPath?: string; readonly outPath: string },
): string[] {
  const args = [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--ignore-user-config", // gotcha 1: skip the heavy ~/.codex config that stalls
    "--skip-git-repo-check", // gotcha 3: utility calls run in a scratch cwd
    "-m",
    req.model,
    "-c",
    `model_reasoning_effort=${req.effort}`,
  ];
  if (paths.schemaPath !== undefined) {
    args.push("--output-schema", paths.schemaPath);
  }
  args.push("-o", paths.outPath); // gotcha 4: capture the final structured message
  args.push(req.prompt); // the positional prompt, last
  return args;
}

// ── The injectable process boundary ───────────────────────────────────────────

/** One spawn of the `codex` binary. `stdin: "ignore"` IS gotcha 2 (closed stdin). */
export interface CodexRunSpec {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: "ignore";
  readonly signal?: AbortSignal;
}

export interface CodexRunResult {
  readonly exitCode: number;
  readonly stderr: string;
}

export type CodexRun = (spec: CodexRunSpec) => Promise<CodexRunResult>;

/** The filesystem + process effects the executor needs, injected so the spawn
 *  wiring is unit-testable without a real `codex` on PATH. */
export interface CodexExecEffects {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly rm: (path: string) => Promise<void>;
  readonly run: CodexRun;
  /**
   * Read the real token usage from the Codex session log written during the run,
   * correlated by the scratch cwd. OPTIONAL: when absent (e.g. a unit test's
   * injected effects) the executor records NO tokens — honest "unmeasured", never
   * a fabricated zero. `defaultCodexExecEffects` supplies the real reader over
   * `~/.codex/sessions`.
   */
  readonly readSessionUsage?: CodexSessionUsageReader;
}

/** The real effects: node fs + one `execa` spawn with closed stdin. */
export const defaultCodexExecEffects: CodexExecEffects = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  readFile: (path) => readFile(path, "utf8"),
  rm: (path) => rm(path, { recursive: true, force: true }),
  readSessionUsage: defaultCodexSessionUsageReader,
  run: async (spec) => {
    const result = await execa(spec.bin, [...spec.args], {
      cwd: spec.cwd,
      stdin: spec.stdin, // "ignore" == `< /dev/null` (gotcha 2)
      reject: false,
      ...(spec.signal === undefined ? {} : { cancelSignal: spec.signal }),
    });
    const stderr = result.stderr == null ? "" : String(result.stderr);
    return { exitCode: result.exitCode ?? 1, stderr };
  },
};

export interface CreateCodexExecutorOptions {
  readonly bin?: string;
  /** The discovered `codex` version, stamped onto the exec result's provenance. */
  readonly harnessVersion?: string;
  /**
   * Observability hook fired once per run with the session-log correlation
   * outcome (measured / unmeasured / ambiguous) — the honest surface a cost
   * harness reads to report REAL Codex tokens or an honest "unmeasured" reason,
   * without the measurement metadata having to travel through the port. Never
   * affects the run; a throw inside it is not caught here, so keep it total.
   */
  readonly onUsageMeasurement?: (measurement: CodexSessionReadResult) => void;
  /** Wall clock, injectable for a deterministic window in tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The safety margin subtracted from the run's start when bounding the session-log
 * mtime window — absorbs clock skew and the gap between "we sampled now()" and
 * "codex created its rollout file". Correlation is by the unique scratch cwd, so
 * a slightly generous window only widens the candidate set the cwd then filters.
 */
export const CODEX_USAGE_WINDOW_MARGIN_MS = 5_000;

/**
 * Build the real `CodexExecutor`: write the schema to a scratch temp dir, spawn
 * one `codex exec` with the assembled argv and closed stdin, read the `-o`
 * output file, JSON.parse it, and always clean up the temp dir. A non-zero exit
 * or non-JSON output is a throw (the port records it as an exec-failed attempt).
 */
export function createCodexExecutor(
  effects: CodexExecEffects = defaultCodexExecEffects,
  options: CreateCodexExecutorOptions = {},
): CodexExecutor {
  const bin = options.bin ?? CODEX_EXEC_BIN;
  const now = options.now ?? Date.now;
  return async (req: CodexExecRequest): Promise<CodexExecResult> => {
    const dir = await effects.mkdtemp(join(tmpdir(), "rennet-codex-"));
    const outPath = join(dir, "out.json");
    // Bound the session-log search to files written from just before this spawn.
    // Captured BEFORE the run so codex's rollout (created at process start) is
    // always in-window; the unique scratch `dir` is the real correlation key.
    const windowStart = now() - CODEX_USAGE_WINDOW_MARGIN_MS;
    try {
      let schemaPath: string | undefined;
      if (req.outputSchema !== undefined) {
        schemaPath = join(dir, "schema.json");
        // OpenAI structured outputs (behind --output-schema) reject the loose
        // `additionalProperties: {}` the Zod projection emits; sanitize per-Codex.
        await effects.writeFile(
          schemaPath,
          JSON.stringify(sanitizeSchemaForCodex(req.outputSchema)),
        );
      }
      const args = buildCodexExecArgs(
        { model: req.model, effort: req.effort, prompt: req.prompt },
        { ...(schemaPath === undefined ? {} : { schemaPath }), outPath },
      );
      const result = await effects.run({
        bin,
        args,
        cwd: dir,
        stdin: "ignore",
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `codex exec exited ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`,
        );
      }
      const raw = await effects.readFile(outPath);
      let output: unknown;
      try {
        output = JSON.parse(raw);
      } catch {
        throw new Error(`codex exec output was not valid JSON: ${raw.slice(0, 200)}`);
      }
      // Best-effort REAL token usage from the session log (chaching-style),
      // correlated by this run's unique scratch cwd. Measurement never fails the
      // call: any error → no tokens → the port stamps an honest unmeasured zero.
      let tokens: CodexExecResult["tokens"];
      if (effects.readSessionUsage !== undefined) {
        try {
          const measurement = await effects.readSessionUsage({
            correlationCwd: dir,
            modifiedSince: windowStart,
          });
          options.onUsageMeasurement?.(measurement);
          if (measurement.status === "measured" && measurement.usage !== null) {
            tokens = measurement.usage;
          }
        } catch (error) {
          options.onUsageMeasurement?.({
            status: "unmeasured",
            usage: null,
            sessionFile: null,
            reason: `codex session usage read threw: ${error instanceof Error ? error.message : String(error)}`,
            scanned: 0,
            matched: 0,
          });
        }
      }
      return {
        output,
        ...(tokens === undefined ? {} : { tokens }),
        ...(options.harnessVersion === undefined ? {} : { harnessVersion: options.harnessVersion }),
      };
    } finally {
      await effects.rm(dir);
    }
  };
}

// ── Composition root ──────────────────────────────────────────────────────────

export interface CodexUtilityAdapterDeps {
  /** Defaults to the real `createCodexExecutor()`. Injectable for tests. */
  readonly executor?: CodexExecutor;
  readonly seed?: CodexUtilitySeed;
  readonly mintDocId?: () => string;
  readonly newRunId?: () => string;
}

/**
 * Compose a runnable CodexUtilityPort wired to the real `codex exec` executor.
 * This is the seat boundary the Model Council resolver names: a resolved Codex
 * seat executes light-tier RSP emission through this port. Wiring the LIVE
 * pipeline resolver to it is the follow-on (`workspace-sglle`).
 */
export function createCodexUtilityAdapter(deps: CodexUtilityAdapterDeps = {}): CodexUtilityPort {
  const executor = deps.executor ?? createCodexExecutor();
  return createCodexUtilityPort({
    executor,
    ...(deps.seed === undefined ? {} : { seed: deps.seed }),
    ...(deps.mintDocId === undefined ? {} : { mintDocId: deps.mintDocId }),
    ...(deps.newRunId === undefined ? {} : { newRunId: deps.newRunId }),
  });
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
 * injected probe seam, returning `{ available, version }`. This is the Codex
 * counterpart of the Claude harness discovery: the composition root uses it to
 * gate `codex` availability for the Model Council WITHOUT a real spawn in tests
 * (the probe is injected). A non-zero exit or a throw (no `codex` on PATH) is
 * `available: false` — fail-closed toward "no Codex seat" rather than a crash.
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
