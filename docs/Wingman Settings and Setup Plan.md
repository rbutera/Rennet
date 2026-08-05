---
tags: [rennet, settings, plans]
categories: [project]
status: active
created: 2026-08-04
updated: 2026-08-05
---

# Rennet Settings and Setup Plan

> [!IMPORTANT] Current implementation authority, 2026-08-05
> Build **Rennet** under [[Rennet Master Plan]] and [[Rennet Architecture Contracts]]. Persistent project config, deterministic snapshots, and learned codebase knowledge live under the repo's `.rennet/`. Temporary staging, model frames, materialised trees, and caches live in Rennet's application cache. Rennet incrementally refreshes the project snapshot as the default branch advances and never consumes derived context whose input fingerprints are stale. `projectContext.visibility` is `local` by default or `git-visible`; Rennet never stages or commits context.

Per-repository and per-project/workspace preferences, plus the setup flows that must never ask a question they can answer themselves. The product name is Rennet; the filename is retained only to preserve existing Obsidian links. Sits on the canonical contracts in [[Rennet Architecture Contracts]], the event-sourced state design in [[Wingman Architecture Plan]], the discovery subsystem in [[Wingman Harness Adapter Protocol]], and the repo doctrine in [[Wingman Repo Bootstrap Plan]].

Elevated to a first-class workstream by Rai on 2026-08-04 (late evening). The tension this document exists to resolve, stated plainly:

> The ratified North Star is zero-config: install, log in with GitHub, harnesses are auto-detected, everything works. And the hard requirement is that it serves both a normal single-repo user AND Rai's layout, where the workspace root `/workspace` is itself a repo, `product-repo` is a repo nested inside it, and product-repo's worktrees live at `/workspace/wt/*`, outside the repo they belong to.

Those two requirements are not actually in tension, and the reason is the design's central claim: **Rai's layout needs zero configuration too.** Every fact about it is discoverable by git plumbing (verified in [[Wingman Architecture Plan]] §0.3 against the real machine). Configuration exists for taste and for team conventions, never for describing the shape of the disk. If a setting is required to make discovery correct, discovery is broken and the setting is a bug with a UI.

Two constraints inherited from the ratified Codex critiques, which this design must not contradict:

- **Capability flags are three layers, not one boolean** (`implementedByAdapter` / `advertisedByHarness` / `availableInSession`; [[reviews/wingman-adapter-licensing-codex-adjudication|adapter adjudication]] point 1). Settings that gate on a harness capability must gate on the *session* layer, and must degrade rather than offer a control that cannot be serviced.
- **`RepoId = realpath(git-common-dir)` is machine-local** and breaks on move, reclone, and any attempt to name a repo to the phone ([[reviews/wingman-architecture-codex-critique|architecture critique]] (f)). Config therefore keys on an internal stable record id with the common dir as one *alias*, not as the identity. §2.3.

---

## 1. The layering model

### 1.1 Two axes, not one

Almost every config system conflates two independent questions, and every subsequent argument about it traces back to that conflation. Keep them separate:

- **Scope**: what the value applies to. Defaults, global, workspace, repository, changeset.
- **Sharing**: who the value belongs to. **Personal** (yours, this machine, never leaves it) or **shareable** (a team convention about this repo, safe to commit).

Scope determines precedence. Sharing determines where the bytes live and who may write them. A setting is declared `personal` or `shareable` in the schema **once**, and that declaration is load-bearing: a personal key appearing in a committed repo file is ignored with a visible diagnostic, never silently honoured, and never silently dropped.

### 1.2 The precedence ladder

Eight layers, lowest to highest. The rule generating the order is: **specificity wins; at equal specificity, personal beats shared.**

| # | Layer | Storage | Sharing | Written by |
|---|---|---|---|---|
| 0 | `builtin` | compiled into `@rennet/core` | n/a | nobody, ever |
| 1 | `global` | `~/Library/Application Support/Rennet/config.json` | personal | the app, on user action |
| 2 | `workspace-shared` | `<workspaceRoot>/.rennet/workspace.jsonc` | shareable | a human, or the app after an explicit share act |
| 3 | `workspace-personal` | app-side store, keyed on workspace record | personal | the app |
| 4 | `repo-shared` | `<repoRoot>/.rennet/project.jsonc` | shareable | a human or Rennet's project-context generator, subject to Git-visibility setting |
| 5 | `repo-personal` | app-side store, keyed on repo record | personal | the app |
| 6 | `changeset` | app-side store, keyed on `ReviewId`, ephemeral | personal | the app, per review |
| 7 | `pinned` | `pin` block inside layer 1 | personal | the app, on user action |

Layer 7 is the escape hatch that makes layer 4 tolerable. Without it, a repo committing `chunk.budgetLoc: 250` overrides a user who deliberately set 400 globally because of how they read, which is a team convention reaching into a personal preference. `pin` is an explicit list of keys in the global config whose global value outranks every shared layer:

```jsonc
// ~/Library/Application Support/Rennet/config.json
{ "chunk": { "budgetLoc": 400 }, "pin": ["chunk.budgetLoc"] }
```

The settings UI offers `pin` as one control on the row ("keep my value even when a repo disagrees"), and the provenance panel always shows when a pin suppressed a shared value, so the pin can never become an invisible reason a team convention is not applying.

**Rejected alternative: personal always beats shared.** Simpler to explain, and wrong for the settings that matter most. `files.generated`, `chunk.mechanical.globs`, and `angles.sequence.orderStrategy` are facts and conventions about *the repo*, and a user's global default for them is a guess made before seeing the repo. Making the guess win by default means the repo file only ever works for people who never touched settings, which is the same as it not working.

**Rejected alternative: one flat project file merged with a single user file, gitconfig style.** Two layers cannot express "this workspace groups these repos" and "this repo has these conventions" at once, which is exactly Rai's case, and adding the missing layers later means re-keying every stored value. Layering retrofits badly; the ladder ships whole in v1 even though the v1 UI exposes only part of it (§7).

### 1.3 Merge semantics are declared in the schema, not folklore

Every setting node declares how layers combine. Four strategies:

| Strategy | Applies to | Behaviour |
|---|---|---|
| `replace` | scalars, enums, ordered lists | higher layer wins whole |
| `deepMerge` | records keyed by a stable id (per-harness options, per-language LSP) | key-by-key, each leaf resolved by its own strategy |
| `union` | set-like glob lists (`files.generated`, `files.ignored`, `context.documents`) | accumulate across layers; remove with a `!`-prefixed entry |
| `append` | guidance prose (`instructions.general`, `instructions.task`, `instructions.angle`) only | concatenate in ladder order with layer-labelled delimiters |

`union` is the important one and it is deliberately asymmetric with `replace`. A repo declaring `"!vendor/**"` is asserting a fact about itself that a workspace default cannot know, and a workspace declaring `"**/*.gen.ts"` is a house convention that a repo should not have to restate. Union with gitignore-style negation is the only semantics under which both statements survive contact. Precedence still applies inside union: a `!` entry at a higher layer removes a pattern contributed at a lower one, and the provenance panel shows the removal with its source, because "my glob stopped working" with no visible cause is exactly the failure this whole section exists to prevent.

Ordered lists (`harness.order`, `angles.order`) are `replace`, not union, because a merged ordering is not an ordering anybody chose. Partial reordering is expressed as an explicit operation on the whole list in the UI, which writes the whole list.

### 1.4 Provenance is not a feature, it is the return type

There is exactly one way to read a setting, and it always carries where the value came from:

```ts
resolve('chunk.budgetLoc')
// => { value: 250,
//      layer: 'repo-shared',
//      source: { kind: 'file', path: '/workspace/product-repo/.rennet/project.jsonc', line: 7 },
//      contributions: [
//        { layer: 'builtin',    value: 400, effective: false },
//        { layer: 'global',     value: 400, effective: false, note: 'not pinned' },
//        { layer: 'repo-shared', value: 250, effective: true }
//      ] }
```

Mechanically enforced, in the style the repo already uses for boundaries ([[Wingman Repo Bootstrap Plan]] §3):

1. The resolver returns `Resolved<T>`, never `T`. There is no `getSetting(key): T` overload to reach for.
2. `scripts/check-settings-access.mjs` fails the gate on any `.value` access outside `packages/ui/src/settings/**` and the small number of call sites that legitimately want the bare value, with fixtures proving the check fails when violated.
3. The command palette carries `Settings: Explain this setting` bound to the focused row, which renders the `contributions` array verbatim. Whatever the resolver believes, the user can see.

