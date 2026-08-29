import type { HarnessEvent, HarnessInProcessTool } from "@rennet/core";
import { describe, expect, it } from "vitest";
import type { ClaudeQueryOptions } from "./claude-adapter";
import { ClaudeAdapter } from "./claude-adapter";
import {
  type ClaudeHarnessDeps,
  type ClaudeSdkTooling,
  createClaudeHarness,
  createClaudeQueryFn,
  type LoadClaudeQuery,
  mapCouncilModel,
  normalizeOutputSchema,
  toSdkOptions,
} from "./claude-query";
import type { DiscoveryDeps } from "./harness-discovery";

/** The SDK-shaped params the factory hands to `query()`; captured for assertions. */
interface CapturedSdkParams {
  prompt: string;
  options?: Record<string, unknown>;
}

/** A fake SDK `query()` loader: yields `frames`, capturing the params it is given. */
function fakeLoadQuery(
  frames: readonly unknown[],
  capture?: (params: CapturedSdkParams) => void,
): LoadClaudeQuery {
  const query = (params: CapturedSdkParams) => {
    capture?.(params);
    return (async function* () {
      for (const frame of frames) yield frame;
    })();
  };
  return async () => query as unknown as Awaited<ReturnType<LoadClaudeQuery>>;
}

function baseOptions(overrides: Partial<ClaudeQueryOptions> = {}): ClaudeQueryOptions {
  return {
    cwd: "/repo",
    pathToClaudeCodeExecutable: "/home/rai/.local/bin/claude",
    permissionMode: "bypassPermissions",
    env: { PATH: "/usr/bin", HOME: "/home/rai" },
    ...overrides,
  };
}

async function drain(session: { events: AsyncIterable<HarnessEvent> }): Promise<HarnessEvent[]> {
  const collected: HarnessEvent[] = [];
  for await (const event of session.events) collected.push(event);
  return collected;
}

