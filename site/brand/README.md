# Rennet mark

The historical pre-launch wordmark glyph and lockup, rendered at four sizes.

## The mark

A disc divided down its vertical axis.

- **Left half:** solid, filled bone (`#EDEFF2`, the app's `--mark-ink`). The curd, the opaque thing, what leaves the machine.
- **Right half:** an open arc, stroked backlight blue (`#85C4DC`, the app's `--private`) with the system's single inner glow. The whey, translucent, what stays on your Mac.
- **Between them:** a hairline of pure ground, so the split reads as a cut (two objects), never as a half-shaded circle (which at icon size reads as a progress meter).

The two corrections the plan asked for are both in: the gap is a real hairline cut, not a fill; and the halves carry the system's own two materials (bone and backlight blue), not one ink. Nobody has to be told the mark restates the product doctrine (the solid part leaves, the lit part stays) for it to work.

Banned, and absent: cheese, milk, drops, curd texture, wheels, wedges, dairy of any kind. The referent is the mechanism, not the food.

## Files

- `rennet-glyph.svg`: the mark, standalone, transparent ground (favicon / icon / menu-bar use).
- `rennet-lockup.svg`: horizontal lockup: mark + word, 9px gap. Word is sans, weight 650, sentence case `Rennet`, near-neutral tracking, in bone. Not the serif (serif is reserved for paper), never lowercase, never letterspaced wide.
- `renders/glyph-{16,32,64,512}.png`: exact-size raster renders.
- `renders/contact-sheet.png`, `renders/qa-sheet.png`: QA: the mark across sizes on the app's dark ground, and each size magnified (nearest-neighbour) so the true pixels are judgeable.
- `render.mjs`, `qa.mjs`: regenerate the renders from the SVG with headless Chrome (zero npm deps). Run from this directory: `node render.mjs && node qa.mjs`.

## 16px legibility: confirmed, not asserted

Open `renders/qa-sheet.png`. At 16px the mark reads as a divided disc: the solid bone half and the open half separated by the cut. The "something has been divided" read survives shrinkage because it is carried by the material contrast (solid vs open), not by the gap width, which goes sub-pixel at 16px. The backlight-blue arc goes faint at 16px (the inner glow softens a thin stroke at that size); the division still reads from the solid-versus-empty contrast, which is the design intent.

## Scope note

These are brand assets in an isolated directory. The live app currently renders a placeholder `RennetMark` (a mono `R`) in `packages/ui/src/components/icons.tsx`. Promoting this corrected mark into that shared component is a separate change: `icons.tsx` is an active collision zone (other branches are editing `packages/ui/src/components` right now) and it carries a legend-coverage test. That promotion was deliberately left out of this branch and is called out in the branding-site report.
