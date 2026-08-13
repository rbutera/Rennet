## ADDED Requirements

### Requirement: The breadcrumb shows human-readable labels
The breadcrumb SHALL render project and review surfaces by their human-readable name when it is known, and SHALL fall back to the identifier when the name is unknown. It SHALL NOT render a blank label and SHALL NOT fabricate a name.

#### Scenario: Names when known, ids when not
- **WHEN** a project or review surface's name is available
- **THEN** the crumb shows the name; and when the name is unavailable the crumb shows the identifier, never a blank or invented label

### Requirement: The palette lists recent locations
The command palette SHALL offer a Recent group listing distinct places the reviewer has visited, most-recent first, deduplicated and capped, each labelled by its human-readable name, excluding the current location. Choosing one SHALL navigate to that surface.

#### Scenario: Jump back to a recent location
- **WHEN** the reviewer opens the palette after visiting several surfaces
- **THEN** the Recent group lists the visited surfaces (most-recent first, no duplicates, current excluded) and choosing one navigates there

### Requirement: Navigation history persists across restarts
The navigation stack, forward stack, and recents SHALL persist across application restarts. On restart the history SHALL be restored, reconciled with the bootstrap-restored review so it is not duplicated; a stored location whose review is no longer available SHALL floor to its nearest resolvable ancestor rather than restoring a broken surface; and malformed or absent stored state SHALL yield the clean default without error.

#### Scenario: History survives a restart
- **WHEN** the reviewer restarts the app after navigating
- **THEN** the back/forward history and recents are restored, the restored review is not duplicated, and a stale stored location falls back to a real ancestor instead of a broken screen

#### Scenario: Corrupt stored state is harmless
- **WHEN** the stored navigation state is missing, malformed, or from an incompatible version
- **THEN** the app starts at the clean default without error

### Requirement: The first-run frame shows the root crumb
The first-run / loading frame SHALL present the root breadcrumb, so the wayfinding spine is visible from the first frame rather than appearing only after a review is open.

#### Scenario: Wayfinding is present at first paint
- **WHEN** the app is starting up or a new user first opens it with no review yet
- **THEN** the root breadcrumb is shown
