/**
 * Real Codex token accounting from the on-disk session logs (chaching-style).
 *
 * `codex exec` reports NO per-call token usage on its stdout or the `-o` output
 * file, so `CodexUtilityPort` used to stamp `ZERO_TOKENS` on every Codex seat —
 * the "opaque" Codex metric. But Codex DOES record usage: it appends a rollout
 * `.jsonl` per session under `~/.codex/sessions/YYYY/MM/DD/`, and Rai's own
 * multi-provider spend monitor (`rbutera/chaching`) reads exactly these files.
 * This module is Rennet's small, dependency-free port of that mechanism.
 *
 * Two responsibilities, both pure/injectable so they are tested without a real
 * `codex` or the user's real session tree:
 *
 *   1. `parseCodexSessionText` — a ~30-line pure parser mirroring chaching's
 *      `token_count`/`last_token_usage` extraction. Each rollout line is a JSON
 *      object; `turn_context` carries `payload.cwd`/`payload.model`, and an
 *      `event_msg` with `payload.type === "token_count"` carries
 *      `payload.info.last_token_usage = { input_tokens, cached_input_tokens,
 *      output_tokens, reasoning_output_tokens }`. Usage is SUMMED across events
 *      (`last_token_usage` is the per-turn delta; its running sum equals the
 *      session's final cumulative `total_token_usage`).
 *
 *   2. `readCodexSessionUsage` — the incremental correlator. Given the scratch
 *      `cwd` a single `codex exec` ran in and a `modifiedSince` floor, it walks
 *      the sessions root, parses only files modified in-window, and returns the
 *      ONE session whose recorded `cwd` matches — or an honest `unmeasured` /
 *      `ambiguous` result. It never guesses a number.
 *
 * The mapping to `RspTokenUsage` deviates from chaching's arithmetic in ONE
 * deliberate way: chaching folds `reasoning_output_tokens` INTO `output`, but the
 * on-disk data shows `total_tokens === input_tokens + output_tokens` with
 * `reasoning_output_tokens` a SUBSET of `output_tokens` (e.g. input 24775, output
 * 398, reasoning 93, total 25173 = 24775 + 398). Rennet has a dedicated
 * `reasoning` breakdown field and computes `total = input + output + cacheRead +
 * cacheWrite`, so folding reasoning into output would double-count against
 * Codex's own `total_tokens`. We therefore keep `output = output_tokens` and
 * carry `reasoning = reasoning_output_tokens` as the informational subset — which
 * makes Rennet's `total` reconcile EXACTLY with Codex's reported `total_tokens`.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RspTokenUsage } from "@rennet/types";

/** A measured-zero usage record (all fields 0, reasoning null). */
export const ZERO_CODEX_USAGE: RspTokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: null,
  total: 0,
};

