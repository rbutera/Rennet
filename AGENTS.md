# Rennet agent instructions

## ⛔ RULE ZERO — NO GATES

**NO CONSENT GATES. NO GATES. NO ROBUSTNESS FOR ROBUSTNESS' SAKE.**

Rai, 2026-08-11, verbatim: *"STOP POLISHING SECURITY CEREMONY WHEN I AM TRYING TO BUILD A DIFF DIGESTOR AND PR REVIEW BUDDY."*

This outranks every other instruction in this file and every doctrine in `docs/`. If a ruling, a contract, a review finding or your own good judgement points at adding a gate, **Rule Zero wins.**

What this forbids:

- Consent tokens, approval ceremonies, disclosure receipts, are-you-sure confirmations.
- Denying an agent a capability so it "structurally cannot" do something. **A capable agent is the product.**
- Read-only-by-default postures on the acting path. Rennet drives the user's coding harness; it must be able to write, and it must be able to push, because submitting a PR requires a push.
- Hardening, sandboxing or lockdown work filed as its own task.
- A reviewer's finding whose fix is any of the above. Findings are not orders — sort them, and drop the ceremony.

What is still worth fixing, and the test that tells them apart:

**Does this make the product do its job better, or does it make the product harder to use safely?** The first is a feature. The second is a gate, however good the argument.

So: a diff that doesn't show what changed is a bug. A crash is a bug. A lie in the UI is a bug. An agent that can't run the tests it just wrote is a gate wearing a lab coat.

⚠️ The failure mode this rule exists to stop is *persuasive*. Every gate added here arrived with a coherent safety argument, written by someone pleased with their own reasoning. **Feeling clever about a restriction is the signal to stop, not to proceed.**


Rennet is Rai Butera's personal product. This is the product monorepo and the private working remote is `rbutera/rennet`.

## Read before changing the product

**Start here: `docs/Rennet Delivery Order.md`.** It says what to build next, what is already finished on an unmerged branch, and how to read the Rule Zero amendment blocks now sitting on many issues. It outranks the ordering implied by issue numbers, P-labels, and any plan document below.

Then, for depth:

1. `docs/Rennet Product and Vision.md`
2. `docs/Rennet Contracts and Rulings.md`
3. `docs/Rennet Architecture Contracts.md`
4. `docs/Rennet Dependency Standard.md`
5. `docs/Rennet Navi Handoff.md`

Every one of these is subordinate to Rule Zero. `docs/Rennet Evidence Gate Status.md` was removed from this list on 2026-08-11: gating implementation on an open evidence gate is exactly the ceremony Rule Zero forbids.

The Contracts and Rulings document (formerly titled the Master Plan; ruling numbers unchanged) wins on general product and architecture conflicts, and the Product and Vision document is the canonical statement of intent. The Architecture Contracts win within project context, immutable patchsets, invalidation, persistence, privacy, and publication. The Dependency Standard wins on package selection, versions, toolchain ownership, package licensing, and dependency overlap. Historical Wingman documents are evidence and rationale only where a current authority supersedes them.

## Fixed boundaries

