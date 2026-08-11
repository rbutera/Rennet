# comprehension-ordering-pass Specification

## Purpose
TBD - created by archiving change build-comprehension-ordering-pass. Update Purpose after archive.
## Requirements
### Requirement: The ordering pass drives an agent to a validator-admitted ordering, agent-owned
`runOrderingPass` SHALL take the admitted decomposition (its chunk set plus its baseline reading order), build the chunk manifest an agent may cite, assemble the `ordering@1` contract prompt over the chunk ids and their baseline order, drive an injected session, stamp a trustworthy `ordering` envelope around the agent's body (minting the docId and the inputDigest, never the agent), and validate it. There SHALL be no user-approval step: the ordering is produced by the agent and admitted by the validator alone.

#### Scenario: A valid agent order is admitted and stamped agentic
- **WHEN** the injected session emits a reading order that covers the offered chunk set with a rationale
- **THEN** the pass admits it, the stamped envelope's provenance route is `agentic`, and the docId and inputDigest are stamped by the pass, not the agent's body

#### Scenario: No ordering-approval command exists
- **WHEN** the command registry is inspected
- **THEN** it contains no command that approves an ordering (the human does not approve ordering)

### Requirement: The deterministic baseline is the always-present fallback
On a rejection the pass SHALL feed the machine-readable report back and retry up to the configured cap sharing the budget. On terminal failure (every attempt rejected, or the turn itself failing) the pass SHALL fall back to `deterministicOrderingBody`, whose `readingOrder` is the decomposition's baseline order, admitted, with the provenance route recorded as `deterministic`.

#### Scenario: A rejected first attempt is fed back and admitted on retry
- **WHEN** the first emitted order omits a chunk (V111) and the retry emits a valid order
- **THEN** the pass admits on the retry with route `agentic` and records the first attempt as rejected with V111

#### Scenario: Every attempt rejected falls back to the baseline
- **WHEN** every attempt emits an invalid order
- **THEN** the pass admits the baseline order with route `deterministic` and `usedFallback` true

#### Scenario: A failing turn falls back to the baseline
- **WHEN** the injected session fails on every attempt
- **THEN** the pass admits the baseline order with route `deterministic`

### Requirement: The live order is resolvable and records which order is live
`resolveLiveOrder` SHALL return the reading order carried by the admitted document together with its provenance route, so a consumer reads the agent order when it was admitted and the baseline when it was not, and can tell which is live. The pass result SHALL also expose the baseline order so a consumer can render either on switch.

#### Scenario: An agent order that differs from the baseline is the live order when admitted
- **WHEN** the agent emits a valid order that differs from the baseline and it is admitted
- **THEN** `resolveLiveOrder` returns the agent order with route `agentic`, while the exposed baseline order is unchanged, and both are covers of the chunk set

#### Scenario: The baseline is the live order on fallback
- **WHEN** the agent order is rejected and the pass falls back
- **THEN** `resolveLiveOrder` returns the baseline order with route `deterministic`

