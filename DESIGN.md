---
name: Rennet
description: Dense change becomes clear human judgment.
colors:
  warm-paper: "#f5f2ec"
  paper-bright: "#fbfaf7"
  ink: "#101317"
  ink-soft: "#5f6872"
  hairline: "#d9d5cd"
  blue: "#527c9b"
  amber: "#b86a2d"
  green: "#58806b"
typography:
  display:
    fontFamily: "Archivo Variable, Arial Narrow, sans-serif"
    fontSize: "clamp(2.7rem, 4.9vw, 5.5rem)"
    fontWeight: 720
    lineHeight: 0.96
    letterSpacing: "-0.04em"
  body:
    fontFamily: "Archivo Variable, Arial Narrow, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Archivo Variable, Arial Narrow, sans-serif"
    fontSize: "13px"
    fontWeight: 600
rounded:
  control: "10px"
  surface: "12px"
spacing:
  control-x: "24px"
  section-min: "96px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper-bright}"
    rounded: "{rounded.control}"
    padding: "0 24px"
    height: "58px"
  review-surface:
    backgroundColor: "{colors.paper-bright}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
---

# Design System: Rennet

## Overview

**Creative North Star: "The Breaking Edge"**

Rennet is a warm editorial system for a serious developer tool. Its defining move is reduction:
dense technical material crosses the cheese-wheel breaking edge and becomes fewer, calmer, more
legible objects. The brand mark is the mechanism, not decorative chrome.

The system pairs compact, high-confidence display typography with quiet paper surfaces, fine rules,
and truthful product evidence. Color is sparse and functional. The product should feel rigorous
without becoming enterprise-cold or dressing itself in generic developer-tool neon.

**Key Characteristics:**

- Warm paper and near-black ink dominate.
- Dense information resolves into a clear reading order.
- The canonical cheese-wheel mark supplies the fragmentation geometry.
- Product-native color identifies meaning; it does not decorate the page.
- Large editorial type creates confidence and pace.

## Colors

The palette is primarily monochrome, with dusty blue, warm amber, and muted green reserved for
meaning inside demonstrations and product evidence.

### Primary

- **Near-black ink** (`#101317`): headlines, primary controls, and the dark raw-diff mass.
- **Warm paper** (`#f5f2ec`): the continuous page field.

### Secondary

- **Review blue** (`#527c9b`): informational groupings and links.
- **Decision amber** (`#b86a2d`): reconstructed decisions and attention points.
- **Evidence green** (`#58806b`): additions and verified structural material.

### Neutral

- **Bright paper** (`#fbfaf7`): elevated review objects and sheets.
- **Soft ink** (`#5f6872`): supporting prose and metadata.
- **Hairline** (`#d9d5cd`): section divisions and surface boundaries.

**The Sparse Color Rule.** Monochrome carries the brand; color appears only where it helps someone
read state, provenance, or structure.

## Typography

**Display Font:** Archivo Variable, using its width axis for compactness.
**Body Font:** Archivo Variable with a wider, calmer setting.

**Character:** Display type is blunt, compressed, and assured without becoming futuristic. Body
copy is neutral and highly readable, allowing the display voice and product evidence to lead.

### Hierarchy

- **Display** (720–750, fluid up to `5.5rem`, `0.96`): hero and major section statements.
- **Title** (650–680, `20–25px`): review objects, questions, and workflow labels.
- **Body** (400, `16–19px`, `1.5`): explanatory prose, normally kept below 65 characters per line.
- **Label** (600, `10–14px`): navigation, metadata, and compact interface evidence.

**The Compressed Thesis Rule.** Compress display headings with the width axis; never substitute a
monospace or generic system-black face to signal technical credibility.

## Layout

The desktop shell is wide and editorial, capped near 1480px with 40px outer gutters. Sections use
large vertical intervals, generally 96–176px, and alternate dense proof with quiet explanation.
The first viewport reads left-to-right from promise to raw diff, cohorts, decisions, and paper.

At tablet widths, secondary decision detail may collapse while the causal sequence stays intact.
Below 620px the digestion sequence becomes vertical: dense diff first, then cohorts, decisions, and
paper. Mobile never miniaturizes the desktop diagram into an unreadable strip.

## Elevation & Depth

The page is flat by default. Review objects and product windows receive one ambient shadow with a
real downward offset and broad blur. Hairlines establish most hierarchy; shadows are reserved for
objects that conceptually lift from the paper.

### Shadow Vocabulary

- **Ambient review lift** (`0 26px 64px -34px rgb(25 30 35 / 32%)`): paper and full product frames.
- **Control lift** (`0 12px 28px -18px rgb(15 19 23 / 80%)`): primary actions at rest.

**The Paper-First Rule.** A surface earns elevation by behaving like a separate review object, not
merely because it needs visual emphasis.

## Shapes

Controls use a restrained 10px radius. Review groupings use 12px corners, while the final paper may
carry one slightly more pronounced folded corner. Borders remain one pixel. The cheese-wheel mark
and its diminishing fragments are the only expressive recurring geometry.

## Components

### Buttons

- **Shape:** compact rectangle with a 10px radius and 58px height.
- **Primary:** near-black fill, white label, 24px horizontal padding, and an authored line icon.
- **Hover / Focus:** two-pixel upward lift on hover; three-pixel review-blue focus outline.
- **Secondary:** text link in review blue, underlined on hover rather than enclosed in another box.

### Cards / Containers

- **Corner Style:** 12px for cohorts and decisions; eight pixels with one deeper corner for paper.
- **Background:** bright paper, occasionally tinted with a very pale functional hue.
- **Shadow Strategy:** ambient only when the object lifts from the page.
- **Border:** one quiet neutral or semantically tinted hairline.

### Navigation

Navigation is spare: the canonical horizontal lockup on the left and a small set of direct links on
the right. External destinations use one consistent authored arrow icon.

### Horizontal Reduction

The signature component begins with one dark, information-dense diff. The canonical fragment edge
breaks it into a smaller set of cohorts, then decisions, then one paper. Counts and sample content
must be truthful or visibly labeled illustrative.

## Do's and Don'ts

### Do:

- **Do** use the committed brand exports from `brand/` without redrawing their geometry.
- **Do** vary scroll density: a dense proof passage should earn a quiet editorial passage.
- **Do** use real product captures or clearly labeled wireframe and synthetic material.
- **Do** preserve the mass-to-meaning reading order at every breakpoint.

### Don't:

- **Don't** expand, inflate, explode, fold, or substitute another metaphor for decomposition.
- **Don't** turn the site into equal-sized SaaS cards or an icon-feature grid.
- **Don't** use gradients, glass, neon, or color as a site-wide decorative identity.
- **Don't** use the standalone mark as a giant decorative object when it is not doing structural work.