The reason this is worth a gate rather than a convention: a settings UI that displays a *recomputed* effective value rather than the resolver's own answer will eventually disagree with the engine, and the class of bug that produces ("the UI says 400, the chunks are 250") is unfalsifiable from the outside. The provenance object is the single source of truth for both the behaviour and the explanation.

### 1.5 Layer 6, the ephemeral changeset override

Per-review overrides exist because a specific PR sometimes needs a different treatment (a 6,000-line vendored bump wants a bigger chunk budget and the appendix collapsed; a security-sensitive PR wants every blast-radius signal on). They are:

- Stored app-side against `ReviewId`, never in a file, never shareable.
- Recorded in the review's event log as `settings.overridden` so a re-open of the review restores them and the publish preview can state that the review was conducted under non-default settings.
- **Not** part of the published payload's substance, and marked `private: false` because they describe the review's conduct rather than the reviewer's pace; the sheet may state "reviewed with a 900-line chunk budget" if the user chooses to include it, and that inclusion is itself a setting.

---

## 2. Storage: the app-side store and the repo file

### 2.1 The split, and the sentence that decides it

Both stores ship. The line between them:

> App-side config describes **you**. The repo file describes **the repo**. A value that would be wrong on a colleague's machine is personal; a value that would be wrong on a different repo is shareable.

Applied, that test is decisive almost every time. `harness.order` is personal (a colleague has different harnesses installed, and this is BYOK). `files.generated` is shareable (the codegen paths are a property of the repo). `appearance.scheme` is personal and obviously so. `angles.sequence.orderStrategy` is shareable and less obviously so, and it is the interesting case: a team that reads tests-first is expressing a convention about how their code should be approached, which is exactly the sort of thing that currently lives in a `CONTRIBUTING.md` paragraph nobody reads.

### 2.2 App-side layout

```
~/Library/Application Support/Rennet/
├── config.json                # layer 1 (global personal) + the pin block
├── config.json.bak.{1..5}     # rotated on every write; no event sourcing for config
├── records.json               # repo + workspace record table and aliases (§2.3)
├── scopes/
│   ├── workspace/<workspaceRecordId>.json    # layer 3
│   └── repo/<repoRecordId>.json              # layer 5
└── state/                     # the event store, review state; NOT config
```

Config is a plain document store with last-write-wins and rotated backups, deliberately **not** event-sourced even though review state is. Three reasons: users expect to be able to open and edit a config file by hand and an event log forbids that; the audit value of a config event log is fully served by five rotated backups plus the provenance panel; and an event-sourced config would make the resolver depend on the event store, which drags a `StorePort` dependency into a subsystem that must work before any review is open.

Writes are atomic (write to a temp file in the same directory, `fsync`, rename). A malformed or unparseable file at any layer is a **loud degradation**, never a silent reset: the layer is skipped, a diagnostic appears in the settings surface and the status area naming the file and the parse error, and the file is left untouched so a human can fix it. Rewriting a file we failed to parse is how a config system eats a user's settings.

### 2.3 Keying, given that `RepoId` is machine-local

The Codex critique is right that `realpath(--git-common-dir)` cannot be the durable key: it breaks when the repo moves, when it is re-cloned, and when the phone needs to name a repo. Config therefore keys on an internal identifier and treats every locator as evidence:

```ts
export interface RepoRecord {
  id: RepoRecordId                  // uuidv7, ours, stable forever
  displayName: string
  aliases: {
    commonDirRealpaths: string[]    // strongest local signal; may be several over time
    forge?: { host: string; owner: string; name: string }   // from remotes
    rootCommitOids: string[]        // git rev-list --max-parents=0 HEAD; machine-independent
  }
  lastSeenAt: number
}
```

Resolution order when a repo is encountered: (1) exact `commonDirRealpath` match, bind silently; (2) forge identity match, bind silently and record the new path as an alias; (3) root-commit OID match with no forge match, **offer** rather than bind: "settings exist for a repo that shares this history. Adopt them?" Root-commit OID is not identity, because forks and mirrors share it, and silently binding one repo's settings to another is a false positive whose only symptom is subtly wrong behaviour. Offering is honest; the user knows whether their fork should inherit.

If nothing matches, a fresh record is created with no settings, which is the correct and completely silent zero-config outcome.

Workspaces key the same way on `WorkspaceRecordId`, with the root path as the alias. The same repo appearing in two workspaces is one `RepoRecord` with one layer-5 file; the two workspaces contribute different layer-2 and layer-3 values above it. That is the correct model and it is exactly what Rai gets if he ever opens `product-repo` directly as well as through `/workspace`.

### 2.4 The repo file, and the two rules that govern it

`<repoRoot>/.rennet/project.jsonc` is the canonical project config. JSONC lets conventions carry their reasons. A `.rennet/workspace.jsonc` at a workspace root remains the same shape with workspace keys allowed. The old `.rennet/config.jsonc` path in examples and bead text is superseded.

**Rule one: Rennet may maintain its own `.rennet/` context, but never user source or Git state.**

Concretely:

- Opening a project may create or update `.rennet/project.jsonc`, `.rennet/snapshot/manifest.json`, `.rennet/snapshot/shards/`, and `.rennet/knowledge/` as Rennet-owned durable project context. These are the only automatic source-checkout writes.
- The default branch snapshot refreshes automatically and incrementally. A derived section is reusable only when every recorded input fingerprint still matches; otherwise it is invalidated and regenerated before use.
- `projectContext.visibility` has exactly two modes: `local` maintains a Rennet-owned `.rennet/.gitignore`; `git-visible` removes only Rennet's own exclusion so stable config, snapshot, and knowledge become visible for the user to commit. If files are already tracked, `local` explains that it cannot untrack them and leaves the index untouched.
- Rennet never runs `git add`, commits, changes branches, or mutates `.git`. It never writes outside `.rennet/` unless a separate explicit feature contract says so.
- UI changes to personal preferences still default to the app-side store. Changes to project context show their target and provenance.

**Rule two: the repo file is untrusted input.**

This is the rule people skip, and it is the one with teeth. A `.rennet/project.jsonc` arrives on a branch, from a contributor, in a PR you are about to review. It can therefore be authored by the person whose code you are checking. That makes it two attack surfaces at once:

- **Prompt injection.** `context.documents` names files that get fed to the harness. A PR that adds `.rennet/project.jsonc` pointing at `docs/friendly-notes.md` gets to write part of the reviewer's prompt.
- **Execution.** Any key naming a binary, a command, an endpoint, or a path outside the repo is remote code execution or exfiltration with extra steps.

So:

1. **Schema allowlist, enforced at parse.** The repo layer may only carry keys whose schema declares `sharing: 'shareable'`. Every other key is dropped with a diagnostic naming the key and the file. There is no "unknown key, pass it through" path.
2. **No key in the shareable set may name an executable, a command line, an endpoint URL, an environment variable, or an absolute path.** This is a property of the inventory (§3) and it is asserted by a test over the schema registry, so a future setting cannot quietly become shareable and violate it.
3. **All paths in the repo layer are repo-relative and are resolved with escape checking.** `../`, absolute paths, and symlinks resolving outside the repo root are rejected at resolution time, not at parse time, because a symlink can be added after the file was accepted.
4. **Trust gate.** The first time committed/shared project instructions are seen, and every time their content hash changes, that untrusted contribution is inert until accepted. Rennet-generated deterministic snapshot data is verified by fingerprints rather than manually trusted. Learned prose never acquires authority merely because it is stored under `.rennet/`.

The trust gate is scoped to human-authored or committed instruction changes, not routine deterministic snapshot refresh. The UI shows the exact changed bytes and provenance, so a project cannot silently rewrite the prompt used to review itself.

### 2.5 Context documents are read at the base ref

A corollary of rule two, stated separately because it is a mechanic rather than a policy.

When reviewing a changeset, the conventions and context documents fed to the harness are read at the **base ref**, not the head ref. A PR that modifies `CLAUDE.md` does not get to modify the prompt used to review it.

The escape valve is explicit and visible: when the changeset touches any file in the effective context set, the review surface shows a row, "this change edits 2 context documents", with a diff and an **Adopt for this review** action that moves those documents to head-ref content for this changeset only (a layer-6 override, recorded in the event log). That covers the legitimate case, which is a PR whose entire purpose is updating the conventions, without making the injection case free.

Working-tree review (the pre-PR author mode) is a different situation and gets a different default: the base ref there is the merge-base with the tracking branch, and the author is reviewing their own machine's files, so context is read from the working tree. The rule generalises to: **context is read from the state the reviewer already trusts**, which is their own tree when reviewing themselves and the base when reviewing someone else.

