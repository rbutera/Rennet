# Design — desktop styling convergence

## Context

Five parallel investigations produced file:line root causes for every symptom. This design records them verbatim so implementation is mechanical. The prototype (`spikes/board-prototype`) is the styling target ("prototype styling is king"). All JS wiring for theming, glyph persistence, and welcome navigation is already correct — the fixes are CSS, kit values, and three surgical TSX changes.

Key verified facts:

- Theme CSS **is** imported (`packages/app-ui/src/index.ts:1` → `index.css:14` → `@rennet/theme/theme.css` → all packs/code themes). `routes/app.tsx` stamps `data-scheme` + `.dark`; `theme-pref.tsx:89-101` stamps `data-rn-theme`/`data-rn-code-theme`. Persistence for the pack is end-to-end.
- Glyph chain works end-to-end (settings → `settings.setProjectValue` → `~/.rennet/projects/<escaped>/config.json` → `glyphByProject` projection); three surfaces render it; only the sidebar skips it.
- Welcome navigation after add-project already lands on `/new-chat?project=<id>` via `ReadyStage` (`first-run-welcome.tsx:861-872`); nothing to add there.

## Goals / Non-Goals

**Goals:** the six fixes in the proposal, each at its root cause, with a positive control per fix.

**Non-Goals (deferred follow-ups):** the ~300-site type-scale sweep onto the prototype's full vocabulary (requires a DESIGN.md ramp-doctrine change); ink-vocabulary consolidation; kit-component adoption sweep (Tabs/Tooltip/Checkbox/Textarea); Appearance-page provenance chip; code-theme restart persistence (deliberately session-only today); coachmark outside-press burn hardening beyond what shell-unmount already fixes.

## Decisions

### D1 — Theme pack/code theme: fix the fallback selector, not the packs

`packages/theme/src/palette.css:146`: change

```
:root:not([data-scheme="light"]):not([data-theme="light"]) {
```

to

```
:root:where(:not([data-scheme]):not([data-theme])) {
```

Rationale: `(0,3,0)` currently beats every pack/code-theme selector `(0,2,0)` on `<html>` whenever the OS is dark and the scheme isn't explicitly light — exactly the default config on a dark Mac. The new guard matches only an unstamped root (what the comment at :143-144 already claims) and `:where()` zeroes specificity so it can never outrank a pack. Light `:root{}` at :30 still loses to it by source order for unstamped surfaces — behavior preserved.

