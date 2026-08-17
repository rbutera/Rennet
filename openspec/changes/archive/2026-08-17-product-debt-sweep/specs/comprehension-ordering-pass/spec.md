## MODIFIED Requirements

### Requirement: The ordering pass drives an agent to a validator-admitted ordering, agent-owned
`runOrderingPass` SHALL take the admitted decomposition (its chunk set plus its baseline reading order), build the chunk manifest an agent may cite, assemble the `ordering@1` contract prompt over the chunk ids and their baseline order, drive an injected session, stamp a trustworthy `ordering` envelope around the agent's body (minting the docId and the inputDigest, never the agent), and validate it. There SHALL be no user-approval step: the ordering is produced by the agent and admitted by the validator alone. The stamped provenance route, tier, and capability snapshot SHALL reflect the executor that actually ran the turn — `agentic`/`heavy` for a Claude harness turn, `utility`/`light` with the per-call structured-output capability for a Codex utility-port turn — never a caller-side re-stamp of a default.

#### Scenario: A valid agent order is admitted and stamped agentic
- **WHEN** the injected session emits a reading order that covers the offered chunk set with a rationale
- **THEN** the pass admits it, the stamped envelope's provenance route is `agentic`, and the docId and inputDigest are stamped by the pass, not the agent's body

#### Scenario: A Codex-executed order is stamped with the port's truth
- **WHEN** the injected turn is executed by the Codex utility port and emits a valid reading order
- **THEN** the admitted envelope's provenance records route `utility`, tier `light`, and the capability snapshot the port reported for that call, while model, harness, effort, and resolutionTrace record the resolved seat as before

#### Scenario: No ordering-approval command exists
- **WHEN** the command registry is inspected
- **THEN** it contains no command that approves an ordering (the human does not approve ordering)

### Requirement: The live order is resolvable and records which order is live
`resolveLiveOrder` SHALL return the reading order carried by the admitted document together with its provenance route, so a consumer reads the agent order when it was admitted (route `agentic` or `utility`, per the executor) and the baseline when it was not (route `deterministic`), and can tell which is live. The pass result SHALL also expose the baseline order so a consumer can render either on switch.

#### Scenario: An agent order that differs from the baseline is the live order when admitted
- **WHEN** the agent emits a valid order that differs from the baseline and it is admitted
- **THEN** `resolveLiveOrder` returns the agent order with the executor's route (`agentic` for a Claude harness turn, `utility` for a Codex utility-port turn), while the exposed baseline order is unchanged, and both are covers of the chunk set

#### Scenario: The baseline is the live order on fallback
- **WHEN** the agent order is rejected and the pass falls back
- **THEN** `resolveLiveOrder` returns the baseline order with route `deterministic`
