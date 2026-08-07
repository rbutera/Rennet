import { describe, expect, it, vi } from "vitest";
import {
  buildCodexExecArgs,
  CODEX_EXEC_BIN,
  type CodexExecEffects,
  type CodexRunResult,
  type CodexRunSpec,
  createCodexExecutor,
  discoverCodexAvailability,
} from "./codex-exec";

// ── buildCodexExecArgs — the four load-bearing gotchas live in the argv ────────

describe("buildCodexExecArgs", () => {
  it("assembles the argv with every load-bearing flag, in the right shape", () => {
    const args = buildCodexExecArgs(
      { model: "gpt-5.6-luna", effort: "low", prompt: "order these chunks" },
      { schemaPath: "/tmp/schema.json", outPath: "/tmp/out.json" },
    );

    expect(args[0]).toBe("exec");
    // gotcha 1: skip the heavy ~/.codex config that otherwise stalls.
    expect(args).toContain("--ignore-user-config");
    // gotcha 3: utility calls run in a scratch (non-repo) cwd.
    expect(args).toContain("--skip-git-repo-check");
    // the model + effort knobs.
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.6-luna");
    expect(args).toContain("-c");
    expect(args[args.indexOf("-c") + 1]).toBe("model_reasoning_effort=low");
    // structured output constraint.
    expect(args).toContain("--output-schema");
    expect(args[args.indexOf("--output-schema") + 1]).toBe("/tmp/schema.json");
    // gotcha 4: capture the final structured message to a file, not the JSONL stream.
    expect(args).toContain("-o");
    expect(args[args.indexOf("-o") + 1]).toBe("/tmp/out.json");
    // the positional prompt is last.
    expect(args[args.length - 1]).toBe("order these chunks");
  });

  it("omits --output-schema when no schema is given (free-form docType)", () => {
    const args = buildCodexExecArgs(
      { model: "gpt-5.6-luna", effort: "low", prompt: "p" },
      { outPath: "/tmp/out.json" },
    );
    expect(args).not.toContain("--output-schema");
    expect(args).toContain("-o");
  });
});

// ── createCodexExecutor — the spawn wiring, with injected effects ─────────────

interface FakeState {
  readonly writes: { path: string; data: string }[];
  spec?: CodexRunSpec;
  readonly dirsRemoved: string[];
}

function fakeEffects(opts: { outContent: string; runResult?: CodexRunResult }): {
  effects: CodexExecEffects;
  state: FakeState;
} {
  const state: FakeState = { writes: [], dirsRemoved: [] };
  const effects: CodexExecEffects = {
    mkdtemp: async (prefix) => `${prefix}XXXX`,
    writeFile: async (path, data) => {
      state.writes.push({ path, data });
    },
    readFile: async () => opts.outContent,
    rm: async (path) => {
      state.dirsRemoved.push(path);
    },
    run: async (spec) => {
      state.spec = spec;
      return opts.runResult ?? { exitCode: 0, stderr: "" };
    },
  };
  return { effects, state };
}

