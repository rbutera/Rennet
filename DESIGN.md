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
  amber-light: "#a86125"
  amber-dark: "#dda664"
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
- **Decision amber** (`#a86125` / `#dda664`): reconstructed decisions, disagreement, and blast
  radius.
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

Controls use 10px corners and review or proof surfaces use 10–14px corners. Borders are one pixel
and structural. A paper may carry one deeper corner when it reinforces the document metaphor, but
the logo remains identity rather than recurring layout geometry. Avoid pills for containers and
avoid ornamental clipping that competes with the evidence.

## Components

### Buttons

- 56px minimum height, 10px radius, 24px horizontal padding.
- Primary controls invert against their field; secondary actions are text links.
- Hover lift is two pixels with a real downward shadow. Focus uses a three-pixel review-blue ring.
- Touch targets are at least 44 by 44 pixels.

### Review and proof surfaces

- 10–14px radius for cohorts, findings, conversations, provider results, and product frames.
- Use either a structural border or a broad ambient shadow; avoid a shadowed border around every
  object.
- Code is always on an opaque surface. Product chrome may be translucent only in the desktop app.
- The final paper may carry one deeper corner, but it remains a document rather than decoration.

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