/** One parsed rollout `.jsonl`: its recorded cwd/model and summed token usage. */
export interface ParsedCodexSession {
  /** The `turn_context.payload.cwd` (Codex records an absolute realpath). */
  readonly cwd: string | null;
  /** The `turn_context.payload.model`, e.g. "gpt-5.6-luna". */
  readonly model: string | null;
  /** Usage summed over every `token_count` event carrying `last_token_usage`. */
  readonly usage: RspTokenUsage;
  /** How many `token_count` events actually carried usage (0 ⇒ nothing to bill). */
  readonly usageEvents: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numField(record: Record<string, unknown> | null, key: string): number {
  if (record === null) return 0;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Pure parse of one rollout `.jsonl`'s full text. Only lines mentioning
 * `turn_context` or `token_count` are JSON-parsed (a cheap substring pre-filter
 * that skips the large assistant-message lines). Malformed lines are ignored.
 */
export function parseCodexSessionText(text: string): ParsedCodexSession {
  let cwd: string | null = null;
  let model: string | null = null;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let reasoning = 0;
  let usageEvents = 0;

  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    // Cheap pre-filter: skip lines that cannot be a context or usage record.
    if (!line.includes("turn_context") && !line.includes("token_count")) continue;
    let obj: Record<string, unknown> | null;
    try {
      obj = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    if (obj === null) continue;
    const payload = asObject(obj.payload);
    if (payload === null) continue;

    if (obj.type === "turn_context") {
      cwd = strField(payload, "cwd") ?? cwd;
      model = strField(payload, "model") ?? model;
      continue;
    }
    if (obj.type !== "event_msg" || payload.type !== "token_count") continue;

    // `last_token_usage` is the per-turn delta; its running sum equals the
    // session's final cumulative `total_token_usage`. A trailing rate-limit-only
    // `token_count` carries `info: null` and is skipped (no usage to add).
    const info = asObject(payload.info);
    const last = asObject(info?.last_token_usage);
    if (last === null) continue;
    const inputTokens = numField(last, "input_tokens");
    const cachedInput = numField(last, "cached_input_tokens");
    const outputTokens = numField(last, "output_tokens");
    const reasoningTokens = numField(last, "reasoning_output_tokens");
    if (inputTokens === 0 && outputTokens === 0 && cachedInput === 0) continue;

    // chaching-style: non-cached input is `input`, the cached prefix is a read.
    input += Math.max(inputTokens - cachedInput, 0);
    cacheRead += cachedInput;
    // `output_tokens` already includes reasoning (see the module header); keep it
    // whole and carry reasoning as the informational subset so Rennet's `total`
    // reconciles with Codex's own `total_tokens`.
    output += outputTokens;
    reasoning += reasoningTokens;
    usageEvents += 1;
  }

  const usage: RspTokenUsage = {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    reasoning: usageEvents > 0 ? reasoning : null,
    total: input + output + cacheRead,
  };
  return { cwd, model, usage, usageEvents };
}

/** The outcome of correlating a run window to a Codex session log. */
export interface CodexSessionReadResult {
  /**
   * `measured` — exactly one in-window session matched the scratch cwd and it
   * carried usage. `unmeasured` — none matched (or the sessions dir was absent):
   * honest, NOT a guessed zero. `ambiguous` — more than one matched, so no number
   * is trusted (the scratch cwd should be unique, so this flags an anomaly).
   */
  readonly status: "measured" | "unmeasured" | "ambiguous";
  /** The real usage on `measured`; `null` otherwise (never a fabricated number). */
  readonly usage: RspTokenUsage | null;
  /** The correlated rollout path on `measured`; `null` otherwise. */
  readonly sessionFile: string | null;
  /** A human-readable reason on the non-`measured` paths. */
  readonly reason?: string;
  /** How many in-window `.jsonl` files were parsed. */
  readonly scanned: number;
  /** How many parsed files matched the cwd AND carried usage. */
  readonly matched: number;
}

/** The filesystem effects the reader needs, injected so it is unit-testable. */
export interface CodexSessionReadDeps {
  readonly readdir: (
    dir: string,
  ) => Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]>;
  readonly stat: (path: string) => Promise<{ mtimeMs: number }>;
  readonly readFile: (path: string) => Promise<string>;
  /** Best-effort realpath (resolves the macOS `/var` → `/private/var` symlink). */
  readonly realpath: (path: string) => Promise<string>;
}

export const defaultCodexSessionReadDeps: CodexSessionReadDeps = {
  readdir: async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
  },
  stat: async (path) => {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs };
  },
  readFile: (path) => readFile(path, "utf8"),
  realpath: (path) => realpath(path),
};

/**
 * The Codex sessions root: `$CODEX_HOME/sessions` when `CODEX_HOME` is set, else
 * `~/.codex/sessions` (the default Codex layout).
 */
export function codexSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME;
  return home && home.length > 0 ? join(home, "sessions") : join(homedir(), ".codex", "sessions");
}

/** Two cwds correlate if their realpaths are equal, or (fallback) their unique
 *  scratch basenames are — sidestepping the `/var` vs `/private/var` prefix. */
function cwdsMatch(target: string, targetBase: string, recorded: string | null): boolean {
  if (recorded === null) return false;
  if (recorded === target) return true;
  const idx = recorded.lastIndexOf("/");
  const recordedBase = idx >= 0 ? recorded.slice(idx + 1) : recorded;
  return targetBase.length > 0 && recordedBase === targetBase;
}

