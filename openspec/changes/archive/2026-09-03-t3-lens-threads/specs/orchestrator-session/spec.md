## REMOVED Requirements

### Requirement: The orchestrator boots with a lean map-not-container primer
**Reason**: Rennet's own orchestrator chat is retired; the review's conversation is its T3 Code thread, which boots with T3's own system prompt and reads the checkout directly.
**Migration**: Open the review's thread in the chat slot; the project map is reachable to the agent as files in the checkout and through the review's work order, not as a primer card.

### Requirement: Primer assembly is deterministic and the card is a versioned template
**Reason**: There is no primer card once the orchestrator session is gone.
**Migration**: None; the T3 thread carries no Rennet-authored primer.

### Requirement: User acts are pushed as structured events into the orchestrator's context
**Reason**: The orchestrator session and its context stream are deleted with the `review.ask` command.
**Migration**: A reviewer's asks are typed into the T3 thread's composer; dispositions reach the coding agent through the composed handoff bundle, which is unchanged.

### Requirement: The user's current view context is injected at request time
**Reason**: Deleted with the orchestrator session.
**Migration**: None; the reviewer cites what they are looking at in the thread, as in any T3 conversation.

### Requirement: The stream consumes the change feed and batches view context under an injected clock
**Reason**: Deleted with the orchestrator session.
**Migration**: None.

### Requirement: The session attaches the live canvasOps@2 surface with no user-only or engine-only op
**Reason**: The canvasOps MCP surface was attached to the orchestrator session, which is deleted; nothing else mounts it.
**Migration**: None in this change; a later change may expose canvasOps to T3 threads as an MCP server if a use for it returns.
