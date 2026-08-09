---
tags: [rennet, design, ux]
categories: [reference]
status: active
created: 2026-08-07
updated: 2026-08-09
related: ["[[Rennet Product and Vision]]", "[[Rennet User Journey]]", "[[Rennet Collation Draft Canvas]]", "[[Code Review App Design Directions]]", "[[Code Review App UX Concepts]]", "[[Code Review App UX Research]]"]
source: ratified extraction from the prototype design/UX docs (glass ratified by Rai — "definitely glass is the way")
---

# Rennet Design Doctrine

**The design register, ratified.** The richest design thinking in the corpus lived in the prototype docs ([[Code Review App Design Directions]], [[Code Review App UX Concepts]], [[Code Review App UX Research]]), which the doc architecture marks historical — so an implementer following the rules ("read the ratified docs + your issue") would never encounter the register the product is supposed to have. This document promotes the system rules to ratified doctrine. It is short on purpose: these are the rules an implementer must not break, with the prototype docs cited for the full reasoning and the mood-board mockups (`prototypes/moodboard/`) as the visual reference.

Glass is the ratified identity (Rai, verbatim: "definitely glass is the way"). Tokens and chrome ship in v1; visual polish may lag; **the doctrine is absolute from the first screen** (R26).

## 1. The three materials

The whole public/private semantics of the product is carried as *material*:

1. **Glass is chrome, never code.** Sidebars, titlebars, toolbars, cards, and thread panels may be translucent and blurred; **every code surface, diff tint, and reading column is fully opaque.** The aurora glows *around* the diff, never through it. (Translucency degrades code contrast — this is a hard rule baked into the tokens, not a taste call.)
2. **Paper is what leaves the machine.** Anything that becomes a GitHub artifact renders as opaque warm paper (`--sheet-*` tokens): the publish sheet above all, and any preview of a comment about to land. Working state lives on glass; the committed account lives on paper. In a fully translucent product, **the thing you sign is the only solid object** — the materiality inversion is the publish ceremony's integrity mechanism (hold-to-sign, the serif document voice reserved for paper alone, the travels ledger on the paper and the stays-on-this-Mac list floating beside it on glass, never touching it).
   - **Signing is a phase transition: glass crystallises into paper (R40).** The forming destination — the collation draft canvas ([[Rennet Collation Draft Canvas]]) — is translucent working **glass** you are still forming; the **sign** act is what freezes it into the one opaque solid object. The draft is deliberately not-yet-solid, and solidity is what signing confers; editing lives on the glass draft, and the paper's only actions are **sign** and **back**. This *sharpens* the materiality inversion rather than bending it: the collation draft stays glass (it will publish once signed, so it is ink-in-formation, never backlight), and only signing makes it paper.
   - **Paper is the one opaque solid object in every scheme — warm-dark in dark, cream in bright; it is materiality (warmth + opacity), never a fixed light colour.** What makes a surface read as *paper* is **warmth** (a material tone against the cool teal/blue glass); what makes it belong in dark mode is **darkness**; what makes it solid is **opacity**. So the dark (bioluminescent-twilight) scheme gets **warm-dark paper** — deep espresso/umber with warm off-white ink — never a light cream sheet on a near-black app and never an inverted "dark panel"; the bright-room scheme keeps the **cream**. The `--sheet-*` tokens must theme per scheme (the dark values are the base default; the cream values move into `[data-scheme="light"]`); only the base material colours theme — the serif document voice, hold-to-sign, and the sheet-glow are unchanged.
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
5. **Marks live at their anchors, never in a list.** An agent mark (L3) renders *at the place it is about* — a highlight ON its lines, the ◇ hand in the gutter of its span, a proposal card inline at the span it concerns. A strip or panel may *index* marks (a jump-list that navigates to the in-code mark), but it must never *house* them: marks in a strip are an inbox, marks at anchors are presence, and presence is the difference between a document you look at and a room you are both in. A mark whose anchor does not resolve to a place renders in the orphan tray, visibly, never silently in a list. This is what makes the code surface a *canvas the agent inhabits with you* rather than a diff viewer beside a sidebar of the agent's notes.

## 4. The chrome voice (terse, functional, zero editorial) [R41]

**Rennet's own chrome is terse and functional. Zero colourful, editorial, or marketing copy.** Labels, empty states, tooltips, section headers, and button text are plain and sparse. Rennet is a **minimal harness** in the literal sense: it hosts canvases that two intelligences (the human and the LLM) converse over. The chrome is the frame around that conversation, not a voice in it. Rai's example of exactly what to kill: **"your code before it becomes someone else's problem."** No taglines, no jokes-in-the-UI, no personality copy, no cheese; a label says what the thing is and stops.

⭐ **The critical exemption: LLM-generated content that fills the canvas is NOT bound by this rule.** The narration, roll-up summaries, decision WHYs, findings prose, refiner output, and every diff/conversation fragment are the **human↔LLM conversation and diff content**; that is the substance the harness exists to host, and it carries whatever voice the analysis needs. The terse rule governs **only Rennet's own chrome**, never the canvas content. When in doubt: did Rennet write it (chrome, terse) or did a model/the diff produce it (content, exempt)?

## 5. Icon economy and the legend [R42]

**Icons over words; extreme text economy in Rennet's own chrome.** The diffs are already text and the app is full of human↔LLM conversation fragments, so Rennet itself should barely use words: use an icon wherever it removes noise without removing meaning (statuses, actions, angle/lens identity, coverage/read state, disposition types, private-to-reviewer marks). This is the visual expression of §4: the chrome recedes so the content reads.

⛔ **There MUST be an icon legend/key that defines every glyph.** Every icon the chrome uses is defined in one discoverable legend; an icon with no legend entry is a bug. Icon economy without the key is a puzzle, not a UI; the key is what makes silence legible. (The exemption of §4 applies here too: this governs chrome glyphs, not content.)

## 6. What this doctrine is for

#62-class bugs ("the UI feels intimidating", radius jank, a spinner someone added because loading needed *something*) are what happens when the register lives in historical docs nobody is required to read. An implementer touching any UI surface reads this document first; a review of any UI slice checks against it. Where a mockup and this doctrine disagree, the doctrine wins; where this doctrine and a ruling disagree, the ruling wins ([[Rennet Contracts and Rulings]]).

Full reasoning, schemes (dark default + composed bright-room), wallpaper/aurora policy, serif scarcity, and the built mood board: [[Code Review App Design Directions]]. The lens model and fixed-point derivation: [[Code Review App UX Concepts]]. The progressive-disclosure evidence: [[Code Review App UX Research]].

---

*Ratified 2026-08-07 as part of the journey/steering pass — the design register promoted from historical prototype docs into doctrine implementers are required to read. Amended 2026-08-08 (R40, Rai blessed): §1.2 gains the glass→paper phase-transition rule and the dark-paper (per-scheme materiality) rule. See [[Rennet Collation Draft Canvas]] §5. Amended 2026-08-09 (R41/R42, Rai's wireframe markup): §4 (terse chrome voice + the LLM-content exemption) and §5 (icon economy + the required legend) added; the former §4 "What this doctrine is for" is now §6.*
