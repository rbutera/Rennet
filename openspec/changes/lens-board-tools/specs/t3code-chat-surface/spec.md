## MODIFIED Requirements

### Requirement: The chat slot renders the T3 thread

The chat slot SHALL render the native T3 thread view for the session's bound thread in every host (desktop and browser): the timeline with grouped tool calls, thinking, streamed text, inline approval and user-input cards, proposed-plan cards, per-turn diffs, and the composer with model, effort and permission mode controls. Sending from the composer SHALL start a turn on the bound thread.

The chat slot SHALL render the session's thread and no other. It SHALL NOT be retargeted at a lens seat's thread, a round's thread, or any other thread the workspace wants to show; a workspace that needs to show another thread mounts the thread view itself. No control anywhere SHALL point the chat slot away from the session's conversation.

#### Scenario: approval card round trip

- **WHEN** a thread in supervised mode requests command approval
- **THEN** the card appears in the chat slot and approving it lets the turn continue

#### Scenario: agent asks a question

- **WHEN** the agent asks a question mid-turn
- **THEN** the chat slot shows the question form and the answer reaches the running turn

#### Scenario: A seat transcript never takes the slot

- **WHEN** the reviewer opens a lens seat's transcript while boards are being drafted
- **THEN** the chat slot still shows the session's thread with its composer, and the transcript is somewhere else

#### Scenario: Positive control retargets the slot

- **WHEN** a control points the chat slot at a seat's thread
- **THEN** the assertion that the slot shows the session's thread fails
