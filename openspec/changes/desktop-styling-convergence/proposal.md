# Desktop styling convergence + broken-surface fixes

## Why

The shipped desktop app visibly diverges from the board prototype (`spikes/board-prototype`), which is the canonical styling target, and four appearance-adjacent features are outright broken: theme pack and code theme pickers do nothing on a dark-mode OS, the chosen project glyph never reaches the sidebar, the onboarding tour fires underneath the welcome wizard and burns its marks, and the macOS sidebar logo crowds the traffic lights. Investigation traced each to small, proven root causes — none of them the suspected "theme not imported" or "hand-rolled components" hypotheses.

## What Changes

- **Theme pack / code theme fix**: `packages/theme/src/palette.css` OS-dark fallback selector drops from specificity (0,3,0) to `:root:where(:not([data-scheme]):not([data-theme]))`, so it can never outrank a stamped theme pack or code theme again. Adds the missing cascade control test.
- **Prototype visual parity** (mechanical, high-leverage):
  - `packages/ui` button/input restored to the prototype's control ramp (h-8 default, font-medium, prototype paddings and icon sizes).
  - `packages/app-ui/src/index.css` gains the prototype's missing base-layer rules: `* { @apply border-border outline-ring/50 }`, display-font `h1,h2,h3`, `tw-animate-css` import (currently never loaded — all overlay animations are no-ops), `@custom-variant dark`.
  - Dead file `packages/ui/src/index.css` deleted.
  - `packages/theme` dark ground palette updated to the prototype's post-review desaturated values; warn (copper) and model color registers added; `text-success` usage fixed.
  - `directory-browser` (file picker) restyled to the prototype's values; requires adding the prototype's 13px/10px type steps to the ramp tokens and allowing them in the design-ramp test.
- **Sidebar glyph**: sidebar project rows and new-chat picker read `glyphByProject` from the settings projection instead of hardcoding `Layers`; `ProjectIcon` routed through `Icon` for the product 1.6px stroke.
- **Provenance chip removal**: the uppercase provenance badges ("REPO", "builtin: local", …) are removed from project settings Repository and Issue Tracker sections; `toProvenance` and its orphans deleted. The Appearance-page chip stays (out of circled scope).
- **Welcome/tour fix**: while the first-run welcome is claimed, the app shell is NOT mounted underneath it (the `display:none` underlay is removed), so coach anchors cannot register and the tour cannot elect until the user lands on the new chat view after onboarding.
- **macOS logo clearance**: sidebar corner-slot mac reserve 76px → 81px (sidebar owner only).
- **Deferred, explicitly out of scope**: the full ~300-site type-scale sweep onto the prototype's 11.5/12.5/13/13.5px vocabulary (needs a doctrine change to DESIGN.md's ramp canon), the ink-vocabulary consolidation (`text-ink-faint` vs prototype's two-level system), and the kit-component conversion sweep (Tabs/Tooltip/Checkbox/Textarea adoption). These are follow-ups, not part of this change.

## Capabilities

### New Capabilities

- `desktop-appearance`: how the desktop applies appearance choices — theme packs and code themes take effect regardless of OS color scheme; the visual system (control ramp, base-layer rules, dark ground palette, warn register) matches the board prototype; the sidebar renders each project's chosen glyph; project settings Repository and Issue Tracker sections show no provenance badges; the macOS sidebar wordmark clears the traffic lights.
- `onboarding-tour`: when the tour may begin — the app shell does not mount beneath the first-run welcome; coach marks first register, elect, and render on the new chat view after the welcome completes; welcome interactions cannot dismiss or burn unseen marks.

### Modified Capabilities

(none — `first-run-welcome` lives in the unpromoted c21 change; its "welcome fills the window before coach marks appear" scenario is restored, not changed)

## Impact

- `packages/theme`: palette.css selector + dark ground values + warn/model registers + new type-step tokens; theme.test.ts fixture string + new cascade test; mobile generated palette regenerated (`palette-data.mjs` consumers).
- `packages/ui`: button.tsx, input.tsx (control ramp); delete dead src/index.css; its own design-ramp test may need the ported arbitrary values allowed.
- `packages/app-ui`: index.css base layer + tw-animate-css dep; sidebar.tsx glyph join; project-icon.tsx stroke; repository.tsx/issue-tracker.tsx chip removal + data/provenance.ts orphan deletion; routes/app.tsx welcome underlay removal + index.css dead rule; corner-slot.tsx 76→81; directory-browser.tsx restyle; design-ramp.test.ts allowances; affected dom tests updated with positive controls.
- `apps/desktop`: none (e2e LIGHT_ZONE stays 76 — it measures the OS zone, not the padding).
- Docs: `docs/developing/guides/settings-and-setup.md` provenance-chip sentence; check `docs/using/**` for glyph/theme claims.
