import { tmpdir } from "node:os";
import type { Query, Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";
import { HOST_LOCUS, type Locus } from "@rennet/core";
import type { ClaudeQueryArgs, ClaudeQueryFn, ClaudeQueryOptions } from "./claude-adapter";
import { CLAUDE_TESTED_RANGE, ClaudeAdapter } from "./claude-adapter";
import {
  type DiscoveryDeps,
  type DiscoveryResult,
  defaultDiscoveryDeps,
  discoverClaude,
  type VersionRange,
  wslDiscoveryDeps,
} from "./harness-discovery";
import { wslClaudeExecutable } from "./wsl-launcher";

/**
 * The composition root for the Claude harness transport.
 *
 * Slice 1 built `ClaudeAdapter` against the `@anthropic-ai/claude-agent-sdk`
 * `query()` surface but INJECTED that transport (a `ClaudeQueryFn`) so the
 * adapter package stayed free of the proprietary dependency and fully hermetic.
 * Rai adopted the SDK on 2026-08-06 (Master Plan R2), so this module is the one
 * place that imports it and produces the REAL `ClaudeQueryFn` the adapter runs.
 *
 * Two disciplines are preserved here:
 *   - The SDK is loaded with a lazy dynamic `import()`, not a static one, so
 *     importing `@rennet/adapters` does not eagerly load the SDK (which resolves
 *     a per-platform native binary) for consumers that never touch the harness,
 *     and so the hermetic adapter tests keep running with no SDK involved.
 *   - R2: `query()` spawns the user's OWN installed `claude` via
 *     `pathToClaudeCodeExecutable`, so auth stays on their subscription OAuth and
 *     costs nothing per token. We never read a credential; we assert
 *     `apiKeySource` on the init frame (in the adapter) instead.
 */

/** The SDK's `query()` surface, narrowed to what this module calls. */
type SdkQuery = (params: { prompt: string; options?: SdkOptions }) => Query;

interface SdkToolResult {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
}

export interface ClaudeSdkTooling {
  readonly tool: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (input: unknown) => Promise<SdkToolResult>,
  ) => unknown;
  readonly createSdkMcpServer: (options: {
    readonly name: string;
    readonly tools: readonly unknown[];
  }) => unknown;
}

export type LoadClaudeTooling = () => Promise<ClaudeSdkTooling>;

/**
 * Loads the real SDK `query()`. Injectable so a hermetic test can supply a fake
 * without the SDK (and without spawning anything).
 */
export type LoadClaudeQuery = () => Promise<SdkQuery>;

const loadRealQuery: LoadClaudeQuery = async () => {
  const module = await import("@anthropic-ai/claude-agent-sdk");
  return module.query as unknown as SdkQuery;
};

const loadRealTooling: LoadClaudeTooling = async () => {
  const module = await import("@anthropic-ai/claude-agent-sdk");
  return {
    tool: module.tool as unknown as ClaudeSdkTooling["tool"],
    createSdkMcpServer:
      module.createSdkMcpServer as unknown as ClaudeSdkTooling["createSdkMcpServer"],
  };
};

const IN_PROCESS_MCP_SERVER_NAME = "rennet-app";

function availableServerName(servers: SdkOptions["mcpServers"]): string {
  if (servers === undefined || !(IN_PROCESS_MCP_SERVER_NAME in servers)) {
    return IN_PROCESS_MCP_SERVER_NAME;
  }
  let suffix = 2;
  while (`${IN_PROCESS_MCP_SERVER_NAME}-${suffix}` in servers) suffix += 1;
  return `${IN_PROCESS_MCP_SERVER_NAME}-${suffix}`;
}

function renderToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result) ?? String(result);
}

async function withInProcessTools(
  options: ClaudeQueryOptions,
  sdkOptions: SdkOptions,
  loadTooling: LoadClaudeTooling,
): Promise<SdkOptions> {
  if (options.inProcessTools === undefined || options.inProcessTools.length === 0) {
    return sdkOptions;
  }
  const tooling = await loadTooling();
  const tools = options.inProcessTools.map((descriptor) =>
    tooling.tool(descriptor.name, descriptor.description, descriptor.inputSchema, async (input) => {
      const result = await descriptor.run(input);
      return { content: [{ type: "text", text: renderToolResult(result) }] };
    }),
  );
  const serverName = availableServerName(sdkOptions.mcpServers);
  const server = tooling.createSdkMcpServer({ name: serverName, tools });
  sdkOptions.mcpServers = {
    ...sdkOptions.mcpServers,
    [serverName]: server,
  } as NonNullable<SdkOptions["mcpServers"]>;
  return sdkOptions;
}