Consequences: update the hardcoded guard string at `packages/theme/src/theme.test.ts:25` (`css.indexOf(':root:not([data-scheme="light"])')`), or the byte-copy test dies. `scripts/palette-data.mjs` does NOT read this block (slices `[data-scheme="dark"],` at :59) — mobile palette unaffected by the selector change (but IS affected by D4's value changes).

New control test (the missing one): in `packages/theme/src/theme.test.ts`, happy-dom test asserting a root with `data-scheme="dark"` does NOT match the guard, while `[data-rn-theme="dracula"][data-scheme="dark"]` matches after stamping. Add `happy-dom` to packages/theme devDependencies (already in workspace).

### D2 — Kit control ramp: verbatim restore from prototype

`packages/ui/src/components/button.tsx` — port from `spikes/board-prototype/components/ui/button.tsx`:

- :6 base `font-semibold` → `font-medium`
- :17 default hover `hover:brightness-110` → `hover:bg-primary/80`
- :35 default `h-9 gap-2 px-4` → `h-8 gap-1.5 px-2.5`
- :36 xs `h-7` → `h-6`; :37 sm `h-8 px-3 text-xs` → `h-7 px-2.5 text-[0.8rem]`
- :38 lg `h-10 gap-2 px-5` → `h-9 gap-1.5 px-2.5`
- :39/:42/:43 icon `size-9/size-8/size-10` → `size-8/size-7/size-9`

`packages/ui/src/components/input.tsx:12` — `h-9 … px-3` → `h-8 … px-2.5`.

Check `packages/ui/src/design-ramp.test.ts` first: if it bans `text-[0.8rem]`/`rounded-[…]`, allow those exact prototype literals there (packages/ui is not covered by app-ui's ramp test).

### D3 — Missing base-layer rules in `packages/app-ui/src/index.css`

Add to the `@layer base` block (:30-102), mirroring `spikes/board-prototype/app/globals.css`:

1. `* { @apply border-border outline-ring/50; }` (globals.css:240-242) — fixes 14 full-ink border sites in one rule.
2. `h1, h2, h3 { font-family: var(--rn-font-display); font-weight: 500; letter-spacing: -0.015em; }` (globals.css:250-256). Drop redundant `font-semibold` on the 12 affected heading sites only if trivially safe; the rule alone is the fix.
3. `@import "tw-animate-css";` near :14 + add `tw-animate-css` to `packages/app-ui/package.json` dependencies (version matching what `packages/ui/package.json` declares). Delete the dead `packages/ui/src/index.css` (nothing imports it — `packages/ui/src/index.ts` is a pure TS barrel).
4. `@custom-variant dark (&:is(.dark *));` after the imports (globals.css:5).

### D4 — Palette catch-up in `packages/theme/src/palette.css`

Dark grounds (prototype `globals.css:185-195`, deliberate post-review desaturation): canvas `#0e0d0c`→`#0a0a0a`, surface `#151413`→`#131313`, raised `#1b1a18`→`#1a1a1a`, overlay `#090807`→`#060606`, code `#0a0909`→`#070707`, scrim `#0e0d0c`→`#0a0a0a`. Apply to BOTH the `[data-scheme="dark"]` block (:97-103,:140) and the OS-fallback copy (:147-151,:188) — theme.test.ts enforces byte-equality.

Warn + model registers: add `--rn-warn`, `--rn-warn-soft`, `--rn-warn-line`, `--rn-model-soft`, `--rn-model-line` to light and dark blocks (values from prototype globals.css:149-156 light, :210-215 dark) and `--color-warn*`/`--color-model-*` mappings to `theme.css` @theme.

`text-success` at `first-run-welcome.tsx:166`: token doesn't exist — change to `text-green` (or the nearest existing success-ish token in theme.css; do not invent a new register for one site).

Type steps for the file picker: add `--text-10` (0.625rem) and `--text-13` (0.8125rem) with sensible line-heights to `theme.css` @theme, and allow `text-10`/`text-13` in `packages/app-ui/src/design-ramp.test.ts` ramp vocabulary. This unblocks the directory-browser restyle without lifting the arbitrary-value ban.

Regenerate the mobile palette (`pnpm nx run <theme-project>:generate` — confirm target name via `pnpm nx show project`) or palette-sync.test.ts reddens.

### D5 — Sidebar glyph join

`packages/app-ui/src/shell/sidebar/sidebar.tsx`:

- `SidebarTree` (:466): `const { glyphByProject } = useSettingsProjection();` replace :568 `<Icon icon={Layers} className="size-3.5 shrink-0 text-ink-faint" />` with `<ProjectIcon icon={glyphByProject[project.id]} className="size-3.5 shrink-0 text-ink-faint" />`.
- `NewChatPicker` (:229): same hook; replace :259 with `<ProjectIcon icon={glyphByProject[project.id]} className="size-3.5 text-ink-soft" />`.
- Drop `Layers` from the lucide import (:39).
- Imports: `ProjectIcon` from `../../settings/assets/project-icon`, `useSettingsProjection` from `../../settings/data/projections` (precedent: `project/archived-view.tsx:6,8`). Provider already mounted above (`routes/app.tsx:302`); context default `EMPTY_SETTINGS_PROJECTION` keeps existing tests green.
- `packages/app-ui/src/settings/assets/project-icon.tsx:56`: route through `Icon` (`return <Icon icon={Glyph} className={cn("size-3.5", className)} />;`) so the glyph gets the product 1.6px stroke.
- Test: extend `sidebar.dom.test.tsx` — mount inside a settings projection with `glyphByProject: { <id>: "rocket" }`, assert the row's glyph is not the default.

### D6 — Provenance chip removal (Scope 1: circled surfaces only)

`packages/app-ui/src/settings/projects/repository.tsx`: delete `<ProvenanceChip …/>` at :168, :201, :206; delete orphaned `locusProvenance` (:124-125); trim imports (:1 `ResolvedProvenance`, :9 `toProvenance`, :15 `ProvenanceChip`). Keep `row.visibilityProvenance` (:130, drives Pin vs Reset) and the `host` prop (:207-209).

`packages/app-ui/src/settings/projects/issue-tracker.tsx`: delete chips at :101, :125; collapse `textField`'s now-single-child fragment (:100/:116); trim imports (:8, :11).

Delete `toProvenance` (`settings/data/provenance.ts:36`) + re-exports (`settings/index.ts:13`, `settings/data/index.ts:36`) + its unit test (`settings-data.dom.test.tsx:185-187`). KEEP `Layered<T>` (provenance.ts:25 — load-bearing for projections). KEEP `provenance-chip.tsx` itself (appearance.tsx:98 still uses it).

Tests: `projects.dom.test.tsx:279-281` drop the chip assertion (surrounding assertions carry the test); :302-311 replace the chip-based detected→global proof with an assertion on the projection probe (`getByTestId("probe-tracker")`), not plain deletion.

Docs: reword `docs/developing/guides/settings-and-setup.md:317` — the resolver ladder stays true; only the claim that the surface shows a chip goes.

### D7 — Welcome shell unmount

`packages/app-ui/src/routes/app.tsx:202-211`: replace the underlay branch with `if (welcomeClaimed) return <FirstRunWelcome settings={settings} />;` (keep/adapt the existing comment to say the shell must NOT mount under the welcome — a `display:none` underlay still runs coach anchors and the coachmark portals to `document.body`).

Delete dead `.rn-startup-underlay` rule (`packages/app-ui/src/index.css:117-119`).

Tests in `app.dom.test.tsx`: flip :47-52 from "chat-dock-slot exists inside the underlay" to "shell not mounted" (`queryByTestId("chat-dock-slot")` null); add regression control: welcome on screen + a project in `projects.list` → no `[data-slot="popover-content"]`/no "Start Here" coachmark in the document (fails today).

Rejected alternative: null-ing the coach store under a welcome flag — works but adds a context, keeps the dock/sidebar/settings polling alive behind the wizard, and only patches the coach symptom.

### D8 — Corner slot 76 → 81

`packages/app-ui/src/shell/corner-slot.tsx:76`: `pl-[76px]` → `pl-[81px]` (sidebar owner, mac only). Do NOT touch chat (:80, 76) or floating (:89, 72). Update stale comments (corner-slot.tsx:18, sidebar.tsx:734). Tests: `sidebar.dom.test.tsx:352,367-372,382` and `corner-slot.dom.test.tsx:112` regex → `/pl-\[(81|76|72)px\]/`. Leave `apps/desktop/e2e/corner-slot.spec.ts` at 76 (OS light zone, still correct).

### D9 — Directory browser restyle to prototype

`packages/app-ui/src/components/directory-browser.tsx` vs `spikes/board-prototype/components/directory-browser.tsx` (the prototype file is the corrected port of this one — logic identical, styling diverged):

- :186 row `px-3 py-2 text-base` → `px-2 py-2.5 text-13 sm:py-1.5`
- :169 list `gap-1 max-h-72 rounded-surface border-line bg-surface p-1.5` → `gap-0.5 max-h-[min(45dvh,24rem)] min-h-32 rounded-md border-border p-1`, no fill (if `max-h-[…]` trips the app-ui ramp test, allow this exact literal or add a token)
- :220 breadcrumb `gap-1 text-sm` → `gap-0.5 text-xs`
- :235 crumbs `px-1.5 py-1 rounded-chip … font-semibold` → `px-1 py-0.5 rounded … font-medium`
- :159 error → `px-3 py-2 rounded-md border-destructive/50 bg-destructive/10 text-13` wash style
- :199 folder icon `text-ink-faint` → `text-ink-soft`
- :202 repo badge `text-2xs` → `text-10`
- :180 restore `aria-selected={index === focusIndex}` (a11y regression vs prototype)
- :126-137 Up button fixes itself via D2.

## Risks / Trade-offs

- **D2 shrinks every control app-wide.** That is the point (prototype parity), but screens hand-tuned against the larger ramp may show minor spacing oddities. Accepted; the deferred type-scale sweep will finish the convergence.
- **D4 palette regen** touches a generated mobile file; the sync test is the control.
- **D3's `* { border-border }`** changes any site that relied on currentColor borders intentionally — investigation found none, all 14 sites are regressions vs prototype.
- **D1** alters cascade for any future surface that stamps a scheme late; `:where()` makes the failure mode "pack wins", which is the desired direction.
- Workstream token names are fixed here (`text-10`, `text-13`) so parallel implementers cannot diverge.
