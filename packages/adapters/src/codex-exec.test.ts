import { bodyJsonSchema } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AppServerConnection, SpawnAppServer } from "./codex-app-server";
import {
  CODEX_EXEC_BIN,
  type CodexExecEffects,
  createCodexExecutor,
  discoverCodexAvailability,
  sanitizeSchemaForCodex,
  stripNullDeep,
} from "./codex-exec";

// ── A fake SpawnAppServer scripting one utility turn (no process) ──────────────

interface SpawnCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

function makeQueue(): {
  push: (v: Record<string, unknown>) => void;
  close: () => void;
  iterable: AsyncIterable<Record<string, unknown>>;
} {
  const buffer: Record<string, unknown>[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const ping = (): void => {
    wake?.();
    wake = null;
  };
  return {
    push: (v) => {
      buffer.push(v);
      ping();
    },
    close: () => {
      done = true;
      ping();
    },
    iterable: {
      async *[Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as Record<string, unknown>;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}

interface Script {
  readonly finalText?: string | null;
  readonly status?: "completed" | "failed";
  readonly usage?: Record<string, number>;
  readonly errorMessage?: string;
  readonly exitBeforeTurn?: boolean;
}

function fakeExecEffects(script: Script = {}): {
  effects: CodexExecEffects;
  spawns: SpawnCall[];
  turnStarts: Record<string, unknown>[];
} {
  const spawns: SpawnCall[] = [];
  const turnStarts: Record<string, unknown>[] = [];
  const spawn: SpawnAppServer = ({ bin, args, cwd }) => {
    spawns.push({ bin, args, cwd });
    const q = makeQueue();
    const conn: AppServerConnection = {
      send: (message) => {
        const { method, id } = message;
        if (method === "initialize") q.push({ id, result: {} });
        else if (method === "thread/start")
          q.push({ id, result: { thread: { id: "t" }, model: "gpt-5.6-obs" } });
        else if (method === "turn/start") {
          turnStarts.push(message.params as Record<string, unknown>);
          if (script.exitBeforeTurn) {
            q.close();
            return;
          }
          const text = script.finalText === undefined ? "{}" : script.finalText;
          if (text !== null) {
            q.push({
              method: "item/completed",
              params: { item: { id: "i", type: "agentMessage", text } },
            });
          }
          if (script.usage) {
            q.push({
              method: "thread/tokenUsage/updated",
              params: { tokenUsage: { total: script.usage } },
            });
          }
          const status = script.status ?? "completed";
          q.push({
            method: "turn/completed",
            params: {
              threadId: "t",
              turn: {
                id: "tn",
                status,
                items: [],
                ...(status === "failed"
                  ? { error: { message: script.errorMessage ?? "boom" } }
                  : {}),
              },
            },
          });
        }
      },
      messages: q.iterable,
      kill: () => q.close(),
      exit: Promise.resolve({ exitCode: 1, stderr: "boom", aborted: false }),
    };
    return conn;
  };
  return { effects: { spawn }, spawns, turnStarts };
}

describe("createCodexExecutor (app-server)", () => {
  it("runs a structured-output turn and returns the parsed final message", async () => {
    const { effects, spawns, turnStarts } = fakeExecEffects({
      finalText: '{"readingOrder":["c1"],"rationale":"x"}',
    });
    const executor = createCodexExecutor(effects, { repoRoot: "/repo" });
    const result = await executor({
      model: "gpt-5.6-luna",
      effort: "low",
      prompt: "order",
      outputSchema: { type: "object" },
    });

    expect(result.output).toEqual({ readingOrder: ["c1"], rationale: "x" });
    // Spawned `codex app-server` in a plain temp cwd (no scratch files, no repo).
    expect(spawns[0]?.bin).toBe(CODEX_EXEC_BIN);
    expect(spawns[0]?.args[0]).toBe("app-server");
    // The turn carries the sanitized outputSchema + full-access posture.
    const turn = turnStarts[0] as Record<string, unknown>;
    expect(turn.outputSchema).toEqual({ type: "object" });
    expect(turn.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(turn.approvalPolicy).toBe("never");
    expect(turn.effort).toBe("low");
  });

  it("passes NO outputSchema turn param for a free-form docType", async () => {
    const { effects, turnStarts } = fakeExecEffects({ finalText: "{}" });
    const executor = createCodexExecutor(effects, { repoRoot: "/repo" });
    await executor({ model: "m", effort: "low", prompt: "p" });
    expect(turnStarts[0]?.outputSchema).toBeUndefined();
  });

  it("sanitizes the outputSchema (additionalProperties {} → false) on the turn", async () => {
    const { effects, turnStarts } = fakeExecEffects({ finalText: "{}" });
    const executor = createCodexExecutor(effects, { repoRoot: "/repo" });
    await executor({
      model: "m",
      effort: "low",
      prompt: "p",
      outputSchema: { type: "object", properties: {}, additionalProperties: {} },
    });
    const schema = turnStarts[0]?.outputSchema as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
  });

  it("threads in-protocol token usage and observed model, firing a measured hook", async () => {
    const usage = {
      inputTokens: 24_775,
      cachedInputTokens: 9_984,
      outputTokens: 398,
      reasoningOutputTokens: 93,
      totalTokens: 25_173,
    };
    const measurements: string[] = [];
    const { effects } = fakeExecEffects({ finalText: "{}", usage });
    const executor = createCodexExecutor(effects, {
      repoRoot: "/repo",
      onUsageMeasurement: (m) => measurements.push(m.status),
    });
    const result = await executor({ model: "m", effort: "low", prompt: "p" });
    expect(result.tokens).toEqual({
      input: 14_791,
      output: 398,
      cacheRead: 9_984,
      cacheWrite: 0,
      reasoning: 93,
      total: 25_173,
    });
    expect(result.model).toBe("gpt-5.6-obs");
    expect(measurements).toEqual(["measured"]);
  });

  it("records NO tokens (honest unmeasured) when the turn reports no usage", async () => {
    const measurements: string[] = [];
    const { effects } = fakeExecEffects({ finalText: "{}" });
    const executor = createCodexExecutor(effects, {
      repoRoot: "/repo",
      onUsageMeasurement: (m) => measurements.push(m.status),
    });
    const result = await executor({ model: "m", effort: "low", prompt: "p" });
    expect(result.tokens).toBeUndefined();
    expect(measurements).toEqual(["unmeasured"]);
  });

  it("surfaces the discovered harness version when configured", async () => {
    const { effects } = fakeExecEffects({ finalText: "{}" });
    const executor = createCodexExecutor(effects, { repoRoot: "/repo", harnessVersion: "0.146.0" });
    const result = await executor({ model: "m", effort: "low", prompt: "p" });
    expect(result.harnessVersion).toBe("0.146.0");
  });

  it("strips a null-valued optional field from the parsed output", async () => {
    const { effects } = fakeExecEffects({
      finalText: '{"findings":[{"findingId":"f1","summary":"x","verification":null}]}',
    });
    const executor = createCodexExecutor(effects, { repoRoot: "/repo" });
    const result = await executor({ model: "m", effort: "low", prompt: "p" });
    expect(result.output).toEqual({ findings: [{ findingId: "f1", summary: "x" }] });
  });

  it("throws and fires a legible failure measurement on a failed turn", async () => {
    const seen: { status: string; reason?: string }[] = [];
    const { effects } = fakeExecEffects({ status: "failed", errorMessage: "invalid_json_schema" });
    const executor = createCodexExecutor(effects, {
      repoRoot: "/repo",
      onUsageMeasurement: (m) =>
        seen.push({ status: m.status, ...(m.reason ? { reason: m.reason } : {}) }),
    });
    await expect(executor({ model: "m", effort: "low", prompt: "p" })).rejects.toThrow(
      /invalid_json_schema/,
    );
    expect(seen[0]?.status).toBe("unmeasured");
    expect(seen[0]?.reason).toMatch(/invalid_json_schema/);
  });

  it("throws and fires a legible failure measurement on non-JSON output", async () => {
    const seen: string[] = [];
    const { effects } = fakeExecEffects({ finalText: "not json at all" });
    const executor = createCodexExecutor(effects, {
      repoRoot: "/repo",
      onUsageMeasurement: (m) => seen.push(m.reason ?? m.status),
    });
    await expect(executor({ model: "m", effort: "low", prompt: "p" })).rejects.toThrow(
      /not valid JSON/,
    );
    expect(seen[0]).toMatch(/not valid JSON/);
  });

  it("throws when the turn completes with no final message", async () => {
    const { effects } = fakeExecEffects({ finalText: null });
    const executor = createCodexExecutor(effects, { repoRoot: "/repo" });
    await expect(executor({ model: "m", effort: "low", prompt: "p" })).rejects.toThrow(
      /no final message/,
    );
  });

  it("throws on a pre-terminal process exit", async () => {
    const { effects } = fakeExecEffects({ exitBeforeTurn: true });
    const executor = createCodexExecutor(effects, { repoRoot: "/repo" });
    await expect(executor({ model: "m", effort: "low", prompt: "p" })).rejects.toThrow(/exited/);
  });

  it("wsl locus routes the spawn through wsl.exe -e codex app-server with a distro cwd", async () => {
    const { effects, spawns, turnStarts } = fakeExecEffects({ finalText: "{}" });
    const executor = createCodexExecutor(effects, {
      locus: { kind: "wsl", distro: "Ubuntu" },
      repoRoot: "/home/rai/repo",
    });
    await executor({ model: "m", effort: "low", prompt: "p" });
    const call = spawns[0] as SpawnCall;
    expect(call.bin).toBe("wsl.exe");
    expect(call.args.slice(0, 2)).toEqual(["-d", "Ubuntu"]);
    expect(call.args[call.args.indexOf("-e") + 1]).toBe("codex");
    expect(call.args[call.args.indexOf("-e") + 2]).toBe("app-server");
    // The turn runs in the DISTRO-NATIVE repo root, not a host path and not a temp dir.
    expect(turnStarts[0]?.cwd).toBe("/home/rai/repo");
  });

  // ── W5: the seat sees the repository it is reasoning about ──────────────────
  // Delta digest, refine-comment and draft-PR-body all reason about a change, and
  // the Claude legs of those same council-routed jobs already run at the repo root.
  // A Codex leg dropped in an empty temp dir was blind purely because of which model
  // the council picked.

  it("roots a utility turn at the bound repository by default", async () => {
    const { effects, spawns, turnStarts } = fakeExecEffects({ finalText: "{}" });
    const executor = createCodexExecutor(effects, { repoRoot: "/repo" });
    await executor({ model: "m", effort: "low", prompt: "p" });
    expect(turnStarts[0]?.cwd).toBe("/repo");
    expect((spawns[0] as SpawnCall).cwd).toBe("/repo");
  });

  it("still honours an explicit cwd — a caller with a different tree in mind wins", async () => {
    const { effects, turnStarts } = fakeExecEffects({ finalText: "{}" });
    const executor = createCodexExecutor(effects, { repoRoot: "/repo" });
    await executor({ model: "m", effort: "low", prompt: "p", cwd: "/elsewhere" });
    expect(turnStarts[0]?.cwd).toBe("/elsewhere");
  });

  // ── W5: the MCP table is no longer wiped with nothing put back ──────────────

  it("sends no mcp_servers override when Rennet has none to pin (user MCP survives)", async () => {
    const { effects, spawns } = fakeExecEffects({ finalText: "{}" });
    const executor = createCodexExecutor(effects, { repoRoot: "/repo" });
    await executor({ model: "m", effort: "low", prompt: "p" });
    expect((spawns[0] as SpawnCall).args).toEqual(["app-server"]);
  });

  it("pins Rennet's loopback servers when it has them", async () => {
    const { effects, spawns } = fakeExecEffects({ finalText: "{}" });
    const executor = createCodexExecutor(effects, {
      repoRoot: "/repo",
      mcpServers: { canvasops: { url: "http://127.0.0.1:5000/mcp" } },
    });
    await executor({ model: "m", effort: "low", prompt: "p" });
    expect((spawns[0] as SpawnCall).args).toContain(
      'mcp_servers={canvasops={url="http://127.0.0.1:5000/mcp"}}',
    );
  });
});

// ── discoverCodexAvailability — the composition root's honest codex probe ──────

describe("discoverCodexAvailability", () => {
  it("reports available with the parsed version when the probe exits 0", async () => {
    const probe = vi.fn(async () => ({ exitCode: 0, stdout: "codex-cli 0.3.5\n" }));
    const result = await discoverCodexAvailability(probe);
    expect(result).toEqual({ available: true, version: "0.3.5" });
    expect(probe).toHaveBeenCalledWith(CODEX_EXEC_BIN);
  });

  it("reports unavailable when the probe exits non-zero", async () => {
    const probe = vi.fn(async () => ({ exitCode: 127, stdout: "" }));
    expect(await discoverCodexAvailability(probe)).toEqual({ available: false, version: null });
  });

  it("reports unavailable when the probe throws (no codex on PATH)", async () => {
    const probe = vi.fn(async () => {
      throw new Error("spawn codex ENOENT");
    });
    expect(await discoverCodexAvailability(probe)).toEqual({ available: false, version: null });
  });

  it("reports available with a null version when stdout has no parseable version", async () => {
    const probe = vi.fn(async () => ({ exitCode: 0, stdout: "codex\n" }));
    expect(await discoverCodexAvailability(probe)).toEqual({ available: true, version: null });
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
    const j = JSON.parse(JSON.stringify(sanitizeSchemaForCodex(schema)));
    expect(j.additionalProperties).toBe(false);
    expect(j.properties.findings.items.additionalProperties).toBe(false);
    expect(j.required).toEqual(["findings"]);
    expect(j.properties.findings.items.properties.id).toEqual({ type: "string" });
  });

  it("keeps a TYPED additionalProperties subschema (only the empty-object case flips)", () => {
    const out = sanitizeSchemaForCodex({
      type: "object",
      additionalProperties: { type: "string" },
    }) as Record<string, unknown>;
    expect(out.additionalProperties).toEqual({ type: "string" });
  });

  it("does not mutate its input", () => {
    const schema = { type: "object", additionalProperties: {} };
    const clone = structuredClone(schema);
    sanitizeSchemaForCodex(schema);
    expect(schema).toEqual(clone);
  });

  it("handles arrays and leaves an existing false untouched", () => {
    const out = sanitizeSchemaForCodex({
      anyOf: [
        { type: "object", additionalProperties: {} },
        { type: "object", additionalProperties: false },
      ],
    }) as { anyOf: Record<string, unknown>[] };
    expect(out.anyOf[0]?.additionalProperties).toBe(false);
    expect(out.anyOf[1]?.additionalProperties).toBe(false);
  });

  it("rewrites oneOf to the OpenAI-supported anyOf recursively", () => {
    const input = {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            properties: { kind: { const: "a" }, value: { type: "string" } },
            required: ["kind", "value"],
          },
          {
            type: "object",
            properties: { kind: { const: "b" }, count: { type: "number" } },
            required: ["kind", "count"],
          },
        ],
      },
    };

    const out = sanitizeSchemaForCodex(input) as {
      items: { oneOf?: unknown; anyOf?: unknown[] };
    };
    expect(out.items.oneOf).toBeUndefined();
    expect(out.items.anyOf).toHaveLength(2);
    expect(input.items.oneOf).toHaveLength(2);
  });

  it("adds every property to `required` and makes a previously-optional one nullable", () => {
    const out = JSON.parse(
      JSON.stringify(
        sanitizeSchemaForCodex({
          type: "object",
          properties: { id: { type: "string" }, note: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        }),
      ),
    );
    expect(new Set(out.required)).toEqual(new Set(["id", "note"]));
    expect(out.properties.id).toEqual({ type: "string" });
    expect(out.properties.note).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
  });

  it("leaves an already-nullable optional idempotent (no double-null branch)", () => {
    const out = JSON.parse(
      JSON.stringify(
        sanitizeSchemaForCodex({
          type: "object",
          properties: { maybe: { anyOf: [{ type: "string" }, { type: "null" }] } },
          required: [],
        }),
      ),
    );
    expect(out.required).toEqual(["maybe"]);
    expect(
      out.properties.maybe.anyOf.filter((b: { type?: string }) => b.type === "null"),
    ).toHaveLength(1);
  });

  it("sets additionalProperties:false on an object that omits it", () => {
    const out = sanitizeSchemaForCodex({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    }) as Record<string, unknown>;
    expect(out.additionalProperties).toBe(false);
  });

  it("makes the REAL finding schema OpenAI-strict compliant (every object: required == property keys)", () => {
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
    expect(
      stripNullDeep({
        findings: [
          { findingId: "f1", verification: null, nested: { keep: 1, drop: null } },
          { findingId: "f2", verification: { verdict: "reproduced", evidence: "e" } },
        ],
      }),
    ).toEqual({
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
