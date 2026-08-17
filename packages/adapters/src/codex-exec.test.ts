import { bodyJsonSchema } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexExecArgs,
  CODEX_EXEC_BIN,
  type CodexExecEffects,
  type CodexRunResult,
  type CodexRunSpec,
  createCodexExecutor,
  discoverCodexAvailability,
  sanitizeSchemaForCodex,
  stripNullDeep,
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

  it("writes the CODEX-SANITIZED schema (additionalProperties {} → false)", async () => {
    const { effects, state } = fakeEffects({ outContent: "{}" });
    const executor = createCodexExecutor(effects);
    await executor({
      model: "gpt-5.6-luna",
      effort: "low",
      prompt: "p",
      outputSchema: { type: "object", properties: {}, additionalProperties: {} },
    });
    const written = JSON.parse(state.writes[0]?.data ?? "null");
    // OpenAI structured outputs would 400 on the loose {} — it must be false.
    expect(written.additionalProperties).toBe(false);
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

  it("records NO tokens when no session-usage reader is injected (honest unmeasured)", async () => {
    const { effects } = fakeEffects({ outContent: "{}" });
    // The fake effects omit readSessionUsage — the executor must not fabricate a zero.
    const executor = createCodexExecutor(effects);
    const result = await executor({ model: "gpt-5.6-luna", effort: "low", prompt: "p" });
    expect(result.tokens).toBeUndefined();
  });

  it("threads REAL tokens from the session log correlated by the scratch cwd", async () => {
    const { effects } = fakeEffects({ outContent: "{}" });
    let seenCwd: string | undefined;
    let seenSince: number | undefined;
    const measurements: string[] = [];
    const executor = createCodexExecutor(
      {
        ...effects,
        readSessionUsage: async ({ correlationCwd, modifiedSince }) => {
          seenCwd = correlationCwd;
          seenSince = modifiedSince;
          return {
            status: "measured",
            usage: {
              input: 14791,
              output: 398,
              cacheRead: 9984,
              cacheWrite: 0,
              reasoning: 93,
              total: 25173,
            },
            sessionFile: "/sessions/2026/08/10/a.jsonl",
            scanned: 3,
            matched: 1,
          };
        },
      },
      {
        now: () => 1_000_000,
        onUsageMeasurement: (m) => measurements.push(m.status),
      },
    );

    const result = await executor({ model: "gpt-5.6-luna", effort: "low", prompt: "p" });

    expect(result.tokens).toEqual({
      input: 14791,
      output: 398,
      cacheRead: 9984,
      cacheWrite: 0,
      reasoning: 93,
      total: 25173,
    });
    // Correlated by the scratch cwd, over a window that opens before the run.
    expect(seenCwd).toMatch(/rennet-codex-/);
    expect(seenSince).toBe(1_000_000 - 5_000);
    expect(measurements).toEqual(["measured"]);
  });

  it("records NO tokens (but fires the hook) when the log is unmeasured", async () => {
    const { effects } = fakeEffects({ outContent: "{}" });
    const measurements: string[] = [];
    const executor = createCodexExecutor(
      {
        ...effects,
        readSessionUsage: async () => ({
          status: "unmeasured",
          usage: null,
          sessionFile: null,
          reason: "no codex session log correlated",
          scanned: 2,
          matched: 0,
        }),
      },
      { onUsageMeasurement: (m) => measurements.push(m.status) },
    );
    const result = await executor({ model: "gpt-5.6-luna", effort: "low", prompt: "p" });
    expect(result.tokens).toBeUndefined();
    expect(measurements).toEqual(["unmeasured"]);
  });

  it("never fails the run when the usage read throws (fires an unmeasured hook)", async () => {
    const { effects } = fakeEffects({ outContent: "{}" });
    const measurements: string[] = [];
    const executor = createCodexExecutor(
      {
        ...effects,
        readSessionUsage: async () => {
          throw new Error("disk gone");
        },
      },
      { onUsageMeasurement: (m) => measurements.push(m.status) },
    );
    const result = await executor({ model: "gpt-5.6-luna", effort: "low", prompt: "p" });
    expect(result.output).toEqual({});
    expect(result.tokens).toBeUndefined();
    expect(measurements).toEqual(["unmeasured"]);
  });

  // ── The anti-silent-degrade guard (bead workspace-vk1qk) ────────────────────
  // A Codex seat that never produces a document must record a LEGIBLE failure
  // measurement — not an empty `measurements: []` a harness reports as an
  // indistinguishable "UNMEASURED (no measurement recorded)".

  it("fires a legible failure measurement on a non-zero exit (not a silent [])", async () => {
    const { effects } = fakeEffects({
      outContent: "{}",
      runResult: { exitCode: 1, stderr: "invalid_json_schema" },
    });
    const seen: { status: string; reason?: string }[] = [];
    const executor = createCodexExecutor(effects, {
      onUsageMeasurement: (m) =>
        seen.push({ status: m.status, ...(m.reason ? { reason: m.reason } : {}) }),
    });
    await expect(executor({ model: "gpt-5.6-luna", effort: "low", prompt: "p" })).rejects.toThrow(
      /exited 1/,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe("unmeasured");
    expect(seen[0]?.reason).toMatch(/exited 1: invalid_json_schema/);
  });

  it("fires a legible failure measurement on non-JSON output", async () => {
    const { effects } = fakeEffects({ outContent: "not json" });
    const seen: string[] = [];
    const executor = createCodexExecutor(effects, {
      onUsageMeasurement: (m) => seen.push(m.reason ?? m.status),
    });
    await expect(executor({ model: "gpt-5.6-luna", effort: "low", prompt: "p" })).rejects.toThrow(
      /not valid JSON/,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/not valid JSON/);
  });

  it("fires a legible failure measurement when the -o output file is missing", async () => {
    // codex accepted the request but wrote no final message — the exact shape the
    // empty-Codex-seat dogfood saw. readFile throws; the guard must make it visible.
    const state: FakeState = { writes: [], dirsRemoved: [] };
    const effects: CodexExecEffects = {
      mkdtemp: async (prefix) => `${prefix}XXXX`,
      writeFile: async (path, data) => {
        state.writes.push({ path, data });
      },
      readFile: async () => {
        throw new Error("ENOENT: no such file or directory, open 'out.json'");
      },
      rm: async (path) => {
        state.dirsRemoved.push(path);
      },
      run: async () => ({ exitCode: 0, stderr: "" }),
    };
    const seen: { status: string; reason?: string }[] = [];
    const executor = createCodexExecutor(effects, {
      onUsageMeasurement: (m) =>
        seen.push({ status: m.status, ...(m.reason ? { reason: m.reason } : {}) }),
    });
    await expect(executor({ model: "gpt-5.6-luna", effort: "low", prompt: "p" })).rejects.toThrow(
      /produced no output file/,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe("unmeasured");
    expect(seen[0]?.reason).toMatch(/produced no output file/);
    // The scratch dir is still cleaned up on this path.
    expect(state.dirsRemoved).toHaveLength(1);
  });

  it("strips a null-valued optional field from the parsed output (undoes the nullable rewrite)", async () => {
    // sanitizeSchemaForCodex forces an optional field to required+nullable so
    // OpenAI-strict accepts the schema; the model then emits `null` for absence.
    // The executor strips it so the RSP body validator sees an ABSENT field.
    const { effects } = fakeEffects({
      outContent: '{"findings":[{"findingId":"f1","summary":"x","verification":null}]}',
    });
    const executor = createCodexExecutor(effects);
    const result = await executor({ model: "gpt-5.6-luna", effort: "low", prompt: "p" });
    expect(result.output).toEqual({ findings: [{ findingId: "f1", summary: "x" }] });
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

// ── sanitizeSchemaForCodex — the OpenAI structured-output compatibility strip ──

describe("sanitizeSchemaForCodex", () => {
  it("rewrites an empty-object additionalProperties to false (deeply)", () => {
    const schema = {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: {},
          },
        },
      },
      required: ["findings"],
      additionalProperties: {},
    };
    const out = sanitizeSchemaForCodex(schema);
    // Round-trip through JSON so the deep assertions read structurally, not via
    // a chain of possibly-undefined casts.
    const j = JSON.parse(JSON.stringify(out));
    expect(j.additionalProperties).toBe(false);
    expect(j.properties.findings.items.additionalProperties).toBe(false);
    // Non-additionalProperties structure is preserved intact.
    expect(j.required).toEqual(["findings"]);
    expect(j.properties.findings.items.properties.id).toEqual({ type: "string" });
  });

  it("keeps a TYPED additionalProperties subschema (only the empty-object case flips)", () => {
    const schema = { type: "object", additionalProperties: { type: "string" } };
    const out = sanitizeSchemaForCodex(schema) as Record<string, unknown>;
    expect(out.additionalProperties).toEqual({ type: "string" });
  });

  it("does not mutate its input", () => {
    const schema = { type: "object", additionalProperties: {} };
    const clone = structuredClone(schema);
    sanitizeSchemaForCodex(schema);
    expect(schema).toEqual(clone);
  });

  it("handles arrays and leaves an existing false untouched", () => {
    const schema = {
      anyOf: [
        { type: "object", additionalProperties: {} },
        { type: "object", additionalProperties: false },
      ],
    };
    const out = sanitizeSchemaForCodex(schema) as { anyOf: Record<string, unknown>[] };
    expect(out.anyOf[0]?.additionalProperties).toBe(false);
    expect(out.anyOf[1]?.additionalProperties).toBe(false);
  });

  // ── Strict `required` completeness (the empty-Codex-seat root cause) ─────────
  // OpenAI structured outputs demand EVERY property appear in `required`. A Zod
  // `.optional()` projects a property that is absent from `required` → HTTP 400
  // `invalid_json_schema` ("Missing '<prop>'"), which is why the Codex finding
  // seat returned nothing until this transform.

  it("adds every property to `required` and makes a previously-optional one nullable", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "string" },
        note: { type: "string" }, // optional: present in properties, absent from required
      },
      required: ["id"],
      additionalProperties: false,
    };
    const out = JSON.parse(JSON.stringify(sanitizeSchemaForCodex(schema)));
    // Every property is now required (OpenAI-strict).
    expect(new Set(out.required)).toEqual(new Set(["id", "note"]));
    // The already-required, non-optional property is untouched.
    expect(out.properties.id).toEqual({ type: "string" });
    // The previously-optional property is now nullable so the model can still
    // signal absence (which the executor then strips back to "absent").
    expect(out.properties.note).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
  });

  it("leaves an already-nullable optional idempotent (no double-null branch)", () => {
    const schema = {
      type: "object",
      properties: {
        maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: [],
    };
    const out = JSON.parse(JSON.stringify(sanitizeSchemaForCodex(schema)));
    expect(out.required).toEqual(["maybe"]);
    const nullBranches = out.properties.maybe.anyOf.filter(
      (b: { type?: string }) => b.type === "null",
    );
    expect(nullBranches).toHaveLength(1);
  });

  it("sets additionalProperties:false on an object that omits it", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    const out = sanitizeSchemaForCodex(schema) as Record<string, unknown>;
    expect(out.additionalProperties).toBe(false);
  });

  it("makes the REAL finding schema OpenAI-strict compliant (every object: required == property keys)", () => {
    // The contract, not the implementation: the projected + sanitized finding
    // schema must have no object node whose `required` omits a declared property.
    // This is exactly the shape OpenAI 400'd on ("Missing 'verification'").
    const sanitized = sanitizeSchemaForCodex(bodyJsonSchema("finding"));
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => {
          walk(child, `${path}[${i}]`);
        });
        return;
      }
      if (node === null || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      const props = obj.properties;
      if (props !== null && typeof props === "object" && !Array.isArray(props)) {
        const keys = Object.keys(props as Record<string, unknown>);
        const required = new Set(Array.isArray(obj.required) ? (obj.required as string[]) : []);
        for (const key of keys) {
          if (!required.has(key)) offenders.push(`${path}.properties.${key}`);
        }
        // OpenAI-strict also needs additionalProperties:false on every object.
        if (obj.additionalProperties !== false) offenders.push(`${path}.additionalProperties`);
      }
      for (const [key, value] of Object.entries(obj)) walk(value, `${path}.${key}`);
    };
    walk(sanitized, "$");
    expect(offenders).toEqual([]);
  });
});