### 2.6 Project snapshot and freshness contract

`.rennet/snapshot/manifest.json` plus content-addressed `.rennet/snapshot/shards/` form a deterministic, schema-versioned codebase map rooted at the resolved default branch. The manifest records the branch and exact commit, generator and parser versions, dependency-graph digest, shard digests, and complete input fingerprints. Shards contain file/module/symbol/dependency/boundary/entry-point facts. `.rennet/knowledge/` holds learned architecture and conventions separately from deterministic facts; every learned artifact records evidence, confidence, snapshot identity, and source fingerprints.

When the default branch advances, Rennet computes the changed paths, invalidates affected snapshot sections and transitive dependants, and incrementally regenerates them. While regeneration is pending, affected context is labelled `updating` or `stale` and is unavailable to review prompts. It is never silently served as current. If incremental safety cannot be proven, regenerate the relevant section or the whole snapshot.

Project context is an input, not authority. Every lens artifact records the project snapshot ID and input fingerprint it consumed. Before reuse or regeneration, the engine verifies those fingerprints against the captured patchset and current valid snapshot.

---

## 3. The settings inventory

Sharing column: **P** = personal (app-side only, rejected from repo files), **S** = shareable (may appear in a repo or workspace file). Merge: `R` replace, `U` union, `M` deepMerge, `A` guidance-only append. Scope column lists the layers at which the key may be set (in addition to `builtin`); `G` global, `W` workspace, `R` repo, `C` changeset.

### 3.1 Harnesses

| Key | Type | Default | Scope | Share | Merge | Notes |
|---|---|---|---|---|---|---|
| `harness.order` | `HarnessId[]` | discovery order | G W R C | P | R | Which harness answers first. Personal because BYOK: a colleague has different binaries |
| `harness.enabled` | `Record<HarnessId, boolean>` | all detected | G W R C | P | M | Turning one off never hides the discovery result, it hides the harness from pickers |
| `harness.<id>.model` | `string` | harness default | G W R C | P | M | Validated against the harness's advertised list where one exists; free text otherwise |
| `harness.<id>.binaryPath` | `string` | discovered | G | P | R | **Never shareable.** Names an executable. Discovery override only, for a machine discovery gets wrong |
| `harness.<id>.maxBudgetUsd` | `number \| null` | `null` | G W R C | P | M | Real enforcement on Claude; token-derived estimate elsewhere, labelled as such |
| `harness.discovery.extraPaths` | `string[]` | `[]` | G | P | U | Appended to the login-shell PATH harvest ([[Wingman Harness Adapter Protocol]] §3.1) |
| `harness.utility.mode` | `'auto' \| 'batched-harness' \| 'direct-api'` | `auto` | G | P | R | The tier-two router. Per-item `harness-degenerate` is not an option, per the adapter adjudication's rejection of process-per-hunk |
| `harness.utility.endpoint` | `{url, model}` | unset | G | P | R | **Never shareable.** Names a network endpoint |
| `harness.utility.concurrency` | `number` | derived | G | P | R | Read by the batch scheduler; capped by the port's own limit |

### 3.2 Angles

| Key | Type | Default | Scope | Share | Merge | Notes |
|---|---|---|---|---|---|---|
| `angles.enabled` | `AngleId[]` | v1 set | G W R C | S | R | A repo may declare its house set. Shareable: it is a statement about how this code wants reading |
| `angles.order` | `AngleId[]` | `['sequence','decisions','blast-radius',...]` | G W R C | S | R | Rail order, and which angle opens by default |
| `angles.preset` | `string` | `'default'` | G W R C | S | R | Names an entry in `angles.presets` |
| `angles.presets` | `Record<string, AnglePreset>` | built-in three | G W R | S | M | A preset is `{ enabled, order, perAngle }`. Editing is LATER; see the v1 cut |
| `angles.sequence.orderStrategy` | `'layered' \| 'tests-first' \| 'spine-first'` | `layered` | G W R C | S | R | The three published expert orders; required to stay a named switchable set |
| `angles.decisions.maxItems` | `number` | **open, see §8** | G W R | S | R | The hard visible cap. "The count IS the product" |
| `angles.blastRadius.signals` | `SignalId[]` | all cheap signals | G W R C | S | U | Never includes churn-heat; the schema has no such value to set |
| `angles.blastRadius.presets` | `('security' \| 'safety-net')[]` | `['safety-net']` | G W R | S | U | The safety-net-weakening preset is on by default |

### 3.3 Chunking

| Key | Type | Default | Scope | Share | Merge | Notes |
|---|---|---|---|---|---|---|
| `chunk.budgetLoc` | `number` | `400` | G W R C | S | R | The SmartBear/Cisco ceiling. Range-validated 50-2000 |
| `chunk.appendix.collapse` | `boolean` | `true` | G W R C | S | R | Mechanical chunks pre-collapsed and skimmable |
| `chunk.mechanical.globs` | `string[]` | built-in list | G W R | S | U | Lockfiles, vendored dirs, codegen. The single most valuable shareable key |
| `chunk.decomposition.mode` | `'deterministic' \| 'validated-hybrid'` | `validated-hybrid` | G W R C | S | R | Per the Codex rejection of deterministic-authoritative. Deterministic is the offline fallback, always present |

### 3.4 Files

| Key | Type | Default | Scope | Share | Merge | Notes |
|---|---|---|---|---|---|---|
| `files.generated` | `string[]` | built-in list | G W R | S | U | Feeds mechanical classification and the appendix |
| `files.ignored` | `string[]` | `[]` | G W R | S | U | Excluded from review entirely. **Counted and shown**, never silently dropped; see the residue rule below |
| `files.largeFileBytes` | `number` | `1_048_576` | G W R | S | R | Above this a file renders on demand rather than eagerly |

Residue rule, inherited from the Codex critique (c): an ignored or unparseable file is not the same as a covered file. Ignored files, binary files, submodule changes, and mode-only changes are all carried in an explicit `excluded` bucket that the coverage surface displays and that **the publish sheet lists**. "Done" may be reached with a non-empty excluded bucket; it may not be reached with an *unacknowledged* one. A settings key that could silently shrink the reviewed surface without a visible count is a settings key that lies about coverage.

### 3.5 Context documents

| Key | Type | Default | Scope | Share | Merge | Notes |
|---|---|---|---|---|---|---|
| `context.autoDetect` | `boolean` | `true` | G W R | S | R | The zero-config path. Opt-out, never opt-in |
| `context.documents` | `string[]` | `[]` | G W R C | S | U | Repo-relative globs, added to the auto-detected set. Escape-checked at resolution |
| `context.exclude` | `string[]` | `[]` | G W R C | S | U | Removes from the auto-detected set without disabling detection |
| `context.totalBudgetBytes` | `number` | `98_304` | G W R C | P | R | Personal: it is a cost and latency preference, not a fact about the repo |
| `context.perDocBudgetBytes` | `number` | `32_768` | G W R C | P | R | |
| `context.nearestAncestor` | `boolean` | `true` | G W R | S | R | Monorepo behaviour: pick up the `CLAUDE.md` nearest each changed file |
| `context.ref` | `'base' \| 'head' \| 'captured-local'` | `base` for PR review, captured local patchset for self-review | C | P | R | Never means the mutable live tree after patchset capture |
| `projectContext.visibility` | `'local' \| 'git-visible'` | `local` | G W R | P | R | Controls whether stable `.rennet` context is visible to Git; Rennet never stages or commits |

### 3.6 Publish

| Key | Type | Default | Scope | Share | Merge | Notes |
|---|---|---|---|---|---|---|
| `publish.defaultEvent` | `'COMMENT' \| 'APPROVE' \| 'REQUEST_CHANGES'` | `COMMENT` | G W R | S | R | Never defaults to APPROVE at any layer; the schema rejects it as a default, it is only ever a selection |
| `publish.prSubmitDefault` | `'draft' \| 'ready'` | `draft` | G W R | S | R | The author-mode variant of the sheet, per the two-variant publish decision |
| `publish.includeDecisions` | `boolean` | `false` | G W R C | P | R | Whether discharged decisions appear in the review body |
| `publish.includeSettingsNote` | `boolean` | `false` | G W R C | P | R | Whether a non-default chunk budget is stated in the review body |
| `publish.holdToSignMs` | `number` | `700` | G | P | R | The ceremony's dwell. Accessibility floor of 0 is allowed; the ceremony is then a confirm |
| `publish.threadStyle` | `'multi-line' \| 'single-line'` | `multi-line` | G W R | S | R | Degrades automatically where the forge lacks multi-line anchors |

