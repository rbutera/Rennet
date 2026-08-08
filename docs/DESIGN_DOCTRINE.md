# Rennet design doctrine

The visual authority is the approved prototype in [`prototypes/moodboard/`](../prototypes/moodboard/), interpreted with [PRODUCT_VISION.md](./PRODUCT_VISION.md). The prototype is a product-state target: preserving its semantic hierarchy matters more than copying incidental sample data.

## Required prototype references

| Work area | Match it against |
|---|---|
| Home, work queues, freshness, author-first entry | [`home.html`](../prototypes/moodboard/home.html) |
| Angles, immutable patchsets, invalidation, regeneration | [`review.html`](../prototypes/moodboard/review.html) |
| Human decision queue and disagreement | [`decisions.html`](../prototypes/moodboard/decisions.html) |
| Explicit outbound preview and signing | [`publish.html`](../prototypes/moodboard/publish.html) |
| Anchored thread/chat treatment | [`chat.html`](../prototypes/moodboard/chat.html) |
| Phone companion priorities | [`mobile.html`](../prototypes/moodboard/mobile.html) |

**No UI-touching issue closes without a side-by-side comparison against the matching prototype screen in `prototypes/moodboard/`.** Include the screen name and the comparison result in the issue's verification note.

## Materials

1. **Glass is chrome, never code.** Titlebars, sidebars, toolbars, cards, and thread panels may be translucent. Code surfaces, diff tints, and reading columns must remain opaque and legible; the aurora glows around the diff, never through it.
2. **Paper is what leaves the machine.** The outbound preview is an opaque warm sheet with the serif document voice. The collation draft is editable glass; signing crystallises it into the paper. Paper offers sign and back, not editing.
3. **Private things glow from within.** Backlight is the only inner glow. It marks the reviewer's private coverage, pace, threads, dismissals, and stays-local information.

Dark mode uses warm-dark opaque paper; light mode uses cream paper. Paper is defined by warmth and opacity, not a fixed light colour.

## Colour law

Use colour only as meaning:

- Backlight blue means **private to the reviewer**. Ink travels; blue stays.
- Amber means **blast radius or disagreement**. It never orders content and never becomes a general warning colour.
- Add green and delete rust are diff semantics. Accent ice-blue is for interaction/selection.
- Do not introduce a fourth signal hue or give chat a competing colour; conversation is backlight behind the current pane.

## Interaction laws

1. **Fixed point:** the hunk under the cursor stays the reference when the user changes angle; the new projection reorganises around it.
2. **Progressive disclosure:** narrative first, grouped summary second, raw diff last—but raw diff remains one keystroke away. Totality/residue is always reachable.
3. **Never a spinner:** show a narratable live feed or resumable progress state. Work becomes legible as artifacts arrive.
4. **Remove ceremony, preserve judgment:** bulk action is one user act; raw comments can be messy because refinement helps, not because the machine publishes for them.
5. **Marks live at anchors:** agent marks occur on the code they concern. Lists may index a mark but may not replace its anchored presence; unresolved anchors go visibly to an orphan tray.
6. **Paper is explicit:** every outbound change is reviewed in a preview before sign/submit. The surface must visibly distinguish what travels from what stays local.

## Screen-specific constraints

- **Home:** lead with the author's local work and show freshness next to it; incoming PRs are present but not the default mental model.
- **Review:** retain exact-current results, make affected work honestly stale, and offer explicit affected-only regeneration. Do not silently replace a review after edits.
- **Decisions:** show a small actionable view without capping the underlying decision set; retain reconstructed why, evidence, and the path to a disagreement thread.
- **Chat:** conversation is ambient marginalia tied to a diff anchor, never a separate room that displaces the code.
- **Mobile:** keep a feed, cards, and preparation verb; remove multi-column structures rather than compressing them.

## Review bar for UI work

A UI change is incomplete unless it: preserves the material/colour semantics; exposes freshness and publication truthfully; meets the relevant prototype side-by-side check; provides keyboard/accessible interaction through the standard primitives; and states its user-journey stage.

The former design, UX, and visual research material is archived for rationale, not authority.
