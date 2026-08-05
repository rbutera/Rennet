# Rennet agent instructions

Rennet is Rai Butera's personal product. This is the product monorepo and the private working remote is `rbutera/rennet`.

## Read before changing the product

1. `docs/Rennet Master Plan.md`
2. `docs/Rennet Architecture Contracts.md`
3. `docs/Rennet Evidence Gate Status.md`
4. `docs/Rennet Navi Handoff.md`

The Master Plan wins on general product and architecture conflicts. The Architecture Contracts win within project context, immutable patchsets, invalidation, persistence, privacy, and publication. Historical Wingman documents are evidence and rationale only where either authority supersedes them.

## Fixed boundaries

- Never use easyJet or other client repositories, code, pull requests, screenshots, data, time, or infrastructure for development, fixtures, calibration, or model-backed dogfood without written authorization.
- Never add AI attribution or co-author trailers. Rai is the sole author.
- Never import or bundle the Claude Agent SDK. Harness adapters wrap user-installed tools through verified public process protocols.
- Never auto-approve, auto-comment, push source branches, or publish anything another human can see without an explicit human action.
- Say "no Rennet backend" and disclose harness/provider egress. Never claim universally that nothing leaves the machine.
- `.rennet/` is local and ignored by default. Rennet never stages or commits a user's project context.
- Do not implement a subsystem while its relevant P0 evidence gate is open.

## Intended package boundaries

`packages/types` imports nothing in-repo. `protocol` may import `types`; `core` may import `protocol`; `adapters` may import `core` and Node; `ui` may import only `types`, `protocol`, and browser-safe dependencies; `apps/desktop` is the only Electron package. Spikes are deliberately excluded from the pnpm workspace.

## Working agreement

Keep `main` releasable. Run the full available local gate before every push. A clean check must include a positive control capable of failing. Preserve user changes, stage only intended files, and never bypass hooks or force-push unless Rai explicitly asks.
