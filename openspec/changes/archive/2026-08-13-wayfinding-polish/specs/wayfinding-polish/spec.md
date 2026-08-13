## ADDED Requirements

### Requirement: The breadcrumb shows human-readable labels
The breadcrumb SHALL render project and review surfaces by their human-readable name when it is known, and SHALL fall back to the identifier when the name is unknown. It SHALL NOT render a blank label and SHALL NOT fabricate a name.

#### Scenario: Names when known, ids when not
- **WHEN** a project or review surface's name is available
- **THEN** the crumb shows the name; and when the name is unavailable the crumb shows the identifier, never a blank or invented label

### Requirement: The palette lists recent project locations
The command palette SHALL offer a Recent group listing distinct project locations the reviewer has visited (projects root and project surfaces), most-recent first, deduplicated and capped, each labelled by its human-readable name, excluding the current location. Choosing one SHALL navigate to that surface, loading the project's data first so the destination renders its real content, never a stale or broken surface. Review/draft/paper surfaces are NOT recorded as recents, because the app cannot reload a review by id (there is no load-review-by-id command); a recent that could not render honestly is not offered.

#### Scenario: Jump back to a recent project
- **WHEN** the reviewer opens the palette after visiting several projects
- **THEN** the Recent group lists the visited project locations (most-recent first, no duplicates, current excluded), and choosing one loads that project and navigates to it

### Requirement: Recent locations persist across restarts
The recent-locations list SHALL persist across application restarts, restored deduplicated and capped; malformed, absent, or incompatible-version stored state SHALL yield an empty list without error. The live back/forward navigation stack is NOT persisted — because a restored review surface cannot be reloaded by id, restoring a deep stack would strand the reviewer on an unrenderable surface; on launch the stack begins at the projects root and the bootstrap-restored review is pushed as today. (Full back/forward-stack persistence is a deferred follow-up gated on a load-review-by-id capability.)

#### Scenario: Recent locations survive a restart
- **WHEN** the reviewer restarts the app after visiting projects
- **THEN** the recent-locations list is restored (deduplicated, capped) and each entry reloads and renders when chosen

#### Scenario: Corrupt stored state is harmless
- **WHEN** the stored recents state is missing, malformed, or from an incompatible version
- **THEN** the app starts with an empty recents list without error

### Requirement: The first-run frame shows the root crumb
The first-run / loading frame SHALL present the root breadcrumb, so the wayfinding spine is visible from the first frame rather than appearing only after a review is open.

#### Scenario: Wayfinding is present at first paint
- **WHEN** the app is starting up or a new user first opens it with no review yet
- **THEN** the root breadcrumb is shown
