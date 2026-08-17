# harness-discovery Delta Specification

## ADDED Requirements

### Requirement: A runtime-dependent harness reports its missing runtime as the health reason

For a harness whose binary requires a separate runtime to execute (omp requires Bun), discovery SHALL resolve and prove the runtime before executing the harness script, enforce its declared minimum version, and carry the exact proven runtime path into process composition. It SHALL fold a missing, below-floor, or unrunnable runtime into the slot's health with a reason naming the runtime — not a spawn-time crash, and not an `unavailable`/`not-found` that hides the real cause behind "no binary". Candidate ranking SHALL demote an asdf harness shim behind a real install, and Windows filename matching SHALL consume the candidate locus's actual `PATHEXT`.

#### Scenario: The harness binary resolves but its runtime does not

- **WHEN** discovery resolves the harness binary but its required runtime is absent from the harvested PATH and curated locations
- **THEN** the slot's health reason names the missing runtime, and the resolved binary path is still reported so the app can say "found omp but not Bun" instead of "no omp found"

#### Scenario: Runtime present, harness proven

- **WHEN** the runtime is runnable and the harness binary answers its version probe
- **THEN** the slot reports `ready` exactly as a runtime-free harness would
