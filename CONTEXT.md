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
- **Project scout**: the seat that inspects a newly added project — after a deterministic pass — to detect its per-project configuration (issue tracker, worktree convention, logo, default branch, gate command, seed guidance), each answer carrying provenance. Its results prefill the project questionnaire.
  _Avoid_: Onboarding agent, detector

## GitHub account

- **GitHub CLI credential**: the token Rennet reads from the user's installed `gh` (`gh auth token`); the primary GitHub credential, carrying the user's own SSO authorization.
- **Device sign-in**: the GitHub OAuth flow in which Rennet shows a short code and the user enters it on GitHub. The fallback when `gh` is not installed.
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

## Session targets

- **Session**: one continuous conversation with the orchestrator and everything hanging off it — its threads, its claim, and at most one review once a target binds. The one chat travels with the reviewer across every surface; it never splits per surface. Sessions nest under projects in the sidebar. Once boards exist the target is locked: a new target means a new session.
  _Avoid_: chat (as the entity name), thread (for the whole session)
- **Claim**: a session's hold on its review target, taken when the session starts. A branch and its pull request are one claimed thing; claimed targets leave the New chat list. Released only by archiving the session.
- **Review target**: the thing a session reviews — your branch, your PR, or a teammate PR. Every surface names a target with these three terms and no synonyms.
  _Avoid_: own diff, local work (as a target name)
- **Your branch**: a working branch of yours with no pull request yet.
  _Avoid_: own branch, working tree (as a target label), local branch
- **Your PR**: a pull request you authored.
  _Avoid_: own PR, my PR
- **Teammate PR**: a pull request someone else authored.
  _Avoid_: their PR, team PR
- **Needs you**: the state of a teammate PR whose review is requested of you.
- **Reviewed**: the state of your branch after a Rennet review, before a PR exists.

## Review model

- **Lens**: a review of the change from one angle (design, sequence, decisions, flagged, noise — in that display order, Design first), drafted by a review agent on a fixed prompt. Each draft passes through the unslop editor before the orchestrator composes from it. Each lens is its own board.
  _Avoid_: angle, canvas
- **Design lens**: the lens that renders the change's spec artifacts (proposal, design, requirement deltas, tasks) as a structured artifact with coverage against the patchset.
  _Avoid_: spec lens
- **Sequence lens**: the lens that orders the change for reading, by dependency of understanding.
  _Avoid_: reading-order lens
- **Element**: the atomic unit of board content — a block, in the headless-CMS / document-block sense, carrying a kind and typed data. Element-typed attributes give the block tree.
  _Avoid_: card, node, widget
- **Kind**: the named, typed shape an element follows, like a document block-type. Rennet's host schema declares a closed set of thirteen; the whiteboard protocol only stores and validates them, and never interprets their meaning.
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
- **Reference chip**: a chip in the message composer that cites code. Created from a line of a code block card and carried by the message as a code ref.
- **Code block card**: the reusable interface component that renders a code ref — highlighted code with its file path and line span, framed by surrounding commentary. The one way code appears in review surfaces; it renders a citation, so the never-copied rule holds. Distinct from the retired "card" sense of a board element.
- **Diff view**: the raw patchset in GitHub's Files-changed shape — changed-file tree with filter, per-file cards with unified dual-gutter hunks, and viewed tracking. Not a lens: it toggles from a chip beside Map, outside the view switcher. Its line comments use the same local-comment → ask flow as code block cards, keyed to new-side line numbers so a request-change ask carries a real diff position.
- **Review comment**: a comment drafted for the GitHub review, distinct from an internal finding until the human posts it.
- **Draft board**: the board a lens's review agent drafts; when it freezes it is the lens board the human reads. There is no separate composed surface.
- **Composition**: the orchestrator's connective authoring across the lens boards — the coverage assertion, section carry with delta stamps, rollups, and the hand-off drafts. Composition is work, not a surface.
  _Avoid_: composition Board, the Board (as a sixth surface), table, canvas
- **Generation**: the set of boards produced for one review of one patchset.
- **Successor account**: the comparison of a reviewed patchset with its successor after a coding-agent handoff.
  _Avoid_: delta re-review
