## MODIFIED Requirements

### Requirement: A session has one T3 thread bound to its checkout

Opening a session SHALL create or resume one T3 thread whose working directory is the review's bound workspace for the repository that the session names, in full-access mode. The binding SHALL carry the repository identity, never only the project, so two repositories in one workspace on the same branch resolve to different threads. The thread SHALL be created with Rennet's session briefing as its instructions, Rennet's app-tools server among its MCP servers, and the model selection the council resolves for the orchestrator-chat job; a seat thread or a round thread SHALL carry neither the session briefing nor the app-tools server.

#### Scenario: two repos, one branch name
- **WHEN** a workspace maps two repositories that both have `main` and a session opens for the second
- **THEN** the T3 thread's working directory is the second repository's checkout

#### Scenario: the session thread is briefed and tooled at bind
- **WHEN** a session's thread is bound
- **THEN** the create command carries the briefing, the app-tools server and the council's selection, and a seat thread bound for the same review carries none of the three
