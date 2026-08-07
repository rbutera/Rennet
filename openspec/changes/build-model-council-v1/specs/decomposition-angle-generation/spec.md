## MODIFIED Requirements

### Requirement: The decomposition angle consults an injected invocation budget before every turn
`runDecompositionAngle` SHALL accept an optional injected invocation budget. When a budget is present it SHALL call `tryConsume` before EVERY `runTurn` — the first attempt and every retry. When `tryConsume` refuses, the runner SHALL record a `budget-refused` attempt carrying the typed refusal and stop issuing turns, falling back to the deterministic floor exactly as it does on a terminal turn failure — no crash, no silent skip. When no budget is injected the runner SHALL behave exactly as before (unbounded by a budget, as its own unit tests exercise it in isolation).

#### Scenario: A retry is refused at runtime and the floor stands
- **WHEN** a decomposition runner is given a budget of one and a turn that always rejects
- **THEN** the first turn runs and consumes the budget, the retry is budget-refused before any second `runTurn` call, the deterministic floor body is returned, and the result flags that the budget was refused

#### Scenario: No injected budget preserves prior behaviour
- **WHEN** a decomposition runner is called with no budget
- **THEN** it runs its attempts exactly as before this change
