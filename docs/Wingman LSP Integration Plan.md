---
tags: [rennet, lsp, plans]
categories: [project]
status: active
created: 2026-08-04
updated: 2026-08-05
---

# Rennet LSP Integration Plan

> Rule Zero (`AGENTS.md`) outranks this file: no consent gates, no gates, no robustness for robustness' sake. The accuracy gates here are a different thing and they stand — L6's degraded-result detector, L7's health checks, L8's lockfile check, L12's no-diagnostics call, L13's definitions-are-not-coverage rule, and L16's refusal set all exist because the alternative is a confident wrong answer.

> [!IMPORTANT] Current implementation authority, 2026-08-05
> Build **Rennet** under [[Rennet Contracts and Rulings]] and [[Rennet Architecture Contracts]]. Persistent project context belongs in the repo's `.rennet/`; temporary staging and materialisations belong in Rennet's application cache, and get cleaned up rather than left as orphans. The measured `git worktree add --detach` mechanism below is the shipping mechanism.

Code intelligence for [[Code Review Harness App]] (name decided: Rennet). Ratified by Rai 2026-08-04 late evening as **essential**: "being able to view the definition of any symbol in a diff."

Sits under [[Wingman Architecture Plan]] and adopts its decisions unchanged (four nouns, ports in `core`, utility-process model, event store, D-numbering). This document adds `L`-numbered decisions so nothing collides. Read [[Wingman GitHub Integration Plan]] for where changesets come from, and the "Glass, ratified" section of [[Code Review App Design Directions]] for the material rules the UI here must obey.

---

## Feasibility verdict

**Feasible, cheap, and verified end to end on Rai's own hardware against a real 2,071-file monorepo. The engineering risk is not "can it work" — it is "can it tell you when it is lying".**

The three things that could have killed it did not:

| Feared blocker | Measured reality |
|---|---|
| Materializing a reviewed ref is expensive | `git worktree add --detach` on product-repo: **0.32 s, 33 MB**, object store shared, 292 KB added to the repo's `.git` |
| The ephemeral checkout breaks the four-noun model | `--git-common-dir` from inside it resolves to **the same `RepoId` as the primary**. It *is* a WORKTREE of the same REPO. Zero model change |
| LSP needs installed dependencies, so PR review is hopeless | Same-repo and workspace-aliased definitions resolve with **no `node_modules` at all**; full cross-module resolution is restored by **symlinking the primary worktree's `node_modules`**, gated on lockfile equality. Zero install, zero network |

Warm query latency measured at **2–42 ms**. Cold time-to-first-correct-definition on the monorepo: **2,287 ms**.

The real hazard is a different shape entirely, and it is the reason this document is long:

> **Every failure mode of this feature returns a plausible, non-null, wrong answer.** Missing dependencies, an unloaded project, a failed NuGet restore, and a wrong URI scheme all produce a definition result that looks like success. None of them error.

A review tool that renders those answers is worse than one with no code intelligence, because it teaches the reviewer to trust a jump that silently points at nothing. The tier model below exists to make that impossible, and the degraded-result detector (L6) is the single most important piece of code in the feature.

---

## How this was verified

Same evidence rule as the GitHub plan. Every claim is marked:

- **[measured]** — I ran it on this machine on 2026-08-04 against `/workspace/product-repo` (2,071 files, 105 MB `.git`) with a hand-written raw JSON-RPC LSP client. Probe scripts: `scratchpad/lsp-probe.mjs`, `lsp-overlay-probe.mjs`, `lsp-coldstart.mjs`.
- **[replicated]** — an independent research agent reached the same result on separate fixtures, on a different server implementation.
- **[cited]** — primary source (repo, docs page, issue) fetched 2026-08-04; the citation appendices live in the session scratchpad.
- **[unverified]** — stated as such, listed again in Open questions.

Nothing was written to the product-repo working tree. The one worktree created for measurement was removed and pruned; `git worktree list` and `git status` were re-checked afterwards and show no residue.

### Calibration note, mine, and it is the lesson

My first cold-start instrument reported **120 consecutive failures** — an apparently clean, apparently damning negative. The server was fine. My assertion was `uri.includes('@types/react')` and the URI arrives **percent-encoded** as `%40types/react`. The check could not pass. I only caught it because a single-shot probe with a different assertion had already succeeded, which contradicted it.

An empty result that flatters what you already suspect is the highest-risk output available. The correct number, once the locator was fixed, was 2,287 ms. Both the broken instrument and the fix are recorded here because the same class of error is what this whole feature must defend the *user* against.

---

## 1. Decisions

### L1 — Materialize reviewed refs as a detached worktree

Two findings carry this decision: **a complete filesystem materialisation is required**, because virtual URI schemes are verifiably dead upstream; and **a sparse or partial checkout is forbidden**, because a partial tree returns the degraded self-reference and that is indistinguishable from success. `git worktree add --detach` is measured at 0.32 s / 33 MB / 292 KB of `.git` admin data, and it is what `MaterializationPort` implements.

Language servers read files. There is no supported path around that, and the industry has already tried and failed to find one:

- **[cited]** LSP issue microsoft/language-server-protocol#1264 (dbaeumer, opened 2021-05-10, **still open**): "Currently servers are restricted to read files from their local file systems." VS Code's own virtual-workspaces guide points at it as the tracking item.
- **[cited]** VS Code's TypeScript extension hard-blocks virtual schemes: `fileSchemes.ts` carries `disabledSchemes = Set([git, vsls, github, azurerepos, chatEditingTextModel])`, and `toTsFilePath` drops the request client-side. `vscode-go` carries the inline comment "gopls handles only file URIs." The ESLint client's document selector is `[{scheme:'file'},{scheme:'untitled'}]`.
- **[cited]** Microsoft tied go-to-definition to checkout from the first release of its PR extension (2018-09-10 blog, verbatim: "Validate PRs from the editor with a new local checkout and run workflow for rich language features such as Go To Definition and IntelliSense"). RMacfarlane on vscode-pull-request-github#1473: "code navigation only works if you have already checked out the pull request." JetBrains says the same thing in its own docs.
- **[cited]** LSIF's stated goal is the industry's admission that the live path does not exist: "support rich code navigation ... without needing a local copy of the source code."

**[measured]** I confirmed the block directly rather than taking it on authority. Opening a document under a custom `rennet-git://` scheme and requesting a definition returned the self-referential degraded answer, while the identical request over a `file://` URI in the same session resolved correctly.

So: **a complete filesystem materialisation is the mechanism**, and the detached-worktree measurement proves it fits the latency budget.

**[measured]** on product-repo at `<private-ref>`:

```
git worktree add --detach <path> <sha>      real 0.32s
materialized tree                            33 MB / 2,071 files
admin dir added to the repo's .git           292 KB
.git in the worktree                         a FILE containing "gitdir: <primary>/.git/worktrees/<name>"
--git-common-dir from inside                 /workspace/product-repo/.git   (identical to primary)
--show-toplevel from inside                  the ephemeral path
appears in `git worktree list --porcelain`   yes, as "detached"
node_modules present                         NO (gitignored, so not tracked, so not materialized)
```

The `--git-common-dir` row is the important one. **The ephemeral worktree is a WORKTREE of the same REPO** under the model already validated in the architecture plan §0.3. Review state, which keys on `RepoId` + changeset, is unaffected. Nothing about the four nouns changes; one new boolean does.