- Never use easyJet or other client repositories, code, pull requests, screenshots, data, time, or infrastructure for development, fixtures, calibration, or model-backed dogfood without written authorization.
- Never add AI attribution or co-author trailers. Rai is the sole author.
- Rennet is **MIT** licensed throughout, one licence for every package (Rai's decision, 2026-08-06). There is no AGPL boundary and no Apache-2.0 carve-out for `protocol`/`types`; any document still describing that split is superseded.
- The Claude adapter **uses `@anthropic-ai/claude-agent-sdk`** (Rai's decision, 2026-08-06, superseding the original R2 ruling in docs/Rennet Contracts and Rulings.md). The SDK spawns the user's own installed `claude` binary via `pathToClaudeCodeExecutable`, so it authenticates with the user's Claude subscription and costs nothing per token. Strip the SDK's bundled per-platform executables at packaging time. Never bundle a harness binary of our own, and never read a credential.
- Nothing another human can see gets published without Rai clicking post. This is a product feature — the review is his, in his voice, over his signature — not a safety gate. **Pushing a branch is not publishing**: Rennet's coding-agent loop writes and pushes freely, because submitting a PR requires a push.
- Say "no Rennet backend" and disclose harness/provider egress. Never claim universally that nothing leaves the machine. This is honest copy, not a consent screen — state the fact, do not make the user clear a dialog.
- `.rennet/` is local and ignored by default. Rennet never stages or commits a user's project context.

## Intended package boundaries

`packages/types` imports nothing in-repo. `protocol` may import `types`; `core` may import `protocol`; `adapters` may import `core` and Node; `ui` may import only `types`, `protocol`, and browser-safe dependencies; `apps/desktop` is the only Electron package. Spikes are deliberately excluded from the pnpm workspace.

## Working agreement

Keep `main` releasable. Run the full available local gate before every push. A clean check must include a positive control capable of failing. Preserve user changes, stage only intended files, and never bypass hooks or force-push unless Rai explicitly asks.

## Nx workflow

- Nx is the monorepo task graph and cache authority. Run repository tasks through `pnpm nx` or the root `pnpm` scripts, never by invoking package tools directly for a gate.
- Use `pnpm nx show projects` and `pnpm nx show project <name>` before guessing project names or targets.
- The full gate is `pnpm check` (`nx run-many -t format,architecture,licenses,lint,typecheck,test,build`). Every implementer and reviewer relies on `pnpm check` being the gate command; run it before every push. Use `pnpm nx affected -t lint,typecheck,test,build` for fast branch iteration.
- Trust a verified local cache hit. Do NOT add `--skip-nx-cache` or clear `.nx/cache` merely to make work look fresh, and do NOT do it out of a vague distrust of the cache. The cache is configured to be correct (see below); if you genuinely think it returned a stale result, that is a bug to reproduce and fix in the cache config, not to paper over with a skip.
- Cache correctness is a declared property, not luck: every cacheable target declares `inputs` covering every file whose content decides its verdict. `format` is keyed on the exact globs Biome checks (not just root-owned files — a past stale-pass bug), and shared config (`biome.json`, `eslint.config.mjs`, `tsconfig.base.json`) lives in `sharedGlobals` so a config edit busts every dependent cache. If you add a target, declare its real inputs and outputs the same way.
- Every cacheable target must declare deterministic inputs and every generated artifact directory as an output. Never hash timestamps, absolute machine paths, ambient credentials, or undeclared environment state.
- A target that reads environment variables must name only the load-bearing variables in its Nx inputs. Secrets must never be copied into cacheable outputs.
- Long-running `serve`, watch, Electron dev, and interactive tasks are not cacheable. E2E remains uncached unless its hermeticity is proven.
- When adding Vite, Vitest, or Playwright, use the matching official Nx inference plugin at the exact same version as `nx`; inspect the inferred task with `pnpm nx show project <name>` before adding manual target configuration.
- Do not add Nx Cloud or remote caching until privacy, retention, and secret-boundary terms are explicitly approved. Local Nx caching is the default.
- `pnpm nx reset` is a diagnosis tool for a proven daemon/cache problem, not a normal development step.

### When `--skip-nx-cache` / `nx reset` is actually legitimate

Almost never. The only sanctioned cases:

- The Nx task-history SQLite DB throws `FOREIGN KEY constraint failed` (or `disk I/O error`) and the target exits 1 *after* printing "Successfully ran target" with zero real errors. This is a known Nx-internal concurrency bug (nrwl/nx#28035, #28424; present through 23.1.0), not a fault in your work or the cache's inputs. It only triggers when two separate `nx` processes write the same task-history DB at once. Recover with `pnpm nx reset` once, then re-run. Do not add `--skip-nx-cache` to the gate to hide it.
- You are debugging the cache config itself and need a cold baseline to compare against.

Prevention beats recovery here: run **one** `nx` invocation at a time within a worktree. Rennet's worktree-per-agent model already isolates the task-history DB across agents (each worktree root gets its own `.nx/`), so the crash needs two concurrent Nx processes *in the same worktree* — avoid that and you avoid the crash.

### Environment gotchas (nimbus / zsh)

- `pnpm exec biome` (and `biome --write`) can OOM under concurrent memory pressure. If biome dies with an allocation error, invoke the raw binary directly: `node_modules/.bin/biome check <paths>` (the workspace uses a hoisted node_modules, so the root `.bin/biome` resolves).
- `cp` and `mv` are interactive aliases (`-i`) that hang waiting for a y/n. Use `command cp -f` / `command mv -f` in scripts and non-interactive shells.
- The shell is zsh. After a pipe, the per-command status is `$pipestatus[1]` (one-indexed), NOT bash's `${PIPESTATUS[0]}` (which is empty in zsh and reads as "no error"). Capture `$?` on its own line immediately after the command, before anything else runs.
- `noclobber` is set: `>` refuses to overwrite an existing file. Use `>|` to force, or write to a fresh path.
- `openspec/` is ignored by the user's global gitignore (`~/.gitignore`). Stage openspec changes with `git add -f openspec/...`.
- After `git push`, verify it landed: `git rev-parse origin/<branch>` must equal local HEAD, and `git cat-file -e origin/<branch>:<a-changed-file>`. A local commit is not a pushed commit.

## Worktree lifecycle & cleanup (MANDATORY after merge)

Each agent works in its own worktree, and each worktree spawns its OWN persistent `nx` daemon + `nx-mcp` server (its own `.nx/`). **These processes SURVIVE `git worktree remove`** — the daemon keeps running rooted in the removed directory. Left uncleaned they accumulate fast: one day of ~16 build worktrees left ~128 stale node processes holding **~7.8 GB of swap** and pushed the 16 GB host into memory pressure. So cleanup is mandatory, not optional.

**When your PR MERGES (you are the merging agent):**
1. Shut down this workspace's nx daemon: `sh -c 'cd <your-worktree> && pnpm nx reset'` (stops the daemon + clears its cache).
2. `cd` OUT of your worktree first (git refuses to remove a worktree you are standing in), then remove it: `sh -c 'cd <main-rennet-checkout> && git worktree remove <your-worktree> --force'`. If it fails with the "main is checked out in a sibling worktree" quirk, the remote merge still completed — just ensure step 1 ran and state the worktree path in your report so the orchestrator prunes it.

**When your PR is SUBMITTED but not yet merged:** KEEP the worktree (the review teammate needs it for fixes). You may still run `pnpm nx reset` once your heavy nx work is done, to drop the idle daemon.

(Wrap `git`/`pnpm`/`nx` in `sh -c '...'` — the host's RTK shell hook mangles those commands and can return corrupted output.)

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
