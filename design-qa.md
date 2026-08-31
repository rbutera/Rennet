# First-run welcome design QA

Source visual truth: `/Users/rai/.codex/visualizations/2026/08/28/01a04855-3c9c-7b82-91dc-47f2b003e1c5/rennet-welcome-flow/`

Approved source image: `/Users/rai/.codex/generated_images/01a04855-3c9c-7b82-91dc-47f2b003e1c5/exec-f7a78dd8-4402-404e-9386-8230446324e3.png`

Implementation: `packages/app-ui/src/welcome/first-run-welcome.tsx` rendered by the desktop application.

Target viewport: 1487 × 1058 CSS pixels at device scale factor 1.

Source pixels: 1487 × 1058. Implementation pixels: 1487 × 1058. Both captured at device scale factor 1, so no density normalization was needed.

State: first-run welcome, opening code flight through the assembled-logo appearance state and every wizard step, Affineur's Bench light theme.

Executed 2026-08-31. Captures under `/tmp/rennet-style-session/qa/` (`proto-*` prototype, `app-*` implementation, `app-b-*` board surfaces, `bproto-*` board prototype). They are scratch, not repository artifacts.

## How the comparison was made

The prototype was served with `npx vite --port 5199` and driven headless at the target viewport. The implementation was driven by the real Electron app under the desktop e2e harness on a throwaway `userData` dir — the app a first run actually gets, not a story or a browser mount. The 1080p host clamps an Electron window to about 992 CSS pixels tall, so the viewport was forced through CDP `Emulation.setDeviceMetricsOverride` at 1487 × 1058 / dsf 1; captured PNGs measure exactly that.

Geometry, type and colour were read from `getComputedStyle` on both sides at the same state, not estimated from pixels. Two disagreements below are recorded as prototype artifacts because the prototype's own computed values were read and found broken, not because the implementation looked better.

## Full-view comparison evidence

Compared, per surface:

| Surface | Verdict |
| --- | --- |
| Opening code flight (700 ms / 1.5 s / 3 s / settled) | Match. Same fragment catalogue, same full-length fragments, same drift and fade. |
| Gather + logo assembly (450 ms / 950 ms) | Match. Fragments converge on the mark, the mark lands, the wordmark wipes in left-to-right behind it. Frames are within about one frame of each other. |
| Assembled logo | Match to the pixel: both `627, 135`, `435 × 102`, inside a 640 px assembly. |
| Appearance panel | Match in structure and dimensions; four recorded differences (below). |
| Sentence reel | Match. One line per sentence under a `1.35em` window, seamless wrap, no per-word reflow. |
| Step 2 Tools | Match. Same eyebrow/headline/body rhythm, row heights, status pills, footnote, divider, Back/Continue. Two differences: monochrome tool glyphs where the prototype uses full-colour brand marks, and the shipped CTA proportions. |
| Step 3 Review setup (no harness) | Match. Same red-lined card, tinted terminal tile, headline, two-button row. The Continue the prototype lacks is #603, deliberate. |
| Step 4 Project | Structural divergence, deliberate: the prototype shows a decorative "Browse this Mac" card with a gold `+`; the implementation inlines the real directory browser (source select, breadcrumb, path bar, folder list, Add). The Full Disk Access strip also sits above the panel rather than below it. |
| Step 5 Ready | Match in composition (mark with green tick, eyebrow, serif headline, body, three-column summary with per-row icons, start CTA, Back). The summary strip is a bordered card here and a hairline-ruled band in the prototype. |
| Progress pips | Match. Same position (`y=1000`), same size to within 9 px of width, and the third state is present — a completed step reads outlined with its tick, distinct from active and from future. |

## Focused region comparison evidence

Measured at the appearance state, 1487 × 1058:

