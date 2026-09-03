## Context

See proposal.md for why. The state this design starts from, measured on 2026-09-03:

- The vendored T3 sidecar already models what we want: a thread carries `worktreePath` and `branch`, every turn runs there, every turn writes a checkpoint under `refs/t3/checkpoints/…`, and `thread.checkpoint.revert` exists. Rennet creates every thread with `worktreePath: null` (`packages/server/src/t3/client.ts` `createThread`), so all of that is unused.
- Rennet's own workspace handling is four things: the user's checkout; `~/.rennet/worktrees/review/<reviewId>` (a detached evidence worktree the seats read from); `~/.rennet/worktrees/<owner>/<repo>/pr-N` for historical PRs; and `~/.rennet/round-worktrees/<sha256(operationId)>` per round operation (`create-server.ts` `planWorkspace`, with a WSL path-translation branch), whose result is replayed onto the source branch by round-collation landing and `settleRoundCommits` (`git add -A` + commit). `cleanupWorktree` refuses on stray files.
- Prompt assembly is `renderLayer` concatenation with one JSON line as the context layer (`lens-pipeline.ts` `renderDrafterPrompt`); the budgeted `assemblePrompt` is used by one runner and given no budget. Twenty-four sites carry context inline (the survey in the proposal's Why); several of their payloads are already files under `~/.rennet` (assembled context text, dossier, work order, boards).
- Citations carry a 64-hex hunk id the seat copies from an inline inventory (`packages/protocol/src/delta/citations.ts` `hunkIdSchema`; `SkippedHunkSchema` on boards); lint checks ids against the offered list; composition runs a cross-lens coverage gate; delta marks key on hunk id. Seventy-one files touch the id.
- Rennet manages `<repo>/.rennet/.gitignore` (`packages/adapters/src/map-visibility.ts`, entries `map/ overlays/ knowledge/`). PR worktrees already write `.rennet/setup*` per worktree.
- The archive path is `dispatch/session.ts` `session.archive` → `sessions.setArchived` → `t3Sidecar.forgetSession([sessionId, reviewId])`; #773 re-runs it when a round outlives an archive; the supervisor retries deferred deletions at start.
- Constraints: Rule Zero (no gates, no consent ceremonies); simplicity of the final result, not of the diff; `effect`/`@t3tools` only in `client.ts` and `t3-chat`; every vendored edit needs a ledger row (none is expected here); a change that alters what a turn sends states its size in the PR.

## Goals / Non-Goals

**Goals:**
- One workspace root per session, recorded on the session, used by every turn's cwd and every thread's `worktreePath`.
- A round is a turn on that root; the checkpoint is the receipt; the worktree zoo and the landing machinery are deleted, not bypassed.
- One writer and one purge for `.rennet/context/<sessionId>/`; every prompt site references paths; the measured seat prompt drops from ~110k characters to under 20k and Design from 242k to under 15k.
- Citations by path and line; hunk ids gone from prompts, boards, lint context and delta marks.
- The Design lens finds the spec itself and settles absent when there is none.

**Non-Goals:**
- Changing how a patchset is captured or what "immutable patchset" means; a round advances to a new captured patchset exactly as before, just from the bound root.
- Changing T3's checkpoint semantics or editing the vendored server.
- Bounding seats (Rai, 2026-09-03: not the priority); this change removes what seats are sent, it does not cap what they do.
- A general "prompt budget" framework; the rule is no inline context, which needs no budget to enforce.
- Reworking the round report classifier's evidence semantics beyond moving its manifest to a file.

## Decisions

**D1. The binding is the session's, decided once, from the review target.** Branch review on the current checkout → that checkout; branch review of another branch → `git worktree add` under `~/.rennet/worktrees/<repoKey>/<branch>` (the PR-worktree helper already does this shape); PR snapshot → a worktree at the reviewed head (the existing PR worktree, now the session's binding rather than a side path). The bound root is stored on the session record and on every thread binding. Alternative considered: bind per generation or per round; rejected because the binding is the thing that makes every child share a cwd, and a per-round binding is the zoo again.

**D2. Rounds run as turns on the session's thread family in the bound root; the branch moves.** The worker commits on the branch, T3 checkpoints the turn, the daemon reads the checkpoint (already projected on `projection_turns`) and captures the successor patchset from the bound root. Deleted: `planWorkspace`, `round-worktrees`, round-collation landing, `settleRoundCommits`, `cleanupWorktree`'s use on rounds, the WSL round path translation. Alternative: keep a detached worktree but bind it once per session; rejected because it keeps the landing step and a second checkout the user cannot see. The immutable-patchset contract is untouched: the patchset is captured after the turn, as now.

**D3. Context files: one writer, one purge, one index.** `writeSessionContext(root, sessionId, files)` creates `.rennet/context/<sessionId>/`, writes the files and a `README.md` that lists each file, what it holds and when to read it, and ensures `context/` is in the managed ignore block. `purgeSessionContext(root, sessionId)` is called from `session.archive` beside `forgetSession`, from #773's round-settle re-sweep, and from a daemon-start sweep that removes directories whose session id no longer exists. Purge is at archive, not at generation settle: a reopened transcript or a resumed round still needs its files. Alternative: write under `~/.rennet/projects/<key>/…` and reference absolute paths; rejected because the seat's tools resolve relative to its cwd and the files must be under the same root the seat reads the checkout from.

