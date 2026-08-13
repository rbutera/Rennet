## ADDED Requirements

### Requirement: The both-model comparison lives in the conversation stream
The unified conversation panel SHALL let the reviewer ask a general question of one model or of both, from the panel's own composer, without a separate ask surface. Asking both SHALL render the two answers as labelled cards (the orchestrator's and the second model's) within the stream, and SHALL NOT render a merged or synthesised answer. The default routing SHALL be the orchestrator only, so a plain send never invokes a second model.

#### Scenario: Asking both shows two labelled answers in the stream
- **WHEN** the reviewer chooses "both" in the panel composer and asks a question
- **THEN** the stream shows the orchestrator's answer and the second model's answer as two labelled cards, side by side, with no merged answer element

#### Scenario: The default is one model
- **WHEN** the reviewer asks without choosing "both"
- **THEN** the ask runs with orchestrator-only routing and the stream shows a single answer

### Requirement: The both-model ask runs without a permission step
Choosing one model or both and asking SHALL run immediately over `review.ask` with no confirmation, consent, or permission step — at parity with the orchestrator-only ask already in the stream.

#### Scenario: Asking both runs immediately
- **WHEN** the reviewer submits a both-model question
- **THEN** the `review.ask` turn runs with no permission prompt and the two answers populate the stream

### Requirement: No separate ask surface remains
Reshaping the both-model comparison into the stream SHALL remove the standalone ask panel from the review heart; the both-model comparison SHALL be reachable only from the unified composer, and no capability to ask both models SHALL be lost.

#### Scenario: One composer, no second ask box
- **WHEN** the reviewer opens a review
- **THEN** the review heart shows a single conversation composer (no separate ask panel) and the both-model comparison is reachable from it
