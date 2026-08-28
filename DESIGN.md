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
  dark-canvas: "#0a0a0a"
  dark-surface: "#131313"
  dark-raised: "#1a1a1a"
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
    fontFamily: "Newsreader Variable, Georgia, serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist Variable, system-ui, sans-serif"
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

One narrow exception, approved by Rai on 2026-08-28 while watching it render: chrome that floats over content in the full-bleed state may use a translucent, blurred ground — the only sanctioned use; opaque grounds remain the rule everywhere else (Rai, 2026-08-28). This covers the desktop shell's corner-slot pill and the floating chip layer the session bar dissolves into when both the sidebar and the chat are closed, and nothing else. The prohibition above stands unchanged for every other surface.

## Color

Light and dark schemes are complete designs. Use `data-scheme="light|dark"` in Rennet applications and `data-theme="light|dark"` in Starlight. Follow the operating-system preference until the user stores an override.

### Dark scheme

- Canvas: `#0a0a0a`
- Surface: `#131313`
- Raised: `#1a1a1a`
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

### Themeability

The Affineur's Bench doctrine above — one gold accent, warm neutrals, no decorative interface hue — governs the **default** theme and everything Rennet ships screenshots of. The default is the absence of any theme attribute.

Beyond it, a viewer may select a bundled **theme pack** (GitHub, One Dark Pro, Dracula, Catppuccin Mocha), each a complete re-binding of every `--rn-*` colour token under `[data-rn-theme="<id>"]` in `packages/theme/src/themes/`. A pack is the user's room: it owes only the semantic-role mapping and the same AA contrast contract as the default. Packs are colour only — no pack alters type, spacing, or radius. Syntax highlighting is an independent axis (`packages/theme/src/code-themes/`, `[data-rn-code-theme="<id>"]`); by default code follows the active pack.

## Typography

- **Fraunces** is for brand moments, display headings, screen titles, and empty states. Use the self-hosted variable font with Georgia as the fallback.
- **Newsreader** is for annotations and quoted prose excerpts. Use the self-hosted variable font with Georgia as the fallback. Conversations and the review body run Geist (amended 2026-08-26; the serif voice narrowed as prose surfaces moved to sans).
- **Geist** is for controls, labels, inputs, navigation, and metadata. Use the self-hosted variable font with the system sans-serif stack as the fallback.
- **Geist Mono** is for source code, diffs, and exact technical values, falling back to the platform monospace stack.

The wordmark is vector artwork. Do not recreate it with a font.

Display headings can reach `6rem` with a line height near `1`. Keep letter spacing at `-0.04em` or looser. Keep long prose lines between 45 and 75 characters where the layout permits.

**Casing.** Structural headers use title case: dialog titles, section headers, short label-like headers, and control labels ("Add Remote", "Pairing Code", "What Changes"). Body copy, helper text, and any title that is a sentence (a finding claim, a decision statement) use sentence case. Casing is content, never CSS: `text-transform` cannot know that a code token (`wsl.exe`, `ensureWslDaemon`) or an acronym keeps its exact casing, so strings are authored cased — chrome by hand, board content by the drafting prompts and the post-process pass.

**Content rhythm.** Vertical space encodes hierarchy on every content surface (lens boards, hand-off lanes, summaries): 8px between lines within a block, 16px at a sub-block boundary inside one item (a detail subhead, a fix callout), 24px between sibling items (findings, decisions, requirements), 32px between sections. A reader should be able to find item boundaries from the whitespace alone; if two adjacent gaps are equal across a hierarchy level, one of them is wrong.

### Desktop type scale

Desktop components use `11 / 12 / 14 / 16 / 18 / 20 / 24` px, plus `text-display` at `clamp(2.125rem, 5vw, 3.5rem)`. Source code expresses the scale in `rem` through Tailwind utilities.

- `text-2xs`, 11px: micro labels
- `text-xs`, 12px: metadata and counts
- `text-sm`, 14px: controls and chrome
- `text-base`, 16px: reading text and inputs
- `text-lg`, 18px: body text and annotations
- `text-xl`, 20px: section headings
- `text-2xl`, 24px: screen titles

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
source is [`packages/app-ui/DESIGN.md`](packages/app-ui/DESIGN.md); the package's
design-ramp test enforces the ramp over the component sources.

