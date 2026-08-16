## ADDED Requirements

### Requirement: Hunk-body content is never interpreted as file metadata

On the degraded REST path, the system SHALL interpret file metadata lines (`--- `/`+++ ` path headers, mode changes, renames) only in a diff block's preamble, before the first `@@` hunk header. After the first hunk header, every line SHALL be treated as hunk content classified by its prefix character alone: a line beginning `+` is an addition and a line beginning `-` is a deletion, regardless of what its content resembles. A body line SHALL never re-key a file, restate its paths, or change its status.

#### Scenario: An added body line rendering as a +++ header does not re-key the file

- **WHEN** a REST-fallback diff block for `actual.txt` contains, inside a hunk, an added source line whose content is `++ b/pnpm-lock.yaml` (rendered in the diff as `+++ b/pnpm-lock.yaml`)
- **THEN** the parsed file is keyed `actual.txt`, no `pnpm-lock.yaml` file appears in the result, and the adversarial line is counted in `additions`

#### Scenario: A deleted body line rendering as a --- header is counted as a deletion

- **WHEN** a hunk contains a deleted source line whose content is `-- b/some/path` (rendered `--- b/some/path`)
- **THEN** the line is counted in `deletions` and has no effect on the file's previous path

#### Scenario: The same-family core parser keeps body lines as body

- **WHEN** a per-file patch handed to decomposition contains, inside a hunk, an added line rendered `+++ b/other.txt`
- **THEN** the hunk's body carries that line as an addition with content `++ b/other.txt`, and no metadata interpretation occurs
