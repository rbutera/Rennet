## Purpose

A lens board exists before its seat starts and is written into, call by call, with a small tool set scoped to that board. The seat thinks in prose and acts in tools; nothing forces its whole turn through one document shape, and no output schema travels.

## ADDED Requirements

### Requirement: A board exists, empty and drafting, before its seat runs

Every lens board of a generation SHALL be created — empty, in a `drafting` state, addressable — at the moment that lens's seat thread is created, before the first turn is sent. A board SHALL NOT be brought into existence by a seat's return. A lane whose seat never writes anything SHALL settle over an empty board with its reason, not over a missing one.

#### Scenario: Boards exist before the first turn

- **WHEN** a generation's seat threads are created
- **THEN** every lens of that generation already has a board in the `drafting` state, and the surface can address each one

#### Scenario: A seat writes nothing

- **WHEN** a seat's turn ends having called no authoring tool
- **THEN** the lane settles under the existing outcome domain over the board that already existed, with the reason recorded, and no board is invented or discarded

### Requirement: A seat writes its board through a tool set derived from the kinds its lens authors

Each seat SHALL be given a tool set covering exactly the element kinds its lens already authors — the shared authoring kinds (`prose`, `section`, `callout`, `annotation`, `code_ref`) plus that lens's own typed kinds — and no others. The set SHALL be DERIVED from the tables that already assign kinds to lenses, not written per lens by hand, so a new kind or a reassigned lane cannot leave the tools behind. Every set SHALL carry an `add`, an `update` and a `remove` verb, a citation verb, a `finish`, and, for a lens that admits an absence, one settle-absent verb whose reason is fixed by the lens and carries no field naming it. A lens that admits no absence SHALL have no such tool.

Fields the host owns SHALL NOT appear on any tool input: the element's author, the patchset id, a noise verdict's judge, a finding's draft status, and a finding's cross-seat concurrence and accord.

#### Scenario: A seat cannot author another lens's kind

- **WHEN** the Sequence seat's tool set is built
- **THEN** it carries a step verb and no finding, decision, requirement or noise-verdict verb, so an out-of-lane element cannot be created rather than being rejected after the fact

#### Scenario: A lens with no admissible absence has no settle-absent tool

- **WHEN** the Sequence seat's tool set is built and the Noise seat's tool set is built
- **THEN** the Noise set carries a settle-absent verb whose reason is fixed as `no-noise`, and the Sequence set carries none

#### Scenario: A new kind reaches the tools without an edit

- **WHEN** a kind is added to the table that assigns kinds to a lens
- **THEN** that lens's tool set carries verbs for it with no per-lens list edited

### Requirement: Every tool input is a flat shape that a provider's tool schema can carry

Every board tool's input SHALL be a single object whose fields are scalars, fixed string enumerations, or arrays of scalars. It SHALL NOT contain a nested object, an array of objects, or a union of shapes at any depth, and its rendered JSON Schema SHALL carry a top-level object type and no `anyOf`, `oneOf` or `allOf`. A structured value that would otherwise be nested — a source reference, a citation — SHALL be flattened into named scalar fields or replaced by an element id.

#### Scenario: Every rendered tool schema is admissible

- **WHEN** every board tool's input schema is rendered to JSON Schema
- **THEN** each one declares a top-level object type and contains no `anyOf`, `oneOf` or `allOf` at any depth

#### Scenario: Positive control reintroduces a union

- **WHEN** a control gives one tool input a field that renders as a union
- **THEN** the schema assertion fails, naming that tool and that field

### Requirement: The host mints element ids and a child names its parent

Every creating tool SHALL return the id of the element it created, and the host SHALL mint that id. Every argument that references an element SHALL name an element the board already holds; a tool SHALL refuse a reference to an element that does not exist, saying what the board does hold. The board's parent-child structure SHALL be maintained by the host from the parent each call names, not from child lists a seat authors.

Because a reference can therefore only point at an element created earlier, a board written this way SHALL NOT be able to carry a dangling element reference or a reference cycle.

#### Scenario: A reference to a nonexistent element is refused

- **WHEN** a seat cites an element id its board does not hold
- **THEN** the call is refused in the same turn with the ids the board does hold, and no element is created

#### Scenario: Dangling and cyclic references cannot be created

- **WHEN** a board is written entirely through the tool set
- **THEN** no element reference on it is dangling and the reference graph has no cycle, without any rule having been run to check it

### Requirement: Structural validation is a refusal in the same call

A rule that can be decided from the element a call carries, together with the daemon's own knowledge of the patchset, SHALL be enforced at the tool boundary: the call is refused, the element is not created, and the refusal names the field and says what would be admissible. This covers code bytes and authored dialogue in prose, malformed prose citations, remainder narration, machinery vocabulary in structural fields, a decision with no evidence or no alternative, an unknown or unresolvable source reference, and a scaffold path cited by any lens but Noise.

