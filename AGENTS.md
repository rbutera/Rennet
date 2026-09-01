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

## Harness prompts & token discipline

From the 2026-09-01 prompt/harness audit. The user's subscription pays for every token Rennet sends, and per-session cost is **invisible in a diff** — the audit's most expensive regression was a five-line deletion. So cost discipline is part of what "done" means for any change that touches a harness path, exactly like the documentation obligation: not a gate, a definition.

- **One choke point.** Every harness call is `port.createSession(spec)` + `session.send(prompt)`, reaching the single `query()` in `packages/adapters/src/claude-query.ts`. Never add a second path to the SDK and never spawn `claude` directly.
- **Every internal turn is a fresh, stateless, `ephemeral: true` session.** The prompt must carry everything — which means everything in it is re-billed on every retry, because a retry is a new cold session re-sending the full prompt. Keep retry prompts to pointers where the design allows, and prefer `resume` (fully wired; the interactive turn loop uses it) when a follow-up turn genuinely continues prior work. A repair turn that re-sends the whole base prompt plus the failing draft costs ~55k tokens to deliver a ~500-token correction.
- **Point the seat at the checkout, not at content** (commit 52920b74). Ship an index plus the exact `git diff`/`git show` commands, never an embedded diff or file body, unless the seat has no checkout to read. The surviving embeddings (the noise payload, the round-report worker diff) are debts, not precedents.
- **Every dynamic interpolation declares a byte bound at its call site** — a cap with an honest truncation marker, or `assemblePrompt`'s `maxBytes` actually passed. Unbounded interpolation is a bug. And never pretty-print JSON for a model: `JSON.stringify(x)`, not `(x, null, 2)` — the indent is a ~30% surcharge no reader sees.
- **The output schema travels once, as the SDK `outputFormat`.** Never restate or inline it in prompt text. This generalises the RSP contract rule ("the JSON shape is enforced separately"); the `hostSchema` double-send was 2.4k tokens per session.
- **A change that grows what a session sends says so in its PR description**, with a rough size: new prompt layer, new interpolation, new settings surface, new tool exposure. This sentence is how the reviewer sees a cost the diff cannot show.
- **Token usage reaches a sink.** The SDK reports usage and cost on every result frame and `turn-metrics.ts` already parses it; a turn path that drops it is a bug of the "lie in the UI" family — spend the user cannot see. New turn paths thread the `collector`.
- **Seats inherit the user's settings — settled, do not re-litigate** (commit 0d52c546, Rai's ruling 2026-09-01). `settingSources` and `strictMcpConfig` are deliberately never set: auth routing lives in `~/.claude/settings.json`, and isolation broke it. Re-adding isolation, however coherent the token or blast-radius argument, is a Rule Zero violation. The cost of inheritance is answered with measurement (the collector), not restriction.
- **Prompt text lives in `@rennet/prompts`.** No byte-identical instruction blocks duplicated across prompt files — share a partial. When a prompt file is retired, the same change removes every cross-reference to it (`review-draft-voice.md` instructed seats to apply `post-process.md` long after production stopped reading it — a live prompt citing a dead one).

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