describe("toSdkOptions", () => {
  // W5: a Claude seat had no way to reach canvasOps at all while the Codex leg of the
  // same council-routed job could. This is the missing surface, and it is ADDITIVE.
  it("translates mcpServers into the SDK's HTTP server config", () => {
    const sdk = toSdkOptions(
      baseOptions({ mcpServers: { canvasops: { url: "http://127.0.0.1:5000/mcp" } } }),
    ) as Record<string, unknown>;
    expect(sdk.mcpServers).toEqual({
      canvasops: { type: "http", url: "http://127.0.0.1:5000/mcp" },
    });
    // Never strict: the user's own configured servers stay reachable alongside ours.
    expect("strictMcpConfig" in sdk).toBe(false);
  });

  it("omits mcpServers entirely when Rennet has none", () => {
    expect("mcpServers" in (toSdkOptions(baseOptions()) as Record<string, unknown>)).toBe(false);
  });

  it("translates outputSchema into the SDK json_schema outputFormat", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const sdk = toSdkOptions(baseOptions({ outputSchema: schema })) as Record<string, unknown>;
    // The one non-passthrough field: our contract's raw schema becomes the SDK's
    // outputFormat wrapper. If this regresses, structured output silently stops
    // being constrained (the real turn is the backstop, but this catches it hermetically).
    expect(sdk.outputFormat).toEqual({ type: "json_schema", schema });
    expect("outputSchema" in sdk).toBe(false);
  });

  it("omits includePartialMessages unless the caller asked for partial frames", () => {
    // The SDK emits NO `stream_event` frames unless this is set, so the adapter's
    // text.delta mapping has no source. Opt-in (F1 Decision 4): pipeline turns keep
    // their exact current frame volume.
    const off = toSdkOptions(baseOptions()) as Record<string, unknown>;
    expect("includePartialMessages" in off).toBe(false);
    const on = toSdkOptions(baseOptions({ includePartialMessages: true })) as Record<
      string,
      unknown
    >;
    expect(on.includePartialMessages).toBe(true);
  });

  it("maps ephemeral to the SDK's persistSession: false, and omits it otherwise (#585)", () => {
    // A one-shot utility turn must not land in ~/.claude/projects/. If this
    // regresses, one context map floods the user's own session history again.
    const ephemeral = toSdkOptions(baseOptions({ ephemeral: true })) as Record<string, unknown>;
    expect(ephemeral.persistSession).toBe(false);
    // The user's own agentic session is their work — it keeps persisting.
    expect("persistSession" in (toSdkOptions(baseOptions()) as Record<string, unknown>)).toBe(
      false,
    );
    expect(
      "persistSession" in
        (toSdkOptions(baseOptions({ ephemeral: false })) as Record<string, unknown>),
    ).toBe(false);
  });

  it("omits outputFormat entirely when no schema is set", () => {
    const sdk = toSdkOptions(baseOptions()) as Record<string, unknown>;
    expect("outputFormat" in sdk).toBe(false);
  });

  it("passes through the remaining option surface unchanged", () => {
    const abortController = new AbortController();
    const sdk = toSdkOptions(
      baseOptions({
        model: "haiku",
        allowedTools: ["Read", "Grep"],
        disallowedTools: ["Write", "Bash"],
        appendSystemPrompt: "be terse",
        abortController,
      }),
    ) as Record<string, unknown>;
    expect(sdk.cwd).toBe("/repo");
    expect(sdk.pathToClaudeCodeExecutable).toBe("/home/rai/.local/bin/claude");
    expect(sdk.permissionMode).toBe("bypassPermissions");
    expect(sdk.model).toBe("haiku");
    expect(sdk.allowedTools).toEqual(["Read", "Grep"]);
    expect(sdk.disallowedTools).toEqual(["Write", "Bash"]);
    // appendSystemPrompt is translated to the SDK's preset "append" form, which
    // keeps Claude Code's built-in system prompt rather than replacing it.
    expect(sdk.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "be terse",
    });
    expect("appendSystemPrompt" in sdk).toBe(false);
    expect(sdk.abortController).toBe(abortController);
    expect((sdk.env as Record<string, string>).PATH).toBe("/usr/bin");
  });

  it("passes executableArgs through as discrete SDK argv", () => {
    const sdk = toSdkOptions(
      baseOptions({ executableArgs: ["-d", "Ubuntu", "-e", "/home/rai/bin/claude"] }),
    );
    expect(sdk.executableArgs).toEqual(["-d", "Ubuntu", "-e", "/home/rai/bin/claude"]);
  });

  it("strips the draft-2020-12 $schema meta the CLI ajv cannot resolve, keeping the body", () => {
    // A Zod-v4-shaped schema: the top-level `$schema` names the draft-2020-12 meta-schema
    // that the installed `claude` --json-schema (ajv) rejects, exiting 1 before the turn.
    const zodShaped = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://rennet.dev/board",
      type: "object",
      properties: {
        kind: { enum: ["a", "b"] },
        ref: { $ref: "#/$defs/thing" },
      },
      required: ["kind"],
      additionalProperties: false,
      $defs: { thing: { type: "string" } },
    };
    const sdk = toSdkOptions(baseOptions({ outputSchema: zodShaped })) as Record<string, unknown>;
    const out = (sdk.outputFormat as { schema: Record<string, unknown> }).schema;
    // The meta declarations are gone (ajv validates under its default dialect)…
    expect("$schema" in out).toBe(false);
    expect("$id" in out).toBe(false);
    // …but every constraint in the BODY survives — including the INTERNAL $ref/$defs,
    // which stay resolvable (the strip is shallow, top-level meta only). No contract weakens.
    expect(out).toEqual({
      type: "object",
      properties: {
        kind: { enum: ["a", "b"] },
        ref: { $ref: "#/$defs/thing" },
      },
      required: ["kind"],
      additionalProperties: false,
      $defs: { thing: { type: "string" } },
    });
  });

  it("normalizeOutputSchema leaves a dialect-free schema untouched", () => {
    const bare = { type: "object", properties: { ok: { type: "boolean" } } };
    expect(normalizeOutputSchema(bare)).toEqual(bare);
  });

  it("maps the council's versioned model aliases to the binary's full ids, else passes through", () => {
    // The council pins a version per role; the installed claude rejects the short versioned
    // alias but accepts the canonical full id for the SAME version (confirmed live).
    expect(mapCouncilModel("opus-4.8")).toBe("claude-opus-4-8");
    expect(mapCouncilModel("sonnet-5")).toBe("claude-sonnet-5");
    // Bare aliases, already-full ids, and unknowns pass through untouched (no lossy strip).
    expect(mapCouncilModel("haiku")).toBe("haiku");
    expect(mapCouncilModel("opus")).toBe("opus");
    expect(mapCouncilModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    // And toSdkOptions applies the map on the way to the SDK.
    expect(
      (toSdkOptions(baseOptions({ model: "opus-4.8" })) as Record<string, unknown>).model,
    ).toBe("claude-opus-4-8");
  });
});

