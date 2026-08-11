## 1. Normalized protocol (core)

- [x] 1.1 Add node-free `harness.ts`: ids, `ApiKeySource`, three-layer `CapabilityLayers`, `buildCapabilities`, `HarnessDescriptor`, `HarnessHealth`
- [x] 1.2 Add the event envelope with adapter-assigned `seq`, the event union (session/text/tool/denied/auth-warning/error/passthrough), and `createSeqCounter`/`envelope`
- [x] 1.3 Add the error taxonomy with the origin axis (`ErrorClass` + `ErrorOrigin` + `HarnessError`)
- [x] 1.4 Define `HarnessPort`/`HarnessSession`/`SessionSpec`/`TurnInput` and re-export the module from `@rennet/core`
- [x] 1.5 Test: capability layers default to false and are derived from passing checks, not declared (red-then-green proven)

## 2. Harness discovery (adapters)

- [x] 2.1 Implement login-shell PATH harvest, known-location union, readdir + X_OK resolution, and execute-to-version health, with injected effects
- [x] 2.2 Rank candidates (known-location, then highest version) and return three-state health
- [x] 2.3 Test: discovery finds the harness in a bare login shell where `claude` is a shell function
- [x] 2.4 Test: discovery never requests a credential path, with a control proving the check can fire

## 3. Claude adapter (adapters)

- [x] 3.1 Declare the narrow `ClaudeQueryFn` boundary and normalize SDK frames to `HarnessEvent`s (session/text/tool/passthrough)
- [x] 3.2 Assert `apiKeySource` on init and emit `auth.metered-key-warning` on a metered key; no warning on oauth (red-then-green proven)
- [x] 3.3 Map a denied write to `tool.denied`, not an error; map result errors through the taxonomy with an origin
- [x] 3.4 Build a read-only session posture (allow/deny tools, no bypass), spread the child env with a scoped session marker, inject no key

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. The read-only/allow-deny half of 3.4 is withdrawn — the session inherits the user's own harness permissions; only the env marker and the never-inject-a-key half still apply.
- [x] 3.5 Derive descriptor capability flags from passing checks; cancel via subprocess abort
- [x] 3.6 Test: end-to-end turn round-trips with adapter-assigned monotonic seq and schema-constrained structured output (hermetic, plus out-of-band real-turn evidence)

## 4. Packaging + gates + docs

- [x] 4.1 Record the SDK vendored-binary exclusion in the desktop Forge config (dormant, R2 + T3 precedent)
- [x] 4.2 Full `pnpm check` green across all 7 projects (format, architecture, licenses, lint, typecheck, test, build)
- [x] 4.3 File follow-up beads: SDK production-dependency + licence decision; live conformance suite; `testedRange` from CI