| Element | Prototype | Implementation |
| --- | --- | --- |
| Wordmark | `627, 135` `435 × 102` | identical |
| Hero tagline / reel | 24 px, `-0.36px` tracking | 24 px, `-0.36px` (after the fix below) |
| Appearance panel | `195, 547` `1098` wide | `195, 446` `1098` wide |
| "Choose your appearance" | Inter 18 px / 700 | Fraunces 18 px / 600 |
| Eyebrow | 10 px / 700, `1.2px` tracking | 11 px / 700, `1.32px` tracking |
| Continue | `144 × 42`, 16 px / 700, white on gold | `103 × 32`, 14 px / 500, dark ink on gold |
| Pips | `493, 1000` `502 × 44` | `497, 1000` `493 × 44` |
| Ground | `#f7f4ed` | `#fbfaf7` |
| Gold | `#bc7a08` | `#e0a52e` |

## Required fidelity surfaces

- Fonts and typography: verified rendered. Display serif on step headlines matches. The hero tagline now resolves to 24 px at this viewport, as the prototype does. The appearance card's `h2` renders in the display serif here and in Inter in the prototype — that is the global `h1,h2,h3` rule at `packages/app-ui/src/index.css:67`, which carries a comment declaring it deliberate.
- Spacing and layout rhythm: verified rendered. Logo, pips and panel width are identical. The panel sits 101 px higher than the prototype's, which is a prototype artifact, not a defect — see Findings.
- Colours and visual tokens: verified rendered and sampled. The implementation's ground and gold are the Affineur's Bench theme tokens; the prototype carries its own local palette. Theme tokens win, per the dependency between `DESIGN.md` and a standalone prototype's ad-hoc values.
- Image quality and asset fidelity: verified rendered. The mark/wordmark split draws from one lockup at the prototype's exact geometry, and the wipe is visible mid-flight.
- Copy and content: verified rendered. The D10 reconciliation (Ready headline, Project headline, Bitbucket "Not supported yet", the no-harness consequence sentence) is present and intentional.
- States and interactions: verified by driving the app — opening, gather, appearance write, tools, no-harness review setup with a working Continue, project browse, Add, Ready. The Settings → First Run → "Replay the first-run welcome" action is present.
- Responsiveness and accessibility: partially verified. The target viewport is verified rendered. Alternate viewports, browser zoom, reduced motion and the dark scheme were not captured in this pass.

## Findings

- Fixed. The hero tagline lost its fluid size in the Tailwind conversion.
  - Location: `packages/app-ui/src/welcome/first-run-welcome.tsx:757` (opening tagline) and `:769` (review reel).
  - Evidence: the prototype sets `font-size: clamp(18px, 1.7vw, 24px)` (`styles.css:193-194`), which computes to 24 px at 1487 px wide. Both implementation taglines were a flat `text-lg`, computing to 18 px.
  - Fix: `xl:text-2xl` alongside `text-lg`, the closest ramp-legal equivalent — the ramp test bans arbitrary `text-[…]`, so the clamp cannot be transcribed. Re-measured after the fix: 24 px, `-0.36px` tracking, matching the prototype exactly.

- Open, for Rai. The primary CTA is smaller and quieter than both the prototype and the approved still.
  - Location: `packages/app-ui/src/welcome/first-run-welcome.tsx:885` and the shared `StepActions` at `:914`.
  - Evidence: prototype `144 × 42` at 16 px / 700, white on `#bc7a08`; implementation `103 × 32` at 14 px / 500, dark ink on `#e0a52e`. The approved still also shows a large white-on-gold button.
  - Not fixed here: the dark-ink `accent` treatment is on the wave plan's do-not-fix list, and the kit's button height ramp tops out at `h-9` (36 px), so matching 42 px means either an arbitrary size or extending the sanctioned ramp. That is a ramp decision, not a QA repair.

