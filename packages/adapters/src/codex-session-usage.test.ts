import { describe, expect, it } from "vitest";
import {
  type CodexSessionReadDeps,
  codexSessionsRoot,
  parseCodexSessionText,
  readCodexSessionUsage,
} from "./codex-session-usage";

// A real `token_count` event carrying `last_token_usage`, plus a `turn_context`.
function turnContext(cwd: string, model = "gpt-5.6-luna"): string {
  return JSON.stringify({ type: "turn_context", payload: { cwd, model } });
}
function tokenCount(u: {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: u.input,
          cached_input_tokens: u.cached,
          output_tokens: u.output,
          reasoning_output_tokens: u.reasoning,
          total_tokens: u.input + u.output,
        },
      },
    },
  });
}
// The trailing rate-limit-only event Codex writes: `info: null`, no usage.
const RATE_LIMIT_ONLY = JSON.stringify({
  type: "event_msg",
  payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 4 } } },
});

describe("parseCodexSessionText", () => {
  it("extracts cwd/model and maps one usage event to RspTokenUsage (reasoning ⊆ output)", () => {
    const text = [
      turnContext("/private/var/folders/T/rennet-codex-abc", "gpt-5.6-luna"),
      tokenCount({ input: 24775, cached: 9984, output: 398, reasoning: 93 }),
      RATE_LIMIT_ONLY,
    ].join("\n");

    const parsed = parseCodexSessionText(text);

    expect(parsed.cwd).toBe("/private/var/folders/T/rennet-codex-abc");
    expect(parsed.model).toBe("gpt-5.6-luna");
    expect(parsed.usageEvents).toBe(1);
    // input = input_tokens - cached; cacheRead = cached; output kept whole.
    expect(parsed.usage.input).toBe(24775 - 9984);
    expect(parsed.usage.cacheRead).toBe(9984);
    expect(parsed.usage.output).toBe(398);
    expect(parsed.usage.reasoning).toBe(93);
    expect(parsed.usage.cacheWrite).toBe(0);
    // total reconciles EXACTLY with Codex's own total_tokens (input + output).
    expect(parsed.usage.total).toBe(24775 + 398);
  });

  it("SUMS last_token_usage across events (the running sum = cumulative total)", () => {
    const text = [
      turnContext("/tmp/x"),
      tokenCount({ input: 24775, cached: 9984, output: 398, reasoning: 93 }),
      tokenCount({ input: 25260, cached: 24320, output: 260, reasoning: 36 }),
    ].join("\n");

    const parsed = parseCodexSessionText(text);

    expect(parsed.usageEvents).toBe(2);
    expect(parsed.usage.input).toBe(24775 - 9984 + (25260 - 24320));
    expect(parsed.usage.cacheRead).toBe(9984 + 24320);
    expect(parsed.usage.output).toBe(398 + 260);
    expect(parsed.usage.reasoning).toBe(93 + 36);
    expect(parsed.usage.total).toBe(24775 + 398 + 25260 + 260);
  });

  it("returns a null-reasoning zero usage when no usage events are present", () => {
    const parsed = parseCodexSessionText([turnContext("/tmp/x"), RATE_LIMIT_ONLY].join("\n"));
    expect(parsed.usageEvents).toBe(0);
    expect(parsed.usage.total).toBe(0);
    expect(parsed.usage.reasoning).toBeNull();
  });

  it("ignores malformed lines and non-context/usage lines", () => {
    const text = [
      "not json at all",
      JSON.stringify({ type: "response_item", payload: { role: "assistant" } }),
      turnContext("/tmp/x"),
      tokenCount({ input: 100, cached: 0, output: 10, reasoning: 2 }),
    ].join("\n");
    const parsed = parseCodexSessionText(text);
    expect(parsed.usageEvents).toBe(1);
    expect(parsed.usage.total).toBe(110);
  });
});

// ── readCodexSessionUsage — correlation over a fake session tree ───────────────

interface FakeFile {
  readonly mtimeMs: number;
  readonly content: string;
}

function fakeDeps(tree: {
  dirs: Record<string, { name: string; isDirectory: boolean; isFile: boolean }[]>;
  files: Record<string, FakeFile>;
  /** Maps a queried path to its realpath (default: identity). */
  realpaths?: Record<string, string>;
}): CodexSessionReadDeps {
  return {
    readdir: async (dir) => {
      const entries = tree.dirs[dir];
      if (entries === undefined) throw new Error(`ENOENT ${dir}`);
      return entries;
    },
    stat: async (path) => {
      const f = tree.files[path];
      if (f === undefined) throw new Error(`ENOENT ${path}`);
      return { mtimeMs: f.mtimeMs };
    },
    readFile: async (path) => {
      const f = tree.files[path];
      if (f === undefined) throw new Error(`ENOENT ${path}`);
      return f.content;
    },
    realpath: async (path) => tree.realpaths?.[path] ?? path,
  };
}

const ROOT = "/sessions";
const DAY = "/sessions/2026/08/10";

function dayTree(files: Record<string, FakeFile>, realpaths?: Record<string, string>) {
  return {
    dirs: {
      [ROOT]: [{ name: "2026", isDirectory: true, isFile: false }],
      "/sessions/2026": [{ name: "08", isDirectory: true, isFile: false }],
      "/sessions/2026/08": [{ name: "10", isDirectory: true, isFile: false }],
      [DAY]: Object.keys(files).map((p) => ({
        name: p.slice(DAY.length + 1),
        isDirectory: false,
        isFile: true,
      })),
    },
    files,
    ...(realpaths ? { realpaths } : {}),
  };
}

