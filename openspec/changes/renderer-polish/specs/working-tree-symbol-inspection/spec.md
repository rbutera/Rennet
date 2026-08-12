# working-tree-symbol-inspection

Renderer selection and presentation of committed-head versus working-tree-overlay symbol answers without disturbing the peek-then-pin review flow.

## ADDED Requirements

### Requirement: Committed review lookup remains the default

The renderer SHALL use the active review's committed-head symbol lookup by default. An unseen review SHALL NOT use the working-tree lookup until the reviewer directly selects `Working tree`.

#### Scenario: first lookup in a review uses committed code

- **WHEN** the reviewer opens a review and clicks a symbol without changing the symbol source
- **THEN** the renderer invokes the committed-head lookup port
- **AND** it does not invoke the working-tree lookup port

#### Scenario: another unseen review also starts committed

- **WHEN** the workspace changes from a review using working-tree lookup to a review with no prior symbol-source choice
- **THEN** the new review uses committed-head lookup in that same render

### Requirement: Working-tree lookup is a direct optional source

When a working-tree lookup port is supplied, the renderer SHALL expose a direct `Committed` / `Working tree` source selector in fixed workspace chrome. Selecting a source SHALL immediately re-resolve the currently visible symbol, if any, and SHALL route subsequent inspector navigation through that source. The selector SHALL choose lookup data only; it SHALL NOT confirm, authorize, or restrict any product action.

#### Scenario: working-tree-only symbol resolves

- **WHEN** the committed lookup does not contain a symbol added or moved in local edits
- **AND** the reviewer selects `Working tree`
- **THEN** the renderer re-runs that symbol through the working-tree lookup port
- **AND** the inspector renders the working-tree definition and references returned by that port

#### Scenario: reviewer switches back to committed code

- **WHEN** the inspector is using working-tree answers and the reviewer selects `Committed`
- **THEN** the current symbol is re-resolved through the committed-head lookup port
- **AND** subsequent inspector navigation uses committed-head lookup

### Requirement: Source changes preserve the wireframe interaction

Changing the symbol source SHALL preserve whether the inspector is a floating peek or a pinned rail, SHALL keep all inspector navigation inside that surface, and SHALL NOT move or reflow the diff. Answers from different sources SHALL NOT coexist in one breadcrumb history as though they came from the same snapshot.

#### Scenario: source changes while the inspector is pinned

- **WHEN** the reviewer pins a symbol inspector and changes from committed to working-tree lookup
- **THEN** the inspector remains pinned in the rail
- **AND** its current symbol resolves against the working tree
- **AND** the diff remains at the same selected element

