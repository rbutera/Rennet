## ADDED Requirements

### Requirement: Worktree location, layout and workspace resolve on the ladder and reach the binding

`worktreeRoot`, `worktreePattern`, `prWorktreePattern` and `workspace` SHALL be registered keys resolved through the ladder like every other, and the session binding SHALL read their resolved values. The global rung of each SHALL live on the daemon's host in `daemon-settings.json`, because a filesystem path is a fact about the host that binds, and the repo rung in the repository's `.rennet/config.json`. A written location SHALL be expanded and made absolute by the daemon. A written pattern SHALL be refused, with the file untouched, when it carries an unknown token, resolves to an absolute path, or can resolve outside the root. No registered setting SHALL persist without a consumer.

#### Scenario: A repo overrides the host's root
- **WHEN** `daemon-settings.json` sets a worktree root and a repository's config sets another
- **THEN** that repository's worktrees are placed under its own root, the row's provenance names the repo layer, and the host's value is listed as a non-effective contribution

#### Scenario: An escaping pattern is refused
- **WHEN** the reviewer writes a branch pattern containing `../`
- **THEN** the write is refused with its reason, the config file is byte-for-byte unchanged, and the resolved pattern is unchanged

#### Scenario: The four keys are consumed
- **WHEN** the registry is enumerated for keys with no reader on the binding path
- **THEN** none of the four appear

### Requirement: A placement preview is the daemon's resolved answer

The settings row for a repository SHALL carry the example paths its resolved root and patterns produce for that repository — one for a branch worktree using the repository's current branch, one for a pull-request snapshot — computed by the daemon from the same functions the binding uses. The client SHALL render those strings and SHALL NOT derive a path of its own.

#### Scenario: Preview follows the resolved values
- **WHEN** the reviewer changes the branch pattern
- **THEN** the branch preview on the row changes to what the binding would now produce for that repository, and nothing in the client computed it

#### Scenario: Two repositories preview differently
- **WHEN** a workspace project holds two repositories
- **THEN** each row's preview names its own repository's key and remote, not the project's
