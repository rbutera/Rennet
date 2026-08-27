# Tasks — c02-ui-kit-additions (C2, #489)

Read `openspec/BUILD-LOOP.md` and `context.md` first, then `proposal.md` (its Reconciliations section is part of the spec). One cluster per session; the repo compiles and the gate is green after every cluster. Sources of record: client asset §1 (#489 comment 5431046569), fence addendum §3 + autopsy S1/S6 (#489 comment 5431046732), kit conventions in `packages/ui/src/components/*` (flat file, relative `cn` import, `data-slot`, no `"use client"`, barrel export). Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless stated.

## 1. Registry primitives — context-menu, toggle-group, kbd, progress

- [x] 1.1 `packages/ui/src/components/context-menu.tsx`: vendor the shadcn/Base UI registry item onto `@base-ui/react/context-menu` (already installed at 1.7.0 — no new dependency). Follow `dropdown-menu.tsx` as the sibling shape (same Base UI menu anatomy: Root/Trigger/Portal/Positioner/Popup, items, separator, sub-menus as the registry item carries them). Kit conventions: relative `cn` import, `data-slot` per part, theme tokens only — the hex lint over `packages/ui` already enforces the colour discipline.
- [x] 1.2 `packages/ui/src/components/toggle-group.tsx` on `@base-ui/react/toggle-group` (plus `toggle.tsx` on `@base-ui/react/toggle` if the registry item factors it out — export both if so). Model "no selection" as an empty value/`null`, never `""` (autopsy S6's sentinel sin).
- [x] 1.3 `packages/ui/src/components/kbd.tsx`: styled `<kbd>` element from the registry — no Base UI primitive underneath. Type-ramp sizing through existing theme utilities; no `text-[Npx]` brackets (a missing size is a `packages/theme` gap to fill, not a bracket to keep).
- [x] 1.4 `packages/ui/src/components/progress.tsx` on `@base-ui/react/progress` (Root/Track/Indicator, `role="progressbar"` semantics come from Base UI).
- [x] 1.5 Barrel: add the four (five with `toggle`) to `packages/ui/src/index.ts`, alphabetical like the existing exports. Licence note: the vendored registry code is MIT (shadcn) and the only runtime dependency is the already-approved `@base-ui/react` — nothing for the blocklist to inspect, and the `licenses` gate stays green by construction.
- [x] 1.6 Test mounts (house convention: `@vitest-environment happy-dom` + testing-library, per `smoke.test.tsx`) in `packages/ui/src/components/additions.test.tsx`: context-menu opens on a `contextmenu` event and an item click fires its handler; toggle-group toggles selection (pressed state reflected via its accessible attribute) and deselect yields empty, not `""`; kbd renders its content in a `<kbd>`; progress exposes `aria-valuenow` for a given value.
- [x] 1.7 Cluster gate green. Commit.

## 2. Ported primitives — collapse, resizable (through the 11-rule fence)

- [x] 2.1 `packages/ui/src/components/collapse.tsx` ported from `spikes/board-prototype/components/collapse.tsx` behavior-identical: grid `grid-rows-[0fr]→[1fr]` transition with `motion-reduce:transition-none`, inner `min-h-0 overflow-hidden` wrapper, content stays mounted, `inert={!open}` keeps the closed state out of the tab order. Fence pass: drop `"use client"`, `cn` from `../lib/utils` instead of `@/lib/utils`, add `data-slot="collapse"`. No other change — this is the keep-list primitive, not a redesign.
- [x] 2.2 `packages/ui/src/components/resizable.tsx` ported from `spikes/board-prototype/components/resize-handle.tsx`, generalized per proposal reconciliation 3: props `value`, `onChange`, `min`, `max` (or an equivalent bounds shape), `defaultValue` (double-click reset), `aria-label`; delete `MIN_CHAT_WIDTH`/`MIN_SURFACE_WIDTH`/`DEFAULT_CHAT_WIDTH` and the `window.innerWidth` chat math (the consumer derives its own max — S1's inverted constant does not travel). Keep: pointer capture, drag clamping, `document.body` cursor/user-select handling with cleanup on pointer-up, `role="separator"` + `aria-orientation="vertical"`, hover/active token-based tinting, the 6px hit area (`w-[6px]`/`-mx-[3px]` are physical sizes, not typography). Vertical orientation only — add an axis when a consumer needs it.
- [x] 2.3 Fence audit recorded (one comment or commit-message line per rule that bit): rule 2 (no `@/lib` imports survive), rule 5 verified no-op (no `text-[Npx]` in either source), rule 8 (no literal defaults — `DEFAULT_CHAT_WIDTH` moved to the consumer side), rule 10 (export only the primitives, via the barrel).
- [x] 2.4 Barrel: export `Collapse` and the resizable primitive from `packages/ui/src/index.ts`.
- [x] 2.5 Test mounts in `additions.test.tsx` — the packet's named proof for collapse: render open with a focusable child, close it, assert the child is STILL in the document (mounted) and the wrapper carries `inert` (out of the tab order); reopen, assert `inert` gone. **Positive control shown once**: remove `inert={!open}`, watch the test fail, revert. Resizable: a pointer-down/move/up sequence calls `onChange` clamped to `min`/`max`; double-click resets to `defaultValue`.
- [x] 2.6 Cluster gate green. Commit.

## 3. Kit-not-hand-rolled lint (autopsy S6), armed

- [x] 3.1 `eslint.config.mjs`: named const `NO_HANDROLLED_TOGGLE` with selectors `JSXAttribute[name.name='aria-pressed']` and `JSXAttribute[name.name='role'][value.value='radiogroup']`, message pointing at `ToggleGroup`/`Toggle` from `@rennet/ui`. Add it to the existing app-ui surface block's `no-restricted-syntax` (the block already carrying `NO_HARDCODED_HEX, NO_DIRECT_INVOKE` — flat config replaces rule options, never merges, so extend THAT list). `packages/ui` is untouched by the rule (the kit is where the markup legitimately lives); test files already exempt via the block's `ignores`.
- [x] 3.2 Quarantine the five incumbent hand-rolls the way C01 quarantined `.invoke` — the checked suppressions baseline, not whole-file ignores: regenerate `eslint-suppressions.json` (`pnpm exec eslint packages/app-ui/src --suppress-rule no-restricted-syntax --prune-suppressions`) so the existing sites in `symbol-inspector.tsx`, `source-switcher.tsx`, `front-door.tsx`, `project-detail.tsx`, `settings-screen.tsx` pass while any NEW hand-roll — including in those files — fails. Each surface rebuild drains its sites; C14 verifies the baseline empty.
- [x] 3.3 Positive-control lint test `packages/app-ui/src/toggle-lint.test.ts` (mirrors the selector through the ESLint API, same pattern as `hex-lint.test.ts`): a raw `<button aria-pressed={x}>` fails with a message naming ToggleGroup; a `<ToggleGroup>` usage passes. Then one probe against the REAL config: a throwaway surface file with a hand-rolled toggle errors `no-restricted-syntax` (exit 1); probe deleted after capture. Evidence, not assertion.
- [x] 3.4 Cluster gate green. Commit.

## 4. Docs (same change, definition of done)

- [x] 4.1 `docs/developing/concepts/design-doctrine.md`: record the kit-not-hand-rolled law where the doctrine's enforcement lives (one sentence + the checks-table row): segmented controls come from the kit's `ToggleGroup`, enforced by lint (`eslint.config.mjs` selector, positive control `packages/app-ui/src/toggle-lint.test.ts`), not review.
- [x] 4.2 Grep `docs/` (excl. `docs/dist`) for pages enumerating kit components or describing folding/resize behavior at component granularity — expected no-op (the docs point at directories, not component lists; `monorepo-map.md`'s ui row lists workspace deps, unchanged). Record the result; update any page found wrong.

## 5. Verification (packet)

- [ ] 5.1 `pnpm check` green — format, architecture, licenses, lint, typecheck, test, build. Licences included: zero new packages, so the report is unchanged; confirm rather than assume.
- [ ] 5.2 Collapse proof (2.5) passes with the positive control shown once (inert dropped → fail → reverted).
- [ ] 5.3 S6 lint positive control fired against the real config (3.3 probe errored, deleted); the five quarantined files lint clean via the baseline.
- [ ] 5.4 All six primitives resolve through `@rennet/ui`'s barrel and each has a passing test mount.
- [ ] 5.5 `BUILD-STATUS.json` c02 → `{"status":"done","passes":true}`; emit `<promise>C02-COMPLETE</promise>`.
