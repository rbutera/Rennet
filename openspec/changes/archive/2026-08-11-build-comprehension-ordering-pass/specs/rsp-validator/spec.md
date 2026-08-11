## MODIFIED Requirements

### Requirement: Decomposition documents are validated against per-body schemas and rules
The validator SHALL pass the whole offered manifest to the per-body validator so each document family derives the occurrence kind it constrains: the decomposition family over `hunk` occurrences (unchanged behaviour), and the ordering document over `chunk` occurrences. The generic anchor, quote, vocabulary, and identity guarantees, and every decomposition rule (V100/V101/V103/V104/V105/V106/V108), SHALL be behaviourally unchanged.

#### Scenario: A well-formed decomposition proposal is still admitted
- **WHEN** a `decomposition.proposal` whose chunks partition the offered hunks, whose edges are acyclic, and whose reading order covers every chunk is validated
- **THEN** it is admitted with no errors, exactly as before

#### Scenario: The ordering document is validated against the offered chunk set
- **WHEN** an `ordering` document is validated
- **THEN** its totality and no-minted rules are checked against the offered `chunk` occurrences, not the `hunk` occurrences
