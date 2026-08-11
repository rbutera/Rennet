---
tags: [rennet, architecture, contracts]
categories: [project]
status: active
created: 2026-08-05
updated: 2026-08-05
related:
  - "[[Rennet Contracts and Rulings]]"
  - "[[Rennet Navi Handoff]]"
  - "[[Rennet Decision Integration Tasks]]"
source: codex
---

# Rennet Architecture Contracts

This note is the authoritative contract for project context, review snapshots, persistence, harness access, and publication in [[Code Review Harness App|Rennet]]. It records Rai's decisions from 2026-08-05 and resolves the relevant contradictions in [[Wingman Architecture Plan]], [[Wingman Settings and Setup Plan]], [[Wingman LSP Integration Plan]], [[Wingman Harness Adapter Protocol]], [[Wingman GitHub Integration Plan]], [[Wingman Surfacing DSL and Model Routing Plan]], and [[Wingman Repo Bootstrap Plan]].

Where this note conflicts with those subordinate plans, **this note wins**. [[Rennet Contracts and Rulings]] remains authoritative outside this note's scope.

## 1. Invariants

These are build constraints, not preferences:

1. A review always targets an immutable `Patchset`. The working tree and a remote PR head may move; a `Patchset` may not.
2. Every analysis artifact names the exact project snapshot, patchset, inputs, generator, and instructions that produced it.
3. Stale project context is never silently used. It is refreshed, or used with the degradation visible and named.
4. Invalidation is detected and classified automatically, and Rennet may regenerate automatically where that makes the review better. Model spend is not gated (§7.2).
5. Rennet writes, commits, and pushes on the acting path — handing work to a coding harness and submitting a PR both require it. It never stages its own `.rennet/` context into the user's Git index, and a review only reaches a forge on the user's explicit act.
6. Persistent project knowledge lives under `.rennet/`. Temporary checkouts, prompt staging, language-server materialisations, and provider frames do not.
7. A harness receives an immutable review materialisation and explicitly assembled context by default, and may run against the live checkout when the task needs it.
8. A repeated command cannot repeat an internal mutation or an external side effect.
9. Unknown durable events are preserved byte-for-byte and never skipped to produce a plausible projection. Projection of the affected review fails closed; what cannot be computed is named rather than guessed, and the warning travels with done, regeneration, and publish instead of refusing them.
10. “Delete review” removes every Rennet-controlled copy of that review and states the limits of deletion outside Rennet's control.

## 2. Project context and `.rennet`

### 2.1 Ownership boundary

`.rennet/` is the repository-local home for durable configuration and project knowledge:

```text
.rennet/
├── project.jsonc               # human-readable project configuration
├── snapshot/
│   ├── manifest.json           # identity, freshness, versions, dependency graph
│   └── shards/                 # deterministic codebase map, split for incremental updates
├── knowledge/                  # learned conventions and architectural knowledge
└── .gitignore                  # Rennet-managed only in local visibility mode
```

`snapshot/` contains a useful structural map, not a copy of the repository. It may describe files, packages, symbols, public contracts, entry points, dependency edges, test relationships, ownership boundaries, and configured conventions.

`knowledge/` contains learned project knowledge. Every learned statement must carry evidence, provenance, confidence, and the snapshot against which it was learned. Model-derived knowledge is a labelled hypothesis until confirmed by deterministic evidence or a human. It may guide exploration, but it may not override current code or a current deterministic map.

The following never live under `.rennet/`:

- materialised source trees or language-server checkouts;
- temporary prompt files and assembled provider payloads;
- review event stores and private reviewer state;
- GitHub, harness, or provider credentials;
- raw harness frames or provider transcripts;
- application logs, crash dumps, and caches.

Those belong to Rennet's application-owned storage described in §7.

### 2.2 Project context visibility

The project setting `projectContext.visibility` has exactly two values:

| Value | Behaviour |
|---|---|
| `local` | Default. Rennet maintains `.rennet/` while a Rennet-owned `.rennet/.gitignore` keeps its contents out of normal Git status. |
| `git-visible` | Rennet removes only its own local-mode exclusion. Stable config, snapshot, and knowledge changes become visible for the user to review and commit. |

Changing visibility is explicit and previews the filesystem diff. Rennet stops after changing the files. It never runs `git add`, `git rm --cached`, or `git commit`.

If `.rennet` files are already tracked, switching to `local` cannot make them untracked without changing the Git index. Rennet must explain that and leave the index untouched. It must never report that context is omitted from Git when tracked files still exist.

