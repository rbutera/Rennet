## 1. The related-context context file

- [ ] 1.1 Add `packages/core/src/board/related-context-file.ts`: `RELATED_CONTEXT_FILE = "related-context.md"`, `RELATED_CONTEXT_MAX_ITEMS = 20`, `RELATED_CONTEXT_MAX_BYTES = 65_536`, and `relatedContextFile(items, opts?)` returning a `SessionContextFile` or `undefined` for no items; one region per item in dossier order with id, tracker, title, state, url, provenance, body, and acceptance criteria under a subheading; a closing line naming the dropped count when either bound is hit. Export from `packages/core/src/board/index.ts`.
- [ ] 1.2 Add `relatedContextRefsFile(refs)` in the same module for the past-ceiling case: one line per extracted ref with its URL and provenance, opening with a line that says retrieval had not finished and the seat may fetch a GitHub ref with `gh issue view`.
- [ ] 1.3 Tests: bounds hold and the truncation line names the count (positive control: 21 items, the 21st absent and the line present); zero items gives `undefined`; acceptance criteria render under their own subheading; the bytes are deterministic for the same items.

## 2. The lane waits, bounded, and names the file to Design

- [ ] 2.1 `runRelatedContextRetrieval` resolves with `readonly DossierItem[] | undefined` — the saved items, or the stored dossier on the early return — and `create-server.ts` holds the promise per review id, cleared on archive.
- [ ] 2.2 Lens pipeline deps gain `relatedContext?: () => Promise<readonly DossierItem[] | undefined>` and `RELATED_CONTEXT_WAIT_MS = 120_000` is declared beside the other lane constants. On the Design lane, when `designSources` is undefined and the assembler produced no board, await it against the ceiling; publish "waiting for related issues" as the lane's latest event while waiting; write `related-context.md` (task 1.1) from the result, or the refs file (task 1.2) past the ceiling, into `designOnlyFiles`.
- [ ] 2.3 Tests in `lens-pipeline.test.ts`: the file is in the Design seat's context and in no other seat's; the host-located path and the assembler path never call `relatedContext`; a `relatedContext` that never resolves opens the seat after the ceiling with the refs file (fake timers); a resolved dossier opens the seat with the items file.

## 3. The prompt

- [ ] 3.1 Rewrite the "When there is no specification" section of `packages/prompts/src/prompts/design.md` as design D1 and D4: the three sources in order, the documentation file rule and the `git diff --name-status` command, the document shape with its two fixed stats, the intro's opening sentence, `inferred: false` for decisions the sources state, acceptance criteria as `requirement` with the file-and-id source, and `settle_absent` only when all three sources are empty with a note naming them.
- [ ] 3.2 `index.test.ts`: assert the section names `related-context.md`, the `Format` and `Specification` stats, the opening sentence, the `git diff --name-status` command, and that `settle_absent` is conditioned on all three being empty; keep the existing assertions green (the search, the tie, "not an empty board, not a placeholder").
- [ ] 3.3 Prove the Design lint rules resolve `pr.md` and `related-context.md` as `source.path` under the bound root on a fixture board that quotes both; if a rule reads only patchset paths, widen it to the context directory in the same task.
- [ ] 3.4 State the prompt's size before and after in the PR description.

## 4. Drive and fixtures

- [ ] 4.1 Add a drive fixture beside `drive/no-spec`: a branch with no specification, a PR body that states a purpose and one decision, one added `docs/` page, and a `Closes #N` ref to an issue with acceptance criteria. Drive the real app: the Design tab shows the overview with `Format: Overview`, the three sections, the decision with its PR source, and one requirement per acceptance criterion with the issue id on its row.
- [ ] 4.2 Drive `drive/no-spec` unchanged (no PR, no docs, no refs): the lane still settles `no-spec` and the tab reads "No spec found for this branch."
- [ ] 4.3 Record both drives' Design turn timing and usage from the collector, and how long related-context retrieval took to settle on each, in the sidecar concept page's drive table.

## 5. Documentation

- [ ] 5.1 `docs/developing/concepts/lens-pipeline.md`, "The Design lens": the overview arm, the file, the bounded wait, the residual absence.
- [ ] 5.2 `docs/using/guides/getting-started.md`, the Design paragraph; `docs/using/concepts/common-questions.md` and `docs/using/index.md` where they say what Design reads.
- [ ] 5.3 `docs/developing/concepts/t3code-sidecar.md`: `related-context.md` in the seat context file list.
- [ ] 5.4 `pnpm check` green, and the drives in section 4 as the positive control.
