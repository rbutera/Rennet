## 1. Supply-chain policy

- [x] 1.1 `check-licenses.mjs`: add `Unlicense` to the SPDX allowlist; add a named `Unknown`-bucket exception for `@anthropic-ai/claude-agent-sdk` + `-darwin-arm64`; filter the `Unknown` bucket by member name (never allowlist the bucket)
- [x] 1.2 `check-licenses.mjs`: unskippable positive control — a fabricated `Unknown`-bucket package must still block, run every invocation on the real path; export the pure `computeBlocked` for direct red proof
- [x] 1.3 `pnpm-workspace.yaml`: exclude the SDK package + all eight per-platform binary packages from `minimumReleaseAge`, by name, with justification
- [x] 1.4 `pnpm-workspace.yaml`: `peerDependencyRules.ignoreMissing` for `zod`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` (verified never imported by `sdk.mjs`)

## 2. Dependency + composition root

- [x] 2.1 Add `@anthropic-ai/claude-agent-sdk` as a production dependency of `@rennet/adapters` (pinned exact `0.3.223`)
- [x] 2.2 `packages/adapters/src/claude-query.ts`: `createClaudeQueryFn()` (lazy SDK `import()`, injectable loader) + `toSdkOptions()` (translate `outputSchema` → SDK `outputFormat`, passthrough the rest)
- [x] 2.3 `packages/adapters/src/claude-query.ts`: `createClaudeHarness()` composing discovery + real `query()` + `ClaudeAdapter`
- [x] 2.4 Export the factory from `@rennet/adapters`; note the `outputSchema` translation in the adapter contract
- [x] 2.5 `apps/desktop/src/main/index.ts`: lazily-composed, memoized `getClaudeHarness()` wiring the real SDK into the app's composition root

## 3. Tests + gate

- [x] 3.1 Hermetic test (`claude-query.test.ts`): `toSdkOptions` translation, lazy-load, real-turn round-trip through the factory path, metered-key warning preserved, `createClaudeHarness` binary/no-binary cases (red-then-green)
- [x] 3.2 Gated opt-in real turn (`integration/real-turn.integration.test.ts` + `pnpm real-turn`): one structured-output turn on the subscription/OAuth path, outside the default gate, `skipIf`-guarded
- [x] 3.3 `pnpm check` GREEN with the SDK present (the `licenses` gate passing WITH the SDK is the core acceptance)
- [x] 3.4 Run the real turn once; capture the evidence (apiKeySource, no metered warning, structured output round-trips)
