## MODIFIED Requirements

### Requirement: The ordering pass consults an injected invocation budget before every turn
`runOrderingPass` SHALL accept an optional injected invocation budget with the same semantics as the decomposition runner: `tryConsume` is called before EVERY `runTurn` (first attempt and every retry); a refusal records a `budget-refused` attempt carrying the typed refusal and falls back to the deterministic baseline order — no crash, no silent skip. When no budget is injected the pass behaves exactly as before.

#### Scenario: An ordering retry is refused at runtime and the baseline stands
- **WHEN** an ordering pass is given a budget that is already exhausted
- **THEN** no `runTurn` runs, the deterministic baseline order is returned with route `deterministic`, and the result flags that the budget was refused
