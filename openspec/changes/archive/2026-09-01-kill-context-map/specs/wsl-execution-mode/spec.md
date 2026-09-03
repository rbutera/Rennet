## MODIFIED Requirements

### Requirement: Shipped WSL operations execute inside the locus
Git capture, checkpoint, submodule probes, pull request git operations, project discovery, project detail, worktree cleanup, snapshot generation, settings git operations, branch pushes, the Claude handoff write turn, and every review-pipeline model turn SHALL execute inside the project's locus. Model turns include canvas lens producers, flagged and noise lenses, spec-delta mapping, symbol lookup, comment refinement, pull request body drafting, delta digest, and handoff composition. For a WSL locus, git and model providers SHALL execute inside the named distribution with distribution-native working paths. Windows file reads SHALL use the matching UNC view.

#### Scenario: Git capture in WSL mode
- **WHEN** a review captures a patchset for a WSL-locus project
- **THEN** git runs inside the distro against the distro-native repo path, and the captured diff is byte-identical to what git inside the distro reports

#### Scenario: A Codex-selected job runs in the distro
- **WHEN** a WSL-locus review assigns a job to an installed distro codex
- **THEN** the codex turn executes inside the distro through the locus command wrapper, and the review is dual-harness rather than degraded to a single Claude seat
