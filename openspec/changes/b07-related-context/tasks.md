# B07 tasks — related-context

Serial clusters; fresh implementer session per cluster; one commit per checked task; no placeholders. Gate per cluster: `pnpm nx affected -t lint,typecheck,test` green with EXIT captured on its own line. Ledger rule: an amendment discovered mid-cluster is recorded in proposal.md in the same commit.

## Cluster 1 — council rows

- [x] 1.1 `core/model-council.ts`: `JOB_CATALOGUE` gains `related-context-retrieval` (light, batched — one worker per session/round) and `project-scout` (heavy, per-call); all three assignment tables gain rows per reconciliation 1 (light: luna/low both+codex-only, haiku/low claude-only; scout: sonnet-5/medium both+claude-only, terra/medium codex-only; `[extrapolated]` comments where #461 is silent, house style). Ids must match protocol `COUNCIL_JOB_IDS` — no protocol edit.
- [x] 1.2 Tests: `resolveAssignment` resolves both ids under all three scenarios + degraded (B06 cluster-1 pattern).
- [x] 1.3 Gate green.

## Cluster 2 — deterministic extraction + gh runner

- [x] 2.1 `packages/adapters/src/related-context.ts` (first slice): `extractRefs({branchName, commitMessages, prTitle, prBody})` → typed refs (GitHub `#123` / `owner/repo#123` / issue URLs; JIRA `ABC-123` keys gated on a configured or plausibly-detected project prefix; Linear refs likewise) with provenance (which source string matched, where). Pure string logic, no I/O. Dedup preserving first-seen provenance.
- [x] 2.2 The gh runner port: `GhRunner` execFile seam (`git-range-diff.ts`'s `GitExec` pattern — injected, tests never spawn). Fetchers: `gh pr view --json` for PR description+comments, `gh api` for issue title/state/body/comments and one-hop linked issues. Timeouts bounded (the `github-fetch.ts` deadline philosophy); a failed fetch is a typed per-ref failure, never a crash and never silently empty.
- [x] 2.3 Tests: extraction fixtures per source + provenance + dedup; gh fetchers against canned runner outputs (success, 404, timeout).
- [x] 2.4 Gate green.

## Cluster 3 — retrieval worker + dossier build + durable store

- [x] 3.1 Retrieval flow in `related-context.ts`: deterministic pass → gh/REST fetch of every ref (JIRA/Linear via configured base URL + token env var NAME read from `process.env` at call time; unconfigured tracker with seen refs → a typed `missingConfig` fact per reconciliation 7, retrieval proceeds without it) → `related-context-retrieval` council worker enriches (one-hop link following, relevance trim) via the B6-pattern injected `runTurn` — output is `DossierItem[]` through protocol `dossierItemSchema` (bounded body enforced by the schema; items over-bound are truncated at the fetch edge, recorded in provenance). No `InvocationBudget` decision here: this path is budget-normal (only the #460 map path is uncapped) — wire the existing budget plumbing as the council does for other light jobs.
- [x] 3.2 Durable store (reconciliation 5): dossier via `serializeDossier` + raw payloads (full threads, linked tickets) under the knowledge-store home pattern (`~/.rennet/projects/<esc>/dossier/…`, keyed by review target + patchset ref). Read seam for the context-tool surface (reconciliation 6 — no new command row). JSDoc names the B8 generation-attach seam.
- [x] 3.3 Tests: full flow over canned gh runner + stub runTurn (dossier items carry provenance + fetched-at; every-item-bounded; missingConfig fact on an unconfigured JIRA ref; failed ref fetch yields a typed failure item-absence, not a crash); store round-trip (write → fresh read → identical bytes via serializeDossier).
- [x] 3.4 Gate green.

## Cluster 4 — project scout

- [x] 4.1 Settings rows (reconciliation 3): `SETTINGS_REGISTRY` gains the issue-tracker section (tracker kind, project key/prefix, JIRA/Linear base URL, token env var NAME) + the §4 non-tracker facts the ladder does not already resolve (worktree base-dir convention, gate command — implementer verifies which exist and records it). Layers per declaration: detected+global+repo where scout can detect, global+repo otherwise. NOTE (verified per rec 3): default branch is already a resolved fact (project-discovery origin/HEAD detection) — no settings row; PR conventions deferred per #461 §4.
- [x] 4.2 `packages/adapters/src/project-scout.ts`: deterministic pass (git remotes → GitHub owner/repo; JIRA/Linear markers in the repo; README/logo files; package manifests → gate command candidates) emitting provenance-tagged detected values; then the `project-scout` council seat (injected `runTurn`, B6 pattern) fills ONLY what determinism left empty, answers marked guessed. Seed guidance rules (CONTRIBUTING / CLAUDE.md / AGENTS.md) land in the existing repo-layer guidance catalogue. Cosmetics (logo path) → settings only, never agent context. Persist detected values via the mechanism reconciliation 3's inspection records.
- [x] 4.3 Wire at project add (re-runnable): the existing project-add path in server triggers the scout (implementer inspects where processing starts and records the point, B04 precedent). Missing-config asks surface as the typed facts (reconciliation 7).
- [ ] 4.4 Tests: deterministic pass on fixture repos (GitHub remote detected, JIRA marker detected, no-signal repo → empty with nothing guessed by determinism); scout fills only gaps (a detected value is never overwritten); guidance seeding; provenance rendering data (detected vs guessed).
- [ ] 4.5 Gate green.

## Cluster 5 — session wiring + docs

- [ ] 5.1 Retrieval at review-session start (reconciliation 8): wire the seam at the existing choke point with the same deps pattern as the swarm runner; record the actual point in the ledger. Per-round re-run is B8's — leave the seam documented, not wired.
- [ ] 5.2 `docs/developing/concepts/context-assembly.md`: the dossier's source (deterministic extraction → gh → light-tier enrich), residence (L1, `.rennet/` store), delivery (inlined verbatim via the DeltaPacket; raw payloads behind the context tools). Sweep docs/ for stale claims (settings pages if registry rows are user-visible; `docs/using/guides/` if any page describes project add).
- [ ] 5.3 Gate green (docs test inside).

## Cluster 6 — verification

- [ ] 6.1 `pnpm check` → EXIT=0 captured on its own line, tail shown.
- [ ] 6.2 Packet E2E (ruled approach, reconciliation 4): frozen real-Rennet-PR fixture (captured `gh` JSON, own-repo material only) through the full retrieval flow with stub `runTurn` → dossier where EVERY item carries provenance + fetched-at, serialized size under the bound, and the result inlines into a real `buildDeltaPacket` call whose packet carries the items untruncated.
- [ ] 6.3 Positive controls, fail-then-revert with evidence: (a) oversize a fixture body → the bound rejects it and the e2e fails; (b) strip provenance from a fixture item → schema rejects; (c) break `extractRefs` → zero items, item-count assert fails. Revert, re-run green, tree clean.
- [ ] 6.4 BUILD-STATUS.json: `b07` → `{"status":"done","passes":true}` (only that line). Commit, push, local == origin.
- [ ] 6.5 Output the sigil: `<promise>B07-COMPLETE</promise>`
