## ADDED Requirements

### Requirement: Two-channel token streaming under an injected clock

The system SHALL stream a harness answer to the renderer as token deltas as they arrive, coalescing them into a single live-updating message. Coalescing timing SHALL be driven by an **injected clock**, not wall-clock, so the streaming behaviour is deterministic under test. A "both" ask SHALL stream the orchestrator channel and the Codex channel concurrently and independently, so one channel's progress or failure never blocks or corrupts the other.

#### Scenario: Deltas coalesce into one live message

- **WHEN** a turn emits token deltas `"Hel"`, `"lo "`, `"world"` on the orchestrator channel
- **THEN** the thread shows one growing harness message whose body converges to `"Hello world"`, not three separate messages

#### Scenario: Two channels stream independently

- **WHEN** a "both" ask streams the orchestrator and Codex channels and the Codex channel fails mid-stream
- **THEN** the orchestrator channel's message still completes with its full body and the Codex channel is surfaced as failed, honestly, not as an empty success

#### Scenario: Coalescing is clock-driven, not wall-clock

- **WHEN** the same delta sequence is replayed under a fake clock the test advances by hand
- **THEN** the coalesced result is byte-identical every run, with no dependence on real elapsed time

### Requirement: Only completed messages are durable

The system SHALL persist a harness answer only once the turn completes. Intermediate coalesced token deltas SHALL NOT be persisted. A turn that is interrupted before completion SHALL NOT leave a partial answer masquerading as a finished one.

#### Scenario: In-flight deltas are not persisted

- **WHEN** a turn is mid-stream (deltas have arrived, no completion) and the store is inspected
- **THEN** the thread carries no completed harness message for that turn, only a turn marked as still streaming

#### Scenario: Completion writes exactly one durable message

- **WHEN** a streaming turn completes
- **THEN** exactly one durable harness `ThreadMessage` with the final body is persisted, and re-reading the store returns that message unchanged

### Requirement: Threads persist beyond the process with version and status

The system SHALL persist each conversation thread — its anchor, messages, `harnessVersionAtCreation`, and a per-turn status distinguishing `streaming`, `complete`, and `interrupted` — to a durable store, so that reloading after the process exits restores the thread. Persistence SHALL extend the existing store pattern rather than introduce a divergent one.

#### Scenario: A thread survives a restart

- **WHEN** a thread with a completed answer is persisted and the store is reopened in a fresh process
- **THEN** the thread, its message, and its `harnessVersionAtCreation` are restored intact

#### Scenario: Turn status is recoverable

- **WHEN** a thread whose latest turn was `streaming` at process exit is reloaded
- **THEN** that turn's status reads `interrupted`, never `complete`

### Requirement: Live re-attach when the main process survives

The system SHALL let a renderer that reloaded, while the main process is still alive, reconnect to a genuinely in-flight stream and resume receiving its remaining token deltas and its completion. The re-attached message SHALL be the same single coalesced message, not a duplicate.

#### Scenario: Renderer reload resumes an in-flight stream

- **WHEN** a turn is mid-stream in main, the renderer reloads and re-attaches, and further deltas then arrive
- **THEN** the renderer resumes the same message and it completes with the full body, with no duplicated or lost message

### Requirement: Interrupted turns are surfaced, never faked

When the main process was killed while a turn was streaming, the system SHALL, on reload, surface that turn as **interrupted**. It SHALL NOT silently mark it complete, SHALL NOT fabricate a final answer, and SHALL NOT silently discard the thread.

#### Scenario: Killed-mid-stream turn reads interrupted

- **WHEN** the app is killed while a turn is streaming and then restarted
- **THEN** the thread is present and its interrupted turn is shown as interrupted, with no fabricated answer body

### Requirement: Thread-orphan surfacing on unresolved anchor

On re-attach, the system SHALL resolve each persisted thread's anchor against the current diff. A thread whose anchor no longer resolves SHALL be marked **orphaned** and surfaced as such. The system SHALL NOT silently drop an orphaned thread and SHALL NOT re-anchor it to whatever code now occupies its former location.

#### Scenario: Moved-away code orphans its thread

- **WHEN** a persisted thread's anchored code no longer exists in the current diff
- **THEN** the thread is surfaced as orphaned, its content preserved, and it is not attached to any other line

#### Scenario: Re-anchoring is refused

- **WHEN** unrelated code now occupies the persisted thread's former anchor key
- **THEN** the thread is NOT presented as if it were about that new code

### Requirement: Scoped reaping of harness children on quit

The system SHALL record every harness child process spawned for a turn in a process registry at spawn time, and SHALL reap exactly those tracked children when the app quits. Reaping SHALL be scoped to the app's own children and SHALL NOT issue a blanket kill of unrelated processes.

#### Scenario: Quit leaves no tracked child running

- **WHEN** turns have spawned harness children and the app reaches `before-quit`
- **THEN** every tracked child PID is signalled to terminate and none is left running

#### Scenario: Reaping does not kill unrelated processes

- **WHEN** an unrelated process shares a name with a harness child but was never registered
- **THEN** it is not signalled by the reaper

### Requirement: Persisted threads never publish

A persisted conversation thread's content SHALL NOT reach any published output, whether or not the thread is mounted in the renderer. The sole private→published path SHALL remain `promoteMessage`. This guarantee SHALL be proven at the persistence boundary, because a scan over mounted DOM cannot observe a persisted-but-unmounted thread.

#### Scenario: Unmounted persisted thread stays out of the payload

- **WHEN** a thread with a distinctive body is persisted but never mounted, and a review is published
- **THEN** that body appears in neither the publish payload nor the signed paper
