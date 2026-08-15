## Purpose

The light-tier authoring step (issue #72, Model Council job M24) that composes N staged review asks into one coherent, execution-ordered work order for a coding harness — content-preserving by construction, fail-closed to a mechanical pass-through, previewed before handoff, and traceable back to every source disposition.

## ADDED Requirements

### Requirement: Composition is a partition over the mechanical bundle, never an authoring of its bodies
Composition SHALL take the deterministic mechanical handoff bundle as input and produce an ordered set of composed tasks in which the model contributes ONLY ordering, grouping, and a one-line per-group title. Every task body SHALL be reconstructed verbatim (byte-identical) from the trusted input asks by their stable ids; the model SHALL never supply, rewrite, summarise, or drop an ask body. Overlapping or related asks MAY be merged into one composed task; merging SHALL preserve every member ask's body in full.

#### Scenario: Overlapping asks merge into one task with bodies preserved verbatim
- **WHEN** fixture dispositions containing overlapping asks are composed and the model proposes grouping them
- **THEN** the composed bundle contains one task citing all of their ids, and every original instruction body appears in the rendered work order byte-for-byte unaltered

#### Scenario: Unrelated asks stay separate
- **WHEN** the model's partition places unrelated asks in their own groups
- **THEN** each composed task carries exactly its own ask, in the model's execution order

### Requirement: A composition that is not a total cover of the ask ids is rejected and the mechanical floor answers
The system SHALL validate every proposed partition against the input asks: each ask id appears in exactly one group, no id is repeated, and no unknown id is cited. On any validation failure, any failed or unavailable compose turn, or any doubt about content preservation, the system SHALL fall closed to the mechanical pass-through composition — one task per ask in deterministic order — which is always complete and SHALL be honestly marked as not model-composed. The fallback SHALL never throw and SHALL never produce a lossy result.

#### Scenario: A dropped ask id falls to the floor
- **WHEN** the compose turn returns a partition omitting one ask id
- **THEN** the result is the mechanical pass-through bundle, marked not composed, containing every ask

#### Scenario: An invented or duplicated ask id falls to the floor
- **WHEN** the compose turn cites an id not present in the input, or cites one id twice
- **THEN** the result is the mechanical pass-through bundle, marked not composed

#### Scenario: A failed or absent compose seat still yields a complete bundle
- **WHEN** no compose seat is installed, or the turn fails or returns malformed output
- **THEN** the result is the mechanical pass-through bundle, marked not composed, and no error escapes to the caller

### Requirement: Every source disposition id round-trips through the trace map
The composed bundle SHALL carry a trace map in which every input ask id appears exactly once, mapping it to the composed task that contains it. When a handoff run executes a composed bundle, the run result SHALL carry that bundle's trace map so the successor review's delta re-review can map the agent's result back to the source dispositions.

#### Scenario: Round-trip totality over the trace map
- **WHEN** any bundle (model-composed or mechanical floor) is produced from N asks
- **THEN** the trace map contains exactly N entries, every ask id appears exactly once, and each maps to the index of the task citing it

#### Scenario: The run result carries the executed bundle's trace map
- **WHEN** a handoff run executes a composed bundle
- **THEN** the run's result includes the trace map of the bundle that was executed

### Requirement: Model-authored prose never enters the executable prompt
The work-order prompt handed to the coding harness SHALL be built only from the reviewers' verbatim ask bodies and facts derived mechanically from the trusted asks (paths, anchors, types). The model's per-group title SHALL be preview-only metadata shown to the human and SHALL NOT appear in the executable prompt, so a validating partition cannot smuggle an invented instruction into what the coding agent executes.

#### Scenario: A title cannot reach the executable prompt
- **WHEN** a valid partition carries a group title containing a sentinel instruction the reviewer never wrote
- **THEN** the rendered executable prompt does not contain the sentinel, while the preview may show the title to the human

### Requirement: The compose turn is council-routed, batched, budget-gated, and trace-logged
Composition SHALL be one batched light-tier model call resolved through the Model Council job for handoff-bundle composition, never one call per ask. The call SHALL be charged against the review's shared invocation budget; an exhausted or absent budget SHALL degrade to the mechanical floor (complete, honestly marked not composed) rather than fabricating a composition or blocking the handoff. The council resolution trace for the compose seat SHALL be recorded with the compose outcome so the product can answer why that model ran.

#### Scenario: One batched call regardless of ask count
- **WHEN** a bundle of N asks is composed
- **THEN** exactly one model turn is spent

#### Scenario: An exhausted budget degrades honestly
- **WHEN** the shared invocation budget has no room for the compose call
- **THEN** no model turn is spent and the result is the mechanical floor, marked not composed

#### Scenario: The resolution trace is recorded
- **WHEN** a compose turn runs on a council-resolved seat
- **THEN** the recorded outcome names the harness, model, and resolution trace of that seat

### Requirement: The handoff run executes the previewed composition, verified by digest
When a composed bundle is supplied to the handoff run, the run SHALL execute that bundle's prompt — the same prompt the paper previewed — after verifying the bundle's content digest and that its ask set matches the mechanical bundle rebuilt from the same dispositions. A verification failure (a corrupted or stale composition whose dispositions have since changed) SHALL refuse the run with an honest reason naming the mismatch, never silently executing something that was not previewed. When no composed bundle is supplied, the run SHALL execute the mechanical bundle exactly as before.

#### Scenario: The previewed composed prompt is what the agent receives
- **WHEN** a handoff run is invoked with a composed bundle that passes digest and ask-set verification
- **THEN** the coding harness receives the composed bundle's prompt, not the mechanical prompt

#### Scenario: A stale composition refuses rather than diverging from the preview
- **WHEN** the staged dispositions have changed since the supplied bundle was composed
- **THEN** the run refuses with a reason naming the stale composition, and no harness turn is spent

#### Scenario: No composition supplied preserves today's behaviour
- **WHEN** a handoff run is invoked without a composed bundle
- **THEN** the mechanical bundle is built and executed exactly as before this change

### Requirement: The collation draft canvas composes in own-branch mode and shows the composed state honestly
In own-branch (handoff) mode, the collation draft canvas SHALL offer composition over the currently staged set and SHALL render the result: the composed tasks in execution order, each showing its member asks and preview title, with an explicit visible distinction between a model-composed bundle and the mechanical pass-through floor. Composition SHALL NOT alter the staged dispositions themselves — it is a derived reading of the same staged data, and withdrawing or editing a staged item SHALL invalidate any composition derived from the previous staged set.

#### Scenario: Own-branch mode surfaces composition
- **WHEN** the collation draft canvas is in own-branch mode with staged dispositions
- **THEN** the user can compose the handoff and sees the resulting grouped, ordered tasks with their member asks

#### Scenario: The floor is visibly the floor
- **WHEN** composition degrades to the mechanical pass-through
- **THEN** the canvas shows the bundle as not model-composed rather than presenting the floor as an authored narrative

#### Scenario: Editing the staged set invalidates a stale composition
- **WHEN** a staged disposition is withdrawn, reworded, or retyped after a composition was produced
- **THEN** the previous composition is no longer presented as current for the changed staged set
