## ADDED Requirements

### Requirement: Viewer navigation and welcome preferences persist outside the ladder

Client settings SHALL persist the first-run completion state, selected theme pack, and last-used project as viewer-owned preferences outside the `builtin < detected < global < repo` settings ladder. Reads SHALL accept an untouched settings file with those fields absent. Writes SHALL leave a malformed client-settings file byte-for-byte untouched.

#### Scenario: Untouched client settings
- **WHEN** `client-settings.json` contains only its supported version
- **THEN** the welcome is incomplete, the default Affineur theme pack applies, and no last-used project is assumed

#### Scenario: Client preferences round-trip
- **WHEN** the welcome completion, theme pack, and last-used project are written and the client restarts
- **THEN** the same values are read back without entering repository settings or the daemon settings ladder

#### Scenario: Malformed client settings refuse the write
- **WHEN** `client-settings.json` is malformed and one of the new client preferences is changed
- **THEN** the write is refused and the malformed file remains byte-for-byte unchanged
