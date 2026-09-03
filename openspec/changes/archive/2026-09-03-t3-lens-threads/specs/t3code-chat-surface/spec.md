## MODIFIED Requirements

### Requirement: The chat slot renders the T3 thread

The chat slot SHALL render the native T3 thread view for the session's bound thread in every host (desktop and browser): the timeline with grouped tool calls, thinking, streamed text, inline approval and user-input cards, proposed-plan cards, per-turn diffs, and the composer with model, effort and permission mode controls. Sending from the composer SHALL start a turn on the bound thread. The slot SHALL also render any other thread the workspace asks for, such as a lens seat's transcript, in a read-only form with no composer.

#### Scenario: approval card round trip
- **WHEN** a thread in supervised mode requests command approval
- **THEN** the card appears in the chat slot and approving it lets the turn continue

#### Scenario: agent asks a question
- **WHEN** the agent asks a question mid-turn
- **THEN** the chat slot shows the question form and the answer reaches the running turn

#### Scenario: a read-only thread
- **WHEN** the workspace opens a lens seat's thread in the slot
- **THEN** the transcript renders and streams, and no composer is shown

### Requirement: A handoff work order can run on the T3 thread

"Hand to coding agent" SHALL dispatch the composed work order as a turn on the bound thread in full-access mode. The turn's diff SHALL be visible in the chat slot when it settles, and the review's delta re-review SHALL be offered from that settled state.

#### Scenario: work order to settled turn
- **WHEN** the reviewer hands off three dispositions to the coding agent
- **THEN** one T3 turn starts with the work order as its prompt, and when it settles the review offers the delta re-review over the resulting changes

## REMOVED Requirements

### Requirement: The chat engine is a per-project setting with Rennet as the default
**Reason**: Rai (2026-09-03): the fallback layer was never asked for; T3 is the only engine.
**Migration**: The `chatEngine` key in `.rennet/config.json` is ignored; every session uses its T3 thread.

### Requirement: Spend and persistence differences are stated where the engine is chosen
**Reason**: There is no engine choice to state them beside.
**Migration**: The persistence, usage and hidden-ref facts move to the sidecar line on the local host card and the sidecar concept page.
