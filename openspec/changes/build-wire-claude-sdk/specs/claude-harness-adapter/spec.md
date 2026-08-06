## MODIFIED Requirements

### Requirement: The Claude adapter drives an injected SDK query surface
The Claude adapter SHALL be written against the `@anthropic-ai/claude-agent-sdk` `query()` contract and SHALL receive that transport by injection. The composition root SHALL supply the default injection by lazily importing the real SDK `query()`, and SHALL adopt `@anthropic-ai/claude-agent-sdk` as a production dependency of `@rennet/adapters`. The composition root SHALL translate the adapter's `outputSchema` into the SDK's `outputFormat: { type: 'json_schema', schema }`, and SHALL pass the user's own installed binary via `pathToClaudeCodeExecutable` so authentication stays on the user's subscription.

#### Scenario: A turn round-trips to a completed outcome through the real query surface
- **WHEN** the composition-root factory drives the SDK `query()` and it yields an init frame, assistant text, and a successful result with `structured_output`
- **THEN** the adapter emits `session.started`, `text.message`, and a `session.ended` completed outcome carrying the structured output, with strictly increasing `seq`

#### Scenario: The SDK is not loaded until a turn iterates
- **WHEN** a `ClaudeQueryFn` produced by the composition root is constructed but not iterated
- **THEN** the SDK module is not imported, and it is imported only once the turn is actually iterated

### Requirement: Subscription OAuth is asserted and metered keys are surfaced
The adapter SHALL read `apiKeySource` on every session's init frame, SHALL emit a visible `auth.metered-key-warning` when the source is a metered key, and SHALL NOT emit that warning when the source is subscription OAuth or the live `none` source. It SHALL never fail the turn closed on this basis and SHALL never inject an API key. A gated, opt-in real turn SHALL prove this end to end against a live `claude` without being part of the default hermetic gate.

#### Scenario: A real subscription turn raises no metered warning
- **WHEN** the gated real turn runs against the user's installed `claude` and the init frame reports `apiKeySource` of `oauth` or `none`
- **THEN** no `auth.metered-key-warning` is emitted and the turn's structured output round-trips

## ADDED Requirements

### Requirement: The licence gate admits the SDK by name and remains able to fail
The licence gate SHALL admit `@anthropic-ai/claude-agent-sdk` and its per-platform binary package by NAME within pnpm's `Unknown` bucket, SHALL admit `Unlicense` as an allowed SPDX identifier, and SHALL NOT allowlist the `Unknown` bucket wholesale. The gate SHALL run a positive control on every invocation proving that a fabricated `Unknown`-bucket package still blocks the build.

#### Scenario: An unvetted unreadable-licence package still blocks
- **WHEN** a package other than the named exceptions appears in the `Unknown` bucket
- **THEN** the gate throws and the build fails

#### Scenario: The positive control proves the gate can fail
- **WHEN** the gate runs
- **THEN** it first asserts that a fabricated `Unknown`-bucket package is reported blocked, and refuses to certify if it is not
