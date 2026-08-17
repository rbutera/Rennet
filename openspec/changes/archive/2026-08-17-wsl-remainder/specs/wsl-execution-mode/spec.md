# wsl-execution-mode — close the deferred locus carve-outs

## MODIFIED Requirements

### Requirement: Shipped WSL operations execute inside the locus
Git capture, checkpoint, submodule probes, PR-open git, project discovery/detail/worktree cleanup, snapshot generation, settings/visibility git, submit-push, the Claude handoff write turn, and every review-pipeline model turn (canvas lens producers, flagged and noise lenses, spec-delta mapping, knowledge enrichment — proactive and orchestrator-resolved — symbol lookup, comment refinement, PR-body drafting, delta digest, and handoff composition) SHALL execute inside the project's locus. For a WSL locus, git and the harnesses execute inside the named distro with distro-native working paths. Windows-side file reads use the matching UNC view.

#### Scenario: Git capture in WSL mode
- **WHEN** a review captures a patchset for a WSL-locus project
- **THEN** git runs inside the distro against the distro-native repo path, and the captured diff is byte-identical to what git inside the distro reports

#### Scenario: Knowledge enrichment runs in the distro
- **WHEN** knowledge enrichment (proactive warm or orchestrator-resolved) runs for a WSL-locus project
- **THEN** the harness turn executes inside the distro with a distro-native working path, and the enriched context is not thinner than the same review on a host-locus project

#### Scenario: A Codex-selected job runs in the distro
- **WHEN** a WSL-locus review assigns a job to an installed distro codex
- **THEN** the codex turn executes inside the distro through the locus command wrapper, and the review is dual-harness rather than degraded to a single Claude seat