**Rejected — virtual filesystem / custom URI scheme.** Verified dead above, and blocked upstream deliberately rather than accidentally: alexdima, 2017, in the VS Code issue that set the policy — "semantic language features should always be accurate. My motivation is trust related." The only working community patch (VS Code #324356, open 2026-07-05, unmerged) does not teach servers to answer over a virtual ref; it *unwraps the git URI back to the real path on disk*. Even the fix is a checkout.

**Rejected — sparse checkout of only the changed files.** Tempting on disk cost, catastrophic on correctness: a language server given a partial tree resolves what it can and returns the degraded self-reference for the rest, which is exactly the indistinguishable-from-success failure this design exists to prevent. Never ship a materialization that is silently incomplete.

**Housekeeping:** materialisations are namespaced, refcounted, disk-budgeted, and cleaned up on launch and quit, so Rennet does not leave orphans in the user's `git worktree list`.

### L2 — Two immutable materializations, one per side. FROZEN

The old side of a hunk is at the base ref; the new side is at the head ref. They are different trees.

**Decision: materialize both as separate cache-owned trees with separate server instances.** The detached-worktree measurement shows that honesty is within the latency and disk budget.

**[measured] The tempting alternative is a trap, and I verified it is a trap.** A language server *does* honour `didOpen` text that differs from what is on disk — I prepended two lines to a file's in-memory content and the definition at the shifted position resolved correctly while the original position resolved to what now occupied it. **[replicated]** on both tsserver 6.0.3 and typescript-go 7.0.2, and the spec mandates it: "The document's content is now managed by the client and the server must not try to read the document's content using the document's Uri."

So one could serve base-ref content as an overlay onto a head-ref tree. **Do not, as the primary mechanism.** The overlay covers only the files you open. Every *other* file in the project — every definition target — still reflects the head tree. A base-side query would resolve into head-ref code and return a confident wrong location. This is precisely the drift that caused the `vscode-go` revert ("Adding file schema back as per discussions in Microsoft/vscode#34034").

The overlay is retained for exactly two legitimate uses, both anchored to a tree that already matches:

1. **A captured local patchset.** The live working tree is never the analysis input after capture. Local edits create a new immutable draft patchset; affected definition bands and analyses become invalid or potentially invalid until refreshed against the new snapshot.
2. **Small-drift acceleration** on a tree we materialized ourselves, where the overlay is the *same ref* and the anchor is correct by construction.

**Rule: never overlay onto a tree we did not materialize at that exact ref.**

**Base side, Tier 0 only, needs no materialization at all.** `git cat-file` / `git show <ref>:<path>` yields the bytes, tree-sitter parses one file without a project, and the index tier answers. Materializing the base is required only when the user asks a Tier 1 question on the left-hand side. Materialize it lazily, on that first request.

### L3 — Three tiers, labelled on every single answer. FROZEN

The product cannot promise compiler-accurate navigation on every repo, because that promise depends on a toolchain that may be absent. So it promises something achievable instead: **an answer always, and the truth about where the answer came from.**

| Tier | Mechanism | Needs | Answers | Label shown |
|---|---|---|---|---|
| **0 — Index** | tree-sitter tags over the repo at the reviewed ref | nothing. A grammar, which we already ship | "3 definitions named `applyRefund` in this repo", ranked | *"3 candidates · index"* |
| **1 — LSP** | a real language server against the materialized worktree | toolchain present **and** deps healthy | the definition, the type, the references | *"TypeScript 7.0.2"* |
| **1-degraded** | server answered, health gate failed or result was self-referential | — | falls back to Tier 0 results, marked | *"deps not installed · showing index results"* |

Tier 0 is not a consolation prize. It is what makes the feature have **no empty state and no spinner-only state**: during the 2.3 s a server takes to load a project, and forever in a repo whose toolchain is absent, the reader still gets somewhere to go. It also reuses machinery already committed to: `web-tree-sitter` is in the pipeline for `enclosingSymbolPath` (architecture plan B13), and the standard `tags.scm` queries that ctags-style tools use are the same grammars.

This is, for the record, exactly what Phabricator shipped in 2012 — **[cited]** `diffusion_symbols.diviner`, verbatim: "jump to symbol definitions from Differential code reviews and Diffusion code browsing by ctrl-clicking (cmd-click on Mac) symbols," backed by Exuberant Ctags on a cron. Click-to-definition in a review diff is a fourteen-year-old idea. Tier 0 is that idea, done with grammars instead of regexes. Tier 1 is the part that was never affordable until the tool lived on the reviewer's own machine.

### L4 — Detect toolchains; never block a keystroke on an install. FROZEN

Rennet spawns a language server it finds, and may install one, restore packages, or download a server binary — into its own cache, in the background. What it must never do is make the reviewer wait: `gd` must feel instant or the feature goes unused. Serve Tier 0 immediately, install behind it, and upgrade the answer when the server is ready.

One fact to route around: **[cited]** Roslyn's language server **auto-restores by default** and **writes `obj/` into the tree it analyses**. Restore into a cache-owned tree, because a stray `obj/` in the user's working tree is untidy. Mutation policy is L5.

Detection ladder per language: user-configured path (the settings workstream owns storage) → repo-local (`node_modules/.bin`) → `PATH` → known install locations. Absent at every rung: Tier 0, plus **one** non-modal line offering the install command as copyable text. Never a nag, never a spinner over an empty screen.

Licensing note: every candidate server is spawned as a **child process**, never linked. `typescript-go` Apache-2.0, `typescript-language-server` Apache-2.0, `vtsls` MIT, `Microsoft.CodeAnalysis.LanguageServer` MIT (**[cited]** verified from the `.nuspec` inside the actual nupkg). Rennet itself is MIT throughout.

### L5 — Mutation policy: prefer cache-owned trees. FROZEN

A language server may need to write (caches, `obj/`, generated types). Split by ownership:

- **Inside a Rennet application-cache materialisation:** writes permitted within an enforced sandbox. It is ours and disposable; generated caches never enter `.rennet/` or the source checkout.
- **Against the user's own working tree:** possible, but not the default. Any restore or build that Tier 1 needs runs inside a Rennet-owned cache materialisation, because that tree is disposable and the user's is not. **[cited]** For Roslyn specifically, the setting that stops it restoring in place is `EnableAutomaticRestore`.
- **Corollary (L14):** materialized worktrees handed to an *editor* are chmod'd read-only, which is a different concern in the opposite direction. The server writes before the read-only flip, or the flip is scoped. Interaction flagged as a spike.

### L6 — The degraded-result detector. FROZEN, and it is the load-bearing one

**[measured]** Without `node_modules`, asking for the definition of `lazy` in `import { lazy } from 'react'` returned:

```
requested:  root.tsx  line 4, char 9
returned:   root.tsx  line 4, chars 9–13     ← the import clause. Itself.
hover:      "import lazy"                     ← no signature, no error
```

Not null. Not an error. A single confident Location pointing at the identifier you clicked. **[replicated]** by an independent agent on both tsserver 6.0.3 and typescript-go 7.0.2, so this is compiler behaviour, not a wrapper quirk.

**[measured]** and worse: the *same shape* appears when everything is installed and correct but the project has not finished loading. At 271 ms and 1,275 ms after `didOpen`, with dependencies present, the answer was the identical self-reference; the correct answer arrived at 2,287 ms.

> **The self-referential result cannot distinguish "dependencies missing" from "not ready yet".** Both are indistinguishable from each other and from a genuine answer, by shape alone.

Therefore:

```
isDegraded(request, result):
    result is null or empty                      -> unresolved
    result has exactly one target
      AND target.uri === request.uri
      AND target range intersects the import
          clause enclosing request.position      -> DEGRADED
```

and, because the shape is ambiguous, **the disambiguation must be out of band**:

1. **Readiness by positive control, not by timeout.** On server start, pick a symbol in the opened file whose definition is *known* from the Tier 0 index to be in a different file, and probe it. Do not serve Tier 1 answers until that probe resolves to the expected file. A readiness check that cannot fail has not passed; this one fails on a broken server, a wrong project root, and a mid-load race alike. For Roslyn there is a real signal to use instead — **[cited]** `workspace/projectInitializationComplete`, after a required `solution/open` or `project/open`.
2. **Dependency health, checked independently of any query result** (L7).

Until both clear: serve Tier 0, labelled, with no spinner.

### L7 — Per-language health gates. FROZEN

"The server is running" is not "the server is right". **[cited]** Roslyn with a failed restore emits false-positive `CS0246`/`CS0103` on package-backed symbols that are *lexically indistinguishable* from real errors — proven by planting four false and one true error and getting five identical-looking diagnostics; the positive control with a cacheable package returned exactly one. Local symbols keep resolving perfectly the whole time. A partial-degraded mode that looks like a clean bill of health.

| Language | Gate | Fails how |
|---|---|---|
| TypeScript | a `tsconfig.json` above the file, **and** a resolvable `node_modules` for its imports | silent self-reference (L6) |
| C# | `obj/project.assets.json` **exists**, its `logs[]` is free of `NU*` entries, and `targets` is non-empty | false-positive CS0246/CS0103; package symbols return empty while local ones resolve |

Never suppress those diagnostic codes heuristically — check the assets file. And this is a second reason diagnostics stay out of scope (L12): in a product where the false-positive budget is CORE, a diagnostic stream that lies under exactly the conditions a review tool operates in is a liability, not a feature.

### L8 — Reuse the primary worktree's installed dependencies, gated on lockfile identity. ADJUSTABLE

This is the finding that makes Tier 1 practical for PR review rather than theoretical.

**[measured]**, same worktree, one symlink apart:

| | no `node_modules` | `node_modules` symlinked from the primary checkout |
|---|---|---|
| `./api/queryClient` (relative) | resolved, `queryClient.ts:50` | resolved, identical |
| `@ej/shared-core` (tsconfig `paths`) | resolved, `libs/shared-core/src/auth/useAuth.ts:11` | resolved, identical |
| `react` (node_modules) | **self-reference (degraded)** | resolved, `@types/react/index.d.ts:1808` |
| hover on `useAuth` | `isAuthenticated: any` | `isAuthenticated: boolean`, `login: () => void` |
| diagnostics | 4 × "Cannot find module" | clean |

Note the hover row: without dependencies the types are not merely absent, they are **wrong** — `any` where the truth is `boolean`, presented with the same confidence. That row alone justifies the tier label appearing on hover as well as on definition.

Cost of the symlink: one `symlink(2)`, zero bytes, zero seconds.

**The gate is exact and non-negotiable:** the lockfile at the reviewed ref must be byte-identical to the lockfile the donor tree was installed from. Compare `git rev-parse <ref>:package-lock.json` against the donor's on-disk hash. **[measured]** both were `acfe5b02…` in my test, which is why it was legal. If the PR touches the lockfile — which is exactly when a reviewer most wants accurate cross-module navigation — the gate fails and Tier 1 degrades to same-repo resolution with the label saying so.

Generalizes beyond TS (`obj/` for .NET, `vendor/` for Go) but v1 ships the TypeScript case only. Marked ADJUSTABLE because the donor-selection policy (which worktree, what if several) is a heuristic, not a principle.

### L9 — Server choice for v1. ADJUSTABLE (the ladder is frozen; the rungs are not)

**TypeScript, in order:**

1. **`tsc --lsp --stdio` from TypeScript 7** (the native Go port, shipped 2026-07-08) when the repo's own TypeScript is 7.x. Single binary, no Node, Apache-2.0, advertises `positionEncoding: utf-16` explicitly. **[cited]** measured at **54–74 MB peak tree RSS versus tsserver's 596–627 MB** — roughly 10×, which for a tool spawning two servers per review (base and head) is the difference between comfortable and rude.
2. **`typescript-language-server`** for TS ≤ 6 repos. Apache-2.0. This is what all of my own measurements ran against.
3. **`vtsls`** as second fallback, MIT, self-contained.

**The TS7 trap, and it must be coded around explicitly: **[cited]** `typescript@7` ships no `lib/tsserver.js`. `typescript-language-server` finds the workspace TypeScript 7, deems it invalid, and **silently falls back to its own bundled 6.0.3 with no client warning** — analysing a TS7 repo with a different compiler major. Detect the repo's TypeScript version first and choose the rung from it; never let rung 2 handle a TS7 repo.

**C#: `Microsoft.CodeAnalysis.LanguageServer`** (Roslyn LS), MIT, from the azure-public **vs-impl** feed — **[cited]** *not* nuget.org, which carries one ~14-month-stale build, and never the dead no-RID package id that stopped at 4.8.0. `--stdio` is first class, but **[cited]** in the shipped 5.4.0 both `--logLevel` and `--extensionLogDirectory` are **required** flags (`main` has drifted and made them optional — code against the shipped build). Requires a .NET 10 runtime present.

**C# Tier 1 is LATER, not v1.** It carries the custom `solution/open` handshake, the `projectInitializationComplete` wait, pull-model diagnostics, the assets-file gate, the auto-restore mutation policy, and a runtime prerequisite. Each is tractable; together they are a second project. Rai's C# work gets Tier 0 in v1, which is honest and immediately useful, and Tier 1 lands once the TypeScript path has proved the architecture.

OmniSharp is **[cited]** maintained but demoted (last release 2025-11, no deprecation notice), does not auto-restore, and sits silently degraded headless. `csharp-ls` is alive and MIT but its restore behaviour is untested. Neither displaces Roslyn LS.

### L10 — Servers run in one `lsp-host` utility process. FROZEN

Placement follows the architecture plan's D12 exactly, with one addition to the process table:

- **renderer** — never. D11 stands: the renderer holds no domain logic, and a language server is an unbounded-memory long-lived subprocess.
- **main** — never. It must not block, and a project load is seconds.
- **engine** — no. A wedged server, a 600 MB tsserver, or a multi-megabyte `references` response must not be able to jank or kill the process that owns the SQLite event store. Same isolation argument that put harnesses in their own processes.
- **`lsp-host` (one `utilityProcess`)** — owns *all* language-server child processes, the JSON-RPC framing, `didOpen` bookkeeping, and the readiness probes. One process rather than one per server: crash isolation from the engine is what matters, and Electron processes are not free.

Lifecycle key: **`(RepoId, refOid, languageId)`** — never a path, consistent with the four nouns. Many PRs share a base OID, so base-side servers are shared across reviews for free.

- **Spawn** lazily on the first Tier 1 query for that language in that review. Prewarming on review open is a setting, default off, because it costs a server per opened PR.
- **Idle shutdown: ours to build.** **[cited]** `typescript-language-server` has no idle-shutdown option (calibrated grep). Track last-request time, then `shutdown` (request) → `exit` (notification) → SIGTERM at 2 s → SIGKILL at 5 s. Default idle 5 minutes.
- **Budget:** max concurrent servers (default 4, LRU evict); per-server RSS ceiling, above which the server is killed and the language demoted to Tier 0 **with a visible notice** — never a silent downgrade. Budget ~2× per tsserver instance: **[cited]** it runs two processes (semantic + partial-semantic syntax server) plus the wrapper. `initializationOptions.maxTsServerMemory` is real but caps V8 old-space per child, not tree RSS.
- **Crash:** demote to Tier 0, one retry with backoff, never a crash loop.

Client transport: **write it, ~60 lines of `Content-Length` framing**, per the stack note's write-it-not-install-it posture — my probe scripts are already that client, and they work. `vscode-jsonrpc` + `vscode-languageserver-protocol` are **[cited]** MIT, contain zero VS Code imports, and work in bare Node via the `vscode-languageserver-protocol/node` subpath; take them only for the typed protocol constants, never `vscode-languageclient`.

### L11 — The protocol surface is tiny. FROZEN

| Message | Direction | Why |
|---|---|---|
| `initialize` / `initialized` | → | once, first. Advertise `general.positionEncodings: ['utf-16']` and `textDocument.definition.linkSupport: true` |
| `textDocument/didOpen` / `didClose` | → | required. **Max one open per URI**; balance every open with a close |
| `textDocument/didChange` | → | working-tree source only (L2) |
| `textDocument/definition` | ↔ | the feature |
| `textDocument/typeDefinition` | ↔ | free, same shape |
| `textDocument/hover` | ↔ | free, same server, same position |
| `textDocument/references` | ↔ | guarded by a hard result cap |
| `shutdown` / `exit` | → | L10 teardown |
| `workspace/configuration`, `client/registerCapability` | ← | **must be answered or the server stalls.** [measured] answering `null` is sufficient |
| `solution/open` + `workspace/projectInitializationComplete` | ↔ | Roslyn only, required, non-standard |

Result-shape hygiene, all **[cited]** and one **[measured]**:

- The definition result is a **union**: `Location | Location[] | LocationLink[] | null`. `LocationLink` is opt-in via `linkSupport` (3.14). TS-family servers return `LocationLink[]` when asked; **Roslyn returns Location-shaped**. Handle the whole union or the C# tier breaks on arrival.
- `references` returns plain `Location[]` and needs `context.includeDeclaration`.
- **Position encoding:** the client capability is plural (`general.positionEncodings`), the server echoes singular (`positionEncoding`), and an omitted value means UTF-16. `tsgo` advertises it; `tls`, `vtsls`, and Roslyn omit it. JS strings are natively UTF-16 so string indices align — but **git blob byte offsets do not**, on any astral-plane character. Convert through UTF-16 code units, never bytes, never codepoints. This is the same hazard the Codex critique already flagged for `textRange` byte offsets into JS strings; it is the same bug wearing a different hat.

Deliberately **not** implemented: completion, formatting, code actions, rename, semantic tokens (Pierre/Shiki already highlights), and diagnostics (L12).

### L12 — No diagnostics. FROZEN for v1

Tempting ("this PR doesn't compile") and wrong for now. **[cited]** Roslyn's false positives under a failed restore are indistinguishable from real errors; TypeScript without `node_modules` produces a wall of "Cannot find module" that says nothing about the change. In a product where the false-positive budget is promoted to CORE by its own validation research, a diagnostic stream whose accuracy depends on conditions the tool cannot guarantee is the fastest available way to lose the reviewer's trust. Revisit only behind a health gate strong enough to suppress the whole stream when it fails.

### L13 — Definitions are context, never coverage. FROZEN

An inline definition is unchanged code from somewhere else in the repo. It is not part of the changeset, so:

- it has **no `hunkVersionId`**,
- it emits **no `hunk.read`**,
- it raises and discharges **no obligations**,
- it can never move the coverage mosaic or the residue check.

Reading a definition is not reviewing. Conflating them would let a reviewer reach "done" by reading code that is not in the change, which is a correctness failure in the direction of false confidence — the direction the architecture plan already names as the worst available.

But it *is* recorded, as private-by-construction data: a new `context.definitionOpened` event with `private: true`, which rides D9's structural publish exclusion for free and gives the decisions angle real material for its reconstructed WHY ("you looked at `applyRefund` three times while reading this chunk").

**The one exception that matters, and it is a feature.** A definition target very often *is* in the changeset — the PR changes the function and its call sites. When the target `(path, line)` at head falls inside a known `HunkVersion`, the band says so and offers a jump. That jump lands on a real reviewable hunk, and reading it there counts normally. Cheap to compute, and it turns a navigation aid into a structural insight: *"the thing you went looking for is also part of this change."*

### L14 — Open-in-editor discloses which physical copy it opens. FROZEN

An affordance above every file header and every hunk, opening the user's editor at the exact line. The mechanics are easy; the ref question is the sharp part.

**Three copies exist, and they are not interchangeable:**

| Copy | When | Label the affordance must show |
|---|---|---|
| **User's own worktree** | the reviewed head ref is checked out in one of their worktrees | *"Open in VS Code"* — no qualifier needed |
| **Ephemeral materialized worktree** | the reviewed ref exists nowhere else on disk | *"Open read-only copy at `<private-ref>`"* |
| **Working tree, divergent** | a worktree has the file but its content differs from the reviewed ref | *"Open your checkout — 3 commits ahead of the reviewed head"* |

The third is the most dangerous because it silently succeeds and shows different code. The second is a data-loss footgun: the user edits a file inside a directory Rennet will delete. Both are handled by **stating it in the affordance before the click, not in a dialog after it**, which is the same discipline as the publish sheet's degradation ledger — the ceremony must not lie about what it did.

Additional guards on the ephemeral case:

- **`chmod -w` the materialized checkout** so an edit fails loudly instead of evaporating. Servers only read, so this should be safe; marked as a spike because it is untested and could break a server that writes a cache.
- **An open editor holds a reference.** Eviction may not remove a materialization an editor is known to have open.
- **The eventual real fix is `promoteToWorktree`:** an explicit act that converts the ephemeral worktree into a named, writable, branch-attached worktree of the same repo. This is elegant precisely because the four-noun model already says it *was* a worktree of that repo — promotion is a rename and an attach, not a copy. It is also exactly Rai's existing `wt/` workflow. LATER, but it is the answer.

**Deep-link mechanics**, per editor:

| Editor | URL form | CLI form |
|---|---|---|
| VS Code | `vscode://file/<abs-path>:<line>:<col>` | `code -g <path>:<line>:<col>` |
| VS Code Insiders | `vscode-insiders://file/…` | `code-insiders -g …` |
| Cursor | `cursor://file/<abs>:<line>:<col>` | `cursor -g …` |
| Zed | `zed://file/<abs>:<line>:<col>` | `zed <path>:<line>:<col>` |
| JetBrains (IDEA/Rider/WebStorm) | `jetbrains://idea/navigate/reference?project=<name>&path=<path>:<line>` — needs a project *name*, which we often do not have | `idea --line <n> <path>` (Toolbox-generated launcher). **Prefer the CLI form.** |
| Sublime | — | `subl <path>:<line>:<col>` |
| Windsurf | `windsurf://file/…` **[unverified]** | — |
| Anything else | — | a user command template with `{path} {line} {col}` |

Rules, both non-negotiable:

1. **`shell: false`, always.** Same rule as `GitPort` §0.4. Spawn a resolved absolute binary with an argv array. A path arriving from a PR can be named anything a contributor likes; with argv it is inert, with a shell string it is an execution primitive.
2. **Percent-encode the path in URL form and allowlist the scheme** before `shell.openExternal`. Never pass an unvalidated scheme.

**Detection** (zero-config North Star): known bundle identifiers under `/Applications` plus known CLI names on `PATH`; offer only what exists. Configuration and persistence belong to the settings workstream — this plan owns only the launch mechanics and the copy-disclosure rule.

### L15 — Inline definition chunks, below the line, opaque. FROZEN (below), ADJUSTABLE (dock variant)

Rai's steer: bring the source **into the current window as a chunk below or alongside the diff line** — inline expansion within the reading flow, not a modal peek.

**Recommendation: below the line, as an inset band.** Evaluated honestly against alongside:

*Why below wins.*
- It preserves reading order. The review is a document read top to bottom; a definition is a footnote, and footnotes go below.
- It matches vocabulary the surface already has. `@pierre/diffs`' `CodeView` ships `collapsed`, `updateItem`, and `version`, and "expand context in place" is the one gesture every diff viewer already teaches. The definition band is that gesture pointed somewhere else.
- It does not reflow the code column. The fixed-point rule (the hunk under the cursor never moves) survives trivially.

*Why alongside loses, for v1.*
- The right margin is **already occupied** by the ratified ambient-chat system: thread cards, the anchored-line inset, the ask-line, the private card. A definition pane there either evicts the conversation or fights it.
- Two scroll owners on one surface is exactly what D14 forbids.
- It narrows the code column at the moment the reader most wants width — reading unfamiliar code.

*The honest concession:* on a wide display, alongside is genuinely better for comparing a definition against its call site side by side. So the dock is not rejected, it is **sequenced**: ship below-the-line in v1; ship `gD` / `cmd-shift-click` as a docked variant LATER, sharing one dock with the thread panel and preserving its state. Do not build two surfaces in v1.

**Material rules, applied without exception.** Glass is chrome, code is opaque:

- **The definition body is CODE. Fully opaque `--code-bg`.** No translucency, no blur, no aurora through it. Same surface treatment as the diff itself.
- **The band's header strip is chrome, therefore glass**: file path, ref badge (`base 39cc0d1b` / `head <private-ref>`), the **tier badge** (L3), collapse, and the open-in-editor affordance (L14).
- **No add/delete tint.** A definition is unchanged code; it carries neither green nor rust, and that absence is itself the signal that you have left the diff.
- **Inset by the gutter width**, with a hairline in the neutral chrome stroke, so it reads as subordinate to the line that summoned it.
- **No backlight blue.** This is a real judgement call, so it is argued rather than assumed: backlight marks things private *to the reviewer that are state* — coverage, pace, chat, dismissals, the stays-on-this-Mac ledger. A definition is reference material, not state. Giving it the private glow would dilute the one mark whose whole job is to say "this never publishes". The band is neutral; only the `context.definitionOpened` *record* is private, and records have no colour.
- A one-or-two-line hover tip stays chrome and may be glass. Anything scrollable becomes a band and goes opaque. The threshold is "can you read it without moving".

**Sizing.** Show the enclosing symbol's full body up to 40 lines, then a foot offering "show all" and "open in editor". Prefer `LocationLink.targetRange` (the whole node) over `targetSelectionRange` (usually just the identifier) — this is why `linkSupport: true` is in the initialize capabilities. When the server returns a plain `Location`, as Roslyn does, fall back to tree-sitter's enclosing node, which is already in the pipeline. Last resort ±20 lines.

**Keyboard-first**, every one a named remappable command in the B28 registry:

| Key | Action |
|---|---|
| `gd`, `cmd-click` | definition, inline band below |
| `gD`, `cmd-shift-click` | definition, docked (LATER) |
| `K` | hover type, transient tip |
| `gr` | references — a *list*, so it opens as a queue in the right margin, each result expandable into its own band |
| `cmd-[`, `backspace` | pop the breadcrumb |
| `esc` | close the band, return to the diff |

**Breadcrumb and depth.** A band can contain symbols, so it can spawn a band. Allow it, cap the stack at **3**, show the trail (`root.tsx:5 → @types/react:1808 → …`), and at the cap replace "expand" with "open in editor". Beyond three levels the reader is no longer reviewing, and the honest move is to hand them to a real editor.

**Composition with ambient chat.** The band's header carries the same ask affordance as the diff. Asking from inside a band creates a thread whose anchor is **the hunk that prompted the lookup**, not the definition — because the definition is not part of the changeset and therefore cannot be published to GitHub. The definition is quoted into the message as a fenced block. This resolves cleanly and for free: every thread anchors to a reviewable hunk, so every thread remains publishable, and the context travels as quoted text. The doctrine sentence still holds — the conversation has no room of its own.

### L16 — Position mapping is a total function that can refuse. FROZEN

See §3. The key rule: **the mapper returns a result, never throws and never guesses**, and every refusal names its reason. A code-intelligence request built from an unmappable position is the third variety of plausible-wrong-answer and is prevented at the type level rather than at review.

---

## 2. Prior art and the honest differentiation

**Do not open the pitch with "nobody does this."** It is false, and it would fail on first contact with anyone who has looked.

- **Critiq** ($29 one-time, macOS/Windows/Linux, GitHub/GitLab/Bitbucket/Azure) sells this exact thesis as its headline. **[cited]**, byte-exact from raw HTML: *"LSP. In the Diff. That's the Whole Thing."* and *"Review Code Like You Read Code. Hover for types. Jump to definitions. Navigate symbols. In the diff: no tab-switching, no browser."* Out of the box: Go, Rust, C#, Vue, TS, JS, Python, plus Neovim-style mapping of any extension to any LSP binary. **Treat Critiq as the incumbent to differentiate against**, not as a gap.
- **Scrutiny** (macOS) **[cited]**: *"Full Language Server Protocol support for 12+ languages. Jump to definition, find all references, peek implementations."* Whether that runs in the diff or in its repo browser is **[unverified]**.
- **Phabricator/Phorge** shipped ctags-grade cmd-click-to-definition into review diffs in ~2012.
- **Google's Critique** has had Kythe cross-references in the diff for years — the internal gold standard nobody outside Google can buy.
- Confirmed negatives: **hunk.dev** (LSP hover appears only as a hypothetical in `docs/extension-system-exploration.md`), **reviu**, **Stage**, **Graphite**, **Gerrit** core, **Review Board**. **CodeRabbit Code Peek** is search-based ("likely definition" via GitHub code search), not semantic.

So what is actually open. Three things, and they are better than a false claim of emptiness:

**1. The platforms are retreating, and that is structural.** **[cited]** GitHub *unshipped* precise code navigation — docs commit `eac1b74c`, 2024-12-04, titled "Unship precise code navigation"; both roadmap issues closed NOT_PLANNED on 2024-11-20; `github/stack-graphs` archived 2025-09-09. It had only ever covered Python and TypeScript out of 21 languages, and no blog post announced the retreat. GitLab's MR code-intel issue died after four years, and its 2026 Orbit code-navigation panel is blob-header-only again. Sourcegraph's own rule states the cost plainly: an indexer works only "if the source code to index can be compiled successfully," and `scip-typescript` documents `npm install` before indexing.

They all concluded that compiler-accurate navigation **without a build** is too expensive to run for everyone. That conclusion is correct — and it is a statement about *server-side economics*, not about the problem. A local desktop tool gets the checkout and the toolchain for free, on hardware someone else is paying for. **The retreat is the wedge.** The right sentence is not "nobody does this", it is "the platforms tried this and gave it back, because it only works where the code already lives."

**2. Nobody has published the mechanism.** Critiq advertises the outcome and documents none of the how: which ref, which checkout, what happens on the base side, what happens when dependencies are missing, how staleness is handled. Across the entire field the engineering question is undocumented. This plan is the answer to it, which is worth something in a product whose distribution model is an open-source core.

**3. The base side of the diff has no prior art at all.** Every working implementation found — VS Code with the PR checked out, JetBrains after checkout, GitLens, Critiq's "even across branches" — works because *one side is a real tree on disk*. **[cited]** VS Code #321274 (open, 2026-06-13) shows the asymmetry live: unstaged diff right side is `file:` and works, staged is `git:` on both sides and dies. GitLens' maintainer, on the temp-file approach that poisoned language servers: "I don't think GitLens could actually provide it."

Two refs, two worktrees, two server instances, one merged answer with a side-aware position mapper: **no prior art was found for this, anywhere.** L2 is the genuinely novel part of this document.

**Honest negatives carried forward:** whether GitHub's rebuilt 2026 Files-changed UI still has symbol navigation is **[unverified]** — a browser check failed its own positive control and was discarded rather than reported as clean. Reviewable, CodeRabbit's site, and Pulldog are JS shells whose fetches failed calibration; those are *not* verified absences and must not be cited as such.

---

## 3. Position-mapping spec

The bridge between a rendered diff line and an LSP request. It is the place off-by-ones become confident wrong answers, so it is specified as a total function with an explicit refusal set.

### Side determines ref, path, and line source

| Rendered line kind | Side | Ref | Path | Line number source |
|---|---|---|---|---|
| addition (`+`) | head | `headOid` | `RawFileDiff.path` | `RawLine.newLineNumber` |
| deletion (`-`) | base | `baseOid` (**merge-base**, per D5) | `RawFileDiff.prevPath ?? path` | `RawLine.oldLineNumber` |
| context | either — **follow the pane the cursor is in** | as above | as above | as above |
| `\ No newline at end of file` | — | — | — | refuse |

Context lines exist on both sides, so a split view resolves by pane and a unified view resolves by the reviewer's last-used side, defaulting to head. Show the ref badge in the band header so the choice is never ambiguous.

### Character offset

The rendered line's column, in **UTF-16 code units**, computed from the JavaScript string of the line content **after** the diff marker is stripped. Two traps, both already established:

- Do **not** derive the column from `RawLine`'s byte range into the raw patch. Byte offsets and UTF-16 offsets diverge on any astral-plane character, and the architecture plan's own byte-range-into-a-JS-string hazard is the same bug.
- Advertise `general.positionEncodings: ['utf-16']` and honour the server's echoed singular `positionEncoding` if it differs. An omitted value means UTF-16.

### Refusal set — every one of these must return `{ ok: false, reason }`

| Reason | Case |
|---|---|
| `file-added-no-base` | left-side query on a file that did not exist at base |
| `file-deleted-no-head` | right-side query on a deleted file |
| `line-absent-at-ref` | an added line queried on the base side, or vice versa |
| `binary` / `submodule` / `mode-only` | no textual positions exist |
| `diff-truncated` | position lies beyond an ingestion truncation — **fail closed**, per the Codex critique's insistence that incomplete ingestion must never present as full coverage |
| `no-newline-marker` | the `\` pseudo-line |
| `unmappable-rename` | rename detection produced no `prevPath` for a left-side query |

### Renames

`RawFileDiff` already carries `prevPath`, so the base side uses it and the head side uses `path`. The rename-detection threshold is already flagged as an open question in the architecture plan (`--find-renames`, default 50%, unvalidated for LLM-generated PRs); a bad rename decision now degrades navigation as well as identity, which raises its priority slightly.

### Working-tree state

When the changeset source is local, capture the user's current commits, index, worktree, and nonignored untracked files into an immutable draft patchset. The live tree may continue changing, but it is never silently substituted into an existing analysis. Detect edits, create/coalesce a new candidate patchset, and classify definition bands and lens artifacts as current, invalid, or potentially invalid. Preserve stale output until explicit affected-only regeneration succeeds. Base and head Tier 1 queries run against cache-owned materialisations of the captured refs/content.

---

## 4. TS type sketches for the LSP port

Illustrative. Placement follows D1/D2: types and ports in `core` (zero `node:*`), implementations in `adapters`, surfaced through the D11 command map. Nothing here imports a language-server library into `core`.

```ts
// core/types/intel.ts

export type RefOid = string & { readonly __brand: 'RefOid' }
export type DiffSide = 'base' | 'head'

/** A resolved point in a specific tree. Never a path-only address. */
export interface RefPosition {
  repoId: RepoId
  refOid: RefOid
  path: string
  line: number          // 0-based, LSP convention
  character: number     // UTF-16 code units (L11)
}

export type PositionMapFailure =
  | 'file-added-no-base' | 'file-deleted-no-head' | 'line-absent-at-ref'
  | 'binary' | 'submodule' | 'mode-only' | 'diff-truncated'
  | 'no-newline-marker' | 'unmappable-rename'

export type PositionMapResult =
  | { ok: true; position: RefPosition; side: DiffSide; originHunkVersionId: HunkVersionId }
  | { ok: false; reason: PositionMapFailure }
```

```ts
// core/types/intel.ts (continued) — provenance is not optional

export type IntelTier = 'lsp' | 'lsp-degraded' | 'index' | 'none'

export interface DepsHealth {
  kind: 'ts-node-modules' | 'dotnet-assets' | 'none-required'
  ok: boolean
  /** Shown verbatim. e.g. "node_modules linked from primary worktree (lockfile match)" */
  detail: string
}

export interface IntelProvenance {
  tier: IntelTier
  serverId?: string                 // 'typescript-go@7.0.2'
  languageId?: string
  materialization: 'working-tree' | 'user-worktree' | 'ephemeral-worktree' | 'none'
  depsHealth: DepsHealth
  /** One line, always rendered in the band header. The tier badge's text. */
  explanation: string
}

export interface DefinitionTarget {
  path: string
  refOid: RefOid
  /** Whole symbol body: LocationLink.targetRange, else tree-sitter node, else +/-20 lines. */
  bodyRange: { startLine: number; endLine: number }
  /** The identifier itself. */
  selectionRange: { startLine: number; startCharacter: number; endLine: number; endCharacter: number }
  /** Set when this definition is ALSO a hunk of the current changeset (L13). */
  alsoInChangeset?: HunkVersionId
  /** Index tier only. Absent means "exact", present means "ranked guess". */
  confidence?: number
}

export interface DefinitionResult {
  provenance: IntelProvenance
  targets: DefinitionTarget[]
  /** True when the server returned the origin import clause (L6). Never rendered as a target. */
  degradedSelfReference: boolean
}

export interface HoverResult {
  provenance: IntelProvenance
  /** Markdown. Empty when the tier cannot type-check. */
  contents: string
}

export interface ReferencesResult {
  provenance: IntelProvenance
  targets: DefinitionTarget[]
  /** True when the hard cap truncated the list. Never present a capped list as complete. */
  truncated: boolean
}
```

```ts
// core/ports/code-intel.ts

export interface CodeIntelPort {
  /** What tier COULD answer here, computed without asking a server. Drives the badge before the query. */
  capabilitiesFor(pos: RefPosition, o?: PortOpts): Promise<IntelProvenance>
  definition(pos: RefPosition, o?: PortOpts): Promise<DefinitionResult>
  typeDefinition(pos: RefPosition, o?: PortOpts): Promise<DefinitionResult>
  hover(pos: RefPosition, o?: PortOpts): Promise<HoverResult>
  references(pos: RefPosition, o?: PortOpts & { limit: number }): Promise<ReferencesResult>
  /** Body text for the inline band. Always available: git cat-file. Never needs a server. */
  readRange(repoId: RepoId, refOid: RefOid, path: string,
            r: { startLine: number; endLine: number }, o?: PortOpts): Promise<string>
}
```

```ts
// core/ports/materialization.ts

export type MaterializationHandle = string & { readonly __brand: 'MaterializationHandle' }

export interface Materialization {
  handle: MaterializationHandle
  path: string
  /** ALWAYS equal to the primary's RepoId. Verified via --git-common-dir. */
  repoId: RepoId
  refOid: RefOid
  kind: 'working-tree' | 'user-worktree' | 'ephemeral-worktree'
  readOnly: boolean
  depsHealth: DepsHealth
  bytes: number
}

export interface MaterializationPort {
  /** Idempotent per (repoId, refOid). Refcounts. Prefers an existing user worktree at that OID. */
  ensure(repoId: RepoId, refOid: RefOid, o?: PortOpts): Promise<Materialization>
  release(handle: MaterializationHandle): Promise<void>
  /** L8: link a donor tree's installed deps when the lockfile blob matches. */
  linkDependencies(handle: MaterializationHandle): Promise<DepsHealth>
  /** L14's eventual fix: the ephemeral worktree becomes a real named one. */
  promoteToWorktree(handle: MaterializationHandle, dest: string, branch?: string): Promise<Worktree>
  /** Idle + LRU eviction under a disk budget. Never evicts a handle an editor holds. */
  gc(budget: { maxBytes: number; maxIdleMs: number }): Promise<{ removed: number; freedBytes: number }>
  /** Crash recovery. Runs on launch AND on quit. Only touches rennet-namespaced worktrees. */
  pruneOrphans(): Promise<{ pruned: number }>
}
```

```ts
// core/ports/editor.ts

export interface EditorDescriptor {
  id: 'vscode' | 'vscode-insiders' | 'cursor' | 'zed' | 'jetbrains' | 'sublime' | 'custom'
  displayName: string
  launch:
    | { kind: 'url'; template: string }                 // percent-encoded, scheme allowlisted
    | { kind: 'argv'; bin: string; args: string[] }     // spawned with shell:false, ALWAYS
}

/** Which physical copy. Computed and SHOWN before launch (L14). */
export type EditorCopy = 'user-worktree' | 'ephemeral-read-only' | 'working-tree-divergent'

export interface EditorTarget {
  copy: EditorCopy
  absolutePath: string
  line: number
  character: number
  /** Rendered in the affordance label, not in a post-hoc dialog. */
  disclosure: string        // "read-only copy at <private-ref>" | "your checkout, 3 commits ahead"
}

export interface EditorLaunchPort {
  detect(): Promise<EditorDescriptor[]>
  resolveTarget(pos: RefPosition): Promise<EditorTarget>
  open(target: EditorTarget, editor: EditorDescriptor): Promise<void>
}
```

```ts
// core/events — additions. All private:true, so D9's publish exclusion covers them for free.

  | 'context.definitionOpened'   // { originHunkVersionId, tier, targetPath, targetRefOid, depth }
  | 'context.intelDegraded'      // { languageId, reason, depsHealth } — feeds the nudge, never nags
  | 'editor.opened'              // { editorId, copy, path, line }
  | 'materialization.created'    // { repoId, refOid, bytes, ms }   system actor
  | 'materialization.evicted'    // { repoId, refOid, reason }      system actor
```

```ts
// core/protocol — commands added to the D11 map. All cancellable via requestId:
//   a references query on a widely-used symbol is exactly the request a user aborts.

  'intel.capabilities'      // RefPosition            -> IntelProvenance
  'intel.definition'        // RefPosition            -> DefinitionResult
  'intel.hover'             // RefPosition            -> HoverResult
  'intel.references'        // RefPosition + limit    -> ReferencesResult
  'intel.readRange'         // repo/ref/path/range    -> string
  'editor.list'             // {}                     -> EditorDescriptor[]
  'editor.resolveTarget'    // RefPosition            -> EditorTarget
  'editor.open'             // target + editorId      -> {}
  'materialization.status'  // reviewId               -> Materialization[]
  'materialization.promote' // handle + dest + branch -> Worktree
```

---

## 5. v1 cut

Consistent with the architecture plan's dogfood target: Rai reviewing real the enterprise client PRs daily, rough edges allowed.

**Recommendation: Tier 0 always, everywhere, both sides. Tier 1 for TypeScript only, against cache-owned immutable materialisations.**

| Component | v1 | Note |
|---|---|---|
| Tier 0 index: tree-sitter tags over the repo at the reviewed ref | **MUST** | Reuses B13's grammars. The reason there is no empty state |
| Cache-owned materialisation, refcounted, namespaced | **MUST** | `git worktree add --detach` is the mechanism |
| Base-side materialization, lazily on first left-side Tier 1 query | **MUST** | L2. The part with no prior art |
| Launch-time + quit-time orphan prune | **MUST** | A crash otherwise leaks application-cache resources |
| Disk budget + LRU + idle eviction | **MUST** | Cheap now, a support burden later |
| Tier 1 TypeScript: `tsc --lsp` for TS7, `typescript-language-server` for TS ≤6 | **MUST** | Version-detect first; never let `tls` touch a TS7 repo |
| `node_modules` symlink from a donor worktree, lockfile-gated | **MUST** | What makes Tier 1 real for PR review rather than theoretical |
| **Degraded-result detector (L6)** | **MUST** | The single most important piece of code here |
| **Positive-control readiness probe** | **MUST** | A readiness check that cannot fail has not passed |
| Tier badge on every definition and every hover | **MUST** | The product's honesty, made visible |
| Position mapper with the full refusal set | **MUST** | L16. Total function, never guesses |
| Inline definition band, below the line, opaque, breadcrumb capped at 3 | **MUST** | Rai's ratified UX |
| Hover types | **MUST** | Same server, same position, near-free |
| `alsoInChangeset` link | **MUST** | Cheap, and turns navigation into structural insight |
| Open-in-editor with copy disclosure | **MUST** | L14. The disclosure is the feature, not the link |
| `lsp-host` utility process + idle teardown | **MUST** | `tls` has no idle shutdown; we build it |
| `context.*` private events | **MUST** | Rides D9 for free |
| References (`gr`) | LATER | Needs a queue surface and a cap policy |
| **C# Tier 1 (Roslyn LS)** | LATER | Custom handshake + assets gate + restore mutation policy + .NET 10 runtime. C# gets Tier 0 in v1 |
| Docked / alongside variant (`gD`) | LATER | One dock, shared with threads |
| Any language beyond TS at Tier 1 | LATER | The port is language-agnostic; the health gates are not |
| Diagnostics | **NO** | L12. Revisit only behind a gate strong enough to suppress the whole stream |
| `promoteToWorktree` | LATER | The elegant fix for the editor footgun |
| Prewarming heuristics | LATER | Setting exists, default off |
| Cross-repo definitions (workspace siblings) | LATER | Interesting for Rai's `/workspace` layout specifically |

Critical path: **tree-sitter tag index → position mapper → materialization port → `lsp-host` + TS server → degraded detector + readiness probe → inline band → editor launch.** The degraded detector must land *with* the first server, not after it; shipping Tier 1 without it is shipping the failure mode.

---

## 6. Open questions / refinement hooks

### Frozen — do not change without escalating

- **Complete filesystem trees are the mechanism** (L1). Virtual schemes are unsuitable and a sparse tree is worse than none.
- **Two immutable sides, two materialisations, two servers** (L2). Overlay is never the primary mechanism.
- **Every answer carries its tier** (L3).
- **Never block a keystroke on an install** (L4); **prefer cache-owned trees for anything that writes** (L5).
- **The degraded-result detector and the positive-control readiness probe** (L6).
- **Definitions are context, never coverage** (L13).
- **Open-in-editor discloses the copy before the click** (L14).
- **Glass is chrome, the definition body is code and therefore opaque** (L15).

### Adjustable with evidence

- Idle timeout (5 min), max concurrent servers (4), disk budget, per-server RSS ceiling. All guesses; tune against real use.
- Band size cap (40 lines) and breadcrumb depth cap (3).
- Donor-selection policy for the `node_modules` link when several worktrees qualify.
- Tier 0 ranking heuristic (same file → same dir → same package → import-graph proximity).
- Whether Tier 0 indexes the whole workspace eagerly or per-review lazily.

### Genuinely open

1. **Cold start is measured on one repo, warm cache.** 2,287 ms on 2,071 files. **[unverified]** at 20k files, or cold cache, or with `tsc --lsp` rather than `typescript-language-server`. This sets the Tier-0-covers-the-gap budget, so it needs a real curve.
2. **Per-server RSS is unmeasured by me.** My `ps` filter did not isolate the tsserver children; the 10× tsgo-vs-tsserver ratio is **[cited]** from synthetic fixtures and its author explicitly warns against quoting it as a real-repo figure. Measure on product-repo before setting the ceiling.
3. **`tsc --lsp` is only verified for definition, hover, and typeDefinition.** References and rename are **[unverified]** on the native port. Re-run my probe scripts against it before promoting it to primary — the whole L9 ladder rests on a server I did not personally drive.
4. **Does `chmod -w` on the materialized worktree break any server?** Untested. Servers should only read, but "should" is not a measurement, and it interacts with L5's writes.
5. **Multi-project monorepo root selection.** **[measured]** `typescript-language-server` walked up correctly from `apps/fusion-frontend`. Repos with overlapping `include` globs, project references, or several tsconfigs claiming one file are unproven. A wrong project root produces — of course — the self-referential degraded answer.
6. **The worktree `.git`-is-a-file caveat.** **[measured]** it is a file containing `gitdir:`. tsserver did not care. **[cited]** other tools' root detection has broken on exactly this. Test each new server against a worktree, not a clone.
7. **Partial clone for large repos.** Sparse checkout is rejected (L1). `--filter=blob:none` on the fetch plus a full tree checkout might cut the cost on very large repos without the correctness loss. Unmeasured.
8. **Base-server eviction across reviews.** The `(repoId, refOid, languageId)` key correctly shares a base server between PRs off the same base; the eviction policy when reviews close at different times is unspecified.
9. **Should a running language server be visible?** A "servers running" indicator in the same inventory line as the harness listeners costs nothing and answers the reasonable question of what Rennet has spawned.
10. **GitHub's 2026 Files-changed symbol navigation** is **[unverified]**; the check failed its own positive control. Five minutes with a logged-in browser before this document's prior-art section is quoted anywhere external.
11. **Whether Scrutiny's LSP runs in the diff or only in its repo browser** is **[unverified]** and matters for the competitive read.

---

## 7. Bead candidates

> [!NOTE] Use [[Rennet Navi Handoff]] for current sequencing.

Sized for autonomous execution. Dependencies hard unless marked soft. `B*` references are architecture-plan beads.

| # | Title | P | Depends on | Description |
|---|---|---|---|---|
| L-B1 | Implement the materialisation port | P0 | B5, B6 | `git worktree add --detach` (0.32 s, measured) behind `MaterializationPort`, with refcount, LRU, disk budget, and orphan cleanup. Materialisations are namespaced so they are recognisable and reapable. |
| L-B2 | Position mapper: diff line → `RefPosition`, total, with the full refusal set | P0 | B7, B11 | Implement L16 including side→ref→path→line selection, renames via `prevPath`, UTF-16 character offsets computed from the JS string (never byte ranges), and every refusal reason. Fixture-driven: added file, deleted file, rename, binary, submodule, truncated diff, `\ No newline`, astral-plane characters in the line. A returned position that cannot exist at its ref is a test failure. |
| L-B3 | Tier 0 structural index: tree-sitter tags over a repo at a ref | P0 | B13 | Build a symbol index from the standard `tags.scm` queries for the grammars already loaded. Incremental, keyed by tree OID, cached outside the event log (derived, disposable). Answers "definitions named X" with a ranking heuristic and an explicit candidate count. Must work with zero toolchain and with the network off. |
| L-B4 | `lsp-host` utility process, ~60-line JSON-RPC client, lifecycle and teardown | P0 | B17 | Stand up the `lsp-host` `utilityProcess` per L10. Content-Length framing, `initialize`/`initialized`/`shutdown`/`exit`, **answer `workspace/configuration` and `client/registerCapability` or servers stall**, one-open-per-URI discipline, idle teardown with SIGTERM→SIGKILL escalation (no server provides it), concurrent-server cap with LRU. |
| L-B5 | **Degraded-result detector + positive-control readiness probe** | P0 | L-B4, L-B3 | Implement L6. Detect the single-target-equals-origin-import-clause shape; never render it as a target. Gate Tier 1 answers behind a readiness probe that resolves a known-cross-file symbol taken from the Tier 0 index. **Calibration requirement: the test suite must include a `node_modules`-absent fixture and assert the detector fires — a detector that cannot fire has not passed.** This is the highest-value bead in the list. |
| L-B6 | TypeScript Tier 1: version detection, server ladder, and the TS7 trap | P0 | L-B4, L-B1 | Detect the repo's TypeScript version first, then choose `tsc --lsp --stdio` (TS7) / `typescript-language-server` (≤6) / `vtsls`. **Assert `typescript-language-server` is never selected for a TS7 repo** (it silently falls back to a bundled 6.0.3). Handle the full definition result union: `LocationLink[]` from TS-family, `Location` from others. |
| L-B7 | Dependency linking: donor `node_modules` symlink gated on lockfile blob identity | P0 | L-B1, L-B6 | Implement L8. Find a worktree of the same repo with installed deps; compare `git rev-parse <ref>:<lockfile>` against the donor's on-disk hash; symlink only on exact match. Emit `DepsHealth` either way. Regression test both arms: matched lockfile resolves `react`, mismatched lockfile degrades and says so. |
| L-B8 | Inline definition band: below-the-line, opaque, breadcrumb, depth cap | P0 | B21, L-B2, L-B5 | Render the band inside `CodeView` per L15: opaque code body, glass header with path + ref badge + tier badge, gutter inset, no add/delete tint, no backlight. Body range from `LocationLink.targetRange`, else tree-sitter node, else ±20 lines. Breadcrumb with `cmd-[`, cap 3. Commands `gd` / `cmd-click` registered in B28. |
| L-B9 | `alsoInChangeset` detection and the jump into the sequence | P1 | L-B8, B15 | When a definition target falls inside a known `HunkVersion` at head, surface "this definition is part of this change" and link into the sequence angle. Cheap; makes navigation structural. |
| L-B10 | Coverage isolation: definitions never count as read | P0 | L-B8, B22 | Assert at the projection level that opening a definition band emits **no** `hunk.read`, raises no obligation, and moves no coverage figure. Add `context.definitionOpened` with `private: true` and extend D10's byte-identical publish test to cover the new private event types. Without this test, L13 is a promise rather than a property. |
| L-B11 | Open-in-editor: detection, deep links, and copy disclosure | P1 | L-B1, L-B2 | Implement `EditorLaunchPort`. Detect installed editors by bundle id and CLI. Deep links per the L14 table, `shell: false` argv or percent-encoded scheme-allowlisted URL. **`resolveTarget` computes which of the three copies will open and returns the disclosure string that the affordance renders before the click.** Ephemeral copies are chmod'd read-only and hold an eviction reference while open. Settings storage is the settings workstream's; this bead owns mechanics only. |
| L-B12 | Hover with tier-labelled types | P1 | L-B5, L-B8 | `textDocument/hover` on the same position, rendered as a transient glass tip (≤2 lines) or an opaque band (scrollable). Must carry the tier badge: without deps the types are not absent but **wrong** (`any` where the truth is `boolean`), which is the exact case the label exists for. |
| L-B13 | Spike: measure cold start and RSS on a large repo, and drive `tsc --lsp` directly | P0 | L-B4 | Answers open questions 1, 2, and 3 — the three numbers the entire budget rests on and which I did not measure. Re-run `lsp-probe.mjs` / `lsp-coldstart.mjs` against `tsc --lsp --stdio`, confirm definition/hover/typeDefinition/references, isolate real per-server RSS on product-repo, and curve cold start against file count. Run before L-B6 promotes tsgo to primary. |
| L-B14 | Spike: multi-project monorepo root selection | P1 | L-B6 | Open questions 5 and 6. Overlapping `include` globs, project references, several tsconfigs claiming one file, and the worktree-`.git`-is-a-file root-detection caveat. Failure mode is the self-referential answer, so the test must assert the *correct target file*, never merely non-null. |
| L-B15 | C# Tier 1: Roslyn LS with the assets-file health gate | P2 | L-B5, L-B6 | LATER per L9. Acquire from the vs-impl feed (never nuget.org), launch `--stdio` with the two required flags as shipped in 5.4.0, send `solution/open`, wait for `workspace/projectInitializationComplete`, pull diagnostics. **Gate every semantic result on `obj/project.assets.json` existing with a clean `logs[]` and non-empty `targets`** — a failed restore makes Roslyn emit false `CS0246`s that are lexically identical to real errors, so this is an accuracy check. Restore runs inside our ephemeral worktrees. |
| L-B16 | References (`gr`) as a capped queue surface | P2 | L-B8 | `textDocument/references` with `context.includeDeclaration`, a hard result cap, `truncated` surfaced honestly, results as a right-margin queue with per-result band expansion. Cancellable — this is the request users abort. |
| L-B17 | Docked / alongside definition variant | P3 | L-B8 | `gD` / `cmd-shift-click`. Shares one dock with the thread panel and preserves its state. Gated on window width via a command `when` clause. Deliberately after the inline band proves the interaction. |
| L-B18 | Promote a cache materialisation to a worktree (`promoteToWorktree`) | P3 | L-B1 | L14 calls this "the eventual real fix" for the editor footgun, and the four-noun model already says the ephemeral tree *is* a worktree of that repo — promotion is a rename and an attach. |

Critical path to a usable v1: **L-B1 → L-B2 → L-B3 → L-B4 → L-B5 → L-B6 → L-B7 → L-B8 → L-B10 → L-B11.** L-B13 runs in parallel from the start and can change L9's ladder, so it must not be deferred.

---

## Related

- [[Code Review Harness App]] — product shape, ratified decisions, the 2026-08-04 LSP decision
- [[Wingman Architecture Plan]] — four nouns, ports, process model, event store, D-decisions this plan extends
- [[Wingman GitHub Integration Plan]] — where changesets come from, and when a local checkout exists
- [[Code Review App Design Directions]] — the glass doctrine L15 obeys
- [[Wingman Settings and Setup Plan]] — owns the storage for editor and per-repo language-server preferences