/**
 * Translate the adapter's by-contract `ClaudeQueryOptions` into the real SDK
 * `Options`. Two fields are not direct passthroughs (verified field-by-field
 * against sdk.d.ts 0.3.223): `outputSchema` (our raw JSON schema) becomes the
 * SDK's `outputFormat: { type: 'json_schema', schema }`, and `appendSystemPrompt`
 * becomes the SDK's `systemPrompt: { type: 'preset', preset: 'claude_code',
 * append }`. Everything else is identical. Keeping the contract stable and
 * translating here means the SDK's version-specific shape lives in exactly one
 * place and the adapter's hermetic tests never have to know about it.
 */
/**
 * Normalize a raw `outputSchema` into the shape the installed `claude` binary's
 * `--json-schema` (ajv) validator accepts. Zod v4's `z.toJSONSchema` stamps a
 * top-level `$schema` naming the draft-2020-12 meta-schema; the CLI's ajv has no
 * 2020-12 meta-schema registered and rejects the WHOLE schema (`claude` exits 1:
 * "not a valid JSON Schema: no schema with key or ref .../draft/2020-12/schema")
 * BEFORE the turn runs. Dropping the top-level meta declaration (`$schema`/`$id`)
 * lets ajv validate under its default dialect — proven live to still ACCEPT the
 * schema AND emit structured output. Every constraint in the schema BODY (fields,
 * `required`, `enum`, `const`, nested `$ref`) is untouched, so no caller's contract
 * weakens. This is the one choke point all five `outputSchema` callers route through
 * (boards, delta-digest, draft-pr-body, handoff-compose, refine-comment); first
 * surfaced by C15's `runRound` — the first production run of any of them — against
 * claude 2.1.246 (above Rennet's tested range; a general version-robustness pass on
 * adapter args is a noted follow-up). Shallow by design: only the top-level meta keys
 * are removed, so internal `$ref`/`$defs` references keep resolving.
 */
export function normalizeOutputSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== "object") return schema as Record<string, unknown>;
  const rest = { ...(schema as Record<string, unknown>) };
  delete rest.$schema;
  delete rest.$id;
  // NOT a place to rescue a top-level union. Stamping `type: "object"` on an all-object
  // `anyOf` envelope was tried and measured live on 2026-09-04 (#810): it only trades
  // `400 ...input_schema.type: Field required` for `400 ...input_schema: input_schema does
  // not support oneOf, allOf, or anyOf at the top level`. The API takes one object at the
  // root, so a caller's schema must BE one (see `DesignDraftOutputSchema`); merging the
  // branches here would silently widen every caller's contract instead.
  return rest;
}

/**
 * Map the model council's VERSIONED aliases to the exact full model id the installed
 * `claude` binary accepts. The council deliberately pins a specific model version per
 * role (`opus-4.8` for lens-draft, `sonnet-5` for the round-report/flagged seats), but
 * `claude` 2.1.246 (above Rennet's tested range) rejects those short versioned aliases
 * ("There's an issue with the selected model (opus-4.8). It may not exist or you may not
 * have access to it.") while accepting the SDK's canonical full ids for the SAME version.
 * So we translate to the full id — preserving the council's exact version intent, never a
 * lossy strip to a bare alias (which would silently substitute whatever the binary's
 * "opus" currently points at). First surfaced by C15's `runRound`, the first production run
 * of any model-routed board seat; every full id here was confirmed live against the binary.
 * Bare aliases (`opus`/`sonnet`/`haiku`) and already-full ids pass through untouched.
 */
const COUNCIL_MODEL_FULL_IDS: Readonly<Record<string, string>> = {
  "opus-4.8": "claude-opus-4-8",
  "sonnet-5": "claude-sonnet-5",
};

export function mapCouncilModel(model: string): string {
  return COUNCIL_MODEL_FULL_IDS[model] ?? model;
}

