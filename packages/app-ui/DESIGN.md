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

Use `10 / 11 / 12 / 12.5 / 13 / 14 / 15 / 16 / 18 / 20 / 24` px plus the display expression `clamp(34px, 5vw, 56px)`. Source code expresses the scale in `rem`; the pixel values below assume a 16px root. Components use Tailwind utilities instead of raw sizes.

| px | rem | utility | role | used for |
|----|-----|---------|------|----------|
| 10 | 0.625 | `text-10` | badge | inline badges inside a dense list row |
| 11 | 0.6875 | `text-2xs` | micro | uppercase micro-caps, the smallest legible chrome |
| 12 | 0.75 | `text-xs` | meta | secondary metadata, counts, pins |
| 12.5 | 0.78125 | `text-12-5` | dense body | diff and code bodies, quote popovers, dense captions |
| 13 | 0.8125 | `text-13` | dense | dense picker and list rows (the file picker) |
| 14 | 0.875 | `text-sm` | chrome | the standard chrome label and control text |
| 15 | 0.9375 | `text-15` | prose | chat turns and review prose (see the prose voice below) |
| 16 | 1 | `text-base` | reading | reading text, emphasised labels, inputs |
| 18 | 1.125 | `text-lg` | body | comfortable body and the annotation serif |
| 20 | 1.25 | `text-xl` | section | screen and section headings |
| 24 | 1.5 | `text-2xl` | title | the largest in-app screen title |
| `clamp(34px, 5vw, 56px)` | responsive | `text-display` | display | the main display headline only |

The half-step `text-12-5` and the prose step `text-15` are the two sizes the
board prototype reads at, and they are the reason the ramp has a `.5`: 12.5px is
where a diff body stops looking like chrome, and 15px is the chat and review
reading size. They are ramp steps like any other — reach for the nearest one
rather than an arbitrary size.

### Prose voice

`font-prose` is the reading voice for chat and review prose. It aliases the sans
stack today (`--font-prose: var(--rn-font-sans)` in
[`packages/theme/src/theme.css`](../theme/src/theme.css)); the alias exists so a
serif body can be tried by editing one token instead of every surface.

Arbitrary font sizes (`text-[…]`, inline `fontSize`) are off-ramp; the package's
design-ramp test forbids them in `packages/app-ui` sources. In the entry
stylesheet [`src/index.css`](src/index.css) it also reads the raw `font-size:`
and `font:` declarations, checking the shorthand's size operand — which sizes
type just as surely — against the ramp alongside `font-size:`.
Its one exemption is decorative micro-type below the 10px floor: the first-run
welcome's code-rain (`.rn-code-fragment`, 9px) and theme-preview miniature
(`.rn-theme-preview code`, 8px), both illegible faux-code rendered as texture.
The test pins those two selectors to those two exact values; nothing else may
use them.

## Motion, and the stylesheet's remaining job

Every authored animation is a theme value. A keyframe is declared in
[`src/index.css`](src/index.css)'s `@theme` block next to an `--animate-*` variable,
which makes it a real `animate-…` utility — so a call site composes it with variants
(`motion-reduce:animate-none`) and `twMerge` can override it, neither of which works
against a bare class the stylesheet defines by hand.

The one exception is a keyframe a **pseudo-element** animates. A pseudo cannot carry a
class, so the utility an `--animate-*` partner would mint is one nothing could ever use
and Tailwind tree-shakes the variable away. Such a keyframe still belongs in `@theme` —
keyframes declared there are emitted whether or not a utility references them — and the
hand-written rule names it directly. Today that is `processing-spin`, the orb's ring.

Reduced motion is honoured twice: by the base rule that collapses every animation's
duration **and zeroes its delay**, and by the variant where a call site can safely drop
the animation outright. Those are not interchangeable — an animation whose settled state
comes from a `forwards` fill (the streaming word reveal) breaks under `animate-none` and
relies on the base rule instead. The delay half of that base rule is what makes an
inline-staggered reveal settle at once rather than fading in on schedule with no motion.

Beyond that the entry stylesheet holds only what utilities cannot express: the base
document material, browser-owned surfaces (scrollbars, selection, caret, focus), three
`@utility` definitions for properties Tailwind has none for
(`app-region-drag`, `app-region-no-drag`, `chrome-scroll-clearance`), the welcome's
sub-ramp decorative type, the processing orb's masked conic ring, and the `.rtok-*`
syntax vocabulary the code markup is generated against.

Two rules follow from past drift:

- **A structural contract is never written in utility class names.** The floating-chrome
  clearance used to hang off `.rennet-floating-chrome-scroll .min-h-0.flex-1.overflow-y-auto`
  — it matched any branch that happened to type those three, and nothing at all when a
  pane restyled. Surfaces mark themselves; the stylesheet does not guess.
- **An opt-out is stated per element, not inferred from a tag list.** The macOS drag
  region's `button, a, input, code` opt-out silently failed for any other interactive
  child.

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
Command, Field, InputGroup, Spinner, …). The kit is written in shadcn's semantic
Tailwind vocabulary, which
[`packages/theme/src/theme.css`](../theme/src/theme.css) aliases 1:1 onto the
`--rn-*` palette — the alias layer renames, and introduces a new value only for an
interaction state the palette does not carry, derived from a palette value:

- **Semantic colour:** `background`→canvas, `foreground`→ink, `card`→surface,
  `popover`→overlay, `primary`→accent-fill, `secondary`/`muted`→raised,
  `destructive`→danger, `border`→line, `input`→line-strong, `ring`→accent-line,
  `accent`→gold (`accent-foreground`→surface), `scrim`→modal backdrop.
- **Derived interaction state (the one exception):** `secondary-hover` is raised
  `color-mix`ed with 5% ink. It is not a rename because the palette has no hover
  step for raised, and a secondary button that hovers to its own rest fill has no
  hover at all. Derive from a palette value; never invent a colour here.
- **Radius:** `rounded-sm`→micro (4px), `rounded-md`→chip (6px),
  `rounded-lg`→control (8px), `rounded-xl`→surface (12px),
  `rounded-2xl`→window (16px).

So a kit utility such as `bg-primary` or `rounded-xl` resolves through the alias
to the same Rennet token an app-ui composite would name directly; both stay on the
ramp the design-ramp test enforces. The full colour, semantics, and component
doctrine is the root [`DESIGN.md`](../../DESIGN.md).
