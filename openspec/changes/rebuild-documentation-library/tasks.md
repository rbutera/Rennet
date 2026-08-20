## 1. Record the documentation model

- [x] 1.1 Add the agreed documentation terms and authority boundaries to `CONTEXT.md` and the current authority docs.
- [x] 1.2 Add an ADR for the canonical root library and ignored Starlight projection.
- [x] 1.3 Record the complete current/planned documentation inventory and assign every file to an audit slice.

## 2. Split source from renderer

- [x] 2.1 Add failing tests for projection sync, deletion, canonical-path mapping, and monorepo inventory drift.
- [x] 2.2 Move the Astro and Starlight application from root `docs` to `apps/docs`.
- [x] 2.3 Move canonical pages to `docs/using`, `docs/developing`, and `docs/adr`, then implement the ignored projection and development watcher.
- [x] 2.4 Update Nx project roots, inputs, dependencies, outputs, workspace metadata, theme checks, version scripts, and the lockfile.
- [x] 2.5 Update the Cloudflare workflow to build and deploy from `apps/docs` when renderer, content, or theme inputs change.

## 3. Rebuild documentation navigation

- [x] 3.1 Add `docs/README.md` as the GitHub entry point and keep the Starlight homepage separate.
- [x] 3.2 Reorganize the current and planned pages into concepts, guides, decisions, reference, plans, and contributing sections.
- [x] 3.3 Convert internal page and heading links to paths that work from GitHub and the rendered site.
- [x] 3.4 Add a complete monorepo map checked against resolved Nx projects and package manifests.
- [x] 3.5 Remove delivery-order and reader-facing research or retired-plan pages after moving current facts to their owning pages.

## 4. Audit facts and prose

- [x] 4.1 Audit and unslop every Using Rennet page against current product behavior.
- [x] 4.2 Audit and unslop every Developing Rennet concept page against current code, tests, and authorities.
- [x] 4.3 Audit and unslop every current guide, decision, reference, planned, and contributing page.
- [x] 4.4 Audit and unslop root authorities, current repository READMEs, package READMEs, app READMEs, and ADRs.
- [x] 4.5 Audit every promoted OpenSpec file, replace placeholder purposes, remove retired requirements, and unslop the full current contract.
- [x] 4.6 Run the full-corpus style scan and manually resolve every remaining generated-writing tell.

## 5. Close stale OpenSpec state

- [x] 5.1 Add outcome notes to the two retired partial changes without checking unfinished work.
- [x] 5.2 Archive all eight stale active changes.
- [ ] 5.3 Validate the rebuilt documentation change strictly, promote its contract deltas, and archive it.

## 6. Prove and publish

- [x] 6.1 Run the documentation structural checks, projection tests, link checks, and `rennet-docs` build with a refuting control.
- [x] 6.2 Run the affected Nx targets and the full `pnpm check` gate.
- [x] 6.3 Commit the reviewed diff, push the branch, open the pull request, and verify the remote branch contents.
- [ ] 6.4 Run independent Codex standards/spec reviews and a Claude PR review, then resolve every actionable finding.
- [ ] 6.5 Re-run the full gate on the reviewed diff before its final push.
