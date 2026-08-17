---
name: Rennet Desktop
description: The dense desktop product scale the review app renders at.
typography:
  display:
    fontFamily: "Helvetica Neue, Instrument Sans Variable, Arial, sans-serif"
    fontSize: "clamp(34px, 5vw, 56px)"
  body:
    fontFamily: "Avenir Next, Source Sans 3 Variable, system-ui, sans-serif"
    fontSize: "16px"
  label:
    fontFamily: "Avenir Next, Source Sans 3 Variable, system-ui, sans-serif"
    fontSize: "13px"
  scale:
    micro: "10px"
    meta: "11px"
    chrome: "12px"
    reading: "13px"
    emphasis: "14px"
    body: "16px"
    section: "19px"
    title: "22px"
rounded:
  micro: "4px"
  chip: "6px"
  control: "8px"
  surface: "12px"
  window: "16px"
  pill: "999px"
---

# Rennet desktop scale

This file is the machine-readable design system for `packages/ui` — the desktop
review app. It exists here, next to the CSS it governs, because the impeccable
design detector resolves a design system by walking up from the file it scans and
stops at the first package boundary (`packages/ui/package.json`); the root
`DESIGN.md` (the marketing + shared narrative) is never reached from inside this
package. So the desktop ramp lives where the lint can actually read it, and the
root `DESIGN.md` documents the same ramp in prose for humans.

The full design system — colour, semantics, elevation, components, do's and
don'ts — is the root [`DESIGN.md`](../../DESIGN.md). This file records only the two
things the desktop material scales differently from marketing: the **type ramp**
and the **radius scale**. Both are enforced: the detector reddens on any
`font-size` or `border-radius` literal off these ramps.

## Type ramp

`10 / 11 / 12 / 13 / 14 / 16 / 19 / 22` px, plus the front-door display expression
`clamp(34px, 5vw, 56px)`. Fractional px sizes are banned — every one was a
split-the-difference nudge between two undocumented steps.

| px | role | used for |
|----|------|----------|
| 10 | micro | uppercase micro-caps, the smallest legible chrome |
| 11 | meta | dense secondary metadata, counts, pins |
| 12 | chrome | the standard chrome label and control text |
| 13 | reading | in-canvas reading text and descriptions |
| 14 | emphasis | emphasised labels and dense titles |
| 16 | body | comfortable body and input text (shared with marketing) |
| 19 | section | screen and section headings |
| 22 | title | the largest in-app screen title |
| `clamp(34–56)` | display | the front-door display headline only |

## Radius scale

`4 / 6 / 8 / 12 / 16` px, plus two geometry exemptions that are shape, not scale:
`999px` (the pill — chips and counts only; doctrine forbids pill *containers*) and
`50%` (circles).

| px | role | used for |
|----|------|----------|
| 4 | micro | inline code chips and the smallest tokens |
| 6 | chip | small chips and segmented controls |
| 8 | control | the standard control / button / icon corner |
| 12 | surface | review surfaces, cards, and body panels |
| 16 | window | the window shell and the handoff paper's deeper corner |
| `999px` | pill | chip and count geometry only |
| `50%` | circle | circular marks and dots |