export function toSdkOptions(options: ClaudeQueryOptions): SdkOptions {
  const sdkOptions: SdkOptions = {
    cwd: options.cwd,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    permissionMode: options.permissionMode,
    // The SDK REPLACES the child env wholesale, so this is the full env the
    // adapter already assembled (base env spread + scoped session marker).
    env: { ...options.env },
  };
  if (options.executableArgs !== undefined) {
    sdkOptions.executableArgs = [...options.executableArgs];
  }
  if (options.abortController) sdkOptions.abortController = options.abortController;
  if (options.model !== undefined) sdkOptions.model = mapCouncilModel(options.model);
  if (options.effort !== undefined) sdkOptions.effort = options.effort;
  if (options.allowedTools !== undefined) sdkOptions.allowedTools = [...options.allowedTools];
  if (options.disallowedTools !== undefined) {
    sdkOptions.disallowedTools = [...options.disallowedTools];
  }
  // Never set settingSources or strictMcpConfig: every session loads the user's
  // own filesystem settings. Auth routing lives there — a settings-env
  // ANTHROPIC_BASE_URL (e.g. a tokenmaxx-style credential proxy) is the only
  // thing keeping the spawned CLI on a live account, and skipping user settings
  // sent every lens seat to the API on an exhausted credential (2026-09-01).
  if (options.appendSystemPrompt !== undefined) {
    // Second translation: the adapter's contract carries an "append" system
    // prompt, which the SDK expresses as the preset form with `append`. This
    // keeps Claude Code's built-in system prompt and adds to it (never replaces
    // it), matching the adapter's `systemPrompt.mode === "append"` intent.
    sdkOptions.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: options.appendSystemPrompt,
    };
  }
  // W5: the adapter's `name → { url }` contract (shared with the Codex and OMP
  // adapters) becomes the SDK's HTTP server config, added alongside the user's
  // own configured servers.
  if (options.mcpServers !== undefined) {
    sdkOptions.mcpServers = Object.fromEntries(
      Object.entries(options.mcpServers).map(([name, server]) => [
        name,
        { type: "http" as const, url: server.url },
      ]),
    );
  }
  if (options.outputSchema !== undefined) {
    sdkOptions.outputFormat = {
      type: "json_schema",
      schema: normalizeOutputSchema(options.outputSchema),
    };
  }
  // Cursor-resume (B09): the adapter's `resume` (a harness session id) is the
  // SDK's `resume` option — loads that conversation's history and continues it.
  if (options.resume !== undefined) sdkOptions.resume = options.resume;
  // Partial-message streaming (F1): without this the SDK emits no `stream_event`
  // frames at all, so the adapter's `text.delta` mapping has nothing to map.
  if (options.includePartialMessages !== undefined) {
    sdkOptions.includePartialMessages = options.includePartialMessages;
  }
  // #585: a one-shot utility turn is not the user's work. `persistSession: false`
  // keeps it out of `~/.claude/projects/` entirely (sdk.d.ts 0.3.223). Safe to set
  // here: Rennet never passes the SDK's `sessionStore`, which is the one option it
  // cannot be combined with.
  if (options.ephemeral === true) sdkOptions.persistSession = false;
  return sdkOptions;
}

/**
 * The REAL `ClaudeQueryFn`: wraps the SDK's `query()` so the adapter's async
 * iteration drives an actual `claude` subprocess. The SDK import is deferred to
 * first iteration so nothing loads it until a turn actually runs.
 */
export function createClaudeQueryFn(
  loadQuery: LoadClaudeQuery = loadRealQuery,
  loadTooling: LoadClaudeTooling = loadRealTooling,
): ClaudeQueryFn {
  return (args: ClaudeQueryArgs): AsyncIterable<unknown> => ({
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      const query = await loadQuery();
      const options = await withInProcessTools(
        args.options,
        toSdkOptions(args.options),
        loadTooling,
      );
      const iterator = query({ prompt: args.prompt, options });
      for await (const message of iterator) yield message as unknown;
    },
  });
}

