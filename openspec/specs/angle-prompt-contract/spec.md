# angle-prompt-contract Specification

## Purpose
TBD - created by archiving change build-decomposition-angle-generation. Update Purpose after archive.
## Requirements
### Requirement: A base instruction is a filled seven-slot uniform contract
Every per-angle base instruction SHALL be produced from one uniform `PromptContract` with exactly seven slots — role, emit, input, discipline, failure valve, ordering, and guidance slot — so that the versioned instruction bytes are attributable slot by slot. `renderBaseInstruction` SHALL be a deterministic pure function of the contract.

#### Scenario: All seven slots render
- **WHEN** a base instruction is rendered from a contract
- **THEN** the output contains the role, the emit target, the input rule, the discipline, the failure valve, the ordering principle, and the guidance-slot marker, and rendering the same contract twice yields byte-identical output

### Requirement: The ordering slot mandates logical dependency order, never salience or danger
The ordering slot of every decomposition contract SHALL instruct logical, first-principles, ground-up ordering by dependency, and SHALL NOT instruct ordering by salience, danger, or blast radius.

#### Scenario: Ordering is logical
- **WHEN** the `decomposition.proposal` base instruction is rendered
- **THEN** its ordering slot names logical dependency and first principles and contains no directive to order by salience, danger, or blast radius

### Requirement: An instruction never restates the JSON schema it must emit against
A base instruction SHALL name the document type and version it must emit but SHALL NOT embed the JSON schema of that document, because the schema travels separately as the structured-output constraint and two sources of truth for one shape drift.

#### Scenario: The emit slot names the type without the schema
- **WHEN** the `decomposition.skeleton` base instruction is rendered
- **THEN** it names the docType `decomposition.skeleton` and its version and does not contain a JSON Schema object

### Requirement: Prompt assembly is fixed-order, layer-labelled, and never truncates the base
`assemblePrompt` SHALL compose layers in the fixed order base, general, angle, task, files, context, then payload; SHALL label every emitted layer; and, when a byte budget is set and the layers overflow, SHALL drop later layers first and SHALL NEVER truncate the base instruction.

#### Scenario: The base survives a tight budget
- **WHEN** a prompt is assembled with a byte budget smaller than the sum of all layers
- **THEN** the base instruction is present in full and one or more later layers are dropped, and the result records which layers were dropped

#### Scenario: Assembly order is deterministic
- **WHEN** the same layers are assembled twice
- **THEN** the assembled text is byte-identical and lists its contributing layers in the fixed order