describe("readCodexSessionUsage", () => {
  it("correlates the ONE in-window session sharing the scratch cwd (measured)", async () => {
    const scratch = "/private/var/T/rennet-codex-MATCH";
    const files: Record<string, FakeFile> = {
      [`${DAY}/a.jsonl`]: {
        mtimeMs: 2_000,
        content: [
          turnContext(scratch),
          tokenCount({ input: 17690, cached: 8960, output: 5, reasoning: 0 }),
        ].join("\n"),
      },
      [`${DAY}/other.jsonl`]: {
        mtimeMs: 2_000,
        content: [
          turnContext("/private/var/T/rennet-codex-OTHER"),
          tokenCount({ input: 999, cached: 0, output: 9, reasoning: 0 }),
        ].join("\n"),
      },
    };
    const result = await readCodexSessionUsage({
      correlationCwd: scratch,
      modifiedSince: 1_000,
      sessionsRoot: ROOT,
      deps: fakeDeps(dayTree(files)),
    });
    expect(result.status).toBe("measured");
    expect(result.sessionFile).toBe(`${DAY}/a.jsonl`);
    expect(result.usage?.total).toBe(17690 + 5);
    expect(result.usage?.cacheRead).toBe(8960);
    expect(result.matched).toBe(1);
  });

  it("normalizes /var → /private/var via realpath before matching", async () => {
    const recorded = "/private/var/T/rennet-codex-SYM"; // what codex wrote
    const queried = "/var/T/rennet-codex-SYM"; // what mkdtemp returned
    const files: Record<string, FakeFile> = {
      [`${DAY}/a.jsonl`]: {
        mtimeMs: 5,
        content: [
          turnContext(recorded),
          tokenCount({ input: 10, cached: 0, output: 2, reasoning: 0 }),
        ].join("\n"),
      },
    };
    const result = await readCodexSessionUsage({
      correlationCwd: queried,
      modifiedSince: 0,
      sessionsRoot: ROOT,
      deps: fakeDeps(dayTree(files, { [queried]: recorded })),
    });
    expect(result.status).toBe("measured");
    expect(result.usage?.total).toBe(12);
  });

  it("excludes sessions modified before the window floor", async () => {
    const scratch = "/private/var/T/rennet-codex-OLD";
    const files: Record<string, FakeFile> = {
      [`${DAY}/old.jsonl`]: {
        mtimeMs: 500, // before the floor
        content: [
          turnContext(scratch),
          tokenCount({ input: 10, cached: 0, output: 2, reasoning: 0 }),
        ].join("\n"),
      },
    };
    const result = await readCodexSessionUsage({
      correlationCwd: scratch,
      modifiedSince: 1_000,
      sessionsRoot: ROOT,
      deps: fakeDeps(dayTree(files)),
    });
    expect(result.status).toBe("unmeasured");
    expect(result.scanned).toBe(0);
    expect(result.usage).toBeNull();
  });

  it("is honest-unmeasured (never a guessed zero) when nothing correlates", async () => {
    const files: Record<string, FakeFile> = {
      [`${DAY}/a.jsonl`]: {
        mtimeMs: 2_000,
        content: [
          turnContext("/private/var/T/rennet-codex-SOMEONE-ELSE"),
          tokenCount({ input: 10, cached: 0, output: 2, reasoning: 0 }),
        ].join("\n"),
      },
    };
    const result = await readCodexSessionUsage({
      correlationCwd: "/private/var/T/rennet-codex-MINE",
      modifiedSince: 1_000,
      sessionsRoot: ROOT,
      deps: fakeDeps(dayTree(files)),
    });
    expect(result.status).toBe("unmeasured");
    expect(result.usage).toBeNull();
    expect(result.scanned).toBe(1);
    expect(result.reason).toContain("no codex session log correlated");
  });

  it("flags ambiguity (never guesses) when two logs share the scratch cwd", async () => {
    const scratch = "/private/var/T/rennet-codex-DUP";
    const files: Record<string, FakeFile> = {
      [`${DAY}/a.jsonl`]: {
        mtimeMs: 2_000,
        content: [
          turnContext(scratch),
          tokenCount({ input: 10, cached: 0, output: 2, reasoning: 0 }),
        ].join("\n"),
      },
      [`${DAY}/b.jsonl`]: {
        mtimeMs: 2_100,
        content: [
          turnContext(scratch),
          tokenCount({ input: 20, cached: 0, output: 3, reasoning: 0 }),
        ].join("\n"),
      },
    };
    const result = await readCodexSessionUsage({
      correlationCwd: scratch,
      modifiedSince: 1_000,
      sessionsRoot: ROOT,
      deps: fakeDeps(dayTree(files)),
    });
    expect(result.status).toBe("ambiguous");
    expect(result.usage).toBeNull();
    expect(result.matched).toBe(2);
  });

  it("is unmeasured (not a throw) when the sessions root does not exist", async () => {
    const result = await readCodexSessionUsage({
      correlationCwd: "/private/var/T/rennet-codex-X",
      modifiedSince: 0,
      sessionsRoot: "/nonexistent",
      deps: fakeDeps({ dirs: {}, files: {} }),
    });
    expect(result.status).toBe("unmeasured");
    expect(result.scanned).toBe(0);
  });
});

describe("codexSessionsRoot", () => {
  it("prefers $CODEX_HOME/sessions when set", () => {
    expect(codexSessionsRoot({ CODEX_HOME: "/custom/codex" } as NodeJS.ProcessEnv)).toBe(
      "/custom/codex/sessions",
    );
  });
  it("falls back to ~/.codex/sessions", () => {
    const root = codexSessionsRoot({} as NodeJS.ProcessEnv);
    expect(root.endsWith("/.codex/sessions")).toBe(true);
  });
});
