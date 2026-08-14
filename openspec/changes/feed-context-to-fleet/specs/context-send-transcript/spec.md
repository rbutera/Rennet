# context-send-transcript

## Purpose

The `ContextManifest` stops claiming and starts proving: send-time capture at the wire records what each fleet agent was actually handed, per-agent records ride the persisted manifest, and the inspector's label upgrades from "assembled" to "sent" exactly as far as the evidence reaches.

## ADDED Requirements

### Requirement: Every fleet send is captured at the wire

The system SHALL capture a send record at the one seam the prompt actually crosses to a harness — the injected `runTurn(prompt, attempt)` boundary for seats (Claude and Codex alike) and the system-prompt append for the orchestrator — recording the seat, the executing harness, the channel, the attempt number, and the byte length and sha256 digest of the exact text handed over. The record SHALL be derived from the sent bytes themselves, never from what a caller intended to send.

#### Scenario: A seat turn stamps a send record

- **WHEN** any fleet seat turn hands its prompt to a harness
- **THEN** a send record is stamped whose `promptDigest` is the sha256 of exactly that prompt string and whose harness names the executor that received it

#### Scenario: A retry is its own record

- **WHEN** a seat retries after a rejected attempt
- **THEN** each attempt has its own send record with its own digest, because a retry prompt (carrying the validator report) is different sent bytes

### Requirement: Context inclusion is proven against the sent bytes

Each send record SHALL state whether the sent text contained the exact labelled block rendered from the digest-verified expected context, and SHALL carry the sha256 of that expected context only when those exact block bytes are present. This proof SHALL remain valid when arbitrary context body text contains a literal layer delimiter. A context layer dropped by a prompt byte-budget SHALL therefore appear as `contextIncluded: false` regardless of the caller having supplied one. When no expected context exists, inclusion SHALL remain false unless the sent bytes themselves contain a parseable context block.

#### Scenario: The proof of the send is the digest join

- **WHEN** a send record has `contextIncluded: true` and its `contextDigest` equals the manifest's `assembledPromptDigest`
- **THEN** that agent provably received the recorded assembly byte-for-byte

#### Scenario: Per-agent variance is recorded, not averaged

- **WHEN** different agents were sent different context bytes (a dropped layer, a superseded capture between runs)
- **THEN** each agent's record carries its own `contextIncluded`/`contextDigest`, and no record is merged, summarized, or discarded to make the sends look uniform

#### Scenario: A delimiter inside context does not deny a real send

- **WHEN** the expected context body itself contains a literal payload-layer delimiter and the sent text contains the exact rendered context block
- **THEN** the record has `contextIncluded: true` and `contextDigest` equal to the sha256 of the complete expected context body

### Requirement: Send records persist on the ContextManifest and cross IPC intact

The system SHALL append send records to the review's persisted `ContextManifest` as an additive optional `sends` field under the same R55 project entry, and SHALL declare the field (and every member of its records) in the protocol schema so the strict IPC command output delivers it to the renderer unstripped. A pre-existing manifest without `sends` SHALL load and render exactly as before.

#### Scenario: The transcript survives restart

- **WHEN** the app restarts after a review's fleet ran
- **THEN** the reloaded manifest carries the send records that were captured, without recomputation

#### Scenario: A later review failure does not erase earlier sends

- **WHEN** one or more fleet sends are captured and a later review step throws
- **THEN** finalization appends the already-captured records before the command failure propagates

#### Scenario: An undeclared field never silently vanishes

- **WHEN** a manifest with send records crosses the desktop IPC boundary
- **THEN** the renderer receives the `sends` field with every record member intact, validated by the protocol schema

### Requirement: The panel's label follows the send evidence, and only that far

The inspector panel SHALL present the context as "sent" only when at least one send record proves the assembly reached an agent (context digest equals `assembledPromptDigest`), listing the per-agent sends; otherwise it SHALL keep presenting "Context Rennet assembled". The sent claim SHALL cover only the fed context block: `exhaustive` remains `false` and `unmanagedSources` continues to disclose what may reach the harness outside the pipeline (its own ambient file reads), unchanged by this capability.

#### Scenario: Proof upgrades the label

- **WHEN** the panel renders a manifest containing a proven send record
- **THEN** it presents the context as sent to the fleet and lists each agent's send (seat, harness, attempt, bytes, inclusion, digest match)

#### Scenario: No proof, no claim

- **WHEN** the panel renders a manifest with no send records (or none proving inclusion)
- **THEN** it presents "Context Rennet assembled" exactly as today

#### Scenario: Ambient reads stay disclosed

- **WHEN** the panel presents a manifest in the sent state
- **THEN** `exhaustive: false` and the `unmanagedSources` disclosure remain rendered — the sent claim never expands to cover the harness's own reads

### Requirement: The transcript never gates

Send capture and persistence SHALL be observation only (Rule Zero): a failed record write, a malformed persisted transcript, or a digest mismatch SHALL never block, delay, or alter a fleet turn, and a malformed persisted manifest SHALL read as honest absence, never a throw.

#### Scenario: A persistence failure is reported, the turn already ran

- **WHEN** appending send records fails after a fleet run
- **THEN** the failure is surfaced to the error sink and the review's results stand untouched
