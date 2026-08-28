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

**Start here: `docs/README.md`.** It maps the current documentation and names the authority for each part of the product. GitHub issues own the live work queue; the documentation does not invent an order that the issue tracker does not carry.

Then, for depth:

1. `docs/using/concepts/product-and-vision.md`
2. `docs/developing/decisions/contracts-and-rulings.md`
3. `docs/developing/concepts/architecture-contracts.md`
4. `docs/developing/reference/dependency-standard.md`
5. `docs/developing/concepts/handoff-and-exits.md`

Every one of these is subordinate to Rule Zero.

Contracts and rulings wins on general product and architecture conflicts, and Product and vision is the canonical statement of intent. Architecture contracts wins within project context, immutable patchsets, invalidation, persistence, privacy, and publication. Dependency standard wins on package selection, versions, toolchain ownership, package licensing, and dependency overlap. Promoted OpenSpec files define accepted behavior. ADRs explain narrow architectural choices but do not overrule Rule Zero or a scoped project authority.

## Fixed boundaries

- Never use client repositories, code, pull requests, screenshots, data, time, or infrastructure for development, fixtures, calibration, or model-backed dogfood without written authorization.
- Never add AI attribution or co-author trailers. Rai is the sole author.
- Rennet is **FSL-1.1-MIT** licensed throughout (Functional Source License, MIT Future License: source-available, no competing commercial use, each release converting to MIT two years after publication), with one licence for every package. Reader-facing copy may call it "open source" in the colloquial sense; do not claim OSI approval or call the licence MIT (the competing-use restriction and the two-year MIT conversion are the real terms).
- The Claude adapter **uses `@anthropic-ai/claude-agent-sdk`**. The SDK spawns the user's installed `claude` binary through `pathToClaudeCodeExecutable`, so it authenticates with the user's Claude subscription and costs nothing per token. Strip the SDK's bundled per-platform executables at packaging time. Never bundle a harness binary or read a harness credential.
- Nothing another human can see gets published without Rai clicking post. The review is his, in his voice, under his name. Use draft, preview, and post language. **Pushing a branch is not publishing**: Rennet's coding-agent loop writes and pushes freely, because submitting a pull request requires a push.
- Say "no Rennet backend" and disclose harness/provider egress. Never claim universally that nothing leaves the machine. This is honest copy, not a consent screen — state the fact, do not make the user clear a dialog.
- `.rennet/` is local and ignored by default. Rennet never stages or commits a user's project context.

## Package boundaries