- Open, for Rai. The ambient particle field renders as a visible lattice.
  - Location: `packages/app-ui/src/welcome/first-run-welcome.tsx:279-283`, mirroring `styles.css:230`.
  - Evidence: the prototype's rule is `top: calc(31% + ((var(--i) % 7) * 8%))`. In CSS `%` is a unit, not a modulo, so the declaration is invalid and dropped — every prototype particle computes `top: 0px` and they pile into one row at the top edge (read from `getComputedStyle`, not inferred). The implementation computes the same expression in JavaScript, so it renders the seven-row field the CSS intended but never displayed. It reads as a regular grid.
  - Not fixed here: the implementation matches the stated intent and the prototype matches what was approved on screen. Which one wins is Rai's call, not a QA repair.

- Recorded, no action. The appearance panel sits 101 px higher than the prototype's.
  - Evidence: the prototype's `<picture class="logo-mark">` lays out BOTH the light and the dark `<img>` (the animation-layer rule `.logo-mark img { display: block }` at `styles.css:189` overrides `.brand-lockup img.brand-dark { display: none }`), so its logo assembly measures 203 px tall against a visible 102 px. The invisible white-on-cream second image is the whole difference. The implementation's assembly is 102 px, and everything below it moves up by the phantom 101.

- Recorded, no action. Palette differences are theme tokens, not drift: ground `#f7f4ed` → `#fbfaf7`, gold `#bc7a08` → `#e0a52e`, GitHub preview `#ffffff` → `#f6f8fa`. The prototype carries a local palette; the implementation carries `@rennet/theme`.

- Recorded, no action. The code-rain syntax hues ride `--rn-syn-*` rather than the prototype's fixed hex, so the rain retints as the reader tries theme packs on the screen it drifts behind. `packages/app-ui/src/index.css:280-282` declares this deliberately.

- Recorded, for a later look. On the New Chat list the row named by the composer's target chip carries no trailing selection check, where the prototype's selected row does. Seen once, in one state; not chased.

## Board surfaces

Compared best-effort at the same viewport. The board prototype (`spikes/board-prototype`) was installed and served on port 5198; the implementation was driven through the e2e harness with a seeded board fixture.

- Shell, sidebar, top bar: match. Search with `⌘P`, New Chat, Add Project, Add Environment, host group headers, project rows with counts, session row with its `now` sublabel, ghost New Chat, footer icons, the panel toggle, the trail, the five lens pills with their dot indicators and the Flagged count badge, and the coachmark card all land in the same places at the same sizes.
- New Chat: match. Headline, project-picker pill, tab row with counts, filter box, list box, row layout, composer shell with its target chip and send button, `Map` / `esc` top right.
- Settings: the implementation's shell renders (nav rail, sections, rows, choice pills, and the new First Run replay action). The prototype's `/settings/general` served a blank right pane, so this pair is NOT a comparison — only the implementation was seen.
- Board content: NOT compared, and cannot be in this environment. The e2e harness runs `RENNET_DISABLE_HARNESS=1`, so board drafting fails ("lens-draft resolved to claude-code, which is unavailable") and the app renders its honest failure surface instead of a board. The failure surface itself reads on-palette. Comparing real lens boards needs a live harness run.

## What this pass could not verify

- Motion timing to the millisecond. Frames were compared at fixed offsets (700 ms, 950 ms, 1.5 s, 3 s, settled) and agreed; the easing curves and the exact 2.76 s / 1.42 s / 0.08 s constants were not measured against the prototype's clock.
- Reduced motion, the dark scheme, alternate viewports, and browser zoom.
- Board content parity, per above.
- The prototype's own settings surface.
- Console errors in the running app were not collected in this pass.

## Comparison history

One pass, 2026-08-31, executed rather than blocked. The interactive prototype itself was reviewed and refined with Rai before implementation, including code-fragment flight, logo spacing, tagline centering, continuous single-word cycling, first-page chrome removal, and bottom progress placement.

final result: pass, with two open questions for Rai (CTA proportions, particle lattice) and one fix applied
