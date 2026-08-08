# Rennet architecture

This is the implementation authority for review identity, persistence, privacy, publication, package boundaries, and dependencies. It consolidates the former architecture contracts and dependency standard; where it conflicts with a historical plan, this document wins.

## Invariants

1. A review targets an immutable `Patchset`; working trees and PR heads may move, patchsets never do.
2. Every artifact records its patchset, project snapshot, inputs, generator, context manifest, instructions, and supersession.
3. Stale project context is refreshed, visibly omitted, or blocks dependent work—never silently used.
4. Detect invalidation automatically; invoke a model only after an explicit user action.
5. Never write a source checkout, Git index, branch, or external review without a distinct user action; never commit or push on the user's behalf.
6. A repeated command must not repeat an internal mutation or an external side effect.
7. Unknown durable events fail closed; delete-review removes every Rennet-controlled copy.
8. A harness reads an immutable app-owned materialisation plus explicit context by default, never the live source checkout.

## Stable boundaries

```text
types  ← no in-repo imports
protocol ← types
core ← protocol
adapters ← core + Node/Electron host capabilities
ui ← types + protocol + browser-safe dependencies
desktop ← the only Electron composition root
```

`ui` never imports `core`; typed IPC is the renderer/engine boundary. Public RSP documents are versioned JSON Schema validated with Ajv and generated TypeScript checked for drift. Private commands, events, settings, and IPC are Zod-first. Package versions are exact pins; pnpm owns packages, Nx owns the local graph/cache, Vite owns renderer builds, and Electron Forge is the sole packaging owner.

## Project context and storage

| Location | Holds | Does not hold |
|---|---|---|
| Repository `.rennet/` | `project.jsonc`, deterministic default-branch snapshot shards, evidence-backed learned knowledge | Review-private state, provider frames, credentials, materialisations, logs, or caches |
| Application support | Event store, projections, review artifacts, immutable patch/diff blobs, settings, encrypted secrets | Source-repository state |
| Application cache | Mirrors, materialised trees, LSP indexes, prompt staging, temporary provider payloads | Durable source of truth |
| Provider/harness storage | Foreign transcripts/retention | Rennet-controlled data |

