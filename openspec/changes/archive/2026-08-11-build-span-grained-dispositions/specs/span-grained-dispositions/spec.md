## ADDED Requirements

### Requirement: A disposition can be anchored at a side-qualified file-line span, additively
`DispositionAnchor` SHALL support an OPTIONAL span anchor — a 1-based file-line range (`span`), a diff side (`side` ∈ additions/deletions/context), and a byte digest of the span's side-text at authoring time (`spanDigest`) — present together or all absent. An anchor with none present SHALL remain a valid path-grained disposition (backward compatible). The anchor SHALL be registrar-independent: it addresses file lines and a side directly, never a CodeView occurrence ordinal (issue #84 is not deepened).

#### Scenario: A path-grained anchor and a full span anchor both validate; a partial span anchor is rejected
- **WHEN** `{path, contentDigest}`, then `{path, contentDigest, span, side, spanDigest}`, then `{path, contentDigest, span}` (no side/digest) are validated
- **THEN** the first two are accepted and the partial one is rejected

### Requirement: Fold identity is the full anchor, so spans on one file coexist
`DispositionSet` dedup and `DispositionCleared` SHALL key off the full anchor identity (path plus, for span anchors, the span and side), not the bare path. Two dispositions on the same file at different spans SHALL coexist; clearing one SHALL leave the other; a path-grained and a span disposition on the same file SHALL coexist.

#### Scenario: Two spans on one file coexist and clear independently
- **WHEN** two dispositions are set on the same file at different line spans and one is cleared
- **THEN** both existed simultaneously and the uncleared span's disposition remains

### Requirement: Span-grained carry is a byte-identical deterministic floor, fail-closed
On a patchset re-capture, a span-grained disposition SHALL carry forward iff the successor file's side-text at the SAME file-line span is byte-identical to the recorded `spanDigest` and is in bounds; a path-grained disposition SHALL carry iff its file is byte-identical (unchanged). A change inside the span, a positional shift of the span, an out-of-bounds span, a missing side, or a missing file SHALL drop the disposition (the reviewer re-reads). No fuzzy matching occurs in the floor.

#### Scenario: An unchanged span carries even when the file changed elsewhere; a shifted or edited span drops
- **WHEN** a re-capture leaves one disposition's span byte-identical (with unrelated edits elsewhere in the file), edits a second disposition's span, and shifts a third's span down by an inserted line
- **THEN** the first carries and the second and third are dropped

### Requirement: Carry above the floor is a model relevance judgment via a mockable port (Rai #48 ruling)
Above the byte-identical floor, dispositions the floor dropped SHALL be offered to a `DispositionRelevanceJudge` port that judges whether each is still relevant to the re-captured code; a `carry: true` verdict re-attaches the disposition, re-anchored to the verdict's span when supplied. An out-of-bounds re-anchor SHALL be dropped (fail-closed), never attached. The judge SHALL be a port injected at the seam so CI exercises the carry logic and floor deterministically with a stub and no live model.

#### Scenario: The judge re-attaches a relevant shifted disposition and a bad re-anchor is dropped
- **WHEN** the floor drops two dispositions and a stub judge returns carry-true with a valid re-anchor for one and carry-true with an out-of-bounds re-anchor for the other
- **THEN** the first is re-attached at its re-anchor and the second is dropped, leaving it orphaned

### Requirement: The relevance judge is a routed, budget-gated council job
The disposition-relevance-judge SHALL be a model-facing job in the Model Council catalogue, resolvable through `resolveAssignment` under every availability scenario, and subject to the live budget gate that covers every routed council invocation. It SHALL be a bounded-inference light-tier job (handed the prior disposition and the successor patch, never fetching code it was not given), assigned a medium-effort model by default.

#### Scenario: The council resolves the relevance judge in every scenario
- **WHEN** the assignment tables are checked for the disposition-relevance-judge under both-providers, Claude-only, and Codex-only
- **THEN** each scenario resolves it to a defined (model, effort) default

### Requirement: A disposition maps to the GitHub review-thread publish payload
A pure mapping SHALL convert a disposition to a publish thread carrying the file path, disposition type, and body, plus — for a span disposition — the end file line, the start line for a multi-line span, and the side (deletions → LEFT / old file; additions and context → RIGHT / new file). A path-grained disposition SHALL map to a file-level payload with no line or side. This payload is the single line/side contract the publish sheet (#22) and GitHub publish (#21) consume.

#### Scenario: Span dispositions carry line and side; a path disposition carries neither
- **WHEN** an additions span, a deletions span, a multi-line span, and a path-grained disposition are mapped to publish threads
- **THEN** the additions thread is RIGHT with the end line, the deletions thread is LEFT, the multi-line thread carries both start and end lines, and the path thread carries no line or side
