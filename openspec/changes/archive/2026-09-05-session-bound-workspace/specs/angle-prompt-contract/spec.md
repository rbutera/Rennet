## MODIFIED Requirements

### Requirement: Prompt assembly is fixed-order, layer-labelled, and never truncates the base
`assemblePrompt` SHALL compose layers in this fixed order: base, general, angle, task, files, context, and payload. It SHALL label every emitted layer. The `files`, `context` and `payload` layers SHALL carry path references into the session's context directory or the bound workspace, never the referenced data itself; an assembled prompt SHALL contain no interpolated inventory, diff, file body, board, dossier, manifest, catalogue or work order. When a byte budget is set and the layers overflow, it SHALL drop later layers first and preserve the complete base instruction.

#### Scenario: The base survives a tight budget
- **WHEN** a prompt is assembled with a byte budget smaller than the sum of all layers
- **THEN** the base instruction is present in full and one or more later layers are dropped, and the result records which layers were dropped

#### Scenario: Assembly order is deterministic
- **WHEN** the same layers are assembled twice
- **THEN** the assembled text is byte-identical and lists its contributing layers in the fixed order

#### Scenario: The context layer is a reference
- **WHEN** a seat prompt is assembled for a session
- **THEN** its context layer names the session's context directory and index and is under two kilobytes regardless of the size of the change