async function walkJsonlInWindow(
  root: string,
  modifiedSince: number,
  deps: CodexSessionReadDeps,
  out: string[],
): Promise<void> {
  let entries: { name: string; isDirectory: boolean; isFile: boolean }[];
  try {
    entries = await deps.readdir(root);
  } catch {
    return; // absent or unreadable dir — nothing to scan
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory) {
      await walkJsonlInWindow(full, modifiedSince, deps, out);
    } else if (entry.isFile && entry.name.endsWith(".jsonl")) {
      try {
        const s = await deps.stat(full);
        if (s.mtimeMs >= modifiedSince) out.push(full);
      } catch {
        // vanished between walk and stat — skip
      }
    }
  }
}

export interface ReadCodexSessionUsageOptions {
  /** The scratch cwd the `codex exec` ran in (correlation key). */
  readonly correlationCwd: string;
  /** Epoch-ms floor: only sessions modified at/after this are considered. */
  readonly modifiedSince: number;
  /** Defaults to `codexSessionsRoot()`. */
  readonly sessionsRoot?: string;
  readonly deps?: CodexSessionReadDeps;
}

/**
 * Correlate a completed `codex exec` run to its rollout log and return the real
 * token usage. Matching is by the UNIQUE scratch cwd (`mkdtemp`), realpath-
 * normalized so the macOS `/var`→`/private/var` symlink does not defeat it, with
 * a basename fallback. Fails honest: no match ⇒ `unmeasured`, many ⇒ `ambiguous`;
 * neither ever invents a number.
 */
export async function readCodexSessionUsage(
  options: ReadCodexSessionUsageOptions,
): Promise<CodexSessionReadResult> {
  const deps = options.deps ?? defaultCodexSessionReadDeps;
  const root = options.sessionsRoot ?? codexSessionsRoot();

  let target = options.correlationCwd;
  try {
    target = await deps.realpath(options.correlationCwd);
  } catch {
    // dir may already be gone; keep the raw path and lean on the basename fallback
  }
  const tIdx = target.lastIndexOf("/");
  const targetBase = tIdx >= 0 ? target.slice(tIdx + 1) : target;

  const files: string[] = [];
  await walkJsonlInWindow(root, options.modifiedSince, deps, files);

  const matches: { file: string; parsed: ParsedCodexSession }[] = [];
  for (const file of files) {
    let parsed: ParsedCodexSession;
    try {
      parsed = parseCodexSessionText(await deps.readFile(file));
    } catch {
      continue;
    }
    if (parsed.usageEvents > 0 && cwdsMatch(target, targetBase, parsed.cwd)) {
      matches.push({ file, parsed });
    }
  }

  if (matches.length === 0) {
    return {
      status: "unmeasured",
      usage: null,
      sessionFile: null,
      reason: `no codex session log correlated to cwd ${target} among ${files.length} file(s) modified since ${new Date(options.modifiedSince).toISOString()}`,
      scanned: files.length,
      matched: 0,
    };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      usage: null,
      sessionFile: null,
      reason: `${matches.length} codex session logs share cwd ${target}: ${matches.map((m) => m.file).join(", ")}`,
      scanned: files.length,
      matched: matches.length,
    };
  }
  const only = matches[0];
  if (only === undefined) {
    return {
      status: "unmeasured",
      usage: null,
      sessionFile: null,
      scanned: files.length,
      matched: 0,
    };
  }
  return {
    status: "measured",
    usage: only.parsed.usage,
    sessionFile: only.file,
    scanned: files.length,
    matched: 1,
  };
}

/** The reader effect the executor injects: bound to a sessions root + fs deps. */
export type CodexSessionUsageReader = (args: {
  readonly correlationCwd: string;
  readonly modifiedSince: number;
}) => Promise<CodexSessionReadResult>;

/** The real reader over the user's `~/.codex/sessions` (or `$CODEX_HOME`). */
export const defaultCodexSessionUsageReader: CodexSessionUsageReader = (args) =>
  readCodexSessionUsage({ correlationCwd: args.correlationCwd, modifiedSince: args.modifiedSince });
