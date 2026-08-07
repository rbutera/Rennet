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

/** The `codex` binary invoked for a utility call. */
export const CODEX_EXEC_BIN = "codex";

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
}

/** The real effects: node fs + one `execa` spawn with closed stdin. */
export const defaultCodexExecEffects: CodexExecEffects = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  readFile: (path) => readFile(path, "utf8"),
  rm: (path) => rm(path, { recursive: true, force: true }),
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
}

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
  return async (req: CodexExecRequest): Promise<CodexExecResult> => {
    const dir = await effects.mkdtemp(join(tmpdir(), "rennet-codex-"));
    const outPath = join(dir, "out.json");
    try {
      let schemaPath: string | undefined;
      if (req.outputSchema !== undefined) {
        schemaPath = join(dir, "schema.json");
        await effects.writeFile(schemaPath, JSON.stringify(req.outputSchema));
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
      return {
        output,
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
