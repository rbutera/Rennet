# t3code-chat-surface Specification

## Purpose
The review workspace shows a T3 Code thread for the session and can route a handoff work order to it, so coding turns carry approvals, agent questions, plan capture and per-turn diffs.
## Requirements
### Requirement: The chat engine is a per-project setting with Rennet as the default

Settings SHALL offer a chat engine choice per project: the Rennet orchestrator or the T3 Code sidecar. The default SHALL be the Rennet orchestrator. Changing the setting SHALL take effect on the next session open and SHALL NOT destroy either engine's transcript.

#### Scenario: switch engines and back
- **WHEN** a project switches to the T3 engine, opens a session, then switches back
- **THEN** the Rennet transcript for that review is intact and the T3 thread remains listed in the sidecar

### Requirement: A session has one T3 thread bound to its checkout

When the T3 engine is selected, opening a session SHALL create or resume one T3 thread whose working directory is the review's checkout for the repository that the session names, in full-access mode. The binding SHALL carry the repository identity, never only the project, so two repositories in one workspace on the same branch resolve to different threads.

#### Scenario: two repos, one branch name
- **WHEN** a workspace maps two repositories that both have `main` and a session opens for the second
- **THEN** the T3 thread's working directory is the second repository's checkout

### Requirement: The chat slot renders the T3 thread

With the T3 engine selected, the chat slot SHALL render the T3 thread view for the bound thread: the timeline with grouped tool calls, thinking, streamed text, inline approval and user-input cards, proposed-plan cards, per-turn diffs, and the composer with model, effort and permission mode controls. Sending from the composer SHALL start a turn on the bound thread.

#### Scenario: approval card round trip
- **WHEN** a thread in supervised mode requests command approval
- **THEN** the card appears in the chat slot and approving it lets the turn continue

#### Scenario: agent asks a question
- **WHEN** the agent asks a question mid-turn
- **THEN** the chat slot shows the question form and the answer reaches the running turn

### Requirement: A handoff work order can run on the T3 thread

When the T3 engine is selected, "hand to coding agent" SHALL dispatch the composed work order as a turn on the bound thread in full-access mode. The turn's diff SHALL be visible in the chat slot when it settles, and the review's delta re-review SHALL be offered from that settled state exactly as it is for the Rennet engine.

#### Scenario: work order to settled turn
- **WHEN** the reviewer hands off three dispositions to the coding agent
- **THEN** one T3 turn starts with the work order as its prompt, and when it settles the review offers the delta re-review over the resulting changes

### Requirement: Spend and persistence differences are stated where the engine is chosen

The engine setting SHALL state that T3 threads are persisted harness sessions that appear in the harness's own history, that their token usage is reported by T3's usage view rather than Rennet's seat usage, and that T3 records per-turn checkpoints as hidden refs inside the reviewed repository, which ordinary pushes do not send. This is copy beside the control, not a confirmation.

#### Scenario: setting copy present
- **WHEN** the engine setting is shown
- **THEN** the persistence, usage and hidden-ref statements are visible without opening a dialog

