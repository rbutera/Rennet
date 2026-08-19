---
name: Rennet Desktop
description: The comfortable desktop product scale the review app renders at.
typography:
  display:
    fontFamily: "Fraunces Variable, Georgia, serif"
    fontSize: "clamp(34px, 5vw, 56px)"
  serif:
    fontFamily: "Source Serif 4 Variable, Georgia, serif"
    fontSize: "18px"
  body:
    fontFamily: "DM Sans Variable, system-ui, sans-serif"
    fontSize: "18px"
  label:
    fontFamily: "DM Sans Variable, system-ui, sans-serif"
    fontSize: "14px"
  scale:
    micro: "11px"
    meta: "12px"
    chrome: "14px"
    reading: "16px"
    body: "18px"
    section: "20px"
    title: "24px"
rounded:
  micro: "4px"
  chip: "6px"
  control: "8px"
  surface: "12px"
  window: "16px"
  pill: "999px"
  circle: "50%"
---

# Rennet desktop scale

This file is the machine-readable design system for `packages/ui` — the desktop
review app. It exists here, next to the CSS it governs, because the impeccable
design detector resolves a design system by walking up from the file it scans and
stops at the first package boundary (`packages/ui/package.json`); the root
`DESIGN.md` (the shared world) is never reached from inside this package. So the
desktop ramp lives where the lint can actually read it, and the root `DESIGN.md`
documents the same ramp in prose for humans.

The full design system — colour, semantics, material, components, do's and
don'ts — is the root [`DESIGN.md`](../../DESIGN.md). This file records only the
things the desktop material scales differently: the **type ramp** and the
**radius scale**. The design detector checks `font-size` longhand and
`border-radius`; the UI package's design-ramp test also checks `font:` shorthand
sizes and the radius-bearing tokens in `tokens.css`.

## Type ramp

`11 / 12 / 14 / 16 / 18 / 20 / 24` px, plus the front-door display expression
`clamp(34px, 5vw, 56px)`. This ramp replaced the dense `10–22` ramp in the
2026-08-19 overhaul: crowding was a defect, not a style. It is **authored in rem**
(the px values are the 16px-root equivalents) and deliberately snaps to Tailwind's
type scale, so components speak utilities, never raw sizes:

| px | rem | utility | role | used for |
|----|-----|---------|------|----------|
| 11 | 0.6875 | `text-2xs` | micro | uppercase micro-caps, the smallest legible chrome |
| 12 | 0.75 | `text-xs` | meta | secondary metadata, counts, pins |
| 14 | 0.875 | `text-sm` | chrome | the standard chrome label and control text |
| 16 | 1 | `text-base` | reading | reading text, emphasised labels, inputs |
| 18 | 1.125 | `text-lg` | body | comfortable body and the annotation serif |
| 20 | 1.25 | `text-xl` | section | screen and section headings |
| 24 | 1.5 | `text-2xl` | title | the largest in-app screen title |
| `clamp(34–56)` | — | `text-display` | display | the front-door display headline only |

Arbitrary font sizes (`text-[…]`, raw `font-size`) are off-ramp; the package's
design-ramp test forbids them in `packages/ui` sources.

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
