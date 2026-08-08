# Rennet rulings ledger

Only currently binding rulings are listed here. IDs are preserved from the former *Rennet Contracts and Rulings* for issue and commit traceability. The product vision owns intent; [ARCHITECTURE.md](./ARCHITECTURE.md) owns the detailed engineering contracts; this ledger resolves cross-cutting conflicts.

| ID | Binding ruling |
|---|---|
| R1 | The product and in-workspace package name is **Rennet**; public namespace, domain, social, and release registrations remain Rai-only. |
| R2 | The Claude adapter uses `@anthropic-ai/claude-agent-sdk` with the user's installed `claude` executable; never read credentials or bundle a harness binary, and strip SDK binaries when packaging. |
| R3 | `types` and `protocol` remain separate for architecture, not licensing: `types` imports nothing in-repo; `protocol` may import `types` only. |
| R4 | Base instructions are product voice, not part of the public RSP contract; `instructions` never becomes a dependency of `protocol` or `types`. |
| R6 | Disagreement data shape ships before a second adapter; actual disagreement emission needs independent evidence and never pretends silence is agreement. |
| R7 | Working-tree and GitHub PR sources are both v1 requirements. |
| R8 | Use patchset-scoped occurrence IDs plus a lineage graph; only byte-exact, context-confirmed material carries read state automatically, and ambiguity fails closed. |
| R9 | Hybrid decomposition: deterministic code guarantees totality and limits; a harness proposes a complete versioned graph; a deterministic validator admits it. |
| R10 | Deterministic work stays local; model utility work is batched, never per hunk; the live RoutePlan gate enforces fewer than five initial invocations and first useful output within 15 seconds. |
| R11 | The six angles are spec, sequence, decisions, claims-and-evidence, blast radius, and noise; subtraction remains a finding family, not an angle. |
| R12 | `append` is a settings merge strategy only for labelled instruction-guidance prose. |
| R13 | Capability flags start false and are earned by conformance, including per-call model selection and advertised models. |
| R14 | Apple enrolment and the individual-vs-company decision are Rai-only and needed before public release, not dogfood. |
| R15 | Route handoff is removed; author-side review itself is the product path. |
| R16 | Use Pierre `CodeView` for diffs; never bare `FileDiff`/`PatchDiff`; `react-virtual` is for non-diff lists only. |
| R17 | Events are append-only with upcasts and fail-safe unknown events; publishing is idempotent, supports `outcome-unknown`, and separates private state from outbound bytes. |
| R18 | Preserve patch bytes and first-class incomplete/binary/submodule input states; done and publish block on incomplete ingestion. |
| R19 | The portable contract is transport-neutral: public RSP is JSON Schema, private protocol is Zod-first, durable repo identity is a `RepoRecord`, and subscriptions project per recipient. |
| R20 | UI imports `types` and `protocol`, never `core`; renderer access is through typed IPC. |
| R21 | Package layout is `types`, `protocol`, `core`, `adapters`, `ui`, `instructions`, and `tsconfig`, with desktop as the Electron host and spikes outside the workspace. |
| R22 | No external code contributions before the contribution policy lands; no AI-authorship trailers. |
| R23 | The third harness target is `omp` / `@oh-my-pi/pi-coding-agent`, not the abandoned `oh-my-pi` package. |
| R24 | Use a forge-neutral `ForgePort`, never GitHub-only domain logic. |
| R25 | Pierre was measured; re-measure the eligible stable version and annotation recycling before upgrading. |
| R26 | Glass tokens and chrome ship in v1; glass-for-chrome, opaque-code, and paper-for-publication are immediate doctrine. |
| R27 | `.rennet/` holds durable project configuration, deterministic snapshots, and evidence-backed knowledge; app storage holds review-private and temporary material. |
| R28 | Every review targets an immutable patchset; local edits and PR updates create successors, never rewrite the active review. |
| R29 | Auto-classify analysis as current, invalid, or potentially invalid; retain old output and require explicit affected-only regeneration. |
| R30 | Project snapshots are deterministic and fingerprinted; stale context is refreshed, visibly omitted, or blocks dependent work—never silently trusted. |
| R31 | Harnesses receive app-owned immutable materialisations and explicit context; disclose authority, egress, provider, model source, and spend; say “no Rennet backend,” not “nothing leaves your machine.” |
| R32 | Delete-review physically purges every Rennet-controlled copy; unknown events remain preserved but block projection, completion, regeneration, and publication. |
| R33 | Author-side completion is a pure PR preview with zero Git/GitHub mutation; reviewer publication is inspect, sign, and one idempotent submit pinned to the reviewed head. |
| R34 | Nx owns the task graph and local cache; pnpm owns packages; Vite owns renderer builds; Electron Forge owns packaging; remote cache needs a privacy decision. |
| R35 | Do not use RxJS or another reactive-streams library: `AsyncIterable` serves harness streams, a post-commit change feed serves fan-out, and bounded batchers plus `p-queue` serve coalescing/concurrency. |
| R36 | Disposing immediately stages a disposition; there is no separate staging action. |
| R37 | Withdraw means unstage; editing is withdraw-and-restage in one gesture. |
| R38 | A v1 signing act publishes all staged items; withdraw items first to publish a subset. |
| R39 | The Model Council may route light-tier work to a different installed harness; cross-harness routing is preferred to tier collapse and must be disclosed in the run ledger. |
| R40 | The editable collation draft canvas is the forming destination; signing freezes it into paper. Editing lives on the draft; the paper offers sign and back only. |

## Always-binding guardrails

MIT applies to every package. Never use client repositories or data without written permission. Never mutate a source checkout, index, branch, or external review implicitly. Do not implement a subsystem while its relevant P0 evidence gate is open.

## Supersession note

R3–R5's former licence conflict, former capped-decision language, and other retired alternatives are intentionally absent. Their historical record is retained in [`archive/Rennet Contracts and Rulings.md`](./archive/Rennet%20Contracts%20and%20Rulings.md).