### 3.7 Findings and the false-positive budget

| Key | Type | Default | Scope | Share | Merge | Notes |
|---|---|---|---|---|---|---|
| `findings.severityFloor` | `'p0' \| 'p1' \| 'p2' \| 'p3'` | `p2` | G W R C | S | R | Below the floor, findings are collected but not surfaced |
| `findings.maxPerChunk` | `number` | `5` | G W R C | S | R | Impact-ranked; the rest are behind a count |
| `findings.requireEvidence` | `boolean` | `true` | G W R | S | R | A finding with no cited line is culled by the verifier before display |
| `findings.dismissals.sticky` | `boolean` | `true` | G | P | R | Dismissals persist across patchsets and train the ranking |
| `findings.ingestBots` | `string[]` | `[]` | G W R | S | U | Which bot authors' PR comments are ingested into the finding queue |

### 3.8 LSP

Design lives in the pending [[Wingman LSP Integration Plan]]; the config surface is fixed here because it has a security shape.

| Key | Type | Default | Scope | Share | Merge | Notes |
|---|---|---|---|---|---|---|
| `lsp.enabled` | `boolean` | `true` | G W R | P | R | Personal: it is a local resource decision |
| `lsp.languages.<id>.enabled` | `boolean` | `true` | G W R | P | M | |
| `lsp.languages.<id>.command` | `string[]` | discovered | G | P | M | **Never shareable, never workspace, never repo.** Names an executable. A repo file that could set this is remote code execution |
| `lsp.startupTimeoutMs` | `number` | `8000` | G | P | R | Past the timeout, silently fall back to tree-sitter |
| `lsp.fallback` | `'tree-sitter' \| 'none'` | `tree-sitter` | G W R | P | R | |

### 3.9 External editor

Ratified by Rai 2026-08-04: every diff and every file gets a shortcut to open in the user's own editor. The deep-link mechanics and the diff-surface affordance belong to [[Wingman LSP Integration Plan]]; what belongs here is where the preference lives, how it is detected, and why it can never be shareable.

| Key | Type | Default | Scope | Share | Merge | Notes |
|---|---|---|---|---|---|---|
| `editor.external.id` | `EditorId \| 'auto' \| 'custom'` | `auto` | G W R | P | R | `auto` resolves through the detection order below on every launch, so an editor installed later is picked up without anyone remembering to change a setting |
| `editor.external.command` | `string` | unset | G | P | R | **Never shareable, never workspace, never repo.** A command template naming an executable. A committed file that could set this is remote code execution against every reviewer on the team. Only meaningful when `id` is `custom` |
| `editor.external.args` | `string` | per-editor template | G | P | M | Template with `{path}`, `{line}`, `{col}`, `{repoRoot}`. Overriding the built-in template for a known editor is a power path, not the default |
| `editor.external.reuseWindow` | `boolean` | `true` | G W R | P | R | Whether the open reuses an existing window on the same repo root |

`EditorId` is a closed enum of editors with a known invocation shape (VS Code, VS Code Insiders, Cursor, Windsurf, Zed, Sublime Text, the JetBrains family, Xcode, plus a `terminal` species covering `$EDITOR` in a spawned terminal). Closed rather than open, because each entry carries a *verified* argument template for line-and-column navigation, and an editor whose template nobody has run is a broken menu item, not a feature.

**Why `id` is per-repo-overridable but `command` is global only.** Wanting Cursor for the TypeScript repo and Xcode for the iOS one is a normal, expressible taste. Wanting a different *command line* per repo is either the same taste (expressible through `id`) or an attempt to make a repo dictate an execution. So the per-scope surface is the safe enum, and the free-text executable stays at the one layer no repo can reach. Note that the per-repo override lives in **layer 5, app-side**, not in the committed repo file, which falls straight out of the personal/shareable split rather than being a special case.

**Detection order** (zero-config; no editor screen is ever shown on first run):

```
1. If editor.external.id is set and not 'auto', use it. Missing binary => degrade (below).
2. Probe the known-editor list, in this order:
     a. running application bundles (macOS: an editor already open is the one you meant)
     b. installed application bundles / known install locations
     c. CLI shims on the harvested PATH (`code`, `cursor`, `zed`, `subl`, `idea`, ...)
3. $VISUAL, then $EDITOR, taken from the LOGIN-SHELL environment harvest, not process.env.
4. Nothing found: the shortcut degrades to Reveal in Finder, and the settings row explains why.
```

Step 3 carries the same trap as harness discovery and gets the same answer ([[Wingman Harness Adapter Protocol]] §3.1): an Electron app launched from Finder inherits a login-shell environment without the user's interactive rc files, so `process.env.EDITOR` is routinely absent on a machine where `echo $EDITOR` in a terminal answers instantly. The PATH harvest already runs for harness discovery; `$EDITOR` and `$VISUAL` are harvested in the same single shell invocation, at no extra cost. And as with harnesses, the resolved name is checked by **executing** it, never by trusting `which`: `$EDITOR` set to a shell function is a real configuration and it must produce a clean degradation rather than a spawn error at the moment the user presses the key.

Degradation is always to something that works: a missing configured editor falls back to the detection order rather than to an error, and the settings row states what happened. A dead shortcut on a keyboard-first product is worse than an honest Reveal in Finder.

### 3.10 Workspace and discovery

| Key | Type | Default | Scope | Share | Merge | Notes |
|---|---|---|---|---|---|---|
| `workspace.displayName` | `string` | dir basename | W | S | R | |
| `workspace.repos.hidden` | `string[]` | `[]` | W | S | U | Repo-relative paths to omit from the home surface. Never affects discovery correctness, only display |
| `workspace.repos.pinned` | `string[]` | `[]` | W | P | U | Ordering on the home surface. Personal: it is about attention |
| `workspace.worktreeDir` | `string` | unset | W | S | R | Where NEW worktrees are created. The one thing discovery genuinely cannot infer. Rai's value: `wt` |
| `workspace.discovery.maxDepth` | `number` | `4` | W | S | R | §5.3 |
| `workspace.discovery.exclude` | `string[]` | built-in list | W | S | U | Directory names never descended into |

Note what is **not** here: no list of repos, no worktree mapping, no repo paths, no "this is a monorepo" flag. All of it is discovered. The workspace file exists to declare taste and the single genuinely undiscoverable fact (where new worktrees go), and if it grows a key that describes disk shape, that key is a discovery bug.

### 3.11 Appearance and privacy

| Key | Type | Default | Scope | Share | Merge | Notes |
|---|---|---|---|---|---|---|
| `appearance.scheme` | `'lamplight' \| 'bright-room' \| 'system'` | `system` | G | P | R | The two ratified glass schemes |
| `appearance.wallpaper.tier` | `'vibrancy' \| 'shipped' \| 'image'` | `vibrancy` on macOS, `shipped` elsewhere | G | P | R | Tier 3 always tone-mapped; chrome legibility is guaranteed by panel dim, never by wallpaper luck |
| `appearance.wallpaper.imagePath` | `string` | unset | G | P | R | Personal, local, never shareable |
| `appearance.density` | `'comfortable' \| 'compact'` | `comfortable` | G | P | R | |
| `privacy.rawFrameCapture` | `boolean` | `false` | G | P | R | Off by default per the Codex finding that raw harness frames are a confidential-data store. On = diagnostics mode, with retention cap |
| `privacy.rawFrameRetentionDays` | `number` | `3` | G | P | R | Only meaningful when the above is on |

### 3.12 The anti-inventory: what is deliberately not configurable

A settings system's discipline is what it refuses. Each of these will be requested; each answer is a design position, not an omission.

| Requested | Answer |
|---|---|
| "Let me share my pace/coverage data" | **Not a setting.** Pace and dwell are private by construction, structurally excluded from every published payload, with the byte-identical-digest test as the mechanism (D9). There is no flag because a flag would require the data to reach the publish projection to be suppressed there, and the guarantee is that it never arrives |
| "Auto-approve when no findings" | **Not a setting.** Approval is the never-automated act. This is a product rule and a repo rule |
| "Auto-post comments as the harness finds them" | **Not a setting.** Every model output is an editable draft; publish is a single batched signed act |
| "Let the harness fix it" | **Not a setting.** Read-only sandbox posture across all harnesses ([[Wingman Harness Adapter Protocol]] §3.4). A review tool that edits your tree while you read is a trust catastrophe |
| "Make the diff surface translucent" | **Not a setting.** Glass is chrome, code is opaque. Absolute |
| "Send telemetry to help improve Rennet" | **Not a setting.** There is no telemetry to enable |
| "Let our repo config set the team's editor command" | **Not shareable.** Per-repo *choice of editor* is expressible (`editor.external.id`, app-side layer 5); a repo-supplied command line is remote code execution against every reviewer who opens the repo |
| "Churn-heat as a blast-radius signal" | **Not a value.** Anti-correlates with defects; the enum has no such member |
| "Use `position` anchoring for older forges" | **Not a setting.** `line`/`side` only; degradation is automatic and capability-driven |
| "Skip the residue check on huge PRs" | **Not a setting.** The totality assertion is what makes coverage mean anything |