describe("createClaudeQueryFn", () => {
  it("drives the loaded SDK query() with the translated options and yields its frames", async () => {
    let captured: CapturedSdkParams | undefined;
    const frames = [{ type: "result", subtype: "success", result: "hi" }];
    const queryFn = createClaudeQueryFn(
      fakeLoadQuery(frames, (params) => {
        captured = params;
      }),
    );
    const schema = { type: "object" };
    const yielded: unknown[] = [];
    for await (const frame of queryFn({
      prompt: "review this",
      options: baseOptions({ outputSchema: schema }),
    })) {
      yielded.push(frame);
    }
    expect(yielded).toEqual(frames);
    expect(captured?.prompt).toBe("review this");
    // The composition root actually performed the outputSchema -> outputFormat
    // translation on the way to query().
    expect(captured?.options?.outputFormat).toEqual({ type: "json_schema", schema });
  });

  it("does not load the SDK until the turn is actually iterated (lazy import)", async () => {
    let loaded = false;
    const loadQuery: LoadClaudeQuery = async () => {
      loaded = true;
      return (() =>
        (async function* () {
          yield* [];
        })()) as unknown as Awaited<ReturnType<LoadClaudeQuery>>;
    };
    const iterable = createClaudeQueryFn(loadQuery)({ prompt: "x", options: baseOptions() });
    expect(loaded).toBe(false); // constructing the iterable must not load the SDK
    let drained = 0;
    for await (const frame of iterable) {
      void frame;
      drained += 1;
    }
    expect(drained).toBe(0);
    expect(loaded).toBe(true); // iterating it does
  });

  it("mounts one in-process MCP server, preserves HTTP servers, and returns the durable result once", async () => {
    const capturedParams: CapturedSdkParams[] = [];
    const capturedTools: Array<{
      name: string;
      description: string;
      inputSchema: unknown;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];
    const tooling: ClaudeSdkTooling = {
      tool: (name, description, inputSchema, handler) => {
        const definition = { name, description, inputSchema, handler };
        capturedTools.push(definition);
        return definition;
      },
      createSdkMcpServer: ({ name, tools }) => ({
        type: "sdk",
        name,
        instance: { tools },
      }),
    };
    let runs = 0;
    const inputSchema = { safeParse: () => ({ success: true }) };
    const appTool: HarnessInProcessTool = {
      name: "app_ask_stage",
      description: "Stage ask",
      inputSchema,
      run: async (input) => {
        runs += 1;
        return { receipt: { kind: "unstage", input } };
      },
    };
    const queryFn = createClaudeQueryFn(
      fakeLoadQuery([], (params) => capturedParams.push(params)),
      async () => tooling,
    );

    for await (const frame of queryFn({
      prompt: "stage it",
      options: baseOptions({
        mcpServers: { canvasops: { url: "http://127.0.0.1:5000/mcp" } },
        inProcessTools: [appTool],
      }),
    })) {
      // Drain the lazy query.
      void frame;
    }

    expect(capturedTools).toHaveLength(1);
    expect(capturedTools[0]).toMatchObject({
      name: "app_ask_stage",
      description: "Stage ask",
      inputSchema,
    });
    const result = await capturedTools[0]?.handler({ askId: "ask-1" });
    expect(runs).toBe(1);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            receipt: { kind: "unstage", input: { askId: "ask-1" } },
          }),
        },
      ],
    });
    expect(capturedParams[0]?.options?.mcpServers).toMatchObject({
      canvasops: { type: "http", url: "http://127.0.0.1:5000/mcp" },
      "rennet-app": { type: "sdk", name: "rennet-app" },
    });
  });

  it("rebuilds the in-process server per turn so removed registry tools disappear", async () => {
    const capturedParams: CapturedSdkParams[] = [];
    const tooling: ClaudeSdkTooling = {
      tool: (name, description, inputSchema, handler) => ({
        name,
        description,
        inputSchema,
        handler,
      }),
      createSdkMcpServer: ({ name, tools }) => ({
        type: "sdk",
        name,
        instance: { tools },
      }),
    };
    const tool: HarnessInProcessTool = {
      name: "app_ask_stage",
      description: "Stage ask",
      inputSchema: {},
      run: async () => ({ receipt: "once" }),
    };
    const queryFn = createClaudeQueryFn(
      fakeLoadQuery([], (params) => capturedParams.push(params)),
      async () => tooling,
    );
    const http = { canvasops: { url: "http://127.0.0.1:5000/mcp" } };

    for await (const frame of queryFn({
      prompt: "first",
      options: baseOptions({ mcpServers: http, inProcessTools: [tool] }),
    })) {
      // Drain the first turn.
      void frame;
    }
    for await (const frame of queryFn({
      prompt: "second",
      options: baseOptions({ mcpServers: http }),
    })) {
      // Drain the next turn after registry removal.
      void frame;
    }

    expect(capturedParams[0]?.options?.mcpServers).toHaveProperty("rennet-app");
    expect(capturedParams[1]?.options?.mcpServers).toEqual({
      canvasops: { type: "http", url: "http://127.0.0.1:5000/mcp" },
    });
  });
});

