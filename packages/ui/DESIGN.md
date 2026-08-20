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

This is the machine-readable design file for `packages/ui`. The design detector stops at the package boundary, so the type and radius scales must live beside the source they govern.

The root [`DESIGN.md`](../../DESIGN.md) defines color, material, typography, layout, and component behavior for every Rennet application. This package file contains the desktop scales that the detector and tests read.

The design-ramp test scans `.ts` and `.tsx` files for arbitrary text sizes, radii, colors, and inline `fontSize` values. It also checks that [`src/index.css`](src/index.css) uses scale variables from [`packages/theme/src/theme.css`](../theme/src/theme.css).

## Type ramp

Use `11 / 12 / 14 / 16 / 18 / 20 / 24` px plus the display expression `clamp(34px, 5vw, 56px)`. Source code expresses the scale in `rem`; the pixel values below assume a 16px root. Components use Tailwind utilities instead of raw sizes.

| px | rem | utility | role | used for |
|----|-----|---------|------|----------|
| 11 | 0.6875 | `text-2xs` | micro | uppercase micro-caps, the smallest legible chrome |
| 12 | 0.75 | `text-xs` | meta | secondary metadata, counts, pins |
| 14 | 0.875 | `text-sm` | chrome | the standard chrome label and control text |
| 16 | 1 | `text-base` | reading | reading text, emphasised labels, inputs |
| 18 | 1.125 | `text-lg` | body | comfortable body and the annotation serif |
| 20 | 1.25 | `text-xl` | section | screen and section headings |
| 24 | 1.5 | `text-2xl` | title | the largest in-app screen title |
| `clamp(34px, 5vw, 56px)` | responsive | `text-display` | display | the main display headline only |

The design-ramp test rejects arbitrary font sizes such as `text-[...]` and raw `font-size` declarations in `packages/ui`.

## Radius scale

Use `4 / 6 / 8 / 12 / 16` px. Pills and circles have separate geometry values: `999px` for chips and counts, and `50%` for circles.

| px | role | used for |
|----|------|----------|
| 4 | micro | inline code chips and the smallest tokens |
| 6 | chip | small chips and segmented controls |
| 8 | control | the standard control / button / icon corner |
| 12 | surface | review surfaces, cards, and body panels |
| 16 | window | window-level surfaces and post previews |
| `999px` | pill | chip and count geometry only |
| `50%` | circle | circular marks and dots |