Rennet may create and incrementally maintain `.rennet/` after project context is enabled. This is the explicit exception to the older rule that Rennet never creates `.rennet/`. Discovery alone still writes nothing.

Repo-supplied `.rennet` content is read as-is. Shareable-key allowlists and repo-relative path escape checks continue to apply because they stop real breakage, and the run ledger records which ref the context came from.

### 2.3 `ProjectSnapshot`

A `ProjectSnapshot` is a deterministic, immutable description of the project at one resolved default-branch commit:

```ts
interface ProjectSnapshot {
  projectSnapshotId: ProjectSnapshotId
  projectId: ProjectId
  defaultBranch: { remote: string | null; name: string; oid: RefOid }
  sourceTreeDigest: Digest
  configDigest: Digest
  generator: { name: string; version: string; schemaVersion: number }
  toolchainDigests: Record<string, Digest>
  shardDigests: Record<string, Digest>
  dependencyGraphDigest: Digest
  createdAt: number
  supersedes: ProjectSnapshotId | null
}
```

The default branch is resolved in this order: forge metadata, the remote's symbolic `HEAD`, a locally configured upstream, then an explicit Rennet setting. A guessed branch name is never silently treated as authoritative.

`projectSnapshotId` is derived from the source OID, configuration digest, generator/schema versions, and deterministic input/toolchain digests. The same inputs must produce byte-identical snapshot shards and the same identity.

### 2.4 Freshness and incremental updates

Rennet checks the resolved default-branch OID on project open, application focus, explicit refresh, and whenever its forge poll observes a change. It does not mutate the source repository to do this. Remote objects required for background analysis live in an app-cache-owned mirror or equivalent app-owned object store.

When the default branch advances:

1. Record the previous and next OIDs.
2. Compute the changed paths and affected dependency-graph closure.
3. Rebuild only affected deterministic shards.
4. Invalidate learned knowledge whose evidence or dependencies changed.
5. Write a new immutable `ProjectSnapshot` and atomically advance the current pointer only after validation succeeds.

Unchanged shards are content-addressed and reused. An incremental build must be byte-identical to a clean full rebuild for the same inputs.

Freshness is evaluated at use time, not inferred from age:

- `current`: source OID, config, generator, schema, toolchain, and every consumed shard digest match;
- `updating`: a newer source OID is known and the replacement is being built;
- `stale`: at least one required fingerprint differs;
- `failed`: refresh failed and no current snapshot exists for the requested inputs.

A dependent operation may consume only `current` artifacts. If context is `updating`, `stale`, or `failed`, Rennet must either finish regeneration first or run without that context and show the exact degradation. It may not pass stale context to a harness as though it were current.

## 3. Reviews and immutable patchsets

### 3.1 Canonical review unit

```ts
interface Review {
  reviewId: ReviewId
  projectId: ProjectId
  source: WorkingTreeReviewSource | PullRequestReviewSource
  activePatchsetId: PatchsetId
  createdAt: number
}

interface Patchset {
  patchsetId: PatchsetId
  reviewId: ReviewId
  ordinal: number
  baseOid: RefOid
  head: { kind: 'git'; oid: RefOid } | { kind: 'working-tree'; snapshotId: WorkingTreeSnapshotId }
  contentManifestDigest: Digest
  projectSnapshotId: ProjectSnapshotId
  capturedAt: number
  supersedes: PatchsetId | null
}
```

Patchsets are append-only. A new local capture, PR push, force-push, rebase, or change to the effective base creates a new patchset. Nothing rewrites the previous patchset or its analysis.

### 3.2 Local pre-PR reviews

The base is the merge-base between the checked-out branch and its explicit upstream target. If no upstream exists, use the resolved default branch. The UI must display the chosen base and allow an explicit override.

A `WorkingTreeSnapshot` captures, as immutable bytes and identities:

- committed branch changes from the base to `HEAD`;
- the index;
- unstaged tracked changes;
- non-ignored untracked files;
- file modes, renames, deletions, binary/submodule state, and incomplete-ingestion markers.

It excludes `.git` internals, ignored files, and Rennet's local-only context. Git-visible `.rennet` changes remain visible as project-metadata changes but are not allowed to recursively change the context used to analyse the same patchset.

The capture is created without writing the working tree or Git metadata. Rapid filesystem events may be debounced into one offered capture, but every patchset shown to the user is immutable.