## Layout

The desktop shell is a collapsible left sidebar (projects grouped by machine, sessions, search, settings) beside the conversation column and a main surface whose top bar carries the view switcher and the primary hand-off action; rbutera/Rennet#458 records the rulings. Collapsed means hidden: the sidebar has no icon rail, and its affordances stay one toggle away in the expanded panel or on ⌘P/⌘K.

**The leftmost pane owns the traffic lights.** On macOS the window hides its native titlebar, so one corner slot — the light inset plus the sidebar toggle — mounts in exactly one place at a time: the sidebar header while the sidebar is expanded (lights, then the wordmark, then the toggle), the chat header while the sidebar is collapsed and the chat is open, and a floating pill over the main view when both are closed. In that last state the main surface runs full-bleed and the session top bar dissolves into a floating chip layer. A session surface carries the chip clearance inside its scrolling region, so its content clears the chips at rest and slides under them on scroll; a takeover surface has its own header and takes the clearance as plain padding instead. One chat open/close control lives on the main view's top-left, in both directions. rbutera/Rennet#558 records the ruling.

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

Board sections, findings, conversations, provider results, and product frames use the 12px surface radius on opaque `surface` or `raised` colors. Use a border or a shadow, not both. Code always sits on an opaque surface.

Post previews use the `sheet` palette. They are cream in light mode, espresso in dark mode, and set review prose in serif.

### Provider identity

Name Claude Code and Codex with their provider marks and plain labels. They are installed tools, not customer logos or endorsements. When both review a change, show the outputs independently and mark disagreement explicitly.

### Theme control

Use one 44px icon button with a visible focus state and an accessible action label. The icon shows the scheme the action will select. The operating-system preference remains the default.

### Component kit

The primitives are a **vendored shadcn/ui kit built on Base UI**, owned in
`packages/ui` (`@rennet/ui`): Button, Input, Textarea, Label, Dialog, Sheet,
Popover, DropdownMenu, Select, Switch, Checkbox, Tabs, Tooltip, ScrollArea, Badge,
Skeleton, Separator, Toast, and the `cmdk` Command palette. `@rennet/app-ui`
composes them into Rennet's screens; the hand-rolled component layer they replaced
is retired (2026-08-20 port). Base UI is the one primitive family — Radix is
allowed only where a shadcn component brings it (`cmdk`). The kit's lucide icons
render at the same **1.6px identity stroke** as the app-ui `Icon` wrapper, so the
whole app reads at one line weight.

The kit is authored in shadcn's semantic Tailwind vocabulary, and
`packages/theme` aliases that vocabulary onto the `--rn-*` palette above — no new
colour or radius exists in the alias layer, it is a rename:

- **Semantic colour:** `background`→canvas, `foreground`→ink, `card`→surface,
  `popover`→overlay, `primary`→accent-fill (`primary-foreground`→accent-ink),
  `secondary`/`muted`→raised, `muted-foreground`→ink-soft, `destructive`→danger,
  `border`→line, `input`→line-strong, `ring`→accent-line, `accent`→gold with
  `accent-foreground`→surface (the AA-safe flip), and `scrim`→the modal backdrop.
- **Radius:** `sm`→micro (4px), `md`→chip (6px), `lg`→control (8px),
  `xl`→surface (12px), `2xl`→window (16px).

The alias map lives in [`packages/theme/src/theme.css`](packages/theme/src/theme.css);
`packages/app-ui/DESIGN.md` records the same for the desktop package.

## Required design behavior

- Keep one ground color from title bar to canvas.
- Reserve gold for selection, decisions, focus, and primary actions.
- Use serif for annotations and review prose. Use sans serif for controls and data.
- Test light and dark schemes.
- Preserve the full review and all important claims at every breakpoint.
- Do not use decorative gradients, neon, glass, or monospace as generic developer-tool styling. Functional progress and state graphics may use a gradient when the gradient encodes the state. Chrome floating over content in the full-bleed state may use a translucent, blurred ground — the one sanctioned exception (see Material, Rai 2026-08-28); opaque grounds remain the rule everywhere else.
- Do not turn a page into a grid of equal feature cards.
- Do not average independent model outputs into one consensus.