describe("ClaudeAdapter driven by the real-shaped query factory", () => {
  const initFrame = (apiKeySource: string) => ({
    type: "system",
    subtype: "init",
    session_id: "s1",
    model: "claude-haiku",
    cwd: "/repo",
    tools: ["Read"],
    apiKeySource,
  });

  it("round-trips a turn and surfaces structured_output through the factory path", async () => {
    const frames = [
      initFrame("none"),
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      {
        type: "result",
        subtype: "success",
        result: '{"ok":true}',
        structured_output: { ok: true },
      },
    ];
    const adapter = new ClaudeAdapter({
      binaryPath: "/home/rai/.local/bin/claude",
      version: "2.1.220",
      queryFn: createClaudeQueryFn(fakeLoadQuery(frames)),
      now: () => 1,
    });
    const session = await adapter.createSession({
      cwd: "/repo",
      outputSchema: { type: "object" },
    });
    await session.send({ prompt: "review" });
    const events = await drain(session);
    expect(events.map((event) => event.kind)).toEqual([
      "session.started",
      "text.message",
      "session.ended",
    ]);
    // apiKeySource "none" is subscription-safe: no metered warning on the wired path.
    expect(events.some((event) => event.kind === "auth.metered-key-warning")).toBe(false);
    const ended = events.at(-1);
    expect(
      ended?.kind === "session.ended" &&
        ended.outcome.status === "completed" &&
        ended.outcome.structuredOutput,
    ).toEqual({ ok: true });
  });

  it("preserves the metered-key warning when the factory path reports a metered source", async () => {
    const adapter = new ClaudeAdapter({
      binaryPath: "/bin/claude",
      version: "2.1.220",
      queryFn: createClaudeQueryFn(fakeLoadQuery([initFrame("user")])),
      now: () => 1,
    });
    const session = await adapter.createSession({ cwd: "/repo" });
    await session.send({ prompt: "review" });
    const events = await drain(session);
    const warning = events.find((event) => event.kind === "auth.metered-key-warning");
    expect(warning?.kind === "auth.metered-key-warning" && warning.apiKeySource).toBe("user");
  });
});

