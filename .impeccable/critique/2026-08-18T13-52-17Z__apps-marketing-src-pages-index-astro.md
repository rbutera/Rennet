---
target: apps/marketing (homepage)
total_score: 30
max_score: 36
na_heuristics: 7
p0_count: 0
p1_count: 3
timestamp: 2026-08-18T13-52-17Z
slug: apps-marketing-src-pages-index-astro
---
# Critique — Rennet marketing home (apps/marketing/src/pages/index.astro)

Method: dual-agent (A: design review · B: detector + browser). Mode: Persuade.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Download jumps offsite to GitHub /releases/latest with no leaving-site signal; nav external links lack the ↗ used elsewhere (index.astro:86-88 vs :110, :330) |
| 2 | Match System / Real World | 4 | Domain-perfect for agentic engineers |
| 3 | User Control and Freedom | 4 | Theme toggle, collapsible objections, skip link |
| 4 | Consistency and Standards | 3 | Nav CTA "Download" vs "Download for macOS"; dark scheme leaves two cards cream, producing 2.0:1 contrast failure |
| 5 | Error Prevention | 3 | macOS-only download, zero platform awareness |
| 6 | Recognition Rather Than Recall | 3 | 9-11px proof micro-text; lens names assume product vocabulary |
| 7 | Flexibility and Efficiency | n/a | Static Persuade surface |
| 8 | Aesthetic and Minimalist Design | 3 | Hero splits focus between headline+CTA and ~20-datapoint micro digest; h1 49vh |
| 9 | Error Recovery | 3 | Wrong-platform + blind offsite download, no recovery path |
| 10 | Help and Documentation | 4 | Docs links, honest FAQ/objections |
| **Total** | | **30/36** | **Good (83%)** |

## Design Specificity Verdict

Authored for this product, top-decile. Not category-interchangeable. Strongest move: one worked example (atlas · feat/rate-limiting, fail-open decision) threaded through hero digest (:118-155), conversation (:220-227), dual-review disagreement (:252-257), product frame (:290). Narrative order matches DESIGN.md. No DESIGN bans violated; all illustrative data labeled; no fabricated social proof.

Deterministic scan: static CLI clean (0). Runtime browser detector: 18 findings desktop-light, 23 mobile-light, 13 desktop-dark. Real: low-contrast (worst 2.0:1 dark), tiny-text 10-11px, undersized-ui-text, mobile viewport-edge bleed, cramped section padding, mobile horizontal scroll (~8px, .conversation-proof/.code-bar/.thread at 390px in 375px column). False positives: cream-palette, kicker-above-heading (deliberate brand/editorial); oversized-h1 judgment call. gpt-thin-border-wide-shadow x5 is a real DESIGN.md violation (border OR shadow, not both).

## Priority Issues

- [P1] Amber accent fails WCAG AA in both schemes. #a86125 on #f1e2d0 = 3.8:1 (x4), on #1b2027 = 3.4:1 (x2); worst #dda664 on #f7f4ee = 2.0:1 (x2, dark mode cream cards: "Two independent reads" + Local-first spec table). Fix: darken light amber toward ~#8a4d1a on cream; theme the cream cards in dark. Command: /impeccable colorize.
- [P1] Load-bearing proof text at 9-11px. diff-head 9px (global.css:401), stage labels 11px, cohort/decision 10-11px, paper meta 9px, dual-proof 10px, map 10px, "Current product wireframe" caption 10px. Fix: raise proof floor to 11-12px. Command: /impeccable typeset.
- [P1] Hero splits focus. 78px/49vh headline + CTA share viewport with 4-stage digest, ~20 datapoints at 9-11px (:115-156). Fix: diagrammatic 4-beat strip, fewer larger items; detailed sequence below. Command: /impeccable layout.
- [P2] Mobile 390px layout bugs. Horizontal scroll ~8px (.conversation-proof/.code-bar/.thread); 1100px img bleeds both sides; 4 paragraphs to viewport edge; harnesses/truth sections flush against border; product-frame hard-coded crop height:500px + translate(-455px,-120px) (global.css:1533-1545). Fix: cap widths 100%, restore insets, object-fit crop. Command: /impeccable adapt.
- [P2] Download moment under-served. Reassurance (no API key/telemetry/markup) at :310-313, far below hero CTA; Download leaves blind for GitHub releases, no install note; non-mac visitors dead-end. Fix: reassurance line + install note at hero CTA, external signal, non-mac fallback. Command: /impeccable clarify.

## Persona Red Flags

- Jordan: "Not for vibe coders" (:104) gatekeeping risk; jargon pipeline in hero; raw releases-list landing.
- Riley: expects .dmg, gets releases list, no checksum/signing note; non-mac dead-end. Otherwise clean — honesty verifiable.
- Casey: 9-11px on phone; 8px scroll wobble; brittle product-frame crop; 14-section scroll. Good: header collapses to Download, CTA above fold.
- Skeptical staff engineer: strongly served; weak spot is wireframe as only product visual (:292).

## Minor Observations

- 5 objects with border+shadow both (DESIGN says pick one).
- Mid-page valley: 4 dense sections in a row (:261-308); "Shells" (:296-301) proofless, renders near-empty.
- CSS var collision: --line color vs width (index.astro:123 / global.css:423); rename local to --bar.
- Comment :74 claims "fixed accountability headline"; hero is a normal grid.
- Proof visuals aria-hidden; SR never hears the disagreement content.
- Cognitive load: ~3 soft failures; only site header >4 options (6), self-resolves ≤560px.

## Questions to Consider

1. Is the hero digest earning its first-viewport slot?
2. Should the disagreement panel fight for the first screen instead of section 7?
3. Reassurance answered in section 12 — after a hero-Download visitor already left for GitHub. Who is it for?