### 3.3 Remote pull-request reviews

Each patchset pins the forge-reported base and head SHAs. A remote branch update creates a new immutable patchset; it never edits the active one in place.

When a new remote patchset appears, Rennet:

1. preserves the patchset currently being read;
2. shows the head/base change and the delta since the last synthesis;
3. maps occurrences through the lineage graph;
4. keeps exact unaffected analysis current;
5. marks affected analysis invalid or potentially invalid;
6. offers affected-only regeneration and a new-patchset review.

A force-push is the same transition with non-linear lineage. An old patchset remains inspectable while its backing objects remain in Rennet-controlled storage.

### 3.4 Occurrences, lineage, and read state

An `Occurrence` is patchset-scoped and immutable. Lineage edges are `exact`, `one-to-one`, `move`, `split`, `merge`, `ambiguous`, or `rejected`.

Only an exact, byte-identical occurrence with matching contextual disambiguators may carry analysis and read state automatically. Similarity is evidence for a possible continuation, never identity. A changed, split, merged, or ambiguous occurrence reopens for review. Ambiguity fails closed.

## 4. Analysis invalidation and regeneration

Every analysis artifact has one of these user-visible states:

| State | Meaning |
|---|---|
| `current` | Every input fingerprint still matches. |
| `invalid` | A directly referenced occurrence, source, instruction, or deterministic dependency changed. |
| `potentially-invalid` | A related symbol, dependency, configuration input, project-snapshot shard, or ambiguous lineage changed. |
| `regenerating` | Replacement generation is in progress against the new patchset. |
| `superseded` | A validated replacement succeeded. |
| `failed` | Replacement failed; the old stale artifact remains visible with the failure. |

Invalidation is automatic and deterministic, and regeneration is not gated on a permission step (§7.2). It can also be invoked directly, so the UX must support:

- **Regenerate affected analysis** across the patchset;
- regeneration of one angle;
- regeneration of one artifact or item;
- a before/after view showing what the replacement supersedes;
- cancellation without destroying the previous artifact.

Affected-only regeneration runs against the new immutable patchset and a `current` project snapshot. It reuses unaffected valid artifacts and asks the harness only for invalid or potentially invalid portions plus the dependency context needed to reason about them.

## 5. Canonical persistent model

The following entities are authoritative. Subordinate plan type sketches are illustrative until aligned to this model.

| Entity | Identity and role |
|---|---|
| `Project` | Stable `projectId`; repository aliases, forge identity, default-branch policy, and current project snapshot pointer. |
| `ProjectSnapshot` | Immutable deterministic project map at one default-branch OID and one complete input fingerprint. |
| `Review` | Stable review lifecycle over one source and an ordered series of patchsets. |
| `Patchset` | Immutable base/head-or-working-tree snapshot plus project context identity. |
| `Occurrence` | Immutable patchset-scoped reviewable unit; agents may reference it but never mint it. |
| `AnalysisArtifact` | Validated lens/decomposition/spec/claim/test/finding/noise output with complete provenance and supersession. |
| `Finding` | An evidenced assertion requiring human disposition; never itself a GitHub comment. |
| `Obligation` | A required human decision or action, with explicit lifecycle and disposition. Reading alone cannot discharge it. |
| `Discussion` | Local thread with an optional occurrence/artifact anchor and optional external publication refs. |
| `Command` | Idempotent requested state transition with actor, payload digest, and concurrency expectation. |
| `Event` | Immutable accepted fact emitted by a command or observed external change. |

Every derived artifact carries at minimum:

```ts
interface ArtifactProvenance {
  artifactId: ArtifactId
  schemaVersion: number
  reviewId: ReviewId
  patchsetId: PatchsetId
  projectSnapshotId: ProjectSnapshotId
  inputFingerprint: Digest
  contextManifestId: ContextManifestId
  generator: { kind: 'deterministic' | 'harness' | 'human'; name: string; version: string }
  harness?: { id: string; version: string; sessionId: string | null }
  model?: { id: string | null; reportedBy: 'harness' | 'config' | 'unknown' }
  instructionDigest: Digest
  createdAt: number
  supersedes: ArtifactId | null
}
```

The `inputFingerprint` covers the offered occurrence manifest, selected project-snapshot shards, assembled context and instructions, effective settings, schema/validator versions, and deterministic tool versions. Same fingerprint means reuse is permitted. A changed fingerprint means revalidation or regeneration is required.

## 6. Commands and idempotency