describe("createClaudeHarness", () => {
  function discoveryDeps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
    return {
      loginShellPath: async () => "/home/rai/.local/bin",
      envPath: "",
      home: "/home/rai",
      listDir: async (dir) => (dir === "/home/rai/.local/bin" ? ["claude"] : []),
      isExecutable: async () => true,
      probeVersion: async () => "2.1.220",
      ...overrides,
    };
  }

  it("builds a ClaudeAdapter wired to the injected query when a binary is discovered", async () => {
    const deps: ClaudeHarnessDeps = {
      discoveryDeps: discoveryDeps(),
      loadQuery: fakeLoadQuery([]),
      env: { PATH: "/usr/bin" },
    };
    const { adapter, discovery } = await createClaudeHarness(deps);
    expect(discovery.chosen?.path).toBe("/home/rai/.local/bin/claude");
    expect(adapter).not.toBeNull();
    expect(adapter?.descriptor.binaryPath).toBe("/home/rai/.local/bin/claude");
    expect(adapter?.descriptor.version).toBe("2.1.220");
  });

  it("returns a null adapter with the discovery health when no binary is found", async () => {
    const { adapter, discovery } = await createClaudeHarness({
      discoveryDeps: discoveryDeps({ listDir: async () => [] }),
      loadQuery: fakeLoadQuery([]),
    });
    expect(adapter).toBeNull();
    expect(discovery.chosen).toBeNull();
    expect(discovery.health.state).toBe("unavailable");
  });

  it("points the SDK directly at wsl.exe with the distro claude in executableArgs", async () => {
    const executableInputs: { distro: string; distroClaudePath: string }[] = [];
    let captured: CapturedSdkParams | undefined;
    const { adapter, discovery } = await createClaudeHarness({
      locus: { kind: "wsl", distro: "Ubuntu" },
      discoveryDeps: discoveryDeps({ locus: { kind: "wsl", distro: "Ubuntu" } }),
      loadQuery: fakeLoadQuery([], (params) => {
        captured = params;
      }),
      hostTransportCwd: "C:\\Users\\rai\\AppData\\Local\\Temp",
      makeWslExecutable: (input) => {
        executableInputs.push(input);
        return {
          pathToClaudeCodeExecutable: "wsl.exe",
          executableArgs: ["-d", input.distro, "-e", input.distroClaudePath],
        };
      },
    });
    expect(discovery.chosen?.path).toBe("/home/rai/.local/bin/claude");
    expect(adapter?.descriptor.binaryPath).toBe("wsl.exe");
    expect(executableInputs).toEqual([
      { distro: "Ubuntu", distroClaudePath: "/home/rai/.local/bin/claude" },
    ]);
    const session = await adapter?.createSession({
      cwd: "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo with spaces",
    });
    await session?.send({ prompt: "probe" });
    if (session) await drain(session);
    expect(captured?.options?.cwd).toBe("C:\\Users\\rai\\AppData\\Local\\Temp");
    expect(captured?.options?.executableArgs).toEqual([
      "-d",
      "Ubuntu",
      "-e",
      "/home/rai/.local/bin/claude",
    ]);
  });
});
