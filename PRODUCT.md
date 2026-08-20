# Rennet

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Rennet is for software engineers who use coding agents and need to understand the large changes those agents produce. The primary user reviews a local repository or a GitHub pull request. They can read the code, but they do not want to reconstruct a large change file by file before they can judge it.

Rennet does the structural reading work without taking the judgment away from the reviewer. The reviewer remains responsible for anything posted in their name.

## Product purpose

Rennet is a local-first, MIT-licensed code review application. Its local daemon captures a changeset, groups related work into cohorts, orders those cohorts for comprehension, and keeps every claim connected to source evidence. Desktop, browser, and mobile clients read the same review.

Rennet supports two user stories.

1. **Review your own work.** Inspect committed and working-tree changes, question the implementation, send a work order to a coding agent, review the resulting delta, push the branch, and open a pull request.
2. **Review someone else's work.** Open a GitHub pull request, read it in comprehension order, record dispositions, edit the review preview, and post one normal GitHub review.

The macOS application is the public download. The release workflow also builds an unsigned Windows installer and portable ZIP. Native mobile distribution is planned; the mobile client already speaks the daemon protocol.

## Positioning

**You stopped writing the code. You still have to answer for it.**

**Not for vibe coders. For agentic engineers.**

Rennet is a review application, not a coding agent or an autonomous approval bot. Coding agents write changes. Rennet asks installed coding agents to help the reviewer understand and refine those changes.

Its main interaction is roll-up, zoom, and lenses. Rennet groups related edits, preserves every underlying decision, and lets the reviewer act on the whole review, a cohort, a group, or one item. The reviewer can also ask what changed, why it changed, and what the surrounding repository implies. Answers stay attached to the review and its code.

## Operating context

The local daemon works alongside Git repositories, worktrees, GitHub, Claude Code, and Codex. The Electron application owns the usual local daemon lifecycle and also hosts the browser client. A paired mobile client can connect to a daemon on another machine.

The first desktop run opens an empty Projects list. After adding a repository, the reviewer can open local changes or a GitHub pull request. Reviews use the Spec, Sequence, Decisions, Flagged, and Noise canvases. Blast radius appears as an overlay.

For another person's pull request, the review preview posts as a batched GitHub review. For the reviewer's own branch, the same dispositions become a work order for a coding agent. Rennet then captures and reviews the resulting delta before it can push the branch and open the pull request.

## Capabilities and constraints

- The macOS Electron application is the public download. Windows release artifacts exist but are unsigned. Native mobile distribution is planned. The browser client runs from the local daemon.
- Rennet has no backend and collects no telemetry. Installed coding agents may send assembled context to their providers. Rennet records what it assembled and sent.
- Rennet uses the user's installed Claude Code and Codex binaries with their existing authentication. Rennet does not ask for a separate model API key or add an inference markup.
- Installed coding agents should work without configuration inside Rennet.
- Local changes and GitHub pull requests are both review sources.
- Claude and Codex can run the same finding pass independently. Rennet preserves agreement and disagreement instead of averaging their output.
- Project intelligence combines a deterministic map of files, workspaces, symbols, references, tests, ownership, and dependencies with cited model explanations. A reference-branch update rebuilds affected map shards and refreshes the learned delta.
- Rennet groups related changes and decisions by default. Users do not configure the grouping algorithm.
- Rennet never hides decisions behind a count limit. Reviewers can zoom and act at useful levels of detail.
- The reviewer explicitly posts human-visible review content. Rennet can drive coding work, edit files, run tests, push branches, and prepare pull requests.
- `.rennet/` contains local project context and is ignored by default. Rennet does not stage or commit it.
- Every Rennet package uses the MIT licence. The product name and brand assets remain Rennet identity assets.

## Brand commitments

The product name is **Rennet**. The name describes the job: making code digestible.

The mark is a shallow cheese wheel whose right edge breaks into smaller pieces. Authoritative sources and exports live in [`brand/`](brand/).

Product and marketing language must be direct and specific. Lead with the reviewer's responsibility and attention limit. Do not promise generic productivity, use fear-based security language, or describe Rennet as an autonomous reviewer.

The marketing site should explain the human context-window problem before it lists mechanisms. It should show both user stories, show that reviewers can question a change, explain installed-agent reuse and independent review, and connect the repository map to review quality.

Confirmed public claims are:

- Available now
- Free and open source
- MIT licensed
- Downloadable for macOS
- Local-first
- No Rennet backend and no telemetry
- Uses installed Claude Code and Codex agents
- Supports conversational review over a diff or pull request
- Shows independent Claude and Codex agreement and disagreement
- Combines deterministic repository discovery with cited model knowledge

## Evidence

- Product intent: [`product-and-vision.md`](docs/using/concepts/product-and-vision.md)
- Product and architecture decisions: [`contracts-and-rulings.md`](docs/developing/decisions/contracts-and-rulings.md)
- Repository map: [`monorepo-map.md`](docs/developing/reference/monorepo-map.md)
- Desktop packaging: [`apps/desktop/PACKAGING.md`](apps/desktop/PACKAGING.md)
- Brand assets: [`brand/README.md`](brand/README.md)
- Product UI: [`apps/desktop/`](apps/desktop/) and [`packages/ui/`](packages/ui/)

Rennet has no confirmed testimonials, customer logos, usage totals, time-saved metrics, review-quality benchmarks, press quotes, or pricing comparisons. Do not invent them.

## Product principles

1. **Make code digestible.** Group related work, establish a useful reading order, and keep every decision reachable.
2. **Let the human choose the altitude.** Keep overview and evidence connected. Let the reviewer act at any useful level.
3. **Spend machine effort to save human attention.** Rennet handles grouping, investigation, refinement, and rereview.
4. **Keep the agent capable.** Coding agents can write, test, and push. A restriction that stops them doing the job is a product defect.
5. **Tell the truth about state and provenance.** Never imply that Rennet read, placed, verified, kept local, or posted something when it did not.

## Accessibility and inclusion

Rennet supports keyboard operation, visible focus states, readable code and prose, sufficient contrast, reduced-motion preferences, and states that do not rely on color alone.

Progressive disclosure reduces the initial reading load without making any part of the review unreachable.
