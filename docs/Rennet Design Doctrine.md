---
tags: [rennet, design, ux]
categories: [reference]
status: active
created: 2026-08-07
updated: 2026-08-07
related: ["[[Rennet Product and Vision]]", "[[Rennet User Journey]]", "[[Code Review App Design Directions]]", "[[Code Review App UX Concepts]]", "[[Code Review App UX Research]]"]
source: ratified extraction from the prototype design/UX docs (glass ratified by Rai — "definitely glass is the way")
---

# Rennet Design Doctrine

**The design register, ratified.** The richest design thinking in the corpus lived in the prototype docs ([[Code Review App Design Directions]], [[Code Review App UX Concepts]], [[Code Review App UX Research]]), which the doc architecture marks historical — so an implementer following the rules ("read the ratified docs + your issue") would never encounter the register the product is supposed to have. This document promotes the system rules to ratified doctrine. It is short on purpose: these are the rules an implementer must not break, with the prototype docs cited for the full reasoning and the mood-board mockups (`prototypes/moodboard/`) as the visual reference.

Glass is the ratified identity (Rai, verbatim: "definitely glass is the way"). Tokens and chrome ship in v1; visual polish may lag; **the doctrine is absolute from the first screen** (R26).

## 1. The three materials

The whole public/private semantics of the product is carried as *material*:

1. **Glass is chrome, never code.** Sidebars, titlebars, toolbars, cards, and thread panels may be translucent and blurred; **every code surface, diff tint, and reading column is fully opaque.** The aurora glows *around* the diff, never through it. (Translucency degrades code contrast — this is a hard rule baked into the tokens, not a taste call.)
2. **Paper is what leaves the machine.** Anything that becomes a GitHub artifact renders as opaque warm paper (`--sheet-*` tokens): the publish sheet above all, and any preview of a comment about to land. Working state lives on glass; the committed account lives on paper. In a fully translucent product, **the thing you sign is the only solid object** — the materiality inversion is the publish ceremony's integrity mechanism (hold-to-sign, the serif document voice reserved for paper alone, the travels ledger on the paper and the stays-on-this-Mac list floating beside it on glass, never touching it).
3. **Private things glow from within.** Surfaces private to the reviewer carry the backlight treatment — **the only inner glow in the system.**

## 2. The colour law

**Functional colour only: add green, delete rust, blast amber, backlight blue, accent ice-blue. No decorative hues, and no fourth signal hue.**

- **Backlight blue `#85C4DC`** (bright-room scheme deepens to `#24657F`) on translucent cyan fills with a faint inner glow = **private-to-reviewer**. It marks exactly the set that never publishes: coverage, pace, chat/threads, dismissals, the stays-panel. The glass-native reading of non-photo blue: a surface lit only under your own light. The conversation has no room of its own — it is backlight behind every pane, and only your hand turns any of it into paper. Chat never gets a colour, only a light.
- **Amber = blast radius and disagreement, nothing else.** Blast radius is an overlay (paint), never an ordering input; disagreement stays in the amber family (it is a risk signal aimed at your judgment) and is distinguished by treatment (glyph, consistency line, verdict copy), not by a new hue. Amber says *risk*; backlight beside it says *the conversation about it is here and still yours*.
- Ink is what travels; blue is what stays.

## 3. The interaction laws

1. **The fixed-point rule.** *The hunk under the cursor is the fixed point; the lens rotates around it.* Switching lens never navigates away: the frame reorganises around the hunk, and switching back restores the previous frame, again centred on it. Every lens must answer "where is this hunk in MY projection?" instantly — every lens is a total function over hunks, and a hunk no lens can place is a loud error state, never a silent omission (the residue check).
2. **The progressive-disclosure floor.** Narrative first, grouped summary second, raw diff last — **with the raw diff always one keystroke away. Trust dies the moment the summary is the only view.** The totality/residue guarantee (what have I not looked at) must be reachable at all times; done/publish block on incomplete ingestion.
3. **Never a spinner.** Generation is itself narratable: the surface shows a **live narrative feed** ("reading the changeset… 214 hunks… chapter 3 looks like the risky one"), each line becoming tappable as its artifact lands. If generation runs long, the feed degrades into a resumable progress summary — still never a blank surface with a spinner. Loading states are replaced by the machine being legible about its work.
4. **Smooth and quick — the machine does the cleanup.** The user may be lazy and messy; anything that adds user ceremony without adding user judgment is wrong. The comment-refinement loop exists so the user is *allowed* to be messy; bulk adjudication is one act; grouping is hard-baked, never a knob.

## 4. What this doctrine is for

#62-class bugs ("the UI feels intimidating", radius jank, a spinner someone added because loading needed *something*) are what happens when the register lives in historical docs nobody is required to read. An implementer touching any UI surface reads this document first; a review of any UI slice checks against it. Where a mockup and this doctrine disagree, the doctrine wins; where this doctrine and a ruling disagree, the ruling wins ([[Rennet Contracts and Rulings]]).

Full reasoning, schemes (dark default + composed bright-room), wallpaper/aurora policy, serif scarcity, and the built mood board: [[Code Review App Design Directions]]. The lens model and fixed-point derivation: [[Code Review App UX Concepts]]. The progressive-disclosure evidence: [[Code Review App UX Research]].

---

*Ratified 2026-08-07 as part of the journey/steering pass — the design register promoted from historical prototype docs into doctrine implementers are required to read.*
