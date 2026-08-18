---
name: Rennet
description: Dense change becomes clear human judgment.
colors:
  light-canvas: "#f4f2ed"
  light-surface: "#fcfbf8"
  light-ink: "#111419"
  light-muted: "#59616b"
  light-line: "#d7d4cd"
  dark-canvas: "#0e1116"
  dark-surface: "#15191f"
  dark-ink: "#f1f0eb"
  dark-muted: "#a8b0ba"
  dark-line: "#2d333b"
  blue-light: "#396f96"
  blue-dark: "#8bbddd"
  amber-light: "#8f4e14"
  amber-dark: "#dda664"
  amber-on-inverse-light: "#e0a45f"
  amber-on-inverse-dark: "#8f4e14"
  green-light: "#41745b"
  green-dark: "#88bc9b"
typography:
  display:
    fontFamily: "Helvetica Neue, Instrument Sans Variable, Arial, sans-serif"
    fontSize: "clamp(2.8rem, 5vw, 6rem)"
    fontWeight: 500
    lineHeight: 0.98
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Avenir Next, Source Sans 3 Variable, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Avenir Next, Source Sans 3 Variable, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 650
rounded:
  control: "10px"
  surface: "12px"
spacing:
  control-x: "24px"
  section-min: "88px"
components:
  button-primary:
    backgroundColor: "{colors.light-ink}"
    textColor: "{colors.light-canvas}"
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

**Creative North Star: “The Breaking Edge”**

Rennet is an editorial system for a serious developer tool. Its defining move is reduction: dense
technical material becomes a smaller number of legible, evidence-bearing objects without hiding the
code underneath. The product is for engineers whose attention is constrained, not engineers who
want judgment removed from the workflow.

The canonical mark illustrates the product promise, but it is identity rather than layout material.
Decomposition is shown through provenance, continuity, ordering, and changing information density.
Never force the logo into a mask, connector, crop, or fragmentation effect.

The system has two related materials:

- **Marketing:** flat editorial fields, fine rules, lifted proof objects, and generous narrative pace.
- **Desktop product:** translucent glass for chrome, opaque code and analysis surfaces, and themed
  paper for the artifact that leaves the machine.

Both materials use the same typography roles, semantic color meanings, scheme vocabulary, spacing
rhythm, and restrained geometry. They are siblings, not identical skins.

## Colors

Light and dark are complete compositions. Both are first-class and must preserve hierarchy,
contrast, product-state meaning, imagery, logos, browser chrome, focus, and elevation.

### Light

- **Canvas** (`#f4f2ed`): a neutral warm-gray field, not cream nostalgia.
- **Surface** (`#fcfbf8`): lifted review objects and editorial proof.
- **Text** (`#111419`) and **muted text** (`#59616b`).
- **Line** (`#d7d4cd`) for section and object structure.

### Dark

- **Canvas** (`#0e1116`): cool near-black suited to long code-review sessions.
- **Surface** (`#15191f`): opaque reading surfaces one step above the canvas.
- **Text** (`#f1f0eb`) and **muted text** (`#a8b0ba`).
- **Line** (`#2d333b`) for quiet structural separation.

Use `data-scheme="light|dark"` as the shared control vocabulary. Honor the operating-system
preference by default, allow an explicit stored override, and resolve it before paint. Use the
committed black and white brand exports instead of filtering or recoloring one asset.

### Semantic roles

Monochrome carries the identity. Functional color explains review state:

- **Review blue** (`#396f96` light / `#8bbddd` dark): links, information, selection, and review
  structure.
- **Decision amber** (`#8f4e14` light / `#dda664` dark): reconstructed decisions, disagreement,
  and blast radius. Amber text on an inverse surface (a band whose lightness flips against the
  scheme) uses the surface-tuned variants `#e0a45f` (light scheme, dark band) and `#8f4e14` (dark
  scheme, cream band). All four are one decision-amber role, chosen so amber text meets WCAG AA
  (≥4.5:1) on the surface it sits on.
- **Evidence green** (`#41745b` / `#88bc9b`): additions, current repository state, and verified
  evidence.

Do not use the application-icon gradient as an interface palette. Do not introduce a decorative
fourth hue. Color never carries a state without text or structure.

## Typography

The production wordmark is an exact path trace of selected concept lettering. It is not a font and
must never be described as one. Its character is light neo-grotesk: open counters, ordinary width,
and low visual friction.

- **Display:** Helvetica Neue where present, with self-hosted Instrument Sans Variable and Arial as
  fallbacks. Use 440–600 rather than compressed extra-bold settings. Headlines lead through scale,
  cadence, and short line length.
- **Body:** Avenir Next where present, with self-hosted Source Sans 3 Variable and system UI as
  fallbacks. Use 400–500 for prose and 600–700 for labels and controls.
- **Code:** the platform monospace stack, only for source code and exact technical values.

Display headings may grow to `6rem`, use `0.94–1.0` line height, and never track tighter than
`-0.04em`. Body copy stays between 45 and 75 characters where practical, starts at 16px, and uses
roughly 1.5–1.6 line height. The same roles apply across marketing and desktop; the desktop keeps a
smaller, more spatially stable scale.

### Desktop scale

The desktop product renders at a denser, enumerated type ramp — smaller than the marketing scale
and spatially stable across the review chrome:

`10 / 11 / 12 / 13 / 14 / 16 / 19 / 22` px, plus the front-door display expression
`clamp(34px, 5vw, 56px)`.