`.rennet/` is `local` by default (Rennet's managed ignore keeps it out of Git status) or explicitly `git-visible`; switching previews filesystem changes and never stages or commits. Repo-supplied context is untrusted and read from the base ref. A deterministic `ProjectSnapshot` is pinned to the resolved default-branch OID and input fingerprints; incremental rebuilds must be byte-identical to full rebuilds. Knowledge carries evidence, confidence, provenance, and its snapshot; model-derived knowledge is a labelled hypothesis until confirmed.

## Review model, lineage, and freshness

A `Review` owns an ordered history of immutable patchsets. Working-tree capture includes branch changes, index, unstaged tracked changes, nonignored untracked files, modes, renames, deletions, binary/submodule state, and explicit incomplete-ingestion markers. PR capture pins forge-reported base/head SHAs. A change creates a successor patchset while leaving the prior one inspectable.

Occurrences are patchset-scoped. Lineage may be exact, one-to-one, move, split, merge, ambiguous, or rejected. Only byte-exact, context-confirmed continuity carries artifacts/read state automatically; changed, split, merged, and ambiguous material reopens.

Artifacts visibly move through `current`, `invalid`, `potentially-invalid`, `regenerating`, `superseded`, and `failed`. A failed or cancelled replacement retains the prior artifact. Regeneration may target the affected set, one angle, or one item; it runs on the successor patchset and a current project snapshot.

## Persistence and side effects

Commands include a stable ID, payload digest, actor, review, and expected sequence. Command receipt, events, projections, and result commit in one transaction. Same ID + same payload returns the recorded result; same ID + different payload fails; sequence conflicts fail rather than silently apply. External mutations have an idempotency marker and query-before-retry reconciliation; timeout after acceptance becomes `outcome-unknown`.

Events are immutable, projections are disposable, and migrations take a verified backup. Unsupported history is retained byte-for-byte but blocks normal projection, completion, regeneration, and publish.

## Harness, privacy, and secrets

The default harness allowlist is captured patchset content, selected current snapshot shards/accepted knowledge, explicit context/instructions, and the task schema/occurrence manifest. Writes, arbitrary execution, inherited hooks/MCP, and ambient settings are denied unless a capability-specific feature both needs and discloses them. If isolation is unproven, mark the manifest non-exhaustive.

Before use, disclose the executable, version, provider/model source, read roots, denied capabilities, unmanaged ambient sources, egress, budget/spend visibility, and the exact assembled prompt. Automatic deterministic refresh needs no spend consent; model-backed work needs explicit consent. GitHub tokens remain host-owned (`gh` token is ephemeral); persisted Rennet secrets use strong OS storage only and never enter domain events, logs, manifests, or renderer state.

## Publication and deletion

- **Author-side:** produce a local PR submission preview (title/body/draft/base/head/degradation ledger); copying is allowed, creating/updating a PR is a separately labelled idempotent action, and Rennet never pushes source code.
- **Reviewer-side:** prepare canonical outbound bytes, inspect the paper, sign, then submit one pending-review batch pinned to the reviewed head. Every other GitHub mutation is separately explicit.
- **Deletion:** remove review events, projections, receipts, artifacts, patch/diff blobs, prompts, manifests, raw frames, IDs, materialisations, LSP indexes, temporary files, review secrets, and reachable backups/WAL content. State the limits for provider/GitHub copies and external backups.

## Chosen dependencies and explicit refusals

| Area | Chosen approach | Important refusal/boundary |
|---|---|---|
| Runtime/tooling | Node 24, pnpm, Nx, TS7 + TS6 tool API alias, Vite, Biome, narrow ESLint | No remote cache without privacy approval; no Vite+ ownership overlap |
| Desktop | Electron + Forge + hardened fuses | No electron-builder/electron-updater; plain Vite configs |
| Persistence | `node:sqlite`, WAL, single writer | No Kysely/SQLite wrapper or generic event-sourcing framework |
| Process/async | `execa` argv/shell false, `p-queue`, native AbortSignal | No shell commands, BullMQ, Redis, or RxJS |
| Git/LSP | user Git, tree-sitter, owned LSP lifecycle/materialisation | No simple-git/NodeGit, `git worktree add` against a user repo, or automatic tool installation |
| UI | React, React Aria, TanStack Query/router, Zustand for ephemeral state, Pierre `CodeView` | No Monaco/CodeMirror/xterm; no bare Pierre diff components |
| Forge | `ForgePort`, minimal Octokit core + `gh` auth | No aggregate Octokit retry stack or automatic mutation retry |
| Schemas/config | Zod for private contracts; Ajv + JSON Schema for RSP; canonical JSON; JSONC parser | Do not define a wire shape independently in both schema systems |
| Review plumbing | Chokidar is a recapture hint; `ignore` handles `.rennetignore`; UUIDv7 is behind an ID port | Git remains the source of truth for tracked/ignored state |
| Quality/diagnostics | Pino local-only, Vitest, Playwright, axe, fast-check, OSV/SBOM/licence checks | No hosted telemetry/traces by default; diagnostics and crash data are purgeable |

Use the committed lockfile and package manifests—not prose—as the source of exact current pins. New dependencies must satisfy the registry-age, licence, supply-chain, ownership, and overlap checks before adoption.

Every security, architecture, and licence check needs a positive control capable of failing. Cache only deterministic targets; e2e, packaging, signing, notarization, publishing, and non-hermetic audits remain uncached.

## Current blockers

Do not proceed past the relevant gate without evidence: lineage precision, cross-harness schema compatibility/real turns, decomposition quality, cache-owned LSP materialisation, actual GitHub batch publication, Pierre stable-version re-measurement, and prototype comprehension. See [MVP_STATUS.md](./MVP_STATUS.md) for the live status.
