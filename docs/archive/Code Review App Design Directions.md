---
categories: [project]
tags:
  - code-reviews
  - design
status: active
created: 2026-08-04
updated: 2026-08-05
---

# Code Review App Design Directions

> [!IMPORTANT] Current design authority, 2026-08-05
> Product is **Rennet** and Glass is the selected direction. [[Rennet Contracts and Rulings]] and [[Rennet Architecture Contracts]] override the exploratory screens and language below. The refreshed prototype must show all six angles, author-side-first entry, immutable patchsets, local invalid/potentially-invalid/regenerating states, affected-only regeneration, the two publish variants, and truthful “no Rennet backend” disclosure. Subtraction is not an angle and route handoff is removed.

Visual design ideation for [[Code Review Harness App|Rennet]]. Builds on [[Code Review App UX Research]] and [[Code Review App UX Concepts]]. The current state is six angles (Spec, Sequence, Decisions, Claims and Evidence, Blast Radius, Noise), ANGLES and CHUNKS vocabulary, context reach, immutable patchsets, explicit publication, and strictly private pace/coverage.

Historical mockups live in `../prototypes/archive/mockups/`. Open them in a browser; they are self-contained HTML, no network, system fonts only.

| File | Screen |
|---|---|
| [01-review-surface.html](../prototypes/archive/mockups/01-review-surface.html) | Historical review surface: sequence rail, chunk reading pane with context reach, angle switcher, private coverage |
| [02-decisions.html](../prototypes/archive/mockups/02-decisions.html) | Decisions angle: capped queue with reconstructed why |
| [03-subtraction.html](../prototypes/archive/mockups/03-subtraction.html) | Historical Subtraction screen; useful content moves to finding rule families and Noise |
| [04-diff-chat.html](../prototypes/archive/mockups/04-diff-chat.html) | Anchored diff chat, harness chip, second-opinion disagreement |
| [05-publish.html](../prototypes/archive/mockups/05-publish.html) | Historical publish screen; replace with local PR-preview and remote-review variants |
| [06-mobile.html](../prototypes/archive/mockups/06-mobile.html) | Mobile companion: live feed while the desk analyzes |
| [00-alt-review-surface.html](../prototypes/archive/mockups/00-alt-review-surface.html) | Screen 01 rendered in the alternate direction for comparison |

---

## Three directions

### A. The Reading Room (recommended, built)

The review is a document you read, not a cockpit you monitor. The whole category ships purple-on-dark-gradient dashboards; this differentiates on sight and matches both the target feeling ("so much easier to understand") and the positioning (an account you sign your name to reads naturally on paper).

