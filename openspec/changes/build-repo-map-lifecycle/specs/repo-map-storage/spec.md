# repo-map-storage

Where the derived Repo Map lives, how access to it travels across worktrees and branches, and how a map may be shared by explicit commit-and-discover. Builds on the wave-1 app-owned `ProjectSnapshotStore` keyed by repo identity.

## ADDED Requirements

### Requirement: The derived Repo Map is stored app-owned and keyed by repo identity

The derived Repo Map (snapshot manifest + content-addressed shards) SHALL be stored in an app-owned local store keyed by the repository's durable identity (`RepoRecord`, whose primary local alias is `realpath(git-common-dir)`, R19), never by working-tree path. Human-authored config (`project.jsonc`, conventions, guideline docs) SHALL remain repo-local under `.rennet/`. This amends R27 per R55: derived data SHALL NOT be required to live under `.rennet/`.

#### Scenario: all worktrees of a repo share one store entry

- **WHEN** two worktrees of the same repository resolve their base ref
- **THEN** both resolve to the same `repoKey` (same `git-common-dir`)
- **AND** both read and write the same store entry, so opening the second worktree triggers no rebuild and creates no per-worktree symlink

#### Scenario: derived data is not committed by default

- **WHEN** a snapshot is built or advanced for a repository with the default (local-only) settings
- **THEN** the derived shards and manifest are written only to the app-owned store
- **AND** the repository's git status is unchanged (no derived file is staged or committed)

### Requirement: A committed map is discovered and validated, never trusted blind

When a repository contains a committed (mirrored) Repo Map under `.rennet/`, Rennet SHALL discover it on project open and validate it before use: shard bytes SHALL be re-verified to hash to their digest and the fingerprint SHALL be re-checked against the committed base OID. A map that fails validation SHALL be ignored in favour of a local build. A map is matched to the current repository by a portable `RepoRecord` alias, not by filesystem path.

#### Scenario: a valid committed map seeds the local store

- **WHEN** a repository is opened and it carries a committed map that validates
- **THEN** the map seeds the local store so the reviewer starts warm without a cold rebuild

#### Scenario: a corrupt or mismatched committed map is ignored

- **WHEN** a committed map fails integrity or fingerprint validation, or does not match the repository's portable identity
- **THEN** it is ignored and a local build is used instead, and no invalid map is ever served to a review

### Requirement: Mirroring a map into the repository is opt-in and default off

Committing (mirroring) the local derived Repo Map into the repository SHALL be a per-project or per-workspace opt-in that is off by default. When off, no derived data is ever written into `.rennet/`. When on, a mirror is produced only by a deliberate user act.

#### Scenario: default settings never mirror

- **WHEN** a project is opened and snapshots advance under default settings
- **THEN** `.rennet/` gains no derived shards or manifest

### Requirement: The visibility switch never stages or commits

`projectContext.visibility` SHALL be `local` by default or `git-visible`. Switching it SHALL preview the filesystem diff and change only Rennet-owned exclusion state; it SHALL never run `git add`, `git rm --cached`, or `git commit`. Files already tracked by git SHALL remain tracked and be disclosed honestly, never silently restaged.

#### Scenario: switching visibility leaves the index untouched

- **WHEN** a user switches `projectContext.visibility`
- **THEN** the change previews the filesystem diff
- **AND** the git index is unchanged and any pre-tracked files are reported rather than restaged
