## Why

Slice 1 built the Claude adapter as an `@anthropic-ai/claude-agent-sdk` integration *by contract*: it drives an injected `ClaudeQueryFn` (the SDK's `query()` surface) but never imports the SDK, because adopting it was an open decision Rai owned. Its licence (`SEE LICENSE IN README.md`, reported by pnpm as the `Unknown` bucket) is not in the MIT-family `check-licenses` allowlist, it fails the repository's 7-day `minimumReleaseAge` floor, and it declares three non-optional peers under `strict-peer-dependencies`. Rai approved adoption on 2026-08-06 (Master Plan R2, decision bead `workspace-03l0h`: "Yes wire the real Claude sdk in"). This slice makes the SDK a real dependency and injects its `query()` as the default transport, so the adapter is runnable end to end from the app, without loosening any supply-chain gate for anything but the SDK itself.

## What Changes

- **Licence gate (`scripts/check-licenses.mjs`)**: add `Unlicense` to the SPDX allowlist (a real public-domain-equivalent licence, transitive via `fast-sha256`) and add a NAMED-package exception for `@anthropic-ai/claude-agent-sdk` and its per-platform binary. The `Unknown` bucket is filtered by member NAME, never allowlisted wholesale — any other unreadable-licence package still blocks the build. A positive control (a fabricated `Unknown`-bucket package must still block) runs on every invocation, on the same path as the real check, so the gate is proven able to fail.
- **Release-age policy (`pnpm-workspace.yaml`)**: exclude the SDK package and its eight per-platform binary packages from `minimumReleaseAge` by name (the SDK releases daily; this is Rai's own harness SDK, deliberately fast-tracked). Nothing else is exempted.
- **Strict peers (`pnpm-workspace.yaml`)**: `peerDependencyRules.ignoreMissing` for the SDK's three non-optional peers (`zod`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`). Its main entry (`sdk.mjs`, which exports `query()`) imports none of them at module scope — they belong to other entry points and the in-process `tool()`/MCP helpers Rennet never uses. Ignoring only these three keeps strict peers on everywhere else and avoids pulling three heavy trees into a review harness that spawns the user's own binary.
- **Dependency**: add `@anthropic-ai/claude-agent-sdk` as a production dependency of `@rennet/adapters`.
- **Composition root (`packages/adapters/src/claude-query.ts`)**: `createClaudeQueryFn()` produces the REAL `ClaudeQueryFn` by lazy dynamic `import()` of the SDK, translating the adapter's by-contract `ClaudeQueryOptions` into the SDK `Options`. Two fields are not direct passthroughs: `outputSchema` → the SDK's `outputFormat: { type: 'json_schema', schema }`, and `appendSystemPrompt` → the SDK's `systemPrompt: { type: 'preset', preset: 'claude_code', append }` (keeps Claude Code's built-in prompt). `createClaudeHarness()` composes discovery + the real `query()` + `ClaudeAdapter` into a runnable harness. The desktop main wires a lazily-composed, memoized `getClaudeHarness()`.
- **Gated real turn (`packages/adapters/integration/real-turn.integration.test.ts`, `pnpm real-turn`)**: an opt-in check, outside the default gate's path and `skipIf`-guarded, that runs one tiny structured-output turn on the subscription/OAuth path and proves round-trip through the real SDK.

## Capabilities

### Modified Capabilities

- `claude-harness-adapter`: the SDK moves from injected-by-contract to a real production dependency, with the default `ClaudeQueryFn` supplied by the composition root via a lazy import of the SDK's `query()`, and an opt-in live real-turn check replacing the out-of-band evidence.

## Impact

- Adds `@anthropic-ai/claude-agent-sdk@0.3.223` (+ its `darwin-arm64` binary and the `Unlicense` transitive `fast-sha256`) to the production dependency graph of `@rennet/adapters`.
- Loosens exactly two supply-chain gates, and only for the SDK family: the licence gate (named `Unknown` exception + `Unlicense` allowance, still fails for any other unvetted package) and the release-age floor (the SDK family by name). Strict peers stays on except for the SDK's three declared peers.
- The hermetic gate (`pnpm check`) stays green and does not spend the subscription; the real turn is opt-in.