---

## 4. Type sketches

Illustrative, not final. Names are load-bearing where §1 and §2 reference them. All of this lives in `@rennet/core` (portable: no `node:*`, no DOM), with the file and keychain touching implemented behind a port in `@rennet/adapters`. The `SettingKey` union and the schema registry are portable specifically so the phone can render a settings surface without importing the engine.

### 4.1 Layers and provenance

```ts
/** Ordered lowest to highest. Index IS precedence; do not reorder without a migration. */
export const CONFIG_LAYERS = [
  'builtin', 'global', 'workspace-shared', 'workspace-personal',
  'repo-shared', 'repo-personal', 'changeset', 'pinned',
] as const
export type ConfigLayer = (typeof CONFIG_LAYERS)[number]

export type ConfigSource =
  | { kind: 'builtin' }
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'app-store'; scope: 'global' | 'workspace' | 'repo'; recordId?: string }
  | { kind: 'changeset'; reviewId: ReviewId }

export interface LayerContribution<T> {
  layer: ConfigLayer
  value: T
  effective: boolean
  source: ConfigSource
  /** Why a present value did not win: 'overridden' | 'not-pinned' | 'suppressed-by-pin'
   *  | 'rejected-personal-key-in-shared-file' | 'rejected-path-escape' | 'layer-untrusted' */
  note?: ContributionNote
}

/** The ONLY thing the resolver returns. There is no bare-value read path (§1.4). */
export interface Resolved<T> {
  key: SettingKey
  value: T
  layer: ConfigLayer
  source: ConfigSource
  /** Every layer that had an opinion, winner and losers alike, in ladder order. */
  contributions: LayerContribution<T>[]
}
```

### 4.2 The schema registry

```ts
export type Sharing = 'personal' | 'shareable'
export type MergeStrategy = 'replace' | 'union' | 'deepMerge'
export type SettableScope = 'global' | 'workspace' | 'repo' | 'changeset'

export interface SettingDef<T> {
  key: SettingKey
  schema: ZodType<T>
  default: T
  sharing: Sharing
  merge: MergeStrategy
  /** Layers at which this key may be SET, over and above `builtin`. */
  scopes: readonly SettableScope[]
  /** True when the value names an executable, command, endpoint, env var, or absolute
   *  path. Asserted `sharing === 'personal' && scopes === ['global']` by a registry test. */
  namesExecutionOrEgress?: true
  /** Values resolved as repo-relative paths, escape-checked at resolution, not at parse. */
  pathKind?: 'repo-relative-glob' | 'repo-relative-file'
  /** Gate on the SESSION capability layer, never the adapter or advertised layer. */
  requiresCapability?: (c: SessionCapabilities) => boolean
  label: string
  help: string
}

export type SettingRegistry = { readonly [K in SettingKey]: SettingDef<SettingValue<K>> }
```

Three registry-level tests, and they are the mechanism rather than the documentation:

```ts
it('no personal key is accepted from a shared file', …)          // parser honours `sharing`
it('every namesExecutionOrEgress key is personal and global-only', …)
it('every shareable key has a pathKind or no path semantics at all', …)
```

### 4.3 The resolver and its port

```ts
export interface ConfigScopeKey {
  workspaceRecordId?: WorkspaceRecordId
  repoRecordId?: RepoRecordId
  reviewId?: ReviewId
}

export interface ConfigResolver {
  resolve<K extends SettingKey>(key: K, scope: ConfigScopeKey): Resolved<SettingValue<K>>
  /** For the settings surface: every key with its ladder, one pass. */
  resolveAll(scope: ConfigScopeKey): Map<SettingKey, Resolved<unknown>>
  /** Diagnostics from parsing, one per rejected key or unreadable layer. Never thrown. */
  diagnostics(scope: ConfigScopeKey): ConfigDiagnostic[]
}

/** Implemented in adapters. Reads and writes are per LAYER, never per key. */
export interface ConfigStorePort {
  readLayer(layer: ConfigLayer, scope: ConfigScopeKey): Promise<RawLayer | null>
  /** Atomic: temp file in the same dir, fsync, rename, rotate backups. */
  writeLayer(layer: ConfigLayer, scope: ConfigScopeKey, doc: RawLayer): Promise<void>
  watch(scope: ConfigScopeKey, onChange: (layer: ConfigLayer) => void): () => void
}

export interface RawLayer {
  schemaVersion: number
  values: Record<string, unknown>
  /** Present only on layer 1. */
  pin?: SettingKey[]
  /** Present only on file-backed layers; the trust gate keys on it (§2.4). */
  contentHash?: string
}

export interface ConfigDiagnostic {
  severity: 'error' | 'warning'
  layer: ConfigLayer
  source: ConfigSource
  code: 'unparseable' | 'unknown-key' | 'personal-key-in-shared-file'
      | 'path-escape' | 'schema-violation' | 'untrusted-layer' | 'schema-version-ahead'
  key?: string
  message: string
}
```

`writeLayer` taking a whole layer rather than a key is deliberate: it makes "the app wrote into a repo" a single auditable call site that the share ceremony (§2.4) can own, instead of a thing any settings row could do incidentally.

### 4.4 File shapes

```ts
/** <repoRoot>/.rennet/project.jsonc: optionally committable, shareable keys only, untrusted input. */
export const RepoConfigFile = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.number().int().positive(),
  settings: z.record(z.string(), z.unknown()),   // filtered against the registry after parse
}).strict()

/** <workspaceRoot>/.rennet/workspace.jsonc: the same, plus the workspace-scoped keys.
 *  Declares ONLY what discovery cannot infer. No repo list, no worktree map, no paths
 *  to repos: if a key here describes the shape of the disk, it is a discovery bug. */
export const WorkspaceConfigFile = RepoConfigFile
```

### 4.5 Records and trust

```ts
export type RepoRecordId = string & { readonly __brand: 'RepoRecordId' }
export type WorkspaceRecordId = string & { readonly __brand: 'WorkspaceRecordId' }

export interface RepoRecord {
  id: RepoRecordId                 // uuidv7, ours, stable forever
  displayName: string
  aliases: {
    commonDirRealpaths: string[]   // strongest local signal; several over a repo's life
    forge?: { host: string; owner: string; name: string }
    rootCommitOids: string[]       // machine-independent HINT, never an identity (§2.3)
  }
  lastSeenAt: number
}

export type RecordMatch =
  | { kind: 'bound'; recordId: RepoRecordId; via: 'common-dir' | 'forge' }
  | { kind: 'offer'; recordId: RepoRecordId; via: 'root-commit' }   // ask, never bind
  | { kind: 'new' }

export interface TrustRecord {
  recordId: RepoRecordId | WorkspaceRecordId
  file: 'repo' | 'workspace'
  acceptedContentHash: string
  acceptedAt: number
}
```

### 4.6 Discovery

```ts
export interface DiscoveryPolicy {
  root: string                     // absolute, realpath'd; nothing above it is ever read
  maxDepth: number                 // default 4
  maxNodes: number
  maxWallMs: number
  excludeDirNames: readonly string[]
  /** ALWAYS false. Present as a named constant so its absence is legible, not settable. */
  readonly followSymlinksOutsideRoot: false
  /** ALWAYS true: gitignored dirs are still probed for repo-ness, or /workspace/wt/* vanishes. */
  readonly probeIgnoredDirectories: true
}

export interface DiscoveryResult {
  repos: DiscoveredRepo[]
  /** Set when a cap was hit. The UI must show this; a truncated walk that looks complete
   *  is the same failure class as a search with a broken locator. */
  stoppedEarly: { reason: 'depth' | 'nodes' | 'time'; at: string } | null
  /** The walk is a HINT; `git worktree list --porcelain` is the truth (§5.3). Any
   *  disagreement is recorded rather than silently resolved. */
  reconciliation: { walkOnly: string[]; listOnly: string[] }
}
```

### 4.7 Context assembly

`ContextManifest` and `ContextDocument` are specified in §6.2 with the pipeline that produces them; they are durable event payloads rather than config types, which is why they live there.

