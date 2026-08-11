# Design

## The two API mismatches the factory absorbs

The adapter's by-contract `ClaudeQueryOptions` and the real SDK `0.3.223` `Options` differ in exactly two fields, both translated in `toSdkOptions()`:

- `outputSchema?: unknown` (our raw JSON schema) → the SDK's `Options.outputFormat: { type: 'json_schema'; schema: Record<string, unknown> }`. The result comes back on the result frame as `structured_output`, which `normalizeClaudeFrame` already reads.
- `appendSystemPrompt?: string` (our append text) → the SDK's `Options.systemPrompt: { type: 'preset'; preset: 'claude_code'; append }`, which keeps Claude Code's built-in system prompt and adds to it rather than replacing it.

Every other option field the adapter sets (`cwd`, `pathToClaudeCodeExecutable`, `permissionMode`, `env`, `abortController`, `model`, `allowedTools`, `disallowedTools`) is a direct passthrough — verified field-by-field against `sdk.d.ts`.

The translation lives in exactly one place — `toSdkOptions()` in the composition root — so the adapter's contract stays stable across SDK versions and its hermetic tests never have to know the SDK's version-specific shape. If the mapping ever regresses, structured output silently stops being constrained; a hermetic unit test asserts the mapping, and the gated real turn is the end-to-end backstop.

## Why a lazy dynamic `import()`

`createClaudeQueryFn()` loads the SDK with `await import(...)` inside the async iterator, not a static top-level import. Consequences:
- Importing `@rennet/adapters` does not eagerly load the SDK (which resolves a per-platform native binary) for consumers that never touch the harness.
- The adapter's hermetic tests keep running with no SDK involved (the transport is still injectable; tests inject a fake `query`).
- The SDK is loaded only when a turn actually iterates.

The `LoadClaudeQuery` seam makes even the composition root hermetically testable: a fake loader supplies a fake `query` with no SDK and no subprocess.

## Supply-chain gates: loosen narrowly, keep able to fail

- **Licence gate**: `Unknown` is not a licence — it is pnpm's bucket for any dep whose licence it cannot read. Allowlisting the bucket would blind the gate to every future unreadable-licence package. So the fix filters the bucket's MEMBERS against a named allowlist (`@anthropic-ai/claude-agent-sdk` + its `darwin-arm64` binary) and blocks everything else. `Unlicense` is a real SPDX identifier and joins the allowlist proper. A positive control constructs a fabricated `Unknown`-bucket package every run and asserts it still blocks; if that ever passes, the gate refuses to certify. This keeps the gate a live circuit (railway question: no single change makes it more permissive without the control catching it).
- **Release-age**: excluded by NAME for the SDK family only, all versions, because the SDK releases daily and re-arming the gate on every bump would produce a failure everyone works around badly. All eight platform binary packages are listed because pnpm records every `optionalDependency` in the lockfile regardless of the current platform.
- **Strict peers**: `ignoreMissing` for exactly the SDK's three declared peers. Grepping the `0.3.223` bundle's main entry (`sdk.mjs`) shows zero module-scope imports of any of them; they are used by `./bridge`, `./browser`, `./sdk-tools`, and the in-process `tool()`/MCP helpers, none of which Rennet touches. The gated real turn is the runtime proof that the absent peers do not break the spawn path.

## Composition root, not consumption

`createClaudeHarness()` composes discovery + real `query()` + `ClaudeAdapter` and returns a runnable adapter (or `null` + discovery health when no binary is found). The desktop main memoizes it behind `getClaudeHarness()` and composes it lazily — discovery spawns the user's login shell, so it runs on first use, not at launch. No review command consumes the harness yet (angle generation and the handoff loop are later slices); this slice makes it *composable and runnable*, which is the bead's scope.

## The real turn is deliberately outside the gate

`pnpm check` runs `vitest run packages/adapters/src`; the real turn lives in `packages/adapters/integration/`, which that path never reaches, and is additionally `skipIf`-guarded on `RENNET_LIVE_CLAUDE`. It spends the subscription and needs a live `claude`, so it must never run hermetically. `pnpm real-turn` runs it on demand.