describe("createCodexExecutor", () => {
  it("writes the schema, closes stdin, runs the argv, and parses the -o output", async () => {
    const { effects, state } = fakeEffects({
      outContent: '{"readingOrder":["c1"],"rationale":"x"}',
    });
    const executor = createCodexExecutor(effects);

    const result = await executor({
      model: "gpt-5.6-luna",
      effort: "low",
      prompt: "order",
      outputSchema: { type: "object" },
    });

    // The parsed final structured message is returned as the body.
    expect(result.output).toEqual({ readingOrder: ["c1"], rationale: "x" });
    // The schema was written to disk for --output-schema.
    expect(state.writes).toHaveLength(1);
    expect(JSON.parse(state.writes[0]?.data ?? "null")).toEqual({ type: "object" });
    // All four load-bearing gotchas are asserted on the ACTUALLY-SPAWNED argv,
    // not just the pure helper — so a refactor that stops routing through
    // buildCodexExecArgs (or drops a flag) is caught here too.
    // gotcha 2: stdin closed (the execa equivalent of `< /dev/null`).
    expect(state.spec?.stdin).toBe("ignore");
    expect(state.spec?.bin).toBe(CODEX_EXEC_BIN);
    // gotcha 1: skip the heavy ~/.codex config that otherwise stalls.
    expect(state.spec?.args).toContain("--ignore-user-config");
    // gotcha 3: utility calls run in a scratch (non-repo) cwd.
    expect(state.spec?.args).toContain("--skip-git-repo-check");
    // gotcha 4: capture the final structured message to a file.
    const spawnedArgs = state.spec?.args ?? [];
    expect(spawnedArgs).toContain("-o");
    expect(spawnedArgs[spawnedArgs.indexOf("-o") + 1]).toMatch(/out\.json$/);
    expect(state.spec?.args).toContain("--output-schema");
    // the scratch dir was cleaned up.
    expect(state.dirsRemoved).toHaveLength(1);
  });

  it("does not write a schema file when the request has no outputSchema", async () => {
    const { effects, state } = fakeEffects({ outContent: "{}" });
    const executor = createCodexExecutor(effects);
    await executor({ model: "gpt-5.6-luna", effort: "low", prompt: "p" });
    expect(state.writes).toHaveLength(0);
    expect(state.spec?.args).not.toContain("--output-schema");
  });

  it("throws (and still cleans up) on a non-zero exit", async () => {
    const { effects, state } = fakeEffects({
      outContent: "{}",
      runResult: { exitCode: 1, stderr: "boom" },
    });
    const executor = createCodexExecutor(effects);
    await expect(executor({ model: "gpt-5.6-luna", effort: "low", prompt: "p" })).rejects.toThrow(
      /exited 1: boom/,
    );
    expect(state.dirsRemoved).toHaveLength(1);
  });

  it("throws on non-JSON output from the -o file", async () => {
    const { effects } = fakeEffects({ outContent: "not json at all" });
    const executor = createCodexExecutor(effects);
    await expect(executor({ model: "gpt-5.6-luna", effort: "low", prompt: "p" })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("surfaces a discovered harness version when configured", async () => {
    const { effects } = fakeEffects({ outContent: "{}" });
    const executor = createCodexExecutor(effects, { harnessVersion: "0.146.0" });
    const result = await executor({ model: "gpt-5.6-luna", effort: "low", prompt: "p" });
    expect(result.harnessVersion).toBe("0.146.0");
  });
});

// ── discoverCodexAvailability — the composition root's honest codex probe ──────

describe("discoverCodexAvailability", () => {
  it("reports available with the parsed version when the probe exits 0", async () => {
    const probe = vi.fn(async () => ({ exitCode: 0, stdout: "codex-cli 0.3.5\n" }));
    const result = await discoverCodexAvailability(probe);
    expect(result).toEqual({ available: true, version: "0.3.5" });
    // Probed the codex binary by name.
    expect(probe).toHaveBeenCalledWith(CODEX_EXEC_BIN);
  });

  it("reports unavailable when the probe exits non-zero", async () => {
    const probe = vi.fn(async () => ({ exitCode: 127, stdout: "" }));
    const result = await discoverCodexAvailability(probe);
    expect(result).toEqual({ available: false, version: null });
  });

  it("reports unavailable when the probe throws (no codex on PATH)", async () => {
    const probe = vi.fn(async () => {
      throw new Error("spawn codex ENOENT");
    });
    const result = await discoverCodexAvailability(probe);
    expect(result).toEqual({ available: false, version: null });
  });

  it("reports available with a null version when stdout has no parseable version", async () => {
    const probe = vi.fn(async () => ({ exitCode: 0, stdout: "codex\n" }));
    const result = await discoverCodexAvailability(probe);
    expect(result).toEqual({ available: true, version: null });
  });
});