- **Typography.** Three roles. Narrative voice: New York (`ui-serif`), used only where the product speaks in sentences: chunk titles, reconstructed whys, the publish statement. This is a deliberate native-macOS commitment (the system's own serif, the one Apple built for reading surfaces), not a fallback. UI voice: SF Pro (`-apple-system`), 13px baseline, the platform's dense-app convention. Code: SF Mono (`ui-monospace`) at 12.5px/1.65, tabular numerals everywhere a count appears. The serif is rationed hard; if it appears on a button the direction has failed.
- **Color, light scheme (default).** Warm paper `#FAF9F5` (cool enough to dodge the AI-cream cliché), ink `#23211C`, warm-tinted secondary text, hairlines `#E5E1D6`. One accent with one job: pencil blue `#2F5FA3` for interaction and selection. The signature color decision: **non-photo blue** (`#33617F` on `#EDF4F8`) marks everything private to the reviewer: coverage, pace, chat, dismissals. In print, non-photo blue is the pencil whose marks the camera never reproduces; here it is the literal encoding of "pace and coverage never publish". Ink is what travels; blue is what stays. Amber `#8A4B0A` belongs to blast radius alone. Diff tints are quiet (`#EAF2E6` / `#F7ECE7`) with colored gutter glyphs, so add/remove reads without shouting.
- **Color, dark scheme ("lamplight", specified, not mocked).** Warm dark paper `#1C1B18`, raised surfaces `#232219`, ink becomes bone `#E8E5DC`, the same role structure remapped: private blue brightens to `#7FB3CE` on `#20303A`, amber to `#D6A75B`. Explicitly composed, not inverted: the diff tints go darker-desaturated, hairlines drop to `#32302A`. It should feel like the same book under a desk lamp, not a different app.
- **Density.** Reading measure discipline: narrative at 62 to 76ch, diffs full width, generous chunk headers, tight rows inside queues. Calm chrome, dense content.
- **Native lean.** Medium-high. Real traffic lights, menu bar parity, system fonts, Liquid Glass materials reserved for chrome (toolbar, palette) while every code surface stays opaque for contrast. The reading surface itself is product-branded paper; that is the identity.

### B. The Instrument (built as the alternate, screen 01 only)

Dark graphite precision tool: Dieter Rams by way of Sublime Merge. Monochrome panels (`#131417` to `#24272C`), hairline seams, SF Pro only, uppercase micro-labels, tabular numerals, and color spent exclusively on meaning: add green, delete rust, risk amber, private cyan, steel-blue selection. Density one notch higher than A. Native lean: high on materials and shortcuts, but the identity is the machined panel, not the platform. Honest assessment: it is handsome and credible, developers trust this register instantly, and it is also the register every competitor already occupies at their best. It wins on familiarity and loses on differentiation, and the publish ceremony has nowhere to go emotionally on graphite.

### C. The Chart Desk (proposed on paper only)

Aviation flight-planning as the world: sectional-chart paper, functional magenta/blue chart linework, plotter typography, the route as an actual plotted course, decisions as waypoints. It suits the Wingman referent and the "route" vocabulary perfectly, and aviation charts are a masterclass in dense-but-calm information design. Not built: the referent dies with the placeholder name, chart linework risks gimmick on a tool used eight hours a day, and its best ideas (the route as a course, functional color coding) are already absorbed into direction A.

## The argument for the Reading Room

1. **Differentiation you can see in a screenshot.** Market research says the category is dark gradient cockpits; a light document surface is recognizable as "not another one" from across the room. Direction B forfeits that.
2. **The positioning needs paper.** "You stopped writing the code. You still have to answer for it" culminates in inspecting exactly what will leave the machine and explicitly signing the action. A signature on a document is a real object; a signature on a cockpit is a metaphor. The publish ledger is the product's boldness budget, spent where the brand lives.
3. **The private/public split becomes material.** Non-photo blue gives the pace-stays-private decision a color you learn once and trust everywhere. No competitor has a visual grammar for "this the team never sees".
4. **Reading is the job.** Every ratified mechanic (prose collapsed, sequence as route, evidence rows, capped decisions) is a reading-comprehension mechanic. The aesthetic should make the same promise the features do.
5. **Risk, named honestly.** Light-default is contrarian in dev tools and some reviewers live in dark rooms; the lamplight scheme is therefore a first-class deliverable, not an afterthought, and diff legibility on paper needs the muted-tint discipline held under pressure. If taste-reaction says the paper feels precious, direction B is the fallback and 00-alt shows the same bones survive the move.

## What the impeccable pass changed

The skill was applied in craft mode (its interactive machinery, concept roll and decision page, cannot run in a headless background session; manual application was the sanctioned substitute). Material changes it forced:

- Killed the kicker/eyebrow habit: chunk numbers moved into the heading proper ("2 · The token bucket"), earned because the sequence is real information.
- Diff markers rebuilt as background tint plus gutter glyphs; no thick colored left borders anywhere.
- All icons are authored inline SVG at one stroke weight; no emoji, no glyph stand-ins.
- Secondary text warm-tinted from the ground hue rather than gray, contrast checked (body roles at or above 4.5:1, metadata above 3:1).
- Boldness concentrated in one place (the publish sheet) instead of scattered; everything else made quieter to pay for it.
- Mechanical detector ran clean on all seven files; the batched screenshot round caught and fixed per-line scroll overflow in the diffs and button text alignment on mobile cards.

> **Status 2026-08-04, end of day: GLASS IS THE RATIFIED IDENTITY** (Rai: "definitely glass is the way"). Everything above this line describing the Reading Room as the recommended direction is superseded history; the Reading Room survives only as the paper material inside Glass (see the consolidation section below). The mood board defaults to Glass.

## The interactive mood board (round 5)

Rai asked for something he can look at and interact with, plus two hard additions: the macOS vibrancy/glass treatment he likes ("glassy transparent sidebar"), and a home surface showing all branches, PRs, and worktrees in one place. The current interactive prototype is at `../prototypes/moodboard/index.html`.

- Open [the current moodboard](../prototypes/moodboard/index.html) in a real browser.
- The screens are one set of HTML themed entirely by design tokens (`assets/tokens.css`), which is itself the design-system argument: the structure holds, the world swaps.
- Interactions that demonstrate feel: sidebar collapse on Home, angle switching (keys 1/2) and mark-chunk-read (R, coverage cells advance) on Review, press-and-hold to sign on Publish.
- The home surface is the workspace model made visible: repos grouped by durable project identity, worktrees shown as checkouts of their repo, local reviews first, PRs with patchset/review state, and explicit invalidation/regeneration status when source moves.

### The Glass direction, and how it reconciles with code legibility

Glass is dark vibrancy done the way the HIG means it: a wallpaper glow (teal and amber aurora) breathing through a frosted sidebar and translucent window chrome, floating panels with hairline light edges. The reconciliation with the research finding (translucency degrades code contrast) is a hard rule baked into the tokens: **glass is for chrome, never for code.** The sidebar, titlebar, and cards may be translucent; every code surface (`--code-bg`), diff tint, and the publish sheet's reading column sit on fully opaque fills. The wallpaper can glow around the diff, never through it. Same rule as the Reading Room's "opaque code surfaces under Liquid Glass", applied at higher contrast stakes.

Honest read after building both: Glass is the direction that photographs best and matches Rai's screenshot taste; the sidebar treatment genuinely flatters the workspace tree, and the home surface is Glass's best screen. But the review surface is where the product lives, and there the paper world still reads better: the serif narrative voice, the ink/private-blue split, and the publish signature all carry meaning that Glass renders merely handsome. Recommended synthesis if one must be chosen: Reading Room as the identity, with the Glass sidebar treatment adopted for the home surface's lamplight (dark) scheme, where vibrancy and the workspace tree meet naturally. The mood board exists so Rai can disagree by clicking.

## Glass, ratified: the consolidated system (round 6)

Rai's verdict, verbatim: "definitely glass is the way." Glass proper, not the synthesis. The mood board now carries the full product on Glass: all seven screens, dark and bright-room schemes, both wordmarks. The earlier honest read (paper wins the reading and signing moments) was treated as the risk register; the answers are below.

### System rules (absolute)

1. **Glass is for chrome, never for code.** Sidebars, titlebars, toolbars, cards, and thread panels may be translucent and blurred; every code surface (`--code-bg`), diff tint, and reading column is fully opaque. The aurora glows around the diff, never through it.
2. **Paper is what leaves the machine.** Anything that becomes a GitHub artifact renders as opaque warm paper (`--sheet-*` tokens): the publish sheet above all, and any preview of a comment about to land. Working state lives on glass; committed account lives on paper. This one rule carries the whole public/private semantics as material.
3. **Private things glow from within.** Surfaces private to the reviewer carry the backlight treatment (see below), the only inner glow in the system.
4. **Functional colour only.** Add green, delete rust, blast amber, backlight blue, accent ice-blue. No decorative hues.

### The five open questions, decided

- **Serif verdict:** the serif does NOT survive as the interface narrative voice. On glass the narrative speaks in the "etched voice": SF Pro at regular weight, larger size, 1.7 leading, soft colour (see `[data-dir="glass"] .why` rules). New York is reserved for paper, which means the publish sheet and the signature line, where it lands with full force precisely because it appears nowhere else. Scarcity is the register.
- **Private-marks colour:** "backlight blue", `#85C4DC` on translucent cyan fills with a faint inner glow (`--private-glow`). The glass-native reading of non-photo blue: not ink that fails to reproduce, but a surface lit only under your own light. Bright-room scheme deepens it to `#24657F` for contrast. It marks coverage, pace, chat, dismissals, and the stays-panel, exactly the set that never publishes.
- **Disagreement-flare hue:** no fourth hue. Disagreement stays in the amber family (it is a risk signal aimed at your judgment) and takes its identity from the split treatment instead: the warning glyph, the two-harness consistency line (3/3 vs 3/3), and the "substantive, not stochastic" verdict copy. Adding a hue would break rule 4 for no information gain.
- **Bright-room (light) Glass:** exists, composed rather than inverted: milky white translucency (`rgba(246,248,250,.52)`) over a pale aurora, ink text, deeper functional colours, white inner highlights instead of glow. Dark is the default; `?scheme=light` or the hub toggle switches it. Tokens live in `[data-dir="glass"][data-scheme="light"]`.
- **Wallpaper/aurora policy:** three tiers. (1) Native default on macOS: behind-window vibrancy (NSVisualEffectView), so the user's own desktop shows through, zero-config and the platform's own trick. (2) The shipped aurora set (the teal/amber pair in the mockups) for Windows/Linux, screenshots, and users who want consistency; it is also the marketing identity. (3) User-supplied image, always tone-mapped (blur, dim, saturation clamp) so chrome legibility never depends on wallpaper luck; text contrast is guaranteed by the panels' own minimum backdrop dim, never by the picture behind them.

### How publish found its register on glass

Materiality inversion, built, not described: in a fully translucent product, **the thing you sign is the only solid object.** The publish sheet is opaque warm paper (`#F7F5EF`), lit by a soft concentration of light (`--sheet-glow`), carrying the serif document voice, the travels ledger, and the italic signature line. The "Stays on this Mac" list never touches the paper: it floats beside the sheet on a frosted glass panel in backlight blue, with the closing line "paper is what leaves the machine; everything still on glass stays here." Hold-to-sign fills the button over 900ms (reduced-motion collapses it). Verified in the browser: the contrast between the one solid sheet and the receded glass world reads as commitment, which was the whole risk.

### Mood board file list (current)

The current canonical files live under `prototypes/moodboard/`: [index.html](../prototypes/moodboard/index.html), `home.html`, `review.html`, `decisions.html`, `chat.html`, `publish.html`, `mobile.html`, and `assets/`. The retired Subtraction screen is retained under `prototypes/archive/` with the earlier exploratory mockups.

## Decisions still open after ratification

- The hold-to-sign motion curve and the signed-state transition (mocked linearly; needs real motion design when built).
- Aurora set curation (how many shipped, whether they shift with time of day).
- Whether the bright-room scheme follows the system appearance automatically (likely yes; not yet decided).
- Serif fallback on Windows/Linux applies only to paper surfaces now, which shrinks the port problem to one material: evaluate at port time.

## Ambient chat (2026-08-04)

Rai's feedback: "there's nothing in the UI about chatting to the LLM." Accurate at the surface level: chat.html existed but was an island; on every other screen the conversation's only trace was one margin note and a footer keyboard hint. The fix makes the conversation AMBIENT without adding a hue or a new material: since threads are private until promoted, every chat affordance rides the existing backlight-blue treatment, and the `thread-mark` motif from chat.html becomes the system-wide glyph for "a conversation lives here".

- **Review surface:** thread marks and the anchored-line inset now appear in the diff gutter itself (keys.ts L18–19, matching chat.html's grammar); the margin gains a live thread card (last message + "Continue · 2 messages"), an "Ask about this finding" affordance on the harness note, and a pinned ask-line ("Ask Claude Code about these lines…" · C) above the private card; the rail carries a listening line (three overlapping backlight dots, one per attached harness).
- **Home:** the sidebar foot's harness inventory became live status ("Claude Code · codex · oh-my-pi listening"); changesets carry private thread-count badges in backlight, deliberately distinct from the plain badge used for public GitHub threads on #475: the two-materials rule at badge scale.
- **Decisions:** the disagreement card's "Read the disagreement" became a backlit "Open the thread · 4 messages" with the thread mark, sitting inside the amber verdict: amber says *risk*, backlight says *the conversation about it is here and still yours*.
- **Subtraction-family findings:** "Ask the author's agent" uses the same thread-open language; no separate Subtraction surface.
- **Hub:** the chat tab is now labelled "Diff chat".
- **CSS:** one shared token-driven block in screens.css (`.listening`, `.thread-open`, `.thread-card`, `.ask-line`); no per-direction markup forks; all four edited screens visually verified on Glass dark.

New doctrine sentence, sibling to "paper is what leaves the machine": **the conversation has no room of its own; it is backlight behind every pane, and only your hand turns any of it into paper.** Corollary that keeps it quiet: the code stays the protagonist; chat never gets a colour, only a light.
