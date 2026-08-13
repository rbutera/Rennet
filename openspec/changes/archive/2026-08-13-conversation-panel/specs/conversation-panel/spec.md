## ADDED Requirements

### Requirement: The review conversation is one unified chat stream
The review heart SHALL present the conversation as a single chat-style stream (not separate anchored-thread cards plus a distinct ask box). Each message SHALL show an icon for its ask type (comment, request-change, question, discuss, general-ask, finding). Line/range-anchored messages SHALL render a quoted reply chip (the line reference), and general orchestrator asks SHALL render without one.

#### Scenario: A line reply and a general ask read differently in one stream
- **WHEN** the stream contains a line-anchored message and a general orchestrator ask
- **THEN** the line-anchored message renders a reply chip with its line reference and the general ask renders none, both in the same stream, each with its ask-type icon

### Requirement: The conversation engine is unchanged; asks run without a permission step
The unified panel SHALL drive turns over the existing `review.ask` command exactly as the prior surfaces did — a general ask is an un-anchored turn, a line reply carries its anchor — with no confirmation, consent, or permission step before a model runs. Thread anchoring and re-attach behaviour SHALL be preserved.

#### Scenario: Asking runs immediately
- **WHEN** the reviewer submits a general question or a line reply in the panel
- **THEN** a `review.ask` turn runs with no permission prompt and the answer populates the stream

### Requirement: Expand-to-fullscreen never reflows the diff
The panel SHALL offer an expand-to-fullscreen toggle that grows it over the review area and back. Opening, growing, or expanding the panel SHALL NOT change the diff column's width (the panel is the diff column's flex sibling).

#### Scenario: The diff column is a fixed point
- **WHEN** the reviewer expands the conversation panel and collapses it again
- **THEN** the diff column's width is unchanged across the toggle

### Requirement: The both-model comparison is preserved
Reshaping the conversation into the unified stream SHALL NOT remove the both-model side-by-side comparison; it SHALL remain reachable.

#### Scenario: Both-model comparison still available
- **WHEN** the reviewer wants the two-model side-by-side answers
- **THEN** that comparison is still reachable (not deleted by this change)
