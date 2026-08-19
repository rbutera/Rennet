---
name: Rennet
description: Dense change becomes clear human judgment.
colors:
  light-canvas: "#fbfaf7"
  light-surface: "#ffffff"
  light-raised: "#f3f1ec"
  light-ink: "#1e1b16"
  light-muted: "#57534a"
  light-line: "#e2ddd2"
  dark-canvas: "#0e0d0c"
  dark-surface: "#151413"
  dark-raised: "#1b1a18"
  dark-ink: "#f2ede4"
  dark-muted: "#a9a196"
  dark-line: "#2a2723"
  gold-light: "#8a5d0b"
  gold-dark: "#e8b13c"
  gold-fill-light: "#e0a52e"
  gold-fill-dark: "#e8b13c"
  green-light: "#41745b"
  green-dark: "#88bc9b"
  danger-light: "#b23b2b"
  danger-dark: "#db7a6a"
typography:
  display:
    fontFamily: "Fraunces Variable, Georgia, serif"
    fontSize: "clamp(2.8rem, 5vw, 6rem)"
    fontWeight: 500
    lineHeight: 1.02
    letterSpacing: "-0.015em"
  serif:
    fontFamily: "Source Serif 4 Variable, Georgia, serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "DM Sans Variable, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "DM Sans Variable, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
rounded:
  control: "10px"
  surface: "12px"
spacing:
  control-x: "24px"
  section-min: "88px"
components:
  button-primary:
    backgroundColor: "{colors.gold-fill-light}"
    textColor: "#191307"
    rounded: "{rounded.control}"
    padding: "0 24px"
    height: "56px"
  review-surface:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.surface}"
---

# Design System: Rennet

## Overview

**Creative North Star: "The Affineur's Bench"**

Rennet turns dense technical change into a smaller number of legible, evidence-bearing
objects without hiding the code underneath — the way an affineur turns milk's chaos into
something aged, warm, and worth serving. The visual system is calm, warm, and seamless:
one continuous near-black (or near-white) ground, quiet surface steps instead of loud
chrome, a single golden accent, and a serif voice for the judgments that matter.

This world supersedes the earlier "Breaking Edge" glass world (ratified 2026-08-19).
Frosted glass, translucent chrome, the review-blue accent, and the cool neutral ramp are
retired. Any document still describing them is historical.

The system has one shared theme across every surface — desktop app, browser app, mobile,
marketing, and the docsite. They differ in scale and density, never in world.

## Material

**The window is one continuous surface.** Canvas, titlebar, and toolbar share the same
background color. There is no glass, no vibrancy, no translucent chrome. Panels separate
through small lightness steps (canvas → surface → raised) and whisper-quiet hairline
borders, never through hard contrast or decorative shadow. Shadows exist only on true
overlays (menus, dialogs, popovers) and carry a real offset and broad blur.

Grounds are warm, never pure gray: every neutral carries a faint bias toward the golden
accent — a whisper, not a tint you can name.

## Colors

Light and dark are complete compositions. Both are first-class.

### Dark (default)

- **Canvas** (`#0e0d0c`): warm near-black; the entire window ground, chrome included.
- **Surface** (`#151413`): opaque reading surfaces one step above the canvas.
- **Raised** (`#1b1a18`): the lifted card, one step above surface.
- **Text** (`#f2ede4`) and **muted text** (`#a9a196`).
- **Line** (`#2a2723` / white-warm alpha hairlines) for quiet structure.

### Light

- **Canvas** (`#fbfaf7`): near-white with a faint warm cast.
- **Surface** (`#ffffff`): white cards and reading surfaces.
- **Raised** (`#f3f1ec`): the warm recessed/raised step.
- **Text** (`#1e1b16`) and **muted text** (`#57534a`).
- **Line** (`#e2ddd2` / warm dark alpha hairlines).

Use `data-scheme="light|dark"` as the shared control vocabulary. Honor the
operating-system preference by default, allow an explicit stored override, and resolve it
before paint.

### Semantic roles

Monochrome carries the identity. Functional color explains review state, and the brand
accent and the decision register are **one hue**:

- **Gold** (`#8a5d0b` light text / `#e8b13c` dark, fills `#e0a52e`/`#e8b13c` with
  near-black ink `#191307`): links, selection, focus, primary actions, review structure,
  reconstructed decisions, disagreement, and blast radius. Decisions are the product's
  core object; they carry the brand color. In the light scheme, gold is a *fill* hue —
  text set in gold uses the ochre `#8a5d0b` so it meets WCAG AA on white.
- **Evidence green** (`#41745b` / `#88bc9b`): additions, current repository state, and
  verified evidence.
- **Danger red** (`#b23b2b` / `#db7a6a`): destructive actions and errors only.

The old review blue is retired entirely. The private/local-only register remains a
derived tint of the accent (gold), carried by the backlight glow and a gold-tinted
surface — never its own hue. Do not introduce a decorative fourth hue. Color never
carries a state without text or structure.

## Typography

Three voices, each with a job:

- **Display — Fraunces** (self-hosted variable, Georgia fallback): brand moments,
  headlines, screen titles, empty states. Weight 440–600, never compressed. Warm, slightly
  soft; this is the product's voice at large sizes.
- **Serif — Source Serif 4** (self-hosted variable, Georgia fallback): the review's
  spoken register. The AI's annotation dialogue beside the diff, review prose, and the
  paper that leaves the machine read in serif at 15–17px.
- **Sans — DM Sans** (self-hosted variable, system-ui fallback): everything operated.
  Buttons, labels, inputs, chips, navigation, metadata. 400–500 for text, 600–700 for
  labels and controls.
