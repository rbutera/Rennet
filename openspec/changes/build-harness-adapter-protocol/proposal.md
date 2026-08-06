## Why

The local review MVP proved the package boundaries and the disposition model, but Rennet still cannot ask a harness anything. Angle generation (#8), the canvasOps server session (#12), and the review-to-agent handoff loop all sit behind one missing seam: a normalized harness adapter protocol and the first real adapter for Claude Code. This slice builds that seam and the Claude adapter, right-sized to what those consumers need now, without settling deferred product choices (disagreement/N=3, session persistence, the utility tier, fork/resume, the cross-adapter conformance runner).

## What Changes

- Add the normalized harness protocol to `packages/core` (node-free so a phone/third-party client can import it): `HarnessPort`, `HarnessSession`, `HarnessDescriptor`, three-layer capability flags (`implementedByAdapter` / `advertisedByHarness` / `availableInSession`, all starting `false` and earned from passing checks), the event union with an adapter-assigned monotonic `seq` and raw-native-frame passthrough, and the error taxonomy with an origin axis.
- Add the Claude Code adapter to `packages/adapters` as an `@anthropic-ai/claude-agent-sdk` integration by contract: it consumes the SDK's `query()` frames, asserts `apiKeySource === 'oauth'` on the init frame and emits a visible `auth.metered-key-warning` when a metered key takes over (detection, never prevention, R2), maps a denied write to a `tool.denied` event rather than an error, defaults to a read-only tool posture, sets a scoped env marker at spawn, and cancels by aborting the subprocess. The SDK is injected (not a workspace dependency), because adopting it is an open decision (see Impact).
- Add harness discovery: harvest the login-shell PATH (`$SHELL -ilc 'printf %s "$PATH"'`, never `which`, because both harnesses are shell functions here), union it with known locations, resolve candidates by readdir + X_OK, and prove each by executing it, yielding three-state health.
- Record the R2 packaging requirement in the desktop Forge config: strip the SDK's bundled per-platform executables (T3 Code's `DESKTOP_FILE_EXCLUSIONS` precedent), dormant until packaging is exercised.
- Keep the adapter fully hermetic and testable: the SDK transport, filesystem, and process execution are all injected, so a test can prove the adapter never opens a credential path.

## Capabilities

### New Capabilities

- `harness-adapter-protocol`: The node-free normalized seam (port, session, descriptor, three-layer capabilities, event envelope with adapter-assigned sequence, native passthrough, error taxonomy with origin axis) that every harness adapter implements and every consumer reads.
- `claude-harness-adapter`: The Claude Code adapter that drives the injected SDK `query()`, normalizes its frames, guarantees subscription-OAuth money safety, and enforces a read-only review posture.
- `harness-discovery`: Login-shell PATH harvest plus known-location resolution and execute-to-health-check that finds the harness where a GUI app's inherited PATH cannot.

### Modified Capabilities

None.

## Impact

- Adds `packages/core/src/harness.ts` (re-exported from core) and `packages/adapters/src/{claude-adapter,harness-discovery}.ts`, plus their tests. No new production dependency is added.
- Records a Forge packaging exclusion for the harness SDK's vendored binaries.
- Deferred, filed as follow-up beads: adopting `@anthropic-ai/claude-agent-sdk` as a production dependency requires a decision Rai owns, because its licence (`SEE LICENSE IN README.md`) is not in the MIT-family `check-licenses` allowlist, and it fails the repository's 7-day `minimumReleaseAge` and `strict-peer-dependencies` policies. Until then the Claude adapter is SDK-shaped and SDK-ready, with the real `query` wired by the composition root. Also deferred: the real-turn live evidence is produced out of band (a real `claude` subprocess) rather than as a gated test, because it is non-hermetic and spends the subscription.
