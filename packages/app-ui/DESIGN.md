---
name: Rennet Desktop
description: The comfortable desktop product scale the review app renders at.
typography:
  display:
    fontFamily: "Fraunces Variable, Georgia, serif"
    fontSize: "clamp(34px, 5vw, 56px)"
  serif:
    fontFamily: "Newsreader Variable, Georgia, serif"
    fontSize: "18px"
  body:
    fontFamily: "Geist Variable, system-ui, sans-serif"
    fontSize: "18px"
  label:
    fontFamily: "Geist Variable, system-ui, sans-serif"
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

This file is the machine-readable design system for `packages/app-ui` — the desktop
review app. It exists here, next to the CSS it governs, because the impeccable
design detector resolves a design system by walking up from the file it scans and
stops at the first package boundary (`packages/app-ui/package.json`); the root
`DESIGN.md` (the shared world) is never reached from inside this package. So the
desktop ramp lives where the lint can actually read it, and the root `DESIGN.md`
documents the same ramp in prose for humans.

The root [`DESIGN.md`](../../DESIGN.md) defines color, material, typography, layout, and component behavior for every Rennet application. This package file contains the desktop scales that the detector and tests read.

The design-ramp test scans `.ts` and `.tsx` files for arbitrary text sizes, radii, colors, and inline `fontSize` values. It also checks that [`src/index.css`](src/index.css) uses scale variables from [`packages/theme/src/theme.css`](../theme/src/theme.css).

## Type ramp

Use `10 / 11 / 12 / 13 / 14 / 16 / 18 / 20 / 24` px plus the display expression `clamp(34px, 5vw, 56px)`. Source code expresses the scale in `rem`; the pixel values below assume a 16px root. Components use Tailwind utilities instead of raw sizes.

| px | rem | utility | role | used for |
|----|-----|---------|------|----------|
| 10 | 0.625 | `text-10` | badge | inline badges inside a dense list row |
| 11 | 0.6875 | `text-2xs` | micro | uppercase micro-caps, the smallest legible chrome |
| 12 | 0.75 | `text-xs` | meta | secondary metadata, counts, pins |
| 13 | 0.8125 | `text-13` | dense | dense picker and list rows (the file picker) |
| 14 | 0.875 | `text-sm` | chrome | the standard chrome label and control text |
| 16 | 1 | `text-base` | reading | reading text, emphasised labels, inputs |
| 18 | 1.125 | `text-lg` | body | comfortable body and the annotation serif |
| 20 | 1.25 | `text-xl` | section | screen and section headings |
| 24 | 1.5 | `text-2xl` | title | the largest in-app screen title |
| `clamp(34px, 5vw, 56px)` | responsive | `text-display` | display | the main display headline only |

Arbitrary font sizes (`text-[…]`, raw `font-size`) are off-ramp; the package's
design-ramp test forbids them in `packages/app-ui` sources.

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

## Kit vocabulary and shadcn aliases

The screens in this package compose the vendored shadcn/Base UI kit
(`@rennet/ui` — Button, Input, Dialog, Sheet, Popover, DropdownMenu, Select,
Checkbox, Switch, Tabs, Tooltip, ScrollArea, Badge, Skeleton, Separator, Toast,
Command, …). The kit is written in shadcn's semantic Tailwind vocabulary, which
[`packages/theme/src/theme.css`](../theme/src/theme.css) aliases 1:1 onto the
`--rn-*` palette — the alias layer renames, it never introduces a new value:

- **Semantic colour:** `background`→canvas, `foreground`→ink, `card`→surface,
  `popover`→overlay, `primary`→accent-fill, `secondary`/`muted`→raised,
  `destructive`→danger, `border`→line, `input`→line-strong, `ring`→accent-line,
  `accent`→gold (`accent-foreground`→surface), `scrim`→modal backdrop.
- **Radius:** `rounded-sm`→micro (4px), `rounded-md`→chip (6px),
  `rounded-lg`→control (8px), `rounded-xl`→surface (12px),
  `rounded-2xl`→window (16px).

So a kit utility such as `bg-primary` or `rounded-xl` resolves through the alias
to the same Rennet token an app-ui composite would name directly; both stay on the
ramp the design-ramp test enforces. The full colour, semantics, and component
doctrine is the root [`DESIGN.md`](../../DESIGN.md).
