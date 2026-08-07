## ADDED Requirements

### Requirement: The invocation budget is a shared runtime counter that refuses over the ceiling
`createInvocationBudget(max)` SHALL return a stateful budget whose `tryConsume(purpose)` grants one invocation and increments the count while the count is below `max`, and refuses once the ceiling is reached. A refusal SHALL be a typed value carrying the code `R10_BUDGET_EXHAUSTED`, the consumed count, the max, and a reason; it SHALL NOT increment the count. The budget SHALL expose the consumed count and the remaining count.

#### Scenario: Grants up to the ceiling then refuses
- **WHEN** a budget of `max` receives `max + 1` `tryConsume` calls
- **THEN** the first `max` are granted with a decrementing `remaining`, and the `(max + 1)`th is refused with `R10_BUDGET_EXHAUSTED` and does not change the count

### Requirement: Retries and the ordering pass draw from the same budget (R10 live gate)
When one budget is threaded through the decomposition runner and the ordering runner of a single review, every actual model turn — the first attempt AND every retry in BOTH runners — SHALL draw from that one budget, so the total number of model turns across the whole decomposition-plus-ordering phase cannot exceed the ceiling. This is the live enforcement of R10 that the pre-flight route-plan count did not provide (bead p0wwp).

#### Scenario: A sixth invocation is refused at runtime across the two runners
- **WHEN** a shared budget of five is threaded through a decomposition proposal that retries and an ordering pass that retries such that six turns would otherwise be issued
- **THEN** exactly five `runTurn` calls happen across the two runners combined, the sixth is refused at runtime, and both phases fall to the deterministic floor