**D4. What goes in the directory, per turn kind.** Lens seats: nothing derived from the diff (they read `git diff`); `blast-radius.json` and `counterparts.json` only if the prompts still use them after the citation change (task 5 decides per file with a size before and after); the round context (`round.json`: dispatched asks, the frozen report board) for a regeneration. Noise: `noise-offer.json` (the offered manifest without line bodies; the seat reads the hunks it is offered from the diff). Coverage: nothing; the turn reads the diff and cites. Round report: `evidence.json` (the manifest). Compose: `boards/<lens>.json`. Opener, PR body, handoff: `boards/`, `asks.json`, `work-order.md`. Scout: nothing (CLAUDE.md, AGENTS.md, CONTRIBUTING.md are in the cwd). Verification, refine, CI classification: `pointers.json` naming the file and lines to read, not the window. The previous draft for a repair is never written; repairs are pointer-only on every leg.

**D5. Citations are `codeRef`.** `{path, side, startLine, endLine}` as already defined. Lint's ctx becomes the patchset's changed regions per path and side (the daemon has the diff); `resolveCitation` returns the region or an `unresolvable-citation` violation carrying path and range. `SkippedHunkSchema` and the `skippedHunks` field are removed from boards; the composition coverage gate is deleted; the coverage turn is deleted (it existed to map requirements onto offered hunks) and, if a coverage view survives in app-ui, it is fed by a daemon projection of cited regions. Delta marks key on `(path, side, start, end)`. The hunk id stays as an internal key on the delta packet for the diff renderer only; nothing in `packages/prompts` or the board protocol names it. Alternative: shorten ids and keep the inventory; rejected because the inventory then still exists and the seat still copies tokens it does not understand.

**D6. Design lens.** `design.md` becomes: find the spec for this branch in the workspace if one exists (`openspec/changes/**`, `.bmad/**`, `.kiro/**`, `docs/adr/**`, grill-me and superpowers documents; `git log <base>..<head>` and the PR body name it); draft from it, cite it by path; if none, return the `no-spec` absence. `design-artifact-discovery.ts`, `DESIGN_ARTIFACT_LIMITS`, `fitDesignArtifactsToPrompt`/`fitDesignArtifactsToBytes` (#782), the `designArtifacts` schema and the no-material candidate accounting are deleted. The lane's `no-spec` absence renders on the bench as "no spec found for this branch" and the board views omit the Design tab (the lens switcher hides an absent lens rather than showing an empty one).

**D7. Order of landing.** Citations first (D5), because they shrink every seat and delete the coverage gate without touching workspaces; then context files (D3, D4) site by site, biggest first; then the Design respec (D6); then the workspace binding and the round deletion (D1, D2) as one wave, because they are one behaviour. Each wave is releasable on its own.

## Risks / Trade-offs

- [A round now moves the reviewer's own branch in their own checkout] → that is the asked-for behaviour and T3's; the checkpoint ref makes every round revertible through `thread.checkpoint.revert`, and the round account names it.
- [A seat reads a file that a purge removed mid-turn] → purge happens only at archive, and archive already awaits the preparation and re-sweeps after a round; a seat turn cannot outlive an archive without #773's hook seeing it.
- [The managed ignore block is absent in a repo Rennet has never mapped] → `writeSessionContext` ensures the block before writing; the existing map-visibility writer is reused, not duplicated.
- [Removing hunk ids breaks delta marks for boards persisted under the old keying] → marks are recomputed from citations on read; a legacy board with id-keyed marks shows no marks rather than wrong ones, and says so.
- [Lint's "unresolvable citation" becomes line-based and a seat cites a context line next to a change] → the resolver accepts a range that overlaps a changed region on the named side; a range entirely outside the change is the violation, with the nearest changed range in the pointer.
- [WSL and remote hosts: the bound root is a distro path] → the binding stores the root in the locus the daemon runs in; the existing locus helpers translate it once at thread creation, and the round-specific translation branch is deleted with the rest.
- [The Design seat finds a spec that is not for this branch] → the prompt names the clue (commit messages, PR body) and asks for the citation of the evidence that ties the spec to the branch; a board with no such citation fails lint like any uncited claim.

## Migration Plan

1. Land the citation wave; existing boards render with marks recomputed from citations.
2. Land the context-file waves; the first daemon start after each adds `context/` to the managed ignore block of every mapped repo on first write.
3. Land the Design respec; the lane's `no-spec` absence is a new admissible reason in the existing absence domain, so old sessions read unchanged.
4. Land the binding wave; on first start the sweep removes `~/.rennet/round-worktrees` and `~/.rennet/worktrees/review` and logs the count; sessions created before the wave bind lazily to their review's branch on first use.
5. Rollback is per wave by revert; no data migration is written that a revert cannot ignore.

## Open Questions

- Whether the app-ui coverage mosaic keeps a place on the surface once it is a projection rather than a gate; it can be decided when the projection exists without changing these specs.
- Whether a Rennet-created branch worktree is removed at archive along with the context files, or kept until the user removes it in the worktree UI (#423); either answer fits the specs.