Every state-changing command includes:

```ts
interface Command {
  commandId: CommandId
  name: string
  actor: Actor
  reviewId: ReviewId | null
  expectedSeq: number | null
  payloadDigest: Digest
  issuedAt: number
}
```

The store records a durable command receipt. Command receipt, emitted events, projection updates, and result commit in one transaction.

- Repeating the same `commandId` and payload returns the recorded result without rerunning work.
- Reusing a `commandId` with a different payload is rejected.
- An `expectedSeq` mismatch rejects as a concurrency conflict rather than applying against surprising state.
- Cancellation and failure are durable outcomes where required for reconciliation.

External mutations add a deterministic external idempotency marker and a query-before-retry reconciliation step. A timeout after GitHub acceptance becomes `outcome-unknown`; it is never blindly retried.

## 7. Storage, privacy, and deletion

### 7.1 Storage classes

| Storage | Contents | Rule |
|---|---|---|
| Repository `.rennet/` | Project config, deterministic map, evidence-backed knowledge | Controlled by the local/Git-visible setting. No secrets or review-private state. |
| Application Support | Event store, projections, review artifacts, necessary immutable patch/diff blobs, settings, encrypted secrets | Durable until user deletion or configured retention. |
| Application cache | App-owned Git object mirror, source materialisations, LSP indexes, prompt staging, temporary provider payloads | Rebuildable and safely evictable. Never attached to the source repo via `git worktree add`. |
| Provider/harness-owned storage | Foreign transcripts and provider-side retention | Never treated as Rennet's source of truth; disclosed as outside Rennet's deletion boundary. |

Raw harness frames are off by default. If enabled for diagnostics, the setting states the contents and retention period, applies a hard size cap, and makes them part of review deletion. Secrets, authorization headers, and environment credentials are always redacted before any diagnostic persistence.

### 7.2 Harness read authority and egress

The default harness working directory is an app-cache-owned immutable materialisation of the patchset. By default it is given:

- captured patchset content;
- selected current project-snapshot shards and accepted knowledge;
- explicitly assembled context documents and instructions;
- the output-schema and occurrence manifest required by the task.

Writes, execution, MCP servers, hooks, and ambient project settings are available to the harness — an agent that cannot run the tests it just wrote is not much use. Where a harness's inputs cannot be fully enumerated, the `ContextManifest` sets `exhaustive: false`, names the possible unmanaged sources, and the UI does not claim a complete egress manifest it does not have.

These facts stay available while a harness runs — in the title-bar execution-mode glyph, the per-run narration line, and the run ledger (R31):

- executable, version, model-selection source, and provider;
- exact read roots;
- whether user configuration, hooks, MCP servers, or other ambient context may load;
- that selected source/context may leave the machine for the harness's provider;
- reported or estimated spend visibility and the applicable budget;
- a link to the exact assembled prompt/context manifest for each run.

The truthful product claim is: **Rennet has no Rennet backend. Data is processed locally except for material explicitly sent through the user's selected harness/provider.** “Nothing leaves your machine” and unqualified “no cloud” are prohibited claims.

Running a model to review code is Rennet's core function, so model spend is not gated: an initial generation or regeneration just runs, under the disclosure and budget above (deterministic refresh needs no model at all). A shared repository setting may never raise spend. Sending a review OUT to a forge is different — publishing to GitHub is the user's own act (invariant 5), never a silent post.

### 7.3 Deleting a review

“Delete review” must remove:

- its events, projections, command receipts, artifacts, patch/diff blobs, prompts, manifests, raw frames, and external-ID mappings;
- every app-cache materialisation, LSP index, and temporary file reachable from it;
- review-scoped secrets, if any;
- review content from Rennet-managed rotated backups before deletion reports success.

SQLite deletion must cover WAL/journal content and be followed by the compaction/checkpoint mechanism required to make deleted rows absent from Rennet-controlled files. The deletion acceptance test searches every Rennet-controlled storage root and backup for seeded review identifiers and content.

Rennet must disclose that it cannot erase copies already sent to a provider or GitHub, harness-owned transcripts, user-created exports, filesystem snapshots, or system backups outside Rennet's control.

### 7.4 Unknown events and migrations

Events are immutable and upcast on read. Projections are disposable and rebuild from the event log.

