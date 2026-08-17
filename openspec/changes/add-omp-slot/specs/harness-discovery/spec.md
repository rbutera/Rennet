# harness-discovery Delta Specification

## ADDED Requirements

### Requirement: A runtime-dependent harness reports its missing runtime as the health reason

For a harness whose binary requires a separate runtime to execute (omp requires Bun), discovery SHALL resolve and prove the runtime alongside the harness binary, and SHALL fold a missing or unrunnable runtime into the slot's three-state health with a reason naming the runtime — not a spawn-time crash, and not an `unavailable`/`not-found` that hides the real cause behind "no binary".

#### Scenario: The harness binary resolves but its runtime does not

- **WHEN** discovery resolves the harness binary but its required runtime is absent from the harvested PATH and curated locations
- **THEN** the slot's health reason names the missing runtime, and the resolved binary path is still reported so the app can say "found omp but not Bun" instead of "no omp found"

#### Scenario: Runtime present, harness proven

- **WHEN** the runtime is runnable and the harness binary answers its version probe
- **THEN** the slot reports `ready` exactly as a runtime-free harness would
