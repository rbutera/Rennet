## MODIFIED Requirements

### Requirement: L3 rendering is the agent's hand, only acceptance creates L2

Orchestrator annotations SHALL render as interface chrome that is visually distinct from L1 analysis and L2 human judgment. Proposals SHALL render beside their target with accept, edit, and dismiss actions. Only acceptance SHALL create L2.

#### Scenario: Dismiss creates no L2

- **WHEN** the user dismisses an orchestrator disposition proposal
- **THEN** no disposition is created

#### Scenario: Edit then accept creates L2 with the edited body

- **WHEN** the user edits a proposal's body and accepts it
- **THEN** a disposition is created carrying the edited body

### Requirement: Shared theme tokens supply every product color

The shared Affineur's Bench theme SHALL be the only source of raw color values
for product interfaces. Dark and light schemes SHALL both render, and UI
components SHALL use shared tokens rather than hardcoded colors. The UI SHALL
NOT use glass, translucency, vibrancy, or the review-blue accent.

#### Scenario: A hardcoded color fails lint

- **WHEN** a UI component contains a raw hex color
- **THEN** lint fails while a component using a shared theme token passes

#### Scenario: A forbidden glass style is introduced

- **WHEN** a product interface adds translucent glass, vibrancy, or the review-blue accent
- **THEN** the design checks fail