- The Nx task-history SQLite DB throws `FOREIGN KEY constraint failed` (or `disk I/O error`) and the target exits 1 *after* printing "Successfully ran target" with zero real errors. This is a known Nx-internal concurrency bug (nrwl/nx#28035, #28424; present through 23.1.0), not a fault in your work or the cache's inputs. It only triggers when two separate `nx` processes write the same task-history DB at once. After every Nx process in that worktree exits, stop only that worktree's daemon with `pnpm nx reset --onlyDaemon`, then remove its lane-local cache with `rm -rf .nx-isolated`. Do not add `--skip-nx-cache` to the gate to hide it.
- You are debugging the cache config itself and need a cold baseline to compare against.

Prevention beats recovery here: run **one** `nx` invocation at a time within a worktree. Nx 23.1 keeps default artifact cache state in the main worktree: `cacheDir` resolves the main worktree root, so all worktrees otherwise share that `.nx/cache` store. A full reset from a worktree also clears workspace data in the main checkout. Different worktrees are therefore not safe reset boundaries by default, even though their source trees are isolated.

Consequences for the concurrent-agent recipe: run the gate with `CI=true NX_DAEMON=false NX_CACHE_DIRECTORY="$PWD/.nx-isolated/cache" pnpm check`. The lane-local artifact cache prevents one worktree's cache cleanup from deleting another lane's live artifacts; it does not require `--parallel=false`. Keep `NX_DAEMON=false` on gates, but do **not** carry it into reset: it disables the daemon client, so `pnpm nx reset --onlyDaemon` cannot stop a daemon. Remove `.nx-isolated/` explicitly during worktree cleanup. A focused `typecheck`-alone run is NOT a sufficient gate (one pass/fail divergence vs `build` on the same command was sighted) — gate with full `pnpm check`, which always includes `build`.

### Environment gotchas (nimbus / zsh)

- `pnpm exec biome` (and `biome --write`) can OOM under concurrent memory pressure. If biome dies with an allocation error, invoke the raw binary directly: `node_modules/.bin/biome check <paths>` (the workspace uses a hoisted node_modules, so the root `.bin/biome` resolves).
- `cp` and `mv` are interactive aliases (`-i`) that hang waiting for a y/n. Use `command cp -f` / `command mv -f` in scripts and non-interactive shells.
- The shell is zsh. After a pipe, the per-command status is `$pipestatus[1]` (one-indexed), NOT bash's `${PIPESTATUS[0]}` (which is empty in zsh and reads as "no error"). Capture `$?` on its own line immediately after the command, before anything else runs.
- `noclobber` is set: `>` refuses to overwrite an existing file. Use `>|` to force, or write to a fresh path.
- `openspec/` is ignored by the user's global gitignore (`~/.gitignore`). Stage openspec changes with `git add -f openspec/...`.
- After `git push`, verify it landed: `git rev-parse origin/<branch>` must equal local HEAD, and `git cat-file -e origin/<branch>:<a-changed-file>`. A local commit is not a pushed commit.
- **Read the code from `main`, not from a worktree, before you assert what the code does** (three incidents 2026-08-28, two of them the coordinator's). A worktree is pinned at its branch point; a landing that restructures a file makes every read of that worktree stale, and the stale read *looks* authoritative because it is a real file on disk. Every one of the three produced a confident instruction to copy a pattern that no longer existed. Before citing a symbol as live, read it at `origin/main` (`git show origin/main:<path>`), and when a diff surprises you, ask `git log origin/main..HEAD -- <path>` who wrote it — a diff against a moving `main` renders inherited text and authored text identically.
- **Never write a scratch file to a bare shared `/tmp/<generic>` path when other seats are active** (incident 2026-08-28): a seat ran `gh pr create --body-file /tmp/pr-body.md`, `noclobber` silently refused its heredoc because another seat's file was already there, `gh` read the stale file, and the PR **opened describing a different seat's work**. Same family as the `git stash` hazard — a shared mutable name plus concurrent seats — except `noclobber` turned a clobber into a *wrong-content publish*, which is worse, and the failure looked like a benign "file exists". Use a **lane-unique** name (`/tmp/rennet-<issue>-<lane>-*`) or write inside your own worktree, and **read back any PR body after `create`**. Not `$$`: it expands per shell invocation, so a write and a later read land on different paths — corrected 2026-08-28 by a seat that tried it. The read-back is the load-bearing half. It has already caught a second failure the rule was not written for: a seat found its PR body was missing a caveat it had stated in chat and *believed* was on the PR. **Text you meant to publish and didn't is the same defect as text you published by mistake**, and only reading the published artefact finds either.
- **`git stash` is FORBIDDEN when multiple worktrees are active** (incident 2026-08-28): `refs/stash` is ONE ref shared across every worktree, so concurrent stash/pop races apply a SIBLING agent's content into your tree. Park WIP by committing to your branch (amend/fixup later) or writing a diff file. **A parking commit can be REFUSED by the pre-commit hook** — mid-edit code often fails lint, which is exactly when you most need to park (incident 2026-08-28: a seat died with 10 files loose and the hook rejected the rescue commit). `--no-verify` is still forbidden; the diff file is the fallback that actually holds, written OUTSIDE the worktree where no `git reset` reaches it. **Delete or refresh a parking diff the moment the work lands in a commit** — a stale patch that a later reader applies over newer committed work is worse than no patch. The real prevention is committing early and often, since only a hook-passing commit parks durably. If you must touch an existing stash, address entries by SHA (`git stash list --format="%H %gd %s"`), never by index alone.

## A green test is a claim, and three different lies wore that colour on 2026-08-28

All three were green, all three read as coverage, none was caught by review. They fail differently, so they need different answers — do not collapse them into "write better tests".

1. **The test that cannot fail.** Asserts something tautological, or mounts a surface that never exercises the path. Answer: a **positive control** — break the code, watch the test redden, restore. `MemoryBridge` never parsing input hid a whole class of wire violations this way.
2. **The test that can fail but was never pointed at the breaking case.** A control proves the test *can* fail; it does not prove it asks the right question. #598's e2e was control-proven and still could not see a wrong-repo capture, because every fixture was single-repo. Answer: a **fixture that contains the shape**, not a better assertion.
3. **The test whose name is not what it tests.** A traversal test that never sent an escape (`fetch` normalised `%2e%2e` client-side, so the guard was never reached), and `"blocks review setup with a friendly install path"` — which asserted that a first-run trap worked, and read as a courtesy. Answer: **execute the thing**. Both were found by driving the real app, neither by reading.

**A control proves a test *can* fail. Nothing proves it fails for the reason written above it.** The reason is what the next reader inherits, and it is the part no suite checks. Worked example (#574): a traversal test's name claimed it refused an escape; it never reached the guard, because `new URL()` resolves `%2e%2e` per the URL spec and `path.normalize` collapses a leading `..` off an absolute path — the request is always inside the root by the time it resolves, and the 404 came from a missing file. The fix ran the request raw over `node:http` so the daemon saw the dot segments, proved the assertion load-bearing by deleting the check and watching a 200 — **and then wrote a comment saying the guard was now exercised. It still wasn't.** True assertion, invented explanation, green bar covering for both. So: executing the path is not executing the sentence. A comment claiming a specific code path is exercised is a claim about control flow, and **control-flow claims get executed, not reasoned.** If you cannot execute it, write down what the assertion cannot catch instead — an absence assertion that passes vacuously is worth naming as such.

**The fix for a bad test is where the next bad test comes from.** Twice on 2026-08-28: a traversal test that never reached its guard was "fixed" with a version carrying the identical normalisation lie, and a commit repairing a test whose name lied introduced an assertion that *could not fail* (`toContain("--draft")`, satisfied by the very next assertion's string). You write the fix believing you now understand the thing, and that belief does the same work the misleading name did. **Control the fix as hard as you would control the original** — and prefer an assertion about position or sequence over membership, since a set of `toContain` checks is satisfied by a workflow that does the right steps in the wrong order.

The third is the hardest, because the name is doing the reviewer's thinking for them. When a test's title describes an outcome you would want, check that the body produces it — especially when the title sounds reassuring. A test asserting a restriction holds will read as safety while it pins a bug.

## A workspace maps MANY repos to ONE identity, and the mapping is not invertible

Four separate defects on 2026-08-28, found one at a time, were all this one rule going unowned: session resolve matching on project id alone, New Chat row-hiding matching on branch alone, the round dispatch picking between two unstamped sessions **by store order**, and branch capture sending `project.openPath` — documented in `wire.ts` as *"the repo, or the first included repo"* — for a row belonging to any included repo.

The shape is always the same and it is always silent: two repos in one workspace both have `main`, and the code picks whichever the mapping happened to yield. Nothing errors. You get the wrong repository's content under the right repository's label.

**So: every path that turns a project into a repo must answer *which* repo, from the row/target/claim that named it — never from the project.** `Project.openPath` and `Project.id` identify a project, not a repository. When you need a repo, carry its identity (`owner/name` from the row, or the stamped `repositoryRoot`) and resolve it server-side.

Two rules that follow, both learned the expensive way:

- **Match on a positive contradiction, never on silence.** Excluding when either side simply does not know a repository re-breaks the sessions that predate the field. `session-entry.ts` carries the canonical form; copy its asymmetry rather than inventing a stricter one.
- **Fixtures decide whether you can see this at all.** A single-repo fixture makes every one of these bugs invisible while the tests pass honestly — #598's E2E was control-proven, and still could not see it. A control proves a test *can* fail; it does not prove the test asks the right question. Any test touching project→repo resolution needs a two-repo workspace sharing a branch name.

## Worktree lifecycle & cleanup (MANDATORY after merge)

Each agent works in its own worktree, and a worktree can spawn a persistent Nx daemon + `nx-mcp` server. **These processes SURVIVE `git worktree remove`** — the daemon keeps running rooted in the removed directory. Left uncleaned they accumulate fast: one day of ~16 build worktrees left ~128 stale node processes holding **~7.8 GB of swap** and pushed the 16 GB host into memory pressure. The default artifact cache and full-reset workspace cleanup can reach the main worktree, so cleanup must stay daemon-only and remove the lane-local cache explicitly. Cleanup is mandatory, not optional.

**When your PR MERGES (you are the merging agent):**
1. After every Nx process in this worktree exits, stop only its daemon and clear its lane-local cache: `sh -c 'cd <your-worktree> && pnpm nx reset --onlyDaemon && rm -rf .nx-isolated'`. Do **not** set `NX_DAEMON=false` on this reset: that disables the daemon client and skips the daemon stop. Never run bare `pnpm nx reset` from a worktree: its full reset can clear the main checkout's artifact cache and workspace data. `--onlyDaemon` leaves the cache alone; the explicit `rm -rf .nx-isolated` removes only this lane's cache.
2. `cd` OUT of your worktree first (git refuses to remove a worktree you are standing in), then remove it: `sh -c 'cd <main-rennet-checkout> && git worktree remove <your-worktree> --force'`. If it fails with the "main is checked out in a sibling worktree" quirk, the remote merge still completed — just ensure step 1 ran and state the worktree path in your report so the orchestrator prunes it.

**When your PR is SUBMITTED but not yet merged:** KEEP the worktree (the review teammate needs it for fixes). Once every Nx process in that worktree exits, you may run the same daemon-only reset and lane-local cache cleanup to drop the idle daemon; keep the worktree and its source files.

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
