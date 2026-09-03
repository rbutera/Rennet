# t3code-chat-surface Specification

## Purpose
The review workspace shows a T3 Code thread for the session and can route a handoff work order to it, so coding turns carry approvals, agent questions, plan capture and per-turn diffs.
## Requirements
### Requirement: A session has one T3 thread bound to its checkout

When the T3 engine is selected, opening a session SHALL create or resume one T3 thread whose working directory is the review's checkout for the repository that the session names, in full-access mode. The binding SHALL carry the repository identity, never only the project, so two repositories in one workspace on the same branch resolve to different threads.

#### Scenario: two repos, one branch name
- **WHEN** a workspace maps two repositories that both have `main` and a session opens for the second
- **THEN** the T3 thread's working directory is the second repository's checkout

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

