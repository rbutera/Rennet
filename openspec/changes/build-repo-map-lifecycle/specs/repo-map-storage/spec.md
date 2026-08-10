# repo-map-storage

Where the derived Repo Map lives (local-first), how it is keyed and promoted for sharing, and the precedence between a local and a committed map. Adopts codeindexer.dev's path-keyed local-plain-files model; diverges by using `~/.rennet` + opt-in in-repo promotion rather than a shared team volume.

## ADDED Requirements

### Requirement: The derived Repo Map is stored local-first, keyed by escaped absolute path

The derived Repo Map SHALL be stored locally by default under `~/.rennet/projects/<escaped-absolute-path>/`, with the default-branch base map at `map/`, per-non-default-base overlays at `overlays/<base-oid>/`, and project config at `config.json`. The per-project key `<escaped-absolute-path>` SHALL be derived from the repository's top-level directory (`git rev-parse --show-toplevel`). Derived data SHALL NOT be committed by default.

#### Scenario: a project resolves to its escaped-path directory

- **WHEN** a repository at a given absolute path is opened
- **THEN** its derived map is read and written under `~/.rennet/projects/<escapePath(top-level)>/map/`
- **AND** the repository's git status is unchanged (no derived file is staged or committed)

### Requirement: The escaped-absolute-path scheme is exact and cross-platform

`escapePath(absPath)` SHALL: (1) resolve to the canonical absolute path; (2) replace every character in `{ '/', '\\', ':' }` with `-`; (3) collapse any run of consecutive `-` into a single `-`. It SHALL be deterministic and stable for a given checkout across runs.

#### Scenario: POSIX path

- **WHEN** `escapePath` is applied to `/Users/rai/dev/lumiere`
- **THEN** the result is `-Users-rai-dev-lumiere`

#### Scenario: Windows drive path

- **WHEN** `escapePath` is applied to `C:\Users\rai\navi`
- **THEN** the drive-colon and following backslash collapse to one `-`, yielding `C-Users-rai-navi`

### Requirement: A map can be promoted into the repo as an opt-in, default off

Promotion SHALL be a per-project opt-in that is off by default. When on, a deliberate user act SHALL write the `map/` tree into the repository at `<repo>/.rennet/map/` on the default branch, so collaborators pick it up through normal git; `config.json` SHALL record the promotion. When off, no derived data is ever written into the repository.

#### Scenario: default settings never promote

- **WHEN** snapshots are built or advanced under default settings
- **THEN** the repository gains no derived `map/` files

#### Scenario: promotion writes a discoverable committed map

- **WHEN** a user promotes the map
- **THEN** a valid map is written under `<repo>/.rennet/map/` on the default branch and recorded in `config.json`

### Requirement: A committed map is validated on discovery, never trusted blind

When a repository contains a committed map at `<repo>/.rennet/map/`, Rennet SHALL validate it before use: shard bytes SHALL be re-verified to hash to their digest and the fingerprint SHALL be re-checked. A map that fails validation SHALL be ignored in favour of a local build. A committed map pertains to the repository it physically lives in, by construction — no forge-identity or alias matching is performed.

#### Scenario: a corrupt committed map is ignored

- **WHEN** a committed map fails integrity or fingerprint validation
- **THEN** it is ignored and a local build is used, and no invalid map is served to a review

### Requirement: The local map takes precedence over the committed map

Map resolution SHALL be: local `~/.rennet/projects/<escaped-path>/map/` first, then committed `<repo>/.rennet/map/`, then a local build if neither exists. The local map SHALL win even when the repository is on a non-default branch.

#### Scenario: local wins on a branch

- **WHEN** both a local map and a committed map exist and the checkout is on a non-default branch
- **THEN** the local map is used and the committed map is the fallback only

### Requirement: A project can be relocated without reindexing

Moving a repository on disk SHALL NOT force a rebuild: a `relocate` operation SHALL update a project's escaped-path directory and record the move in `config.json`, and aliases SHALL resolve alternative escaped paths to the same project.

#### Scenario: relocate preserves the map

- **WHEN** a repository is moved and `relocate` is run with the new path
- **THEN** the existing map is reused under the new escaped-path directory without reindexing

### Requirement: The visibility switch never stages or commits

`projectContext.visibility` SHALL be `local` by default or `git-visible`. Switching it SHALL preview the filesystem diff and change only Rennet-owned exclusion state; it SHALL never run `git add`, `git rm --cached`, or `git commit`. Files already tracked by git SHALL remain tracked and be disclosed honestly, never silently restaged.

#### Scenario: switching visibility leaves the index untouched

- **WHEN** a user switches `projectContext.visibility`
- **THEN** the change previews the filesystem diff
- **AND** the git index is unchanged and any pre-tracked files are reported rather than restaged
