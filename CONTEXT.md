# Rennet ubiquitous language

This file defines the terms shared by the product, documentation, and code. It contains no implementation guidance or architecture decisions.

## Documentation

- **Documentation library**: the canonical current and planned Rennet documentation, readable on GitHub and rendered by the docs app.
  _Avoid_: Docsite, docs source
- **Docs app**: the application that renders the documentation library at `docs.rennet.dev`.
  _Avoid_: Documentation, docs library
- **Project authority**: a current document with final say over one named part of the product or engineering model.
  _Avoid_: Source of truth
- **Decision record**: a narrow architectural choice and the reason it applies.
  _Avoid_: Ruling, spec
- **Promoted spec**: an accepted behavioral contract for one Rennet capability.
  _Avoid_: Plan, change
- **Planned page**: documentation for accepted behavior that is not live on `main` and cites its active tracking source.
  _Avoid_: Historical page, roadmap

## Projects

- **Project**: the persisted thing Rennet opens for review. It is either a workspace or a project repo, and it remembers which source it lives on.
- **Workspace**: a folder containing several git repos, which Rennet discovers by scanning under it.
  _Avoid_: Monorepo, folder
- **Project repo**: a single git repository opened on its own.
  _Avoid_: Repository (bare), repo
- **Source**: the machine whose filesystem a project lives on and whose Rennet host serves it: the local machine, a WSL distro, or a paired remote.
  _Avoid_: Host (for the machine), location, target
- **Rennet host**: the serving process a Rennet client talks to, running on a source. The preferred interface-facing name for the process; architecture writing may still say daemon.
  _Avoid_: Daemon (in interface copy), server

## GitHub account

- **Device sign-in**: the GitHub OAuth flow in which Rennet shows a short code and the user enters it on GitHub.
- **Side door**: the Settings action that accepts a personal access token instead of device sign-in.
- **Token store**: Rennet's local record of the connected GitHub credential.
- **Connect card**: the optional first-run control for starting device sign-in.
- **Not connected**: no GitHub credential is available.
- **Token invalid**: GitHub rejected the available credential.
- **Insufficient scope**: the credential is valid but lacks a permission required by the requested GitHub action.
- **GitHub egress**: the daemon's bounded path for GitHub requests, including sign-in, pull-request reads, and release checks. A network failure remains distinct from an authentication failure.

## Reviewing pull requests

- **Smart list**: a project's unified list of local working branches and GitHub pull requests. Local rows appear before GitHub loading finishes, and pull-request progress is reported per repository.
- **Retrospective review**: a review of a closed or merged pull request. It can inspect the captured change but cannot post.
- **Managed clone**: a repository clone that Rennet owns because it could not use a matching local clone.
- **PR worktree**: a checkout of the exact pull-request commit under review.
- **Setup file**: `.rennet/setup`, a list of shell commands Rennet runs when preparing a PR worktree.

## Review model

- **Lens**: a review of the change from one angle (spec, sequence, decisions, noise, flagged), drafted by a review agent on a fixed prompt. Each lens is its own board.
  _Avoid_: angle, canvas
- **Element**: the atomic unit of board content — a block, in the headless-CMS / document-block sense, carrying a kind and typed data. Element-typed attributes give the block tree.
  _Avoid_: card, node, widget
- **Kind**: the named, typed shape an element follows, like a document block-type. Rennet's host schema declares a closed set of twelve; the whiteboard protocol only stores and validates them, and never interprets their meaning.
- **Finding**: a concern the review raises, carrying a severity and cross-model concurrence and bound to cited code. Shown inline in the sequence thread and sorted by severity in the flagged lens; the flagged lens is a view of findings, not a separate kind.
- **Decision**: a choice the change embodies — its statement, evidence, the alternatives weighed, and why.
- **Requirement**: a spec obligation (a *shall*) and whether the change covers it.
- **Noise verdict**: a hunk judged noise or signal, with the reason and whether an LLM or a deterministic rule judged it.
- **Order step**: a waypoint in the change's reading order; the sequence lens renders these as its left spine.
- **Section**: an ordered, titled, navigable container of elements.
- **Prose**: a markdown element — the agent's freeform narration and augmentation surface.
- **Callout**: an emphasized aside.
- **Annotation**: a pin fixing a comment to a cited code location.
- **Message**: a turn in the review discussion — a finding, question, discussion, or request-change — replying to an element.
- **Code ref**: a citation into the patchset by path, side, and line span. The review cites code; it never copies it.
- **Code block card**: the reusable interface component that renders a code ref — highlighted code with its file path and line span, framed by surrounding commentary. The one way code appears in review surfaces; it renders a citation, so the never-copied rule holds. Distinct from the retired "card" sense of a board element.
- **Review comment**: a comment drafted for the GitHub review, distinct from an internal finding until the human posts it.
- **Draft board**: the board a lens's review agent drafts.
- **Composition Board** (the Board): the surface the orchestrator authors from the lens drafts, where the human reviews.
  _Avoid_: table, canvas
- **Generation**: the set of boards produced for one review of one patchset.
- **Successor account**: the comparison of a reviewed patchset with its successor after a coding-agent handoff.
  _Avoid_: delta re-review
- **Board-native data**: content a human authors on the board — marks, groupings, arrangement, notes — which the orchestrator composes from.

## Desktop presence

- **Logo menu**: the menu opened from the top-left Rennet mark. It contains application destinations, version information, and the restart action when an update is ready.
- **Owned daemon**: the local daemon whose lifecycle belongs to this desktop application.
- **Attached daemon**: a daemon that the application uses but does not own.
- **Tray-resident**: the desktop application has no open window but remains available from the system tray with its daemon and streams intact.
- **Update-ready**: an update has downloaded and will apply when the user chooses the restart action.