---

## 5. Setup flows

### 5.1 First run

The whole flow is one screen and it asks nothing. It reports.

```
Rennet
  GitHub      rbutera            connected via gh
  Harnesses   Claude Code 2.1.220 · Codex 0.144.1
  Open a pull request                          [ paste a URL or pick from your PRs ]
```

Sequence, all concurrent, none blocking:

1. `gh auth token` (rung 0, [[Wingman GitHub Integration Plan]]). Success is the entire GitHub setup. Failure walks down the rungs, and the fallbacks are visible options rather than hidden power-user settings, because at a locked-down enterprise rung 1 is dead on arrival.
2. Harness discovery: login-shell PATH harvest, known-locations union, our own resolution, execute-to-health-check, three-state health. Never `which`, never `command -v`; on Rai's machine both harness names resolve to shell functions and a login shell finds neither binary.
3. External editor detection, folded into the same login-shell harvest as step 2 (§3.9). Never shown as a question, never shown as a step; it either resolves or the shortcut degrades to Reveal in Finder later.
4. Nothing else. No workspace prompt, no theme picker, no editor picker, no key entry, no account.

Failure copy is specific rather than generic, because the specific failures are known: "found your Claude Code config at `~/.claude` but not the `claude` binary" is a different and far more actionable message than "no harness found", and the discovery subsystem already distinguishes them.

The first review works with zero config files existing anywhere on the machine. That is the acceptance test for this whole document, and it is worth writing as an actual test: a fresh `HOME`, no `Application Support` directory, one repo, one PR, assert a decomposed review.

### 5.2 Adding a workspace

Point at a directory. Discovery walks it. The app shows what it found and asks for one confirmation, which exists so the user learns the model rather than because the app needs an answer:

```
/workspace                                    workspace, and itself a repo
  focused                    main             3 open PRs
  product-repo                  nested repo      12 open PRs
    ├ product-repo              main             primary checkout
    ├ wt/feature-branch             feature-branch          worktree, outside this repo's tree
    ├ wt/feature-branch          feature-branch       worktree
    └ .claude/worktrees/x    detached         worktree
  metric-ai                                   1 open PR

  [ Add workspace ]     3 repos, 6 checkouts, 16 pull requests
```

Three things that screen is quietly proving, and which are the entire answer to the "support people like Rai" requirement:

- `/workspace` being both the workspace root and a repo is a normal, unremarkable row. Mode is not a mutually exclusive choice; **workspace mode is a superset of project mode**, and a root that happens to be a repo is simply listed among its peers.
- `product-repo` nested inside `/workspace` is one repo with N checkouts, not N projects, because they share a `--git-common-dir`.
- `wt/feature-branch` sits physically inside `/workspace` and is attributed to `product-repo`, because the object store says so. It is gitignored by `/workspace` and it still appears (§5.3).

No file is written to any repo. The workspace record is created app-side. `.rennet/workspace.jsonc` is not created and is not suggested.

Opening a single repo directory is the same flow with a one-row result, and produces a workspace record whose root is the repo. There is no separate "project mode" code path to maintain, only a display difference: a one-repo workspace hides the repo grouping.

### 5.3 What discovery must never do

Discovery runs on untrusted disk and it is the subsystem most likely to hang, leak, or embarrass the app. The prohibitions are as load-bearing as the algorithm:

1. **Never walk outside the chosen root.** Not upward, not via `..`, not via a config value.
2. **Never follow a symlink whose realpath escapes the root.** Symlinks inside the root are followed once, with a visited-inode set so a cycle terminates. Rai's `product-repo/openspec -> /workspace/openspec` is exactly this case, and it must not produce an infinite walk or a second copy of the repo.
3. **Never crawl the whole disk.** No `/`, no `$HOME` as an implicit root, no Spotlight query, no background indexer. Depth cap (default 4 from the root), a hard node cap, and a wall-clock cap, with a visible "stopped early" state rather than a silent partial result. A truncated discovery that looks complete is the same failure class as a search with a broken locator.
4. **Never descend into** `node_modules`, `.git` internals, `dist`, `build`, `target`, `.venv`, `Pods`, `DerivedData`, or anything in `workspace.discovery.exclude`.
5. **Never touch a repo it finds.** Discovery is `rev-parse`, `worktree list --porcelain`, `remote -v`, and a bounded `readdir`. No fetch, no index read that could take the index lock, no checkout, no config write, no hook execution, no `.rennet/` creation. Read-only in the strongest sense: no git command that can write is in the discovery allowlist at all, enforced by the `GitPort` command allowlist rather than by care.
6. **Never let a gitignore hide a repo.** This one is a trap with Rai's name on it: `/workspace/wt/` is gitignored by `/workspace` (`.gitignore:28`), and a discovery that skips ignored directories would hide every product-repo worktree. So ignored directories are still probed for repo-ness; only their non-repo contents are skipped.

And the calibration that makes item 6 safe rather than lucky: **the walk is a hint, `git worktree list --porcelain` is the truth.** Every discovered repo is asked for its own worktree list, which reports checkouts wherever they live, including outside the workspace root entirely. The walk finding a worktree and the worktree list reporting it are two independent mechanisms, and only one of them is authoritative. If they disagree, the list wins and the discrepancy is recorded, because a walk that quietly stopped matching is precisely the check that cannot fail.

The discovery golden test runs against `/workspace` and asserts the full shape: root-is-a-repo, one nested repo, worktrees under `wt/` attributed to product-repo, worktrees under `product-repo/.claude/worktrees/` also attributed to product-repo, and the symlinked `openspec` not producing a duplicate.

### 5.4 The per-repo settings surface

Reached from the repo row in the home surface, or from anywhere in a review by way of the command palette. Layout follows the provenance model rather than a category tree:

- Each row shows the effective value, and to its right a small mark naming the winning layer. Values coming from the repo file carry a distinct mark, because "this is the team's, not yours" is the single most useful thing the surface can communicate.
- Rows overridden at a higher layer than the one being viewed show the override inline rather than lying about the value.
- The row's overflow menu carries exactly four actions: **Explain** (the contributions ladder), **Reset to inherited**, **Pin my value**, and **Share with the repo** (shareable keys only, and it opens the diff sheet from §2.4).
- A banner at the top of the surface when the repo file is present but untrusted, showing the diff and offering acceptance. Nothing else in the surface is blocked by it.

Private marks are backlight blue throughout this surface, since almost everything on it is visible to the reviewer alone.

---

## 6. How config reaches the harness

### 6.1 The pipeline

```
resolve context.* for (workspace, repo, changeset)
  → candidate set
      auto-detected (when context.autoDetect):
        1. <repoRoot>/CLAUDE.md, AGENTS.md
        2. <repoRoot>/.rennet/conventions/**/*.md
        3. nearest-ancestor CLAUDE.md / AGENTS.md per changed file  (context.nearestAncestor)
        4. CONTRIBUTING.md, .github/pull_request_template.md
      plus context.documents globs (union across layers)
      minus context.exclude
  → read at context.ref (base by default; §2.5)
  → escape-check every resolved path against the repo root
  → order deterministically (below)
  → apply per-doc budget, then total budget, truncating at section boundaries
  → assemble, wrap each document in an explicit reference-material delimiter
  → emit ContextManifest as a durable event
  → invoke harness
```

Ordering is deterministic and specified rather than incidental, because a changed ordering changes model output and an unexplained change in review quality is unaffordable: (1) repo-root doctrine documents, in the fixed category order above; (2) nearest-ancestor documents, sorted by path depth then lexically; (3) changeset-specific material (PR body, linked ticket) last, because it is the most specific and closest to the question.

Budgets are in **bytes**, not tokens, deliberately. A token budget needs a tokenizer, the tokenizer differs per harness, and a budget that silently means different things per harness is worse than a slightly wrong one that means the same thing everywhere. The manifest reports bytes; the UI may show an estimated token count clearly labelled as an estimate, which is the same discipline the accounting model uses for derived USD.

Truncation is at section boundaries (markdown headings), head-first, and **always visible**: a truncated document appears in the manifest with its original and included byte counts. A context pipeline that silently drops the second half of a conventions doc produces reviews that are subtly wrong in a way nobody can trace.

### 6.2 The manifest, and the honesty problem inside it

