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

# Rennet design system

## Direction

**Creative direction: "The Affineur's Bench"**

Rennet turns a dense code change into a smaller set of readable objects without hiding the source. The interface uses warm opaque grounds, small changes in surface lightness, one gold accent, and serif type for review prose.

Desktop, browser, mobile, marketing, and documentation use the same palette and type families. Each application can choose its own density and layout.

## Material

Canvas, title bar, and toolbar share one background. Panels use the `canvas`, `surface`, and `raised` steps with low-contrast hairlines. Menus, dialogs, and popovers are the only elements that use the overlay shadow.

All neutral colors have a warm cast. Do not use glass, vibrancy, translucent chrome, or decorative shadows.

## Color

Light and dark schemes are complete designs. Use `data-scheme="light|dark"` in Rennet applications and `data-theme="light|dark"` in Starlight. Follow the operating-system preference until the user stores an override.

### Dark scheme

- Canvas: `#0e0d0c`
- Surface: `#151413`
- Raised: `#1b1a18`
- Text: `#f2ede4`
- Muted text: `#a9a196`

### Light scheme

- Canvas: `#fbfaf7`
- Surface: `#ffffff`
- Raised: `#f3f1ec`
- Text: `#1e1b16`
- Muted text: `#57534a`

### Semantic roles

- **Gold** uses `#8a5d0b` for light-scheme text, `#e8b13c` for dark-scheme text, and `#e0a52e` or `#e8b13c` for fills. It marks links, selection, focus, primary actions, decisions, disagreement, and blast radius.
- **Evidence green** uses `#41745b` in light mode and `#88bc9b` in dark mode. It marks additions, current repository state, and verified evidence.
- **Danger red** uses `#b23b2b` in light mode and `#db7a6a` in dark mode. It marks destructive actions and errors.

Do not add a decorative interface hue. Never use color as the only statement of state.

The canonical values live in [`packages/theme/src/palette.css`](packages/theme/src/palette.css). DOM applications consume the CSS variables. The mobile application consumes the generated React Native palette.

## Typography

- **Fraunces** is for brand moments, display headings, screen titles, and empty states. Use the self-hosted variable font with Georgia as the fallback.
- **Source Serif 4** is for annotations, conversations, review prose, and post previews. Use the self-hosted variable font with Georgia as the fallback.
- **DM Sans** is for controls, labels, inputs, navigation, and metadata. Use the self-hosted variable font with the system sans-serif stack as the fallback.
- **Monospace** is for source code, diffs, and exact technical values.

The wordmark is vector artwork. Do not recreate it with a font.

Display headings can reach `6rem` with a line height near `1`. Keep letter spacing at `-0.04em` or looser. Keep long prose lines between 45 and 75 characters where the layout permits.

### Desktop type scale

Desktop components use `11 / 12 / 14 / 16 / 18 / 20 / 24` px, plus `text-display` at `clamp(2.125rem, 5vw, 3.5rem)`. Source code expresses the scale in `rem` through Tailwind utilities.

- `text-2xs`, 11px: micro labels
- `text-xs`, 12px: metadata and counts
- `text-sm`, 14px: controls and chrome
- `text-base`, 16px: reading text and inputs
- `text-lg`, 18px: body text and annotations
- `text-xl`, 20px: section headings
- `text-2xl`, 24px: screen titles

Do not use arbitrary font sizes in `packages/ui`. [`packages/ui/DESIGN.md`](packages/ui/DESIGN.md) is the machine-readable package design file, and the design-ramp test checks component sources.

## Layout

The desktop shell has no permanent application navigation rail. The top bar carries history, location, and primary actions. Files, review angles, conversation, and manifest panels belong to the current workspace and can sit beside its main content.

The marketing shell is at most 1440px wide with 40px side gutters. Section spacing ranges from 88px to 168px. Responsive layouts preserve the document order when columns collapse.

### Change decomposition

Always show the complete sequence:

**raw change -> related changes -> human decisions -> review ready to post**

Use visible stage names, honest counts, evidence labels, and provenance. Do not use the logo or decorative fragments as the decomposition diagram.

### Cheese references

Keep the motif quiet. Warm gold, cream review previews, one useful empty-state illustration, or one loading detail is enough. Do not put cheese illustrations or dense wordplay in working UI.

## Depth and motion

Normal surfaces are flat and opaque. Menus, dialogs, and the command palette may use `--rn-shadow-overlay`.

Motion must explain a state change. Start animated content from a visible state, use an exponential ease-out when practical, and honor `prefers-reduced-motion`.

## Shape

Marketing controls use 10px corners. Marketing proof surfaces use 10px to 14px corners. Desktop uses this scale:

- 4px for inline code chips and small tokens
- 6px for chips and segmented controls
- 8px for controls, buttons, and icons
- 12px for review surfaces, cards, and panels
- 16px for window-level surfaces and post previews
- 999px for chips and count pills only
- 50% for circles

Use one-pixel, low-contrast borders for structure.

## Components

### Buttons

Primary actions use a gold fill with near-black text. Secondary actions use a quiet outline or a text link. Marketing primary buttons have a minimum height of 56px, a 10px radius, and 24px horizontal padding. Desktop controls target a 32px visual height. Touch controls provide a target of at least 44 by 44 pixels.

All interactive elements use a three-pixel gold focus ring. Only an element that already floats may lift on hover.

### Review surfaces

Cohorts, findings, conversations, provider results, and product frames use the 12px surface radius on opaque `surface` or `raised` colors. Use a border or a shadow, not both. Code always sits on an opaque surface.

Post previews use the `sheet` palette. They are cream in light mode, espresso in dark mode, and set review prose in serif.

### Provider identity

Name Claude Code and Codex with their provider marks and plain labels. They are installed tools, not customer logos or endorsements. When both review a change, show the outputs independently and mark disagreement explicitly.

### Theme control

Use one 44px icon button with a visible focus state and an accessible action label. The icon shows the scheme the action will select. The operating-system preference remains the default.

## Required design behavior

- Keep one ground color from title bar to canvas.
- Reserve gold for selection, decisions, focus, and primary actions.
- Use serif for annotations and review prose. Use sans serif for controls and data.
- Test light and dark schemes.
- Preserve the full review and all important claims at every breakpoint.
- Do not use decorative gradients, neon, glass, or monospace as generic developer-tool styling. Functional progress and state graphics may use a gradient when the gradient encodes the state.
- Do not turn a page into a grid of equal feature cards.
- Do not average independent model outputs into one consensus.