- **Board-native data**: content a human authors on the board — marks, groupings, arrangement, notes — which the orchestrator composes from.
- **Ask**: the staged unit of the hand-off: a typed message carrying an anchor, text, intent, and exit lane, minted from a finding, comment, thread, or conversation, with provenance to its source. Staged by the orchestrator; the receipt is the undo.
  _Avoid_: disposition, staged item
- **Exit**: one of the review's terminal actions — post the GitHub review, dispatch a work-order round, or push and open the pull request. Work orders exist only on one's own branch.
- **Round**: one dispatched work order and its returned successor patchset. Rounds serialize; each mints a new generation of boards, drafted delta-aware.
- **Round report**: the board accounting for what a round did with the asks — addressed, partial, untouched, or beyond the asks, each item verified against the round's diff and anchored. Drafted first when a round returns (its own prompt, the shared post-process pass): it is the greeting the reviewer reads while the lens drafters regenerate, and the successor account those drafters receive.
- **Rounds ledger**: the header control beside Map · Diff, present exactly when the session has a completed round. It lists every round's report; each round pins its asks, worker commits, frozen board generation, and the patchset generation it minted, so earlier reports and diffs stay readable.
- **Living draft**: an outbound document (review text, work order, PR description) the orchestrator alone authors and continuously reworks as the review progresses. Steered by conversation or span selection, never typed into; retired content is ledgered and restorable.
- **Related-context dossier**: the bounded, structured collection of material related to a change — referenced issue-tracker tickets, the PR description and comments, one-hop links — retrieved per patchset generation and handed verbatim to the review agents as part of their delta context. Items carry id, provenance, and freshness; agents cite them by id.
  _Avoid_: Ticket context, linked issues (as a mechanism name)

## Commands

- **Command**: one entry in the app's command registry — a named operation with typed arguments and a label, declared once and exposed selectively to the sidebar, the command menu, and the orchestrator. The one vocabulary of things Rennet can be told to do.
  _Avoid_: action (as the registry term)
- **App tools**: the commands exposed to the orchestrator as tools, letting it drive Rennet itself from the conversation. Distinct from the whiteboard authoring tools, which author board content.
  _Avoid_: app-control tools

## Settings

- **Coding harness**: an installed coding-agent runtime Rennet invokes on a source, such as Claude Code, Codex, or omp.
- **Settings ladder**: the precedence order a setting resolves through — builtin, detected, global, repo. The highest layer offering a value is effective, and every contribution stays visible as provenance.
- **Client settings**: preferences of the machine a person views Rennet on — appearance and keybindings. They follow the viewer, apply to whatever it views, and sit outside the settings ladder.
- **Daemon settings**: a source's machine-local settings, read by that source's Rennet host. They form the global rung of the settings ladder for projects on that source.
- **Orchestrator harness**: the coding harness a source uses for the interactive orchestrator conversation. A source with both Claude and Codex detected has an explicit preferred orchestrator harness.
- **Dual Harness**: a per-source review mode available when Claude and Codex are both detected. It runs one seat per provider for review roles that define a second seat; it does not run every model job twice.

## Desktop presence

- **First-run welcome**: the one-time setup experience for a new Rennet client. It introduces Rennet, establishes required system access and harness choices, then hands the user to Add Project. It precedes the contextual onboarding tour and is not a recurring empty-project state.
- **Coach mark**: one contextual teaching card anchored to a control when the user first reaches it. Coach marks appear one at a time and together form the replayable onboarding tour.
- **System access**: operating-system access Rennet needs to browse and read project files. It is established against a real project location and remains distinct from GitHub scopes and coding-harness authority.
- **Logo menu**: the menu opened from the top-left Rennet mark. It contains application destinations, version information, and the restart action when an update is ready.
- **Owned daemon**: the local daemon whose lifecycle belongs to this desktop application.
- **Attached daemon**: a daemon that the application uses but does not own.
- **Tray-resident**: the desktop application has no open window but remains available from the system tray with its daemon and streams intact.
- **Update-ready**: an update has downloaded and will apply when the user chooses the restart action.
