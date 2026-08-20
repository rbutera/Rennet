# decomposition-floor Specification

## Purpose
Defines the deterministic, offline decomposition that classifies every changed hunk and produces dependency-ordered chunks without a model.
## Requirements
### Requirement: The floor is deterministic, offline, and zero-model
The decomposition floor SHALL be a pure function of a captured patchset with no network, model, clock, or filesystem access, and its output SHALL be byte-identical across two runs on the same patchset.

#### Scenario: A patchset renders with no harness and no network
- **WHEN** a real multi-file patchset is decomposed with no harness installed and no network available
- **THEN** it produces a complete decomposition with every hunk classified, every substantive chunk within budget, a dependency DAG, and a reading order

#### Scenario: Byte-stability across two runs
- **WHEN** the same patchset is decomposed twice
- **THEN** the two decompositions serialise identically

### Requirement: Mechanical classification is the admission authority for verified noise
The floor SHALL classify every hunk as substantive or mechanical. It SHALL assign each mechanical hunk one class from this closed vocabulary: `lockfile`, `generated`, `pure-rename`, `formatting-only`, `vendored`, or `mode-only`.

#### Scenario: A lockfile is mechanical
- **WHEN** a changed file is a recognised lockfile
- **THEN** its hunks are classified mechanical with class `lockfile`

#### Scenario: A whitespace-only change is mechanical
- **WHEN** a hunk's added and deleted content are identical after removing all whitespace and both sides are non-empty
- **THEN** the hunk is classified mechanical with class `formatting-only`

#### Scenario: A real code change is substantive
- **WHEN** a hunk changes non-whitespace content and matches no mechanical signal
- **THEN** it is classified substantive and routed to a substantive chunk, never an appendix

### Requirement: Chunking honours the ≤400 changed-LOC budget including oversize hunks
The floor SHALL group substantive changes by file and enclosing symbol, then greedily merge them to a changed-LOC budget that defaults to 400. It SHALL split a hunk that exceeds the budget into contiguous fragments within the limit. Every substantive chunk SHALL remain within budget.

#### Scenario: A 1,000-line hunk splits
- **WHEN** a substantive hunk changes 1,000 lines against a 400-LOC budget
- **THEN** it is split into fragments each within the budget, the fragments preserve the total changed LOC, and every resulting substantive chunk is within budget

#### Scenario: Enclosing-symbol grouping degrades safely
- **WHEN** no symbol extractor is supplied or a grammar is unavailable
- **THEN** the enclosing symbol degrades to the empty string and grouping falls back to file level without blocking

### Requirement: Every changed hunk is accounted for
The floor SHALL place every hunk in exactly one chunk with no hunk in two chunks, and its residue SHALL be empty because the floor places everything.

#### Scenario: Every hunk is placed exactly once
- **WHEN** a patchset with substantive and mechanical changes is decomposed
- **THEN** the union of all chunk hunk-ids equals the offered hunk set exactly, with no duplication and an empty residue

### Requirement: The reading order is a logical dependency DAG, never danger or salience
The floor SHALL derive dependency edges from resolvable code imports, SHALL keep the stored edge set acyclic by dropping any edge that would close a cycle, and SHALL emit a reading order that is a topological linearisation of the edges covering every chunk exactly once, ordered dependency-first with a logical layer/path tiebreak.

#### Scenario: An import orders the dependency first
- **WHEN** one changed file imports another changed file by a relative specifier
- **THEN** an `enables` edge runs from the imported file's chunk to the importing chunk and the imported chunk precedes it in the reading order

#### Scenario: An import cycle is broken into a DAG
- **WHEN** two changed files import each other
- **THEN** the stored edges contain no cycle and the reading order still covers every chunk exactly once