```ts
export interface ContextManifest {
  manifestId: string
  reviewId: ReviewId
  patchsetId: PatchsetId
  assembledAt: number
  ref: { kind: 'base' | 'head' | 'worktree'; oid: string }
  documents: ContextDocument[]
  totalBytes: number
  budgetBytes: number
  /** Documents the pipeline selected but dropped for budget, so the omission is visible. */
  dropped: { path: string; bytes: number; reason: 'total-budget' | 'per-doc-budget' | 'unreadable' }[]
  /** TRUE only when the harness was proven to load nothing we did not supply. */
  exhaustive: boolean
  /** When exhaustive is false, what else the harness may have loaded on its own. */
  unmanagedSources: string[]
}

export interface ContextDocument {
  path: string                 // repo-relative
  bytes: number
  originalBytes: number
  sha256: string
  truncated: boolean
  selectedBy: ConfigLayer      // which layer put this document in the set
  origin: 'auto-detected' | 'configured' | 'changeset'
}
```

`exhaustive` is the field that keeps this honest, and it exists because of a real hazard. The v1 Claude adapter spawns the user's installed `claude` in print mode ([[reviews/wingman-adapter-licensing-codex-adjudication|the ratified adjudication]]), and a CLI running in the repo's cwd may load project settings, `CLAUDE.md`, and hooks on its own. If it does, a manifest claiming to be the complete context is a lie, and it is a lie about the exact thing this feature exists to prove.

So: the adapter attempts explicit isolation (the setting-sources flag or its equivalent per harness), and the manifest records whether isolation was **verified**, not whether it was requested. Where isolation cannot be proven, `exhaustive: false` and `unmanagedSources` names what may have loaded. The UI's "context sent" panel then says "plus whatever Claude Code loads from this project" rather than presenting a complete-looking list. Confirming isolation per harness is a cheap spike (§8) and it gates whether this panel can make a strong claim or only a partial one.

### 6.3 The "what was sent" surface

One panel, reachable from any harness answer and from the review's overflow menu:

- The document list with bytes, truncation marks, and the layer that selected each one.
- The dropped list, which is as important as the included list.
- The `exhaustive` claim, stated in words rather than as a green tick.
- **Open the assembled prompt**: the actual text, scrollable, copyable. No summary, no reconstruction. If the product's pitch is that the human stays the gate, the human can read the thing the model read.

Manifests are recorded per patchset, so "what did it see last time" is answerable after a force-push, which is the moment the question actually gets asked.

---

## 7. v1 dogfood cut

Rai's ratified v1 serves **both modes**: reviewing a locally generated diff before the PR exists, and reviewing someone else's PR. The settings and setup work is cut accordingly.

| Component | v1 | Note |
|---|---|---|
| Setting schema registry (zod, `sharing`, `merge`, `scopeAllowed` per key) | **MUST** | The registry is what makes every later rule mechanical |
| Eight-layer resolver returning `Resolved<T>` with contributions | **MUST** | Layering retrofits badly; ship it whole even with a thin UI |
| Schema-driven merge (`replace` / `union` / `deepMerge`) with `!` negation | **MUST** | |
| App-side store: `config.json`, per-scope files, atomic write, rotated backups | **MUST** | |
| Record table with aliases (common dir, forge, root-commit as a *hint*) | **MUST** | Directly answers the machine-local `RepoId` critique |
| Loud degradation on unparseable config, never silent reset | **MUST** | |
| Repo file **read** with shareable allowlist + path escape checks | **MUST** | |
| Trust gate on repo file first-sight and change | **MUST** | Cheap, and it is the injection defence |
| Context read at base ref, with per-review adopt-at-head override | **MUST** | |
| Settings inventory: harness, chunking, files, context, publish, findings, appearance | **MUST** | The subset in §3 minus LSP and angle presets |
| External editor: detection order, `editor.external.id` at G/W/R, degradation | **MUST** | The preference and its detection. The deep-link mechanics and the diff-surface affordance belong to the LSP plan |
| External editor: `custom` command template and per-editor arg overrides | LATER | The safe enum covers v1; free-text command is the power path |
| `Explain this setting` (contributions ladder) in palette and row menu | **MUST** | The provenance guarantee is worthless unless it is reachable |
| `check-settings-access.mjs` gate with failing fixtures | **MUST** | A check that cannot fail has not passed |
| First-run flow (gh + discovery + open a PR), zero questions | **MUST** | |
| Fresh-`HOME` zero-config acceptance test | **MUST** | The acceptance test for this whole document |
| Workspace add flow with the found-shape confirmation screen | **MUST** | |
| Discovery: depth/node/time caps, symlink escape, ignored-dirs-still-probed | **MUST** | |
| Discovery golden test against `/workspace` | **MUST** | Two independent mechanisms, worktree list authoritative |
| Context pipeline with deterministic ordering and byte budgets | **MUST** | |
| `ContextManifest` durable event + "what was sent" panel + open assembled prompt | **MUST** | |
| Per-repo settings surface with layer marks | **MUST** | Thin is fine; honest is not optional |
| Layer 6 changeset overrides (mechanism + `settings.overridden` event) | **MUST** | Mechanism MUST, dedicated UI LATER |
| `.rennet` project config, snapshot, knowledge, freshness and Git-visibility toggle | **MUST** | Persistent project context is a core input; stale context must be structurally unusable |
| `pin` block and its UI | LATER | Ship the resolver support, expose the control when a second user exists |
| Angle presets library and preset editing | LATER | `angles.enabled` / `angles.order` cover v1 |
| LSP settings surface | LATER | Follows [[Wingman LSP Integration Plan]] |
| `workspace.repos.hidden` / `pinned` | LATER | Discovery correctness first, curation second |
| Settings export / import bundle | LATER | The only sync story there will ever be; there is no cloud |
| Team preset packages (a shareable named angle+chunk+files bundle) | LATER | Interesting product surface; needs a second team |
| Settings replication to the mobile companion | LATER | Must not leak local paths; see §8 |

The deliberate asymmetry: everything that shapes **stored data or identity** is MUST (records, aliases, layers, events), and almost everything that is only **surface** is LATER. Config surfaces are cheap to add and stored-shape mistakes are not.

---

## 8. Open questions and refinement hooks

**Frozen: do not change without escalating**

- Personal keys never appear in a committed file, enforced by the schema registry and a test over it.
- No shareable key may name an executable, a command, an endpoint, an env var, or an absolute path. Asserted over the registry, so a future setting cannot quietly violate it.
- Automatic source-checkout writes are confined to Rennet-owned `.rennet/` project context. Rennet never stages, commits, changes branches, mutates `.git`, or writes user source.
- The resolver returns provenance; there is no bare-value read path.
- Discovery is read-only, bounded, and never escapes the root.
- Pace and coverage privacy is not a setting.

**Adjustable with evidence**

- Depth cap (4), node cap, and wall-clock cap for discovery. Tune against real workspaces; record the numbers.
- Context budgets (96KB total, 32KB per document). Tune against actual harness behaviour on large PRs.
- Backup rotation count (5).
- Which documents are auto-detected and in what category order.

**Genuinely open**

1. **`angles.decisions.maxItems` has no number.** The hub requires a hard visible cap and never sets one; the angle cannot ship without it. Cheapest resolution: run the decisions angle over ten real the enterprise client PRs with no cap and look at the distribution before choosing.
2. **Can each harness be proven to load no context we did not supply?** Gates whether `ContextManifest.exhaustive` can ever be true. Half a day per harness: run with isolation flags, diff observed behaviour against a repo with a deliberately distinctive `CLAUDE.md`, and confirm the marker does or does not reach the answer. A positive control is essential here; absence of the marker in one answer proves nothing on its own.
3. **Bytes or tokens for the context budget.** Bytes chosen for cross-harness consistency; revisit if the byte budget produces wildly different token counts for different repos' document styles.
4. **Does `repo-shared` really outrank `global`?** The `pin` escape hatch makes the call survivable either way. Watch for the first time a pin is needed for a setting other than `chunk.budgetLoc`; if pins proliferate, the ordering is wrong.
5. **Monorepo sub-package settings.** v1 puts one `.rennet/project.jsonc` at the repo root only, and covers most of the monorepo want through nearest-ancestor context documents. If nearest-ancestor context is not enough, nested project files can apply the same ladder by path depth.
6. **File format.** JSONC chosen for comments (a shared conventions file whose values cannot be explained is half a file). TOML is friendlier to hand-edit and worse at nesting; YAML is a footgun. Weak conviction, cheap to change before anyone commits a file, impossible after.
7. **Which layers replicate to the phone.** The phone must render harness pickers and angle sets, so it needs some resolved values, but the architecture critique is explicit that path-bearing models must not go to remote clients. Likely answer: the phone receives a *resolved, path-stripped projection* of the settings it can act on, never the layers or the files. Needs designing alongside the pairing protocol, not after.
8. **Config schema versioning.** Config is not event-sourced, so the migration story is a `schemaVersion` field plus forward migrations applied on read and written back on next save, with a backup taken first. Unspecified in detail; needed before the first setting is renamed.
9. **Where do angle presets live once they are shareable?** A preset is a bundle of settings, which makes it either a config value (simple, nests awkwardly) or a first-class object with its own identity (cleaner, more machinery). Deferred with the preset feature.
10. **Does `editor.external.id: 'auto'` re-resolve per launch or bind once?** Re-resolving means installing Cursor changes behaviour with no action required, which is the Brita-filter answer; binding once means behaviour is stable and explicable. Leaning re-resolve, with the resolved editor shown on the settings row so the change is visible rather than mysterious. Also unresolved: whether "running application bundles" outranking "installed bundles" is delightful or erratic, since it makes the target editor depend on what happens to be open.
11. **Does the trust gate need per-key granularity?** Currently the whole repo file is accepted or not. If a repo file grows to the point where a user wants to accept the globs but not the context documents, granularity becomes necessary. Watch for it; do not build it speculatively.

