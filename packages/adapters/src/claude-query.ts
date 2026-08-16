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

/**
 * Loads the real SDK `query()`. Injectable so a hermetic test can supply a fake
 * without the SDK (and without spawning anything).
 */
export type LoadClaudeQuery = () => Promise<SdkQuery>;

const loadRealQuery: LoadClaudeQuery = async () => {
  const module = await import("@anthropic-ai/claude-agent-sdk");
  return module.query as unknown as SdkQuery;
};

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
  if (options.model !== undefined) sdkOptions.model = options.model;
  if (options.allowedTools !== undefined) sdkOptions.allowedTools = [...options.allowedTools];
  if (options.disallowedTools !== undefined) {
    sdkOptions.disallowedTools = [...options.disallowedTools];
  }
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
  if (options.outputSchema !== undefined) {
    sdkOptions.outputFormat = {
      type: "json_schema",
      schema: options.outputSchema as Record<string, unknown>,
    };
  }
  return sdkOptions;
}

/**
 * The REAL `ClaudeQueryFn`: wraps the SDK's `query()` so the adapter's async
 * iteration drives an actual `claude` subprocess. The SDK import is deferred to
 * first iteration so nothing loads it until a turn actually runs.
 */
export function createClaudeQueryFn(loadQuery: LoadClaudeQuery = loadRealQuery): ClaudeQueryFn {
  return (args: ClaudeQueryArgs): AsyncIterable<unknown> => ({
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      const query = await loadQuery();
      const iterator = query({ prompt: args.prompt, options: toSdkOptions(args.options) });
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
  });
  return { adapter, discovery };
}
