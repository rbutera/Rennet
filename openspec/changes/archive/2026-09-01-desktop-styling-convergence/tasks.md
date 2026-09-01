# Tasks — desktop styling convergence

Groups 1–3 have disjoint file footprints and run in parallel. Group 4 is the serial gate.

## 1. Theme package (packages/theme only — design D1, D4)

- [x] 1.1 Fix the OS-dark fallback guard in `palette.css:146` to `:root:where(:not([data-scheme]):not([data-theme]))` (D1)
- [x] 1.2 Update the guard string fixture in `theme.test.ts:25`; add the happy-dom cascade control test (guard must NOT match a stamped root; pack selector must win) with red-then-green proof (D1)
- [x] 1.3 Port the prototype's desaturated dark grounds into both dark blocks of `palette.css` (D4)
- [x] 1.4 Add warn (copper) and model registers to `palette.css` (light + dark + fallback) and `theme.css` @theme (D4)
- [x] 1.5 Add `--text-10` and `--text-13` type tokens to `theme.css` @theme (D4)
- [x] 1.6 Regenerate the mobile palette; confirm palette-sync test green (D4)

## 2. Kit ramp + base CSS (packages/ui + app-ui/src/index.css + app-ui/package.json — design D2, D3)

- [x] 2.1 Restore prototype control ramp in `packages/ui/src/components/button.tsx` and `input.tsx`; check packages/ui's own design-ramp test for needed allowances (D2)
- [x] 2.2 Add `* { @apply border-border outline-ring/50; }` and the display-font `h1,h2,h3` rule to app-ui `index.css` @layer base (D3)
- [x] 2.3 Import `tw-animate-css` in app-ui `index.css`, add the dependency to app-ui `package.json`, delete dead `packages/ui/src/index.css` (D3)
- [x] 2.4 Add `@custom-variant dark (&:is(.dark *));` to app-ui `index.css` (D3)
- [x] 2.5 Delete the dead `.rn-startup-underlay` rule from app-ui `index.css:117-119` (companion to task 3.4; the rule is owned here to keep footprints disjoint) (D7)

## 3. App-UI surfaces (app-ui TSX + tests + docs — design D5–D9)

- [x] 3.1 Sidebar glyph join in `sidebar.tsx` (SidebarTree + NewChatPicker), `ProjectIcon` through `Icon`, drop `Layers` import; extend `sidebar.dom.test.tsx` with the glyph positive control (D5)
- [x] 3.2 Remove provenance chips from `repository.tsx` and `issue-tracker.tsx`; delete `toProvenance` + re-exports + its unit test; keep `Layered<T>` and `provenance-chip.tsx`; update `projects.dom.test.tsx` incl. the projection-probe replacement assertion (D6)
- [x] 3.3 Reword the provenance-chip sentence in `docs/developing/guides/settings-and-setup.md` (D6)
- [x] 3.4 Welcome shell unmount in `routes/app.tsx`; flip the underlay assertion in `app.dom.test.tsx` and add the no-coachmark-during-welcome regression control (D7)
- [x] 3.5 Corner slot `pl-[76px]` → `pl-[81px]` + comment updates + the four test literal updates (D8)
- [x] 3.6 Restyle `directory-browser.tsx` to prototype values using `text-10`/`text-13`; restore `aria-selected`; allow `text-10`/`text-13` (and the list `max-h` literal if needed) in app-ui `design-ramp.test.ts` (D9)
- [x] 3.7 Fix `text-success` at `first-run-welcome.tsx:166` to an existing token (D4)

## 4. Gate + landing (serial, after 1–3)

- [x] 4.1 `pnpm check` full gate green in this worktree (one nx invocation at a time)
- [x] 4.2 Dual review (opus + codex), fix findings, re-gate
- [x] 4.3 Commit, push branch, verify push landed, merge to main [archive 2026-09-01: landed via #594; releases v0.4.x shipped since]
- [x] 4.4 Trigger manual release (`gh workflow run auto-release.yml -f bump=patch`) [archive 2026-09-01: landed via #594; releases v0.4.x shipped since]