---

## 9. Bead candidates

| # | Title | Description | P | Depends on |
|---|---|---|---|---|
| S1 | Setting schema registry with `sharing` / `merge` / `scopeAllowed` | zod schema per key, plus the registry-level tests: no personal key is shareable, no shareable key names an executable/command/endpoint/env var/absolute path. These tests are the mechanism, not documentation | P0 | repo scaffold |
| S2 | Eight-layer resolver returning `Resolved<T>` with contributions | Precedence ladder, four merge strategies including guidance-only `append` and `!` negation on unions, `pin` support in the resolver. Property test: resolution is a pure function of the layer stack, and every contribution is reported whether or not it won | P0 | S1 |
| S3 | App-side config store: atomic writes, rotated backups, loud degradation | Global file, per-scope files, temp-write-fsync-rename, five rotations, and the parse-failure path that skips the layer, surfaces a diagnostic naming file and error, and never rewrites what it could not read. Test the corrupt-file case explicitly | P0 | S1 |
| S4 | Record table and alias resolution (the machine-local `RepoId` fix) | `RepoRecord` / `WorkspaceRecord` with uuidv7 ids; alias match order common-dir → forge identity → root-commit OID as an *offer* not a bind. Tests: move a repo, re-clone a repo, fork a repo, assert settings follow in the first two and are only offered in the third | P0 | S1 |
| S5 | Project file reader with allowlist, escape checks, and the trust gate | Parse `.rennet/project.jsonc`, drop non-shareable keys with diagnostics, reject `..`/absolute/symlink-escaping paths, and hold untrusted human-authored instruction changes inert until accepted. Fixtures include each hostile case | P0 | S2, S4 |
| S6 | `check-settings-access.mjs` gate with failing fixtures | Fails the build on `.value` access outside the permitted call sites; ships with fixtures that violate it and a `--self-test` that fails if the fixtures pass | P0 | S2 |
| S7 | Workspace and repo discovery with the full prohibition set | Depth/node/wall-clock caps with a visible stopped-early state, symlink realpath escape checking with a visited-inode set, ignored directories still probed for repo-ness, read-only `GitPort` command allowlist. Golden test against `/workspace`: root-is-a-repo, nested product-repo, `wt/*` and `.claude/worktrees/*` attributed to product-repo, symlinked `openspec` producing no duplicate | P0 | GitPort |
| S8 | Walk-vs-worktree-list reconciliation | Treat the directory walk as a hint and `git worktree list --porcelain` as authoritative; record and surface any disagreement rather than picking silently. This is the calibration that makes S7's ignored-directory rule safe | P0 | S7 |
| S9 | First-run flow and the fresh-`HOME` acceptance test | One screen, no questions: gh token, harness discovery, open a PR. Automated test with an empty `HOME` and no Application Support directory asserting a decomposed review with zero config files anywhere | P0 | S3, S7, harness discovery |
| S10 | Workspace add flow with the found-shape confirmation | The tree screen from §5.2, one confirm, nothing written into any repo. Renders correctly for the one-repo case (project mode as a display variant, not a code path) | P0 | S7 |
| S11 | Context document pipeline: selection, ordering, budgets, delimiters | Auto-detection set, nearest-ancestor resolution, union of configured globs, deterministic ordering, section-boundary truncation, reference-material wrapping. Golden tests on ordering, because a changed order silently changes review quality | P0 | S2, S7 |
| S12 | Context read at base ref, with the adopt-at-head override | Base-ref default for PR review, worktree for self-review, a visible row when the changeset edits context documents, and a layer-6 override recorded as an event. Test: a PR adding an adversarial `CLAUDE.md` does not change its own review's prompt | P0 | S11 |
| S13 | `ContextManifest` event and the "what was sent" panel | Per-patchset manifest with hashes, truncation, dropped list, `exhaustive`, `unmanagedSources`; panel including open-the-assembled-prompt | P0 | S11 |
| S14 | SPIKE: can each harness be proven to load no unmanaged context? | Distinctive-marker repo, isolation flags per harness, positive control first (prove the marker is detectable when context IS supplied), then the negative. Sets whether `exhaustive` can ever be true. Verdict to the vault | P0 | S13 |
| S14b | External editor detection and preference | Closed `EditorId` enum with a *verified* line-and-column argument template per entry (an untested template is a broken menu item, not a feature). Detection order: explicit setting, running app bundles, installed bundles, PATH shims, then `$VISUAL`/`$EDITOR` from the login-shell harvest, then degrade to Reveal in Finder. `id` settable at global/workspace/repo (app-side layer 5); `command` global only. Coordinate with the LSP plan's deep-link work, do not duplicate it | P1 | S2, harness discovery PATH harvest |
| S15 | Per-repo settings surface with layer marks and Explain | Effective value plus winning layer per row; the four row actions; the untrusted-repo-file banner; backlight blue for private rows | P1 | S2, S5 |
| S16 | Layer 6 changeset overrides and `settings.overridden` | Mechanism, event, restoration on review re-open, and the publish-preview statement when a review ran under non-default settings | P1 | S2, event store |
| S17 | Decide `angles.decisions.maxItems` from real data | Run the decisions angle uncapped over ten real the enterprise client PRs, look at the distribution, choose the cap, record it here. The angle cannot ship without it | P1 | decisions angle |
| S18 | `.rennet` project snapshot and Git-visibility modes | Generate deterministic snapshot plus learned knowledge with provenance/fingerprints; incrementally refresh on default-branch movement; block stale inputs; `local`/`git-visible` toggle; never `git add`, commit, change branches, mutate `.git`, or touch user source | P0 | S4, S5, context pipeline |
| S19 | `pin` block and its row control | Resolver support ships in S2; this is the UI plus the provenance display of a pin-suppressed shared value | P2 | S15 |
| S20 | Config schema versioning and forward migration | `schemaVersion`, migrations applied on read and written back on next save with a backup first, plus golden fixtures of every historical shape. Needed before the first key is renamed | P2 | S3 |
| S21 | Settings projection for the mobile companion | Path-stripped, resolved-only projection of the settings the phone can act on; never layers, never files, never local paths. Designed with the pairing protocol, not after it | P3 | pairing protocol |
| S22 | Settings export / import bundle | The entire sync story: a file the user moves. No cloud, no account, no account-shaped anything | P3 | S3 |

---

## Related

- [[Code Review Harness App]]: product hub, the four-noun model, the zero-config North Star, the ratified decisions
- [[Wingman Architecture Plan]]: workspace types, event-sourced state, D9 privacy-by-construction, the v1 cut this one mirrors
- [[Wingman Harness Adapter Protocol]]: discovery, the PATH trap, capability flags, read-only sandbox posture, the utility tier
- [[Wingman Repo Bootstrap Plan]]: `CLAUDE.md` doctrine, the gate culture this config design borrows its enforcement style from
- [[Wingman GitHub Integration Plan]]: the auth rungs behind first run, publish event vocabulary
- [[reviews/wingman-architecture-codex-critique]]: the machine-local `RepoId` finding that shapes §2.3
- [[reviews/wingman-adapter-licensing-codex-adjudication]]: three-layer capability flags, raw-frame confidentiality, the CLI adapter that creates the `exhaustive` problem in §6.2
- [[Wingman LSP Integration Plan]]: pending; §3.8 fixes its config surface in advance because it has a security shape, and §3.9 owns the external-editor *preference* while that plan owns the deep-link mechanics and the diff-surface affordance
