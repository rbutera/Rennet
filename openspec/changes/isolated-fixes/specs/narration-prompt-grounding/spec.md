# narration-prompt-grounding

Bounded code evidence in the light-tier roll-up narration prompt, so accounts can describe the changed code rather than paraphrasing node titles.

## ADDED Requirements

### Requirement: Narration payloads carry bounded decomposition evidence

The roll-up narration payload SHALL include the existing node structure and a chunk-evidence entry for every decomposition chunk. Each entry SHALL identify the chunk and its files and SHALL carry real added, deleted, or context line content from the hunks assigned to that chunk.

The encoded sum of chunk excerpts SHALL NOT exceed `NARRATION_CHUNK_EXCERPT_MAX_BYTES`. Excerpt allocation and UTF-8 truncation SHALL be deterministic, SHALL expose whether each chunk was truncated, and SHALL reserve a share for every chunk rather than allowing earlier chunks to consume the entire allowance.

#### Scenario: a small decomposition reaches the narration turn with code evidence

- **WHEN** roll-up narration runs for a decomposition whose chunk content fits within the excerpt ceiling
- **THEN** the model-facing payload contains each chunk's id, title, file paths, and real hunk line content
- **AND** every chunk entry reports that it was not truncated

#### Scenario: an oversized decomposition remains within the light-tier ceiling

- **WHEN** the decomposition's chunk content exceeds the total excerpt allowance
- **THEN** the encoded sum of all chunk excerpts is no greater than `NARRATION_CHUNK_EXCERPT_MAX_BYTES`
- **AND** every chunk receives its deterministic share in decomposition reading order
- **AND** each shortened entry reports that it was truncated

#### Scenario: grounding does not become an admission gate

- **WHEN** the model emits a structurally valid account without a citation
- **THEN** the existing narration validation and node-coverage rules determine admission unchanged
- **AND** the account is not rejected merely because it has no citation
