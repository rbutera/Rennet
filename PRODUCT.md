# Rennet

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Rennet is for agentic software engineers who already use coding harnesses such as Claude Code and Codex and now face a new bottleneck: understanding, judging, and taking responsibility for the large changes those agents produce.

The primary user is an individual engineer working in a local repository or reviewing a GitHub pull request. They are technically capable, short on attention, and need the machine to do the structural reading work without taking the final judgment away from them.

## Product Purpose

Rennet is a local-first, MIT-licensed Electron desktop app that makes large code changes digestible. It turns a changeset into logically ordered cohorts, surfaces the decisions inside it, lets the reviewer move between overview and detail, and carries their dispositions either into a GitHub review or back to a coding agent.

Rennet exists because AI has made producing code dramatically easier without making reviewing it easier. Success means an engineer can understand and answer for an agent-generated change without reading a large diff file by file from top to bottom.

The product is available now, free, and open source. The marketing site's primary action is **Download Rennet for macOS**. Its secondary action is to view, follow, or star the project on GitHub.

## Positioning

**You stopped writing the code. You still have to answer for it.**

Rennet is a review harness, not another coding agent and not an autonomous approval bot. Coding harnesses point models at a codebase so they can write; Rennet points the coding harnesses already on the user's machine at a change so the human can read and judge it.

Its distinct mechanism is **roll-up + zoom + lenses**: related changes become logical cohorts, decisions remain fully reachable, the reviewer can act at any granularity, and the reading order is optimized for comprehension rather than file order, churn, or risk.

## Operating Context

Rennet runs as a macOS desktop application alongside coding harnesses, local Git repositories, worktrees, and GitHub. The first-run experience is the empty Projects list rather than an onboarding wizard.

Users add a workspace or project repository, let Rennet process its local context, then enter either their own local branches or team pull requests. Reviews move through the Spec, Sequence, Decisions, Flagged, and Noise canvases, with blast radius available as an overlay. The user accumulates dispositions, edits the resulting paper, and signs it.

For another person's pull request, signing produces a normal batched GitHub review. For the user's own branch, the same dispositions become a work order for a coding harness; Rennet then re-reviews what changed.

## Capabilities and Constraints

- Rennet is an Electron desktop app. macOS is the supported download at launch; Windows and Linux distribution are not launch claims.
- The product is local-first and has no Rennet backend or telemetry. Selected harnesses may send assembled context to their own providers, and Rennet must describe that fact honestly rather than claiming that nothing leaves the machine.
- Rennet uses the user's installed coding harnesses and their existing authentication. Claude Code is first; other harnesses follow the same adapter boundary.
- Zero-config is the north star: installed harnesses should be detected and work without API-key setup inside Rennet.
- Both local working changes and GitHub pull requests are first-class review sources.
- Related changes and decisions are aggressively grouped by default. Grouping is opinionated product behavior, not project configuration.
- Decisions are never hidden behind a count limit. Users can zoom and act at the whole-review, cohort, group, partial, or individual-item level.
- The human makes the judgment and explicitly posts human-visible review content. Rennet may freely drive coding work, write changes, run tests, push branches, and prepare pull requests.
- `.rennet/` holds local project context and is ignored by default. Rennet does not stage or commit a user's project context.
- Rennet is MIT licensed throughout. The product name and brand assets are separate identity assets, not generic code examples.

## Brand Commitments

The product name is **Rennet**. The name connects directly to the promise of making code digestible.

The canonical mark is a compact cheese wheel whose right edge breaks into smaller pieces: a large body becoming something a person can digest. The authoritative identity sources and exports live in [`brand/`](brand/).

Product and marketing language should be direct, intelligent, and honest. Lead with the user's responsibility and the review bottleneck, not generic claims about AI productivity or making enormous pull requests pleasant. Rennet should feel like a serious tool for engineers without lapsing into enterprise procurement language, fear-based security language, or autonomous-review hype.

Confirmed public claims are:

- Available now
- Free and open source
- MIT licensed
- Downloadable for macOS
- Local-first
- No Rennet backend and no telemetry
- Works with coding harnesses already on the user's machine

## Evidence on Hand

- Canonical product intent: [`docs/Rennet Product and Vision.md`](docs/Rennet%20Product%20and%20Vision.md)
- Current delivery truth and priorities: [`docs/Rennet Delivery Order.md`](docs/Rennet%20Delivery%20Order.md)
- Product and architecture rulings: [`docs/Rennet Contracts and Rulings.md`](docs/Rennet%20Contracts%20and%20Rulings.md)
- Desktop packaging and installation: [`apps/desktop/PACKAGING.md`](apps/desktop/PACKAGING.md)
- Production brand assets: [`brand/README.md`](brand/README.md)
- Existing product UI: [`apps/desktop/`](apps/desktop/) and [`packages/ui/`](packages/ui/)

There are no confirmed testimonials, customer logos, usage totals, time-saved metrics, review-quality benchmarks, press quotes, or pricing comparisons. Future marketing work must not fabricate them.

## Product Principles

1. **Make code digestible.** Roll up related work, establish a comprehensible reading order, and keep every decision reachable.
2. **Let the human choose the altitude.** Overview and evidence are one continuous surface; approval and feedback work at any useful granularity.
3. **Spend machine effort to save human attention.** The user may be terse or messy. Rennet performs the grouping, investigation, refinement, and re-review work.
4. **Keep the agent capable.** Coding agents can write, test, and push. Restrictions that make the product harder to use are not product quality.
5. **Tell the truth about state and provenance.** Never imply something was read, placed, verified, local, or published when it was not.

## Accessibility & Inclusion

Rennet must support efficient keyboard-driven operation, clear focus states, readable code and prose, adequate contrast, reduced-motion preferences, and interfaces that remain understandable without relying on color alone.

The information architecture should reduce cognitive load for people reviewing complex changes under attention pressure. Progressive disclosure must preserve access to the complete review rather than hiding information permanently.