A citation verb SHALL resolve its citation against the captured patchset in the same call. A citation that resolves SHALL return a citable element id; a citation that does not SHALL be refused with the nearest changed range on that path and side, or with the fact that the path has no changed lines on that side.

#### Scenario: A citation outside the change is refused where it is made

- **WHEN** a seat cites a range that no changed region of the patchset covers
- **THEN** the call is refused with the nearest changed range on that path and side, and no code reference element is created

#### Scenario: Code bytes in prose are refused

- **WHEN** a seat writes prose containing a fenced code block
- **THEN** the call is refused naming that field, and the board holds no such element

### Requirement: Whole-board validation is the finish verdict, answered in the same turn

A rule that can only be decided over the whole board SHALL run when the seat calls `finish`. `finish` SHALL either settle the board or return a pointer list — each pointer naming an element and, where the rule knows it, a field — which the seat answers with further tool calls in the same turn before calling `finish` again. The pointer list SHALL carry no prose, no draft and no restated instructions.

The two tiers together SHALL cover exactly the rule set that lints a lens board today; a rule assigned to neither tier is a defect, and the assignment SHALL be asserted rather than described.

#### Scenario: Finish returns pointers and the seat answers them

- **WHEN** a Sequence board's `finish` finds one step unreachable from any top-level section
- **THEN** it returns one pointer naming that step, the seat fixes it with further calls, and the next `finish` settles the board — all within one turn

#### Scenario: The two tiers reunite to the whole rule set

- **WHEN** the boundary tier and the finish tier are combined
- **THEN** they are exactly the lens rule set, with no rule in both and none in neither

### Requirement: No output schema travels on a board seat turn

A board seat's turn SHALL NOT be given a structured-output contract. The board schema SHALL NOT be attached to the turn, restated in prompt text, or expected back as the turn's result. A seat's final assistant message SHALL be prose or nothing, and a turn that ends without one SHALL NOT be treated as a failure on that ground alone.

#### Scenario: The seat turn carries no schema

- **WHEN** a lens seat's drafting turn is started
- **THEN** no output schema is attached to it and none appears in its prompt

#### Scenario: The transcript carries no structured payload

- **WHEN** a seat's turn settles
- **THEN** no structured-output payload appears as a message on that seat's thread

### Requirement: A repair is the finish verdict, and a partial board survives

An attempt SHALL be spent only by a turn that ENDS without having settled its board or declared its lens absent. A refused call and a returned `finish` verdict SHALL cost no attempt, because both are answered inside the turn that caused them.

When a turn does end unsettled, the board it wrote SHALL be kept, marked as unsettled with the reason, and the follow-up turn SHALL carry the last `finish` verdict and nothing else — never the base instructions, never the board, never a draft. The follow-up turn SHALL resume writing into the same board.

#### Scenario: A refusal costs no attempt

- **WHEN** a seat's turn has ten calls refused and then finishes cleanly
- **THEN** the lane records one attempt and settles

#### Scenario: A turn dies mid-board

- **WHEN** a seat's turn ends with eleven elements written and no `finish`
- **THEN** the eleven elements remain on the board, the lane is marked unsettled with the reason, and the next turn carries only the last verdict and continues writing into that board

### Requirement: A seat reaches its board through a daemon-hosted loopback endpoint addressed per seat

The daemon SHALL host the board tool surface as a loopback HTTP MCP server bound to the local interface, and SHALL give each seat its own address and its own credential, so a call names the board it writes without the seat having to carry a board identifier. The credential SHALL be minted per seat, stored only as a one-way digest, refreshed while the seat works, and revoked when its lane settles rather than left to expire. A seat's credential SHALL NOT appear on any process's argument list.

This addressing SHALL NOT be described or implemented as a restriction on what a seat may do: it names the board a call writes, exactly as a file handle names a file.

#### Scenario: Two seats on one lane write one board

- **WHEN** the Flagged lens runs a Claude seat and a Codex seat
- **THEN** each has its own address and credential, both write to the one Flagged board, each element carries the voice that wrote it, and the ids they receive cannot collide

#### Scenario: The credential is not on the process table

- **WHEN** a seat's harness child is running
- **THEN** its argument list contains no board credential

#### Scenario: A settled lane's credential stops working

- **WHEN** a lane settles
- **THEN** its seats' credentials are revoked at once rather than waiting for a liveness window

### Requirement: A board tool call reaches the reviewer as a receipt, never as a payload

The live line published for a running seat SHALL render a board tool call as a receipt in plain words — what was added, what was cited, what `finish` returned — and SHALL NOT render a tool call's raw input as the seat's speech. The generic fallback that prints a tool's name and its raw input SHALL NOT apply to a board tool.

#### Scenario: A citation reads as a citation

- **WHEN** a seat cites lines 41 to 58 of a changed file
- **THEN** the lane's live line names the path and the range, and contains no JSON

#### Scenario: Positive control removes the receipt arm

- **WHEN** a control removes the board-tool arm from the live-line projection
- **THEN** the assertion that no lane's live line contains a raw tool input fails