An unknown event type or unsupported event version is preserved byte-for-byte. Projection of the affected review fails closed rather than skipping the event and presenting a plausible partial as complete; the UI reports the exact unsupported type/version and the application version that would understand it. Done, regeneration, and publish are not refused — they carry that warning with them, loudly, so nothing is published as though it were derived from state Rennet could compute.

A store written by a newer schema opens and says so. Migrations take a verified backup first.

## 8. GitHub secret ownership

GitHub credentials remain host-owned:

- Rung 0 calls `gh auth token`; the token is held in memory for the shortest practical lifetime and is never persisted by Rennet.
- Rennet never parses `hosts.yml`, reads a harness auth file, or reads another application's Keychain item.
- Pasted PATs and future GitHub App refresh tokens are stored only through `SecretStorePort` backed by Electron `safeStorage` when strong OS encryption is available.
- If strong secret storage is unavailable, Rennet refuses persistence and requires authentication again next launch.
- Tokens never enter core domain objects, events, logs, crash reports, context manifests, or renderer state. `ForgePort` receives a host-side token provider, not a token value.
- Disconnecting GitHub deletes every Rennet-owned token and invalidates in-memory providers.

## 9. Publication contract

### 9.1 Author-side pre-PR review

Completing a local review creates a **PR submission preview** containing the proposed title, body, draft/base/head metadata, surfaced decisions, and publication/degradation ledger. Preview is a pure local projection. It does not push a branch, create a PR, update a PR, post comments, or resolve threads.

The user may copy the preview. Creating or updating the PR is a separate, explicitly labelled GitHub mutation, idempotent under §6, and it pushes the branch as part of that act (R33).

### 9.2 Reviewer-side publication

Publishing a review is prepare → inspect → sign → submit. The prepare step records canonical outbound bytes and their digest. The sheet shows every comment, body section, review event, anchor degradation, and private item that will remain local.

Submit is one explicit idempotent action pinned to the reviewed head SHA. It uses GitHub's pending-review batch where supported, then one submit. Every other GitHub mutation, including PR creation/update, replies, thread resolution, and review submission, has its own explicit action and command ID. No setting may enable auto-comment, auto-approve, auto-resolve, or automatic retry after an unknown outcome.

## 10. Acceptance criteria

Every criterion below ships with a seeded violation that makes it fail — a check that cannot fail has not passed:

- A clean full `ProjectSnapshot` and an incremental update at the same OID are byte-identical.
- Changing a source/config/tool fingerprint marks dependent context stale and shows the degradation; no harness request presents a stale shard as current.
- Fresh local context updates leave `git status` unchanged in `local` mode, while `git-visible` mode exposes files without staging or committing them.
- Opening or reviewing a repository does not change its working tree, index, refs, config, hooks, `.git/worktrees`, or other Git metadata, apart from the explicitly enabled `.rennet` context files.
- A working-tree capture includes committed, staged, unstaged, and non-ignored untracked changes and remains inspectable after the live tree changes.
- A PR head update creates a second patchset; the first remains byte-identical and inspectable.
- Exact unchanged occurrences retain valid analysis; changed and ambiguous occurrences reopen and cannot inherit `read` through similarity.
- Seeded direct and dependency changes produce `invalid` and `potentially-invalid` states respectively.
- A failed or cancelled regeneration leaves the stale prior artifact visible and does not mark it current.
- Two identical commands yield one event range and one result; a duplicate publish yields one GitHub side effect under failure injection.
- The displayed assembled prompt is byte-identical to the bytes supplied to the harness; unmanaged sources are never hidden.
- A deleted review leaves no seeded identifier or content in any Rennet-controlled database, WAL, backup, blob store, or cache.
- A seeded unknown event survives byte-for-byte, fails its projection closed rather than producing a plausible partial, and warns on done, regeneration, and publish rather than blocking them.
- `gh` tokens never appear in durable storage or renderer messages; persisted tokens are rejected when strong OS encryption is unavailable.
- Author preview causes zero Git or GitHub mutations. Every external mutation requires a separate explicit act and survives timeout/retry without duplication.

## Related

- [[Rennet Contracts and Rulings]]
- [[Rennet Navi Handoff]]
- [[Rennet Decision Integration Tasks]]
- [[Wingman Architecture Plan]]
- [[Wingman Settings and Setup Plan]]
- [[Wingman LSP Integration Plan]]
- [[Wingman Harness Adapter Protocol]]
- [[Wingman GitHub Integration Plan]]
- [[Wingman Surfacing DSL and Model Routing Plan]]
- [[Wingman Repo Bootstrap Plan]]