export interface ClaudeHarnessDeps {
  /** Discovery effects; defaults to the locus-appropriate real effects. */
  readonly discoveryDeps?: DiscoveryDeps;
  /** Version floor/ceiling the adapter has been exercised against. */
  readonly range?: VersionRange;
  /** SDK `query()` loader; defaults to the real lazy import. Injectable for tests. */
  readonly loadQuery?: LoadClaudeQuery;
  /** Base environment the spawned `claude` inherits (the SDK replaces the child env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Loopback MCP servers every session of this harness may call (W5) — the Claude
   *  counterpart of `CodexAdapterConfig.mcpServers`. Unsupplied in production: no
   *  loopback canvasOps server exists to point it at yet. */
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
  /** Host-local cwd for the Windows `wsl.exe` child; injectable for tests. */
  readonly hostTransportCwd?: string;
  /**
   * The project's execution locus (add-windows-support). A WSL locus discovers the
   * distro's `claude` and points the SDK directly at `wsl.exe`, with the distro
   * command carried as prepended executable argv. Defaults to the host.
   */
  readonly locus?: Locus;
  /**
   * The distro-native repo cwd (e.g. `/home/rai/repo`) passed to `wsl.exe --cd`.
   * Optional; when absent the turn runs in the distro login home.
   */
  readonly wslCwd?: string;
  /** Build the SDK's directly-spawnable WSL executable specification. */
  readonly makeWslExecutable?: (input: {
    distro: string;
    distroClaudePath: string;
    distroCwd?: string;
  }) => { pathToClaudeCodeExecutable: string; executableArgs: string[] };
}

export interface ClaudeHarnessResult {
  /** A ClaudeAdapter wired to the real SDK, or `null` when no binary was found. */
  readonly adapter: ClaudeAdapter | null;
  /** The discovery result, whose `health` explains an unavailable harness. */
  readonly discovery: DiscoveryResult;
}

/**
 * Compose a runnable Claude harness end to end: discover the user's installed
 * `claude`, and if found, build a `ClaudeAdapter` wired to the REAL SDK
 * `query()`. Returns `adapter: null` (with the discovery health) when no binary
 * is found, so a caller surfaces an unavailable state rather than crashing.
 */
export async function createClaudeHarness(
  deps: ClaudeHarnessDeps = {},
): Promise<ClaudeHarnessResult> {
  // The hermetic-test hook (#386): discovery probes ABSOLUTE locations
  // (/opt/homebrew/bin, /usr/local/bin, ChatGPT.app) that no amount of HOME/PATH
  // surgery can scrub, so a deterministic e2e sets RENNET_DISABLE_HARNESS=1 and
  // the app renders its model-free floor. Honoured only from the EXPLICITLY
  // passed env (never ambient process.env in library code), and disclosed in the
  // health detail. Caveat, accepted for a test hook: a daemon launched with the
  // flag reports harnesses as not installed.
  if (deps.env?.RENNET_DISABLE_HARNESS === "1") {
    return {
      adapter: null,
      discovery: {
        candidates: [],
        chosen: null,
        health: {
          state: "unavailable",
          reason: "not-found",
          detail: "Harness discovery is disabled (RENNET_DISABLE_HARNESS=1).",
        },
      },
    };
  }
  const range = deps.range ?? CLAUDE_TESTED_RANGE;
  const locus = deps.locus ?? HOST_LOCUS;
  const discoveryDeps =
    deps.discoveryDeps ??
    (locus.kind === "wsl" ? await wslDiscoveryDeps(locus.distro) : defaultDiscoveryDeps());
  const discovery = await discoverClaude(discoveryDeps, range);
  if (!discovery.chosen) {
    return { adapter: null, discovery };
  }
  const executable =
    locus.kind === "wsl"
      ? (deps.makeWslExecutable ?? wslClaudeExecutable)({
          distro: locus.distro,
          distroClaudePath: discovery.chosen.path,
          ...(deps.wslCwd === undefined ? {} : { distroCwd: deps.wslCwd }),
        })
      : { pathToClaudeCodeExecutable: discovery.chosen.path, executableArgs: undefined };
  const adapter = new ClaudeAdapter({
    binaryPath: executable.pathToClaudeCodeExecutable,
    ...(executable.executableArgs === undefined
      ? {}
      : { executableArgs: executable.executableArgs }),
    ...(locus.kind === "wsl" ? { transportCwd: deps.hostTransportCwd ?? tmpdir() } : {}),
    version: discovery.chosen.version,
    queryFn: createClaudeQueryFn(deps.loadQuery),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.mcpServers === undefined ? {} : { mcpServers: deps.mcpServers }),
  });
  return { adapter, discovery };
}