- **Code:** the platform monospace stack, only for source code, diffs, and exact
  technical values. Monospace is never interface texture.

The wordmark remains an exact path trace of concept lettering — identity, not a font.

Display headings may grow to `6rem`, use `~1.0` line height, and never track tighter
than `-0.04em`. Body copy stays between 45 and 75 characters where practical.

### Desktop scale

The desktop product renders at a comfortable, enumerated type ramp — larger than the
previous dense ramp; crowding was a defect, not a style. It is authored in **rem**
(px shown at the 16px root) and snaps to Tailwind's type scale — components speak
utilities (`text-sm`, `text-lg`), never raw sizes:

`11 / 12 / 14 / 16 / 18 / 20 / 24` px (`text-2xs` through `text-2xl`), plus the
front-door display expression `text-display` = `clamp(2.125rem, 5vw, 3.5rem)`.

- **11px / `text-2xs`** micro — uppercase micro-caps, the smallest legible chrome.
- **12px / `text-xs`** meta — secondary metadata, counts, pins.
- **14px / `text-sm`** chrome — the standard chrome label and control text.
- **16px / `text-base`** reading — reading text, emphasised labels, inputs.
- **18px / `text-lg`** body — comfortable body and the annotation serif.
- **20px / `text-xl`** section — screen and section headings.
- **24px / `text-2xl`** title — the largest in-app screen title.

Arbitrary sizes (`text-[…]`, raw `font-size`) are off-ramp. The machine-readable
source is [`packages/ui/DESIGN.md`](packages/ui/DESIGN.md); the package's
design-ramp test enforces the ramp over the component sources.

## Layout

The desktop shell has **no left navigation rail**. A single top bar carries back/forward
history, the current location, and primary actions; the content owns the rest of the
window. Contextual panels (conversation, manifest) dock inside the content area.

The marketing page reading order, shell caps (1440px, 40px gutters), and section
intervals (88–168px) are unchanged from the prior world. Desktop may place related
passages side by side; mobile preserves the same DOM and story order in one column.

### Decomposition

The signature sequence is always complete:

**raw change → related changes → human decisions → one PR review, ready to post**

Represent it as a semantic ordered sequence with visible stage names and honest counts.
Use shared evidence color, labels, and provenance to show how material moves between
stages. Do not use the cheese-wheel mark, a logo-shaped mask, or decorative fragments as
the transformation.

### The wink

The cheese motif is subliminal — warm golds, cream paper, aged-patience language — plus
at most a couple of authored delight moments (an empty-state wedge, a loading line).
Never a costume: no cheese illustrations in working chrome, no pun density.

## Elevation & Depth

Flat by default, always opaque. Separation comes from surface steps and hairlines.
True overlays (dialogs, menus, command palette) may use one ambient shadow with a real
downward offset and broad blur. Motion is limited to purposeful state transitions and
one authored narrative moment; it starts from visible content, respects reduced motion,
and uses exponential ease-out.

## Shapes

Marketing controls use 10px corners; marketing proof surfaces 10–14px. Desktop uses the
enumerated radius scale: `4 / 6 / 8 / 12 / 16` px, with geometry exemptions `999px`
(pills — chips and counts only, never containers) and `50%` (circles). Borders are one
pixel, low-contrast, and structural — a hairline you feel rather than see.

- **4px** micro — inline code chips and the smallest tokens.
- **6px** chip — small chips and segmented controls.
- **8px** control — the standard control, button, and icon corner.
- **12px** surface — review surfaces, cards, and body panels.
- **16px** window — the window shell and the handoff paper's deeper corner.

## Components

### Buttons

- Primary actions are gold fills with near-black ink; they are the only saturated object
  in a resting screen. Secondary actions are quiet outlines or text links (ochre in
  light, gold in dark).
- Marketing primary buttons: 56px min height, 10px radius, 24px horizontal padding.
- Desktop controls target ~32px height with the 8px control radius; touch targets stay
  at least 44 by 44 pixels on touch surfaces.
- Focus uses a three-pixel gold ring. Hover lift is two pixels with a real shadow only
  where the element already floats.

### Review and proof surfaces

- Cohorts, findings, conversations, provider results, and product frames use the 12px
  surface radius on `surface`/`raised` steps with hairline borders — border **or**
  shadow, never both.
- Code is always on an opaque surface.
- The handoff paper keeps its warm materiality: espresso sheet in dark, cream in light,
  serif ink; it may use the 16px window radius.

### Provider marks

Claude Code and Codex are named with their recognizable provider marks and plain-word
labels — installed tools the user already owns, not customer logos or endorsements.
Dual review shows two independent outputs side by side and gives disagreement its own
explicit state.

### Theme control

A single 44px icon button with a visible focus state and an accessible action label. The
icon shows the scheme the action will select. The OS preference remains the default.

## Do's and Don'ts

### Do

- Keep the window seamless: one ground color from titlebar to canvas.
- Reserve gold for what deserves attention; a resting screen is warm neutrals.
- Set the AI's annotation voice and review prose in serif; set controls in sans.
- Treat both themes as authored compositions and test both.
- Keep every review stage, user story, and important product claim present at every
  breakpoint.

### Don't

- Do not reintroduce glass, vibrancy, translucent chrome, or the review-blue accent.
- Do not use gradients, neon, or monospace as generic developer-tool identity.
- Do not turn any page into an equal-card feature grid.
- Do not let serif carry controls or dense data, or sans carry the annotation voice.
- Do not claim the own-work flow already pushes or opens a pull request until the live
  path does.
- Do not average independent model outputs into one synthetic consensus.
