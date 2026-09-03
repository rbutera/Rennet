# t3-lens-threads Specification

## Purpose
Every seat the review pipeline runs is a durable, inspectable T3 Code thread in the daemon-owned sidecar, so a lens's work streams while it happens and a repair continues the same conversation instead of starting cold.
## Requirements
### Requirement: Every board seat runs as one persistent T3 thread

Each lens seat (Design, Sequence, Decisions, Flagged primary, Flagged second, Noise) and the round report SHALL run as one T3 thread on the review's project in the daemon-owned sidecar, with the review's checkout as its working directory. A generation SHALL create one thread per seat, and every turn of that seat in that generation SHALL run on that thread. Threads SHALL persist in the sidecar's own home and SHALL never be created in or read from the user's own T3 installation.

#### Scenario: a generation opens six threads
- **WHEN** a review's first generation starts with both harnesses available
- **THEN** the sidecar lists one thread per seat for that generation, each rooted at the review's checkout, and the daemon's binding names the generation, the seat and the thread

#### Scenario: the user's own T3 home is untouched
- **WHEN** a generation runs on a machine that also has the user's own T3 Code installed
- **THEN** no thread, project or setting is written under the user's T3 home

### Requirement: A repair is a follow-up turn on the seat's thread

When a seat's draft fails lint, the repair SHALL run as the next turn on the same thread, carrying only the lint pointers and the frozen element ids as its prompt. The base drafting prompt SHALL NOT be re-sent. The output schema SHALL be attached to the turn once, as the turn's structured-output contract, and SHALL NOT be restated in prompt text.

#### Scenario: one repair after a lint failure
- **WHEN** a Decisions draft fails lint with two pointers
- **THEN** the Decisions thread gains one more turn whose prompt names the two pointers and the frozen ids, and the thread's first turn is not repeated

#### Scenario: retry budget counts thread turns
- **WHEN** a lane has exhausted its repair budget for the attempt
- **THEN** no further turn starts on that seat's thread and the lane settles under the existing outcome domain

### Requirement: A seat's usage and timing reach the collector

Each turn on a seat's thread SHALL report its token usage and wall-clock duration to the review's metrics collector as one record per turn, labelled by seat and attempt, so the generation's spend and timing summaries include every T3 turn.

#### Scenario: a two-turn seat records two turns
- **WHEN** a Design seat drafts and then repairs once
- **THEN** the collector holds two records for `board.lens-draft` on that generation, each with tokens and duration from the thread's turn

### Requirement: The Flagged dual seat runs on two providers as two threads

The Flagged lens SHALL run its primary seat as a thread on the Claude provider and its second seat as a thread on the Codex provider, reconciled as they are today; when only one provider is available it SHALL degrade to one thread and say so in the round account.

#### Scenario: both providers present
- **WHEN** a generation runs with Claude and Codex both seeded in the sidecar
- **THEN** the Flagged lane has two threads, one per provider, and the reconciled findings carry each seat's provenance

### Requirement: Archiving a session deletes its threads

`session.archive` (archiving, not un-archiving) SHALL delete from the sidecar the session's own bound thread and every seat thread bound to that review's generations, using T3's `thread.delete` orchestration command, and SHALL remove those bindings. Un-archiving SHALL NOT restore them: the next use of that session creates fresh threads. A sidecar that is not running SHALL still leave the bindings dropped, and a thread the sidecar no longer has SHALL NOT fail the archive.

#### Scenario: archive deletes every thread bound to the review
- **WHEN** a session whose review has drafted one generation is archived
- **THEN** the sidecar no longer lists that session's thread or any of that generation's seat threads, and the daemon holds no binding naming them

#### Scenario: un-archiving then opening the session creates a new thread
- **WHEN** an archived session is un-archived and its chat is opened again
- **THEN** a new thread is created and bound, and the deleted transcripts do not come back