// ── stripNullDeep — undo the optional→required-nullable rewrite on the OUTPUT ──

describe("stripNullDeep", () => {
  it("drops null-valued object keys, deeply", () => {
    const input = {
      findings: [
        { findingId: "f1", verification: null, nested: { keep: 1, drop: null } },
        { findingId: "f2", verification: { verdict: "reproduced", evidence: "e" } },
      ],
    };
    expect(stripNullDeep(input)).toEqual({
      findings: [
        { findingId: "f1", nested: { keep: 1 } },
        { findingId: "f2", verification: { verdict: "reproduced", evidence: "e" } },
      ],
    });
  });

  it("preserves array elements and primitives (only object keys are dropped)", () => {
    expect(stripNullDeep([1, "a", true])).toEqual([1, "a", true]);
    expect(stripNullDeep("x")).toBe("x");
    expect(stripNullDeep(null)).toBe(null);
  });
});

// ── Locus-aware scratch/argv (#334), hermetic (no real wsl.exe) ────────────────

describe("createCodexExecutor locus composition", () => {
  it("wsl locus mints distro scratch, routes through wsl.exe, and reads back via UNC", async () => {
    const writes: { path: string; data: string }[] = [];
    const removed: string[] = [];
    let spec: CodexRunSpec | undefined;
    const effects: CodexExecEffects = {
      mkdtemp: async (prefix) => `${prefix}HOST-should-not-be-used`,
      mintDistroScratch: async () => "/tmp/distro-codex",
      writeFile: async (path, data) => {
        writes.push({ path, data });
      },
      readFile: async () => "{}",
      rm: async (path) => {
        removed.push(path);
      },
      run: async (runSpec) => {
        spec = runSpec;
        return { exitCode: 0, stderr: "" };
      },
    };
    const executor = createCodexExecutor(effects, {
      locus: { kind: "wsl", distro: "Ubuntu" },
    });

    await executor({
      model: "gpt-5.6-luna",
      effort: "low",
      prompt: "p",
      outputSchema: { type: "object" },
    });

    // The spawn is wrapped: wsl.exe -d Ubuntu --cd /tmp/distro-codex -e codex …
    expect(spec?.bin).toBe("wsl.exe");
    expect(spec?.cwd).toBeUndefined();
    expect(spec?.args.slice(0, 2)).toEqual(["-d", "Ubuntu"]);
    const args = spec?.args ?? [];
    expect(args[args.indexOf("--cd") + 1]).toBe("/tmp/distro-codex");
    expect(args[args.indexOf("-e") + 1]).toBe("codex");
    // -o and --output-schema are distro-native paths under the distro scratch.
    expect(args[args.indexOf("-o") + 1]).toBe("/tmp/distro-codex/out.json");
    expect(args[args.indexOf("--output-schema") + 1]).toBe("/tmp/distro-codex/schema.json");
    // The Windows side writes/reads/cleans the same dir through its UNC view.
    expect(writes[0]?.path).toBe("\\\\wsl.localhost\\Ubuntu\\tmp\\distro-codex\\schema.json");
    expect(removed[0]).toBe("\\\\wsl.localhost\\Ubuntu\\tmp\\distro-codex");
  });

  it("wsl locus without a mintDistroScratch effect throws (never a host fallback)", async () => {
    const effects: CodexExecEffects = {
      mkdtemp: async (prefix) => `${prefix}XXXX`,
      writeFile: async () => undefined,
      readFile: async () => "{}",
      rm: async () => undefined,
      run: async () => ({ exitCode: 0, stderr: "" }),
    };
    const executor = createCodexExecutor(effects, { locus: { kind: "wsl", distro: "Ubuntu" } });
    await expect(executor({ model: "m", effort: "low", prompt: "p" })).rejects.toThrow(
      /mintDistroScratch/,
    );
  });
});
