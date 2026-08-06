# Rennet agent instructions

Rennet is Rai Butera's personal product. This is the product monorepo and the private working remote is `rbutera/rennet`.

## Read before changing the product

1. `docs/Rennet Product and Vision.md`
2. `docs/Rennet Contracts and Rulings.md`
3. `docs/Rennet Architecture Contracts.md`
4. `docs/Rennet Dependency Standard.md`
5. `docs/Rennet Evidence Gate Status.md`
6. `docs/Rennet Navi Handoff.md`

The Contracts and Rulings document (formerly titled the Master Plan; ruling numbers unchanged) wins on general product and architecture conflicts, and the Product and Vision document is the canonical statement of intent. The Architecture Contracts win within project context, immutable patchsets, invalidation, persistence, privacy, and publication. The Dependency Standard wins on package selection, versions, toolchain ownership, package licensing, and dependency overlap. Historical Wingman documents are evidence and rationale only where a current authority supersedes them.

## Fixed boundaries

- Never use easyJet or other client repositories, code, pull requests, screenshots, data, time, or infrastructure for development, fixtures, calibration, or model-backed dogfood without written authorization.
- Never add AI attribution or co-author trailers. Rai is the sole author.
- Rennet is **MIT** licensed throughout, one licence for every package (Rai's decision, 2026-08-06). There is no AGPL boundary and no Apache-2.0 carve-out for `protocol`/`types`; any document still describing that split is superseded.
- The Claude adapter **uses `@anthropic-ai/claude-agent-sdk`** (Rai's decision, 2026-08-06, superseding the original R2 ruling in docs/Rennet Contracts and Rulings.md). The SDK spawns the user's own installed `claude` binary via `pathToClaudeCodeExecutable`, so it authenticates with the user's Claude subscription and costs nothing per token. Strip the SDK's bundled per-platform executables at packaging time. Never bundle a harness binary of our own, and never read a credential.
- Never auto-approve, auto-comment, push source branches, or publish anything another human can see without an explicit human action.
- Say "no Rennet backend" and disclose harness/provider egress. Never claim universally that nothing leaves the machine.
- `.rennet/` is local and ignored by default. Rennet never stages or commits a user's project context.
- Do not implement a subsystem while its relevant P0 evidence gate is open.

## Intended package boundaries

`packages/types` imports nothing in-repo. `protocol` may import `types`; `core` may import `protocol`; `adapters` may import `core` and Node; `ui` may import only `types`, `protocol`, and browser-safe dependencies; `apps/desktop` is the only Electron package. Spikes are deliberately excluded from the pnpm workspace.

## Working agreement

Keep `main` releasable. Run the full available local gate before every push. A clean check must include a positive control capable of failing. Preserve user changes, stage only intended files, and never bypass hooks or force-push unless Rai explicitly asks.

## Nx workflow

- Nx is the monorepo task graph and cache authority. Run repository tasks through `pnpm nx` or the root `pnpm` scripts, never by invoking package tools directly for a gate.
- Use `pnpm nx show projects` and `pnpm nx show project <name>` before guessing project names or targets.
- Use `pnpm nx affected -t lint,typecheck,test,build` for branch iteration and `pnpm nx run-many -t lint,typecheck,test,build` for the full pre-push gate once those targets exist.
- Trust a verified local cache hit. Do not add `--skip-nx-cache` or clear `.nx/cache` merely to make work look fresh.
- Every cacheable target must declare deterministic inputs and every generated artifact directory as an output. Never hash timestamps, absolute machine paths, ambient credentials, or undeclared environment state.
- A target that reads environment variables must name only the load-bearing variables in its Nx inputs. Secrets must never be copied into cacheable outputs.
- Long-running `serve`, watch, Electron dev, and interactive tasks are not cacheable. E2E remains uncached unless its hermeticity is proven.
- When adding Vite, Vitest, or Playwright, use the matching official Nx inference plugin at the exact same version as `nx`; inspect the inferred task with `pnpm nx show project <name>` before adding manual target configuration.
- Do not add Nx Cloud or remote caching until privacy, retention, and secret-boundary terms are explicitly approved. Local Nx caching is the default.
- `pnpm nx reset` is a diagnosis tool for a proven daemon/cache problem, not a normal development step.


<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax


<!-- nx configuration end-->