`packages/protocol` and `packages/theme` import no Rennet package. `prompts` (the prompt-text + RSP prompt-contract package, formerly `lens-instructions`, which absorbed the deleted `instructions` package in B02) may import `protocol`; `core` may import `protocol` and `prompts`; `adapters` may import those packages plus Node dependencies; `server` may import `protocol`, `prompts`, `core`, and `adapters`; `client` may import `protocol`; `ui` (the vendored shadcn/Base UI component kit) may import only `protocol` and `theme`; `app-ui` (Rennet's composites and screens) may import only `protocol`, `theme`, `ui`, and browser-safe dependencies. `apps/desktop` is the only Electron package. Spikes are excluded from the pnpm workspace.

## Documentation

Root `docs/` is the canonical documentation library. `apps/docs` renders it as a static Astro Starlight site on Cloudflare Pages. The site has two audiences: **Using Rennet** for people who run reviews and **Developing Rennet** for people who build Rennet. Mermaid fences render as themed SVG through `beautiful-mermaid`, without a headless browser.

**Standing obligation, part of the definition of done — not a gate:** a change to the monorepo updates the affected documentation *in the same change*. The test is: *if someone reads the docs after this change and is now wrong, the change is not done.* This is enforced the way the rest of Rennet's discipline is — it is what "done" means, not a separate consent step or approval.

- How to write a page: `docs/developing/contributing/docs-style-guide.md`.
- What every page must carry: `docs/developing/contributing/good-docs-standard.md`.
- Reach for a mermaid diagram when a flow or architecture is clearer seen than read; write it as a ```mermaid fence and it renders to a themed SVG at build time.
- The documentation library describes current or explicitly planned Rennet. Git and archived OpenSpec changes retain old material; never narrate that history in reader-facing docs.

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

Prevention beats recovery here: run **one** `nx` invocation at a time within a worktree. **Worktrees DO isolate the Nx cache** (re-corrected 2026-08-28, this time by measurement; both earlier claims in this file were wrong, the second one — "every worktree shares ONE cache and ONE task-history DB" — most of all). Nx resolves `workspaceDataDirectory` from the directory holding `nx.json`, which is the worktree root, not the git common dir. Verified: every active worktree carries its own `.nx/workspace-data/<uuid>-v3.db`, and since Nx 20 that DB *is* the local cache as well as the task-history store — there is no `.nx/cache` and no `node_modules/.cache/nx` anywhere in this repo. The shared `<uuid>` in the filename is a hash of the workspace name, not shared state. So two agents gating in two worktrees are NOT two processes on one DB; the `FOREIGN KEY constraint failed` bug needs two `nx` processes in the **same** worktree, which is what the one-at-a-time rule above actually prevents.

Consequences for the concurrent-agent recipe: keep `NX_DAEMON=false` (it prevents a per-worktree daemon surviving `git worktree remove`, which is the swap-leak failure mode below). `NX_CACHE_DIRECTORY="$PWD/.nx-isolated/cache"` is **no longer required for isolation** — it was buying something the worktree already gave you, at the price of a permanently cold cache and 30–90 MB of disk per seat that `pnpm nx reset` cannot see. Prefer plain `NX_DAEMON=false pnpm check`. If you do use `NX_CACHE_DIRECTORY`, you own removing `.nx-isolated/` yourself (see the lifecycle section). Either path is control-proven (2026-08-28): an injected type error cache-misses and fails honestly. A focused `typecheck`-alone run is NOT a sufficient gate (one pass/fail divergence vs `build` on the same command was sighted) — gate with full `pnpm check`, which always includes `build`.

### Environment gotchas (nimbus / zsh)

- `pnpm exec biome` (and `biome --write`) can OOM under concurrent memory pressure. If biome dies with an allocation error, invoke the raw binary directly: `node_modules/.bin/biome check <paths>` (the workspace uses a hoisted node_modules, so the root `.bin/biome` resolves).
- `cp` and `mv` are interactive aliases (`-i`) that hang waiting for a y/n. Use `command cp -f` / `command mv -f` in scripts and non-interactive shells.
- The shell is zsh. After a pipe, the per-command status is `$pipestatus[1]` (one-indexed), NOT bash's `${PIPESTATUS[0]}` (which is empty in zsh and reads as "no error"). Capture `$?` on its own line immediately after the command, before anything else runs.
- `noclobber` is set: `>` refuses to overwrite an existing file. Use `>|` to force, or write to a fresh path.
- `openspec/` is ignored by the user's global gitignore (`~/.gitignore`). Stage openspec changes with `git add -f openspec/...`.
- After `git push`, verify it landed: `git rev-parse origin/<branch>` must equal local HEAD, and `git cat-file -e origin/<branch>:<a-changed-file>`. A local commit is not a pushed commit.
- **Read the code from `main`, not from a worktree, before you assert what the code does** (three incidents 2026-08-28, two of them the coordinator's). A worktree is pinned at its branch point; a landing that restructures a file makes every read of that worktree stale, and the stale read *looks* authoritative because it is a real file on disk. Every one of the three produced a confident instruction to copy a pattern that no longer existed. Before citing a symbol as live, read it at `origin/main` (`git show origin/main:<path>`), and when a diff surprises you, ask `git log origin/main..HEAD -- <path>` who wrote it — a diff against a moving `main` renders inherited text and authored text identically.
- **`git stash` is FORBIDDEN when multiple worktrees are active** (incident 2026-08-28): `refs/stash` is ONE ref shared across every worktree, so concurrent stash/pop races apply a SIBLING agent's content into your tree. Park WIP by committing to your branch (amend/fixup later) or writing a diff file. **A parking commit can be REFUSED by the pre-commit hook** — mid-edit code often fails lint, which is exactly when you most need to park (incident 2026-08-28: a seat died with 10 files loose and the hook rejected the rescue commit). `--no-verify` is still forbidden; the diff file is the fallback that actually holds, written OUTSIDE the worktree where no `git reset` reaches it. **Delete or refresh a parking diff the moment the work lands in a commit** — a stale patch that a later reader applies over newer committed work is worse than no patch. The real prevention is committing early and often, since only a hook-passing commit parks durably. If you must touch an existing stash, address entries by SHA (`git stash list --format="%H %gd %s"`), never by index alone.

## A workspace maps MANY repos to ONE identity, and the mapping is not invertible

Four separate defects on 2026-08-28, found one at a time, were all this one rule going unowned: session resolve matching on project id alone, New Chat row-hiding matching on branch alone, the round dispatch picking between two unstamped sessions **by store order**, and branch capture sending `project.openPath` — documented in `wire.ts` as *"the repo, or the first included repo"* — for a row belonging to any included repo.

The shape is always the same and it is always silent: two repos in one workspace both have `main`, and the code picks whichever the mapping happened to yield. Nothing errors. You get the wrong repository's content under the right repository's label.

**So: every path that turns a project into a repo must answer *which* repo, from the row/target/claim that named it — never from the project.** `Project.openPath` and `Project.id` identify a project, not a repository. When you need a repo, carry its identity (`owner/name` from the row, or the stamped `repositoryRoot`) and resolve it server-side.

Two rules that follow, both learned the expensive way:

- **Match on a positive contradiction, never on silence.** Excluding when either side simply does not know a repository re-breaks the sessions that predate the field. `session-entry.ts` carries the canonical form; copy its asymmetry rather than inventing a stricter one.
- **Fixtures decide whether you can see this at all.** A single-repo fixture makes every one of these bugs invisible while the tests pass honestly — #598's E2E was control-proven, and still could not see it. A control proves a test *can* fail; it does not prove the test asks the right question. Any test touching project→repo resolution needs a two-repo workspace sharing a branch name.

## Worktree lifecycle & cleanup (MANDATORY after merge)

Each agent works in its own worktree, and each worktree spawns its OWN persistent `nx` daemon + `nx-mcp` server (its own `.nx/`). **These processes SURVIVE `git worktree remove`** — the daemon keeps running rooted in the removed directory. Left uncleaned they accumulate fast: one day of ~16 build worktrees left ~128 stale node processes holding **~7.8 GB of swap** and pushed the 16 GB host into memory pressure. So cleanup is mandatory, not optional.

**When your PR MERGES (you are the merging agent):**
1. Shut down this workspace's nx daemon and clear its stores: `sh -c 'cd <your-worktree> && pnpm nx reset && rm -rf .nx-isolated'`. `nx reset` only knows about `.nx/` — it will **not** touch `.nx-isolated/`, so a seat that used `NX_CACHE_DIRECTORY` leaves 30–90 MB behind silently. Measured 2026-08-28: 313 MB stranded across six worktrees.
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

## Design Context

Target audience: software engineers who use coding agents and must answer for the large changes those agents produce. Positioning is "you stopped writing the code, you still have to answer for it" and "not for vibe coders, for agentic engineers". Two using-side readers run reviews: an engineer reviewing their own agent-written branch (question the change, hand a work order to a coding agent, review the delta, push, open a pull request) and a team reviewer posting one GitHub review under their own name. A third using reader weighs local-first operation and honest provenance before installing. The developing-side reader builds Rennet with the repo open under Rule Zero. Full personas with red flags: `docs/developing/contributing/personas.md`.

Brand and voice: Rennet turns dense change into readable objects without hiding the source. The look is "The Affineur's Bench": warm opaque grounds, one gold accent, serif for review prose. Palette, type, and component rules live in `DESIGN.md`. Documentation voice, the two-audience split, and structure rules live in `docs/developing/contributing/docs-style-guide.md`. Direct and concrete language; models surface, suggest, and flag while the reviewer judges, approves, and publishes; never imply Rennet approved or posted something it did not.

