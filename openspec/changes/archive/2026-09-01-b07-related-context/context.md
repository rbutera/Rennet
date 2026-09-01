# Context packet — B7 related-context

Read `openspec/BUILD-LOOP.md` first. Plan row: B7.

## Objective

Implement #461: `adapters/related-context.ts` — deterministic ref extraction (branch name, commit messages, PR body) → GitHub via `gh` first-class (no octokit for this; #483 reversal stands) → light-tier enrichment → the bounded per-change **related-context dossier** (structured items: id/tracker/title/state/bounded body/acceptance criteria/URL/provenance/fetched-at + freshness), Delta-resident, inlined verbatim into every drafter prompt. JIRA/Linear config-only (base URL + token env var, worker hits their REST). `adapters/project-scout.ts` — the #461 §4 detection set, run at project add. Config keys ride the #476 settings ladder (scout fills detected, user overrides global rung, optional repo file); missing config = in-chat ask that persists, never a modal. Council job ids: `project-scout` (medium), `related-context-retrieval` (light).

## Out of scope

The add-project UI (C12); standing tracker knowledge flowing through the swarm (B6 owns the pipe). Raw threads stay behind a context tool, not in the dossier.

## Blocked by

B3 (dossier shape). B6 for the L0 hand-off seam.

## Sources

- The decision: https://github.com/rbutera/rennet/issues/461 · settings ladder: https://github.com/rbutera/rennet/issues/476
- Engine asset §2 adapters: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046330
- Existing: `packages/adapters/src/github-*`, token handling via `gh auth token` (memory: enterprise orgs forbid OAuth-app installs)
- Docs: `docs/developing/concepts/context-assembly.md`

## Verification

- `pnpm check` green. E2E: against a real Rennet PR, extraction produces a dossier whose every item carries provenance + fetched-at, stays under the size bound, and inlines into a DeltaPacket (B5) without truncation.

## Completion sigil

`<promise>B07-COMPLETE</promise>`