- **10px** micro — uppercase micro-caps, the smallest legible chrome.
- **11px** meta — dense secondary metadata, counts, pins.
- **12px** chrome — the standard chrome label and control text.
- **13px** reading — in-canvas reading text and descriptions.
- **14px** emphasis — emphasised labels and dense titles.
- **16px** body — comfortable body and input text (shared with marketing).
- **19px** section — screen and section headings.
- **22px** title — the largest in-app screen title.

Fractional px sizes are not used: each one was a split-the-difference nudge between two steps. The
design detector checks `font-size` longhand against this ramp for `packages/ui`; the package's
owned design-ramp test also checks `font:` shorthand. Both read the machine-readable source in
[`packages/ui/DESIGN.md`](packages/ui/DESIGN.md), which sits inside the package because the detector
resolves a design system by walking up from the scanned file and stops at the package boundary.

## Layout

The marketing page follows this reading order:

1. Accountability headline and agentic-engineer stance.
2. AI-expanded pull requests and the pressure on the human context window.
3. The two user stories: own work before submission, then someone else’s pull request.
4. Digestion plus conversation with the diff.
5. Existing Claude Code and Codex, independent dual review, and why disagreement matters.
6. Deterministic repository discovery reinforced by evidence-backed model knowledge.
7. Product evidence, lenses, local-first truth, objections, and action.

Desktop may place related passages side by side. Mobile preserves this same DOM and story order in
one column; it never rotates, hides, or miniaturizes a desktop pipeline.

The shell caps near 1440px with 40px desktop gutters. Sections use 88–168px vertical intervals and
alternate dense proof with quiet explanation. Related content is tight; distinct ideas receive
meaningful separation.

### Decomposition

The signature sequence is always complete:

**raw change → related cohorts → human decisions → one review paper**

Represent it as a semantic ordered sequence with visible stage names and honest or clearly
illustrative counts. On wide screens it may read left to right. On phones it becomes a vertical
spine with one stage per viewport passage, larger representative content, and downward connectors.
No stage disappears at an intermediate breakpoint.

Use shared evidence color, labels, and provenance to show how material moves between stages. Do not
use the cheese-wheel mark, a logo-shaped mask, or decorative fragments as the transformation.

## Elevation & Depth

The system is flat by default. Product frames, review papers, and mechanism proofs may use one
ambient shadow with a real downward offset and broad blur. Marketing chrome stays opaque; only the
desktop product shell may use translucent glass. Motion is limited to purposeful state transitions
and one authored narrative moment. It starts from visible content, respects reduced motion, and uses
exponential ease-out rather than bounce or perpetual ambient animation.

## Shapes

Marketing controls use 10px corners, and marketing review or proof surfaces use 10–14px corners.
Desktop controls and surfaces use the on-ramp values in the desktop scale below. Borders are one
pixel and structural. A paper may carry one deeper corner when it reinforces the document
metaphor, but the logo remains identity rather than recurring layout geometry. Avoid pills for
containers and avoid ornamental clipping that competes with the evidence.

### Desktop radius scale

The desktop product uses an enumerated radius scale: `4 / 6 / 8 / 12 / 16` px, with two geometry
exemptions that are shape rather than scale — `999px` (the pill, for chips and counts only, never
containers) and `50%` (circles).

- **4px** micro — inline code chips and the smallest tokens.
- **6px** chip — small chips and segmented controls.
- **8px** control — the standard control, button, and icon corner.
- **12px** surface — review surfaces, cards, and body panels.
- **16px** window — the window shell and the handoff paper's deeper corner.

The design detector checks `border-radius` against this scale for `packages/ui`; the package's
owned design-ramp test additionally covers radius-bearing tokens. Their source is
[`packages/ui/DESIGN.md`](packages/ui/DESIGN.md).

## Components

### Buttons

- Marketing primary buttons use a 56px minimum height, 10px radius, and 24px horizontal padding.
- Desktop buttons use the 8px control radius; their height and padding follow the denser desktop
  surface they inhabit.
- Primary controls invert against their field; secondary actions are text links.
- Hover lift is two pixels with a real downward shadow. Focus uses a three-pixel review-blue ring.
- Touch targets are at least 44 by 44 pixels.

### Review and proof surfaces

- Marketing review and proof surfaces use 10–14px corners. Desktop cohorts, findings,
  conversations, provider results, and product frames use the 12px surface radius.
- Use either a structural border or a broad ambient shadow; avoid a shadowed border around every
  object.
- Code is always on an opaque surface. Product chrome may be translucent only in the desktop app.
- The desktop handoff paper may use the 16px window radius, but it remains a document rather than
  decoration.

### Provider marks

Claude Code and Codex are named with their recognizable provider marks and plain-word labels. They
appear as installed tools the user already owns, not as customer logos or endorsements. Dual review
shows two independent outputs side by side and gives disagreement its own explicit state.

### Theme control

Use a single 44px icon button with a visible focus state and an accessible action label. The icon
shows the scheme the action will select. The operating-system preference remains the default until
the visitor chooses an override.

## Do's and Don'ts

### Do

- Use committed black and white brand exports without redrawing their geometry.
- Keep every review stage, user story, and important product claim present at every breakpoint.
- Show real product captures or clearly labeled illustrative material.
- Preserve access to actual code while changing its reading order.
- Treat both themes as authored compositions and test both.

### Don’t

- Do not use the standalone mark as a giant decorative object or decomposition device.
- Do not turn the page into an equal-card feature grid.
- Do not use gradients, glass, neon, or monospace as generic developer-tool identity.
- Do not claim the own-work flow already pushes or opens a pull request until the live path does.
- Do not average independent model outputs into one synthetic consensus.
