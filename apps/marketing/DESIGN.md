---
name: Rennet marketing
description: Six constellations around the work of understanding code.
colors:
  canvas: "#100d0b"
  ink: "#faf3e9"
  ink-soft: "#c9bfb2"
  line: "rgb(219 173 107 / 19%)"
  gold: "#f3b437"
  glass: "rgb(19 15 11 / 90%)"
  surface: "rgb(25 20 15 / 94%)"
  light-glass: "rgb(249 242 230 / 93%)"
  light-surface: "#eee3d0"
  light-ink: "#302315"
  light-ink-soft: "#65533e"
  light-line: "rgb(99 70 35 / 20%)"
typography:
  display:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "clamp(3.2rem, 6.1vw, 6rem)"
    fontWeight: 580
    lineHeight: 1.04
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "clamp(2rem, 4.3vw, 3.8rem)"
    fontWeight: 540
    lineHeight: 1.08
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "17px"
    lineHeight: 1.65
rounded:
  control: "10px"
  capture: "12px"
  glass: "26px"
  mobile-glass: "20px"
components:
  button-primary:
    backgroundColor: "{colors.gold}"
    textColor: "#171006"
    rounded: "{rounded.control}"
    padding: "14px 23px"
  reading-panel:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.ink}"
    rounded: "{rounded.glass}"
---

# Rennet marketing design system

## Overview

**Creative North Star: "A body of code becomes a constellation"**

This is the visual authority for `apps/marketing` only. The product UI and documentation retain the [root design authority](../../DESIGN.md). Warm charcoal space and amber/copper points surround readable glass panels; the final scene becomes the warm Rennet sphere. Self-hosted Geist carries headings and prose.

The six-scene concept was authored and approved by Rai. It replaces the earlier gold-wave compositions; no new image composition is the implementation authority. The [surface brief](.impeccable/surfaces/apps-marketing-src-pages-index-astro.md) owns the page's sequence and persuasion strategy. Tokens above describe the current stylesheet, not the product app's palette.

## Colors

Gold marks primary downloads and keyboard focus. Pale text and warm neutral supporting copy read over dark glass; amber/copper particles carry the warm palette through every scene. The final particle sphere transitions through the brand's red, orange, and gold.

The reading control offers pale panels with dark brown text. It changes panel tokens and product capture sources; the background scene, header, hero, and closing remain dark. Dark panels are the initial default, and the explicit reading preference is stored locally.

## Typography

Use the self-hosted variable Geist face for headings, body, navigation, and controls. Code examples use the platform monospace stack. The wordmark remains vector artwork.

Headings are balanced, closely spaced, and large enough to stand apart from the scene. Body copy uses comfortable leading. On narrow screens the body falls to 16px and the opening headline uses `clamp(2.6rem, 10vw, 3.5rem)`.

## Layout

A fixed full-viewport canvas sits behind ordinary document content. Each chapter leaves a visible interval for its scene before the reading panels. The main shell is capped at 1180px with 40px side gutters; chapter content is capped at 1040px. At 600px and below, the shell uses 18px gutters and chapter panels use 14px gutters.

The header stays fixed. At 900px some navigation links disappear; at 600px the navigation list is hidden while download, reading-theme, and motion controls remain. Workflow columns collapse to one, and the four-stage digest becomes a vertical sequence. Disclosures keep their original narrative order and deep links.

## Elevation & Depth

Reading panels combine the dark glass fill above, a faint amber highlight, a hairline, an inset highlight, and a broad shadow. Backdrop blur is 16px on desktop and 10px on narrow screens. Product screenshots remain opaque, so source evidence stays visually separate from atmospheric geometry.

Hero copy has no backing layer. Code is composed at the desktop margins and above the mobile headline; local text shadows preserve letter contrast. Closing copy has a separate 96% charcoal backing feathered with a 38px blur (24px on narrow screens). The footer uses 97% charcoal fill with a matching feathered shadow. Keep these reading backings in place when adjusting bloom or scene placement; text should not depend on a dark patch of the moving object.

The scene uses procedural amber/copper points, additive blending, bloom, and a warm, subtly grained atmospheric background. Normal scrolling controls morphs between the six objects; ambient motion supplies rotation and a subtle final pulse. The final sphere rises with the document so the closing headline remains beneath its silhouette. Pause stops the ambient clock and selects discrete scenes on scroll. Reduced-motion preference starts the scene paused and removes CSS smooth scrolling and transitions. Hidden tabs stop animation frames. WebGL failure or context loss leaves the CSS backdrop and static brand fallback behind readable content.

## Shapes

Large rounded glass panels contain the reading sections. Smaller rounded frames contain captures and illustrative evidence. Icon controls are circular; primary downloads use the control radius. Scene geometry is generated locally in code, with no external point-cloud asset files.

## Components

- **Download:** gold primary link in the hero and closing, pale compact link in the fixed header. All lead to the release page.
- **Reading panel:** one section of prose or product explanation on glass; use the pale variant through the shared reading preference.
- **Product disclosure:** native `details` and `summary` preserve keyboard operation. Seven captures remain reachable through their labels and anchors; each carries copy written from the reviewer's side, naming what the surface does for them rather than how Rennet builds it.
- **Lens list:** a two-column definition list under the lens heading names each lens and the one question it answers, in the reviewer's words. It collapses to one column at 600px.
- **Capture:** one lazy image with dark and light source data. The reading control swaps its source. A closed disclosure does not guarantee that the browser avoids downloading it.
- **Motion and reading controls:** labelled toggle buttons with pressed states; visible gold focus rings support keyboard use.

## Do's and Don'ts

- Keep product claims and fixture captions readable without the animated canvas.
- Preserve original brand assets and opaque shipped-app captures.
- Keep constellation materials scoped to marketing.
- Do not import the glass treatment into the product app.
- Do not present illustrative conversation or review counts as measured product results.
- Write copy from the reviewer's point of view: what they see, ask, and decide. Do not describe Rennet's internals (seats, boards as machinery, repository maps) or defend design choices the reader never raised.

The mobile hero reserves 360px above its copy for the visible code scene. Intro geometry rises with document scroll so it does not pass through the copy; the closing keeps its separate feathered backing.

Every scene uses a near-neutral charcoal atmosphere with restrained grain. Colour comes from the particles, controls and final logo, never a gold background wash. The code scene stays complete until scrolling begins, independently of the removed scroll prompt.
