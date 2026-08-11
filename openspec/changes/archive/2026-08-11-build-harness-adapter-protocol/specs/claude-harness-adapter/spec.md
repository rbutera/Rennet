## ADDED Requirements

### Requirement: The Claude adapter drives an injected SDK query surface
The Claude adapter SHALL be written against the `@anthropic-ai/claude-agent-sdk` `query()` contract, SHALL receive that transport by injection rather than importing the SDK as a workspace dependency, and SHALL pass the user's own installed binary so authentication stays on the user's subscription.

#### Scenario: A turn round-trips to a completed outcome
- **WHEN** the injected transport yields an init frame, assistant text, and a successful result with structured output
- **THEN** the adapter emits `session.started`, `text.message`, and a `session.ended` completed outcome carrying the structured output, with strictly increasing `seq`

### Requirement: Subscription OAuth is asserted and metered keys are surfaced
The adapter SHALL read `apiKeySource` on every session's init frame, SHALL emit a visible `auth.metered-key-warning` when the source is a metered key, and SHALL NOT emit that warning when the source is subscription OAuth. It SHALL never fail the turn closed on this basis and SHALL never inject an API key.

#### Scenario: A metered key takes over a session
- **WHEN** the init frame reports an `apiKeySource` other than `oauth`
- **THEN** the adapter emits `session.started` and an `auth.metered-key-warning` naming the metered source

#### Scenario: A subscription session
- **WHEN** the init frame reports `apiKeySource` of `oauth`
- **THEN** the adapter emits `session.started` with no warning event

### Requirement: The adapter never opens a credential path
The adapter and its discovery SHALL never read a harness credential file (for example a Claude credentials file or a Codex `auth.json`), relying on the spawned harness to authenticate itself.

#### Scenario: A session is created and discovery runs
- **WHEN** the adapter creates a session and discovery resolves the binary
- **THEN** no credential file path is read, and the safety check that would catch such a read is proven able to fire
