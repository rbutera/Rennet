---
target: desktop product UI (packages/ui)
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-08-18T13-15-17Z
slug: packages-ui-src-app-tsx
---
# Critique — Rennet desktop UI (packages/ui/src/app.tsx)

Method: dual-agent (Assessment A: design review sub-agent · Assessment B: detector/evidence sub-agent). 2026-08-18.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | AI review pass shows static text card; no motion/elapsed/cancel; busy-bar and ProgressFeed unwired to live-canvas load (app.tsx:2789, effect ~1239-1267) |
| 2 | Match System / Real World | 3 | Product-authored truthful vocabulary |
| 3 | User Control and Freedom | 2 | No cancel on running review; disposition undo on different surface; hold-to-sign all-or-nothing |
| 4 | Consistency and Standards | 3 | Ramp discipline exceptional; docked for tokens.css palette drift + dual review surfaces |
| 5 | Error Prevention | 3 | Fail-closed publish checks, stale-hold void, double-sign guard |
| 6 | Recognition Rather Than Recall | 3 | Palette shows effective keybinding + conflicts; only 4 direct chords |
| 7 | Flexibility and Efficiency | 2 | Remappable keys; no 1-5 canvas jump, no disposition shortcuts |
| 8 | Aesthetic and Minimalist Design | 3 | Real material idea; organ stacking clutters first paint |
| 9 | Error Recovery | 3 | Honest failure states; "engine returned nothing" terse retry-only |
| 10 | Help and Documentation | 1 | No in-app help, no shortcut sheet, cold start unexplained |
| Total | | 25/40 | Acceptable (upper end) |

All 10 heuristics scored (none n/a). Operate surface.

## Design Specificity Verdict

Authored for this product. Thesis: glass is chrome, code opaque, paper leaves the machine (tokens.css:9-19). Five canvases + zoom ladder IA; blast overlay with NOT ASSESSED honesty; fixture-never-dressed-as-real.
Leaks: (1) Files tab ships generic 3-pane diff grid with dead "Angles: Not run" rail (app.tsx:~340-370); (2) tokens.css "superseded", hexes drift from DESIGN.md (blue #8cc0e8 vs #8bbddd, amber #e2b266 vs #dda664, green #8cc79e vs #88bc9b) + unsanctioned --private glow (forbidden fourth hue). Missed: raw→cohorts→decisions→paper spine never visible.

Deterministic scan: detector exit 0, zero findings, not degraded. 1001/1001 tests pass incl. design-ramp/tokens/hex-lint. Grep corroborates: all font-sizes on ramp, all radii on-ramp/tokenized, zero raw hex outside tokens.css (27 grep hits = issue numbers in comments, false positives). Detector blind to: progress feedback, focus rings, hold reassurance, palette drift vs DESIGN.md values.

Browser overlay: skipped — Electron renderer, browser bundle daemon-served (vite.browser.config.ts, #381), no standalone dev server.

## Priority Issues

- [P1] No progress during AI review run. Static .canvas-primer text for longest wait; ProgressFeed (progress-feed.tsx) exists unwired. Fix: wire ProgressFeed + elapsed + cancel. Command: /impeccable polish
- [P1] Focus indication thin; .canvas-app outline:none (canvas.css:23) no replacement; ~11 focus rules in ~7500 CSS lines; DESIGN.md 3px review-blue ring not implemented systemically. Fix: systemic :focus-visible ring token. Command: /impeccable audit
- [P1] Hold-to-sign no progress feedback; only opacity 0.72 (styles.css:1097); data-hold-ms unrendered. Fix: fill/ring keyed to holdToSignMs + early-release announcement. Command: /impeccable polish
- [P2] Vestigial Files surface with dead Angles rail. Fix: wire to canvas state or strip to honest raw diff. Command: /impeccable distill
- [P2] Token palette drift + --text-faint ~4.2:1 light-mode (est., 156 sites incl. 10/11px text), below AA. Fix: reconcile tokens to DESIGN.md; fix contrast. Command: /impeccable colorize + /impeccable audit

## Persona Red Flags

Alex: frozen review card (hung vs working indistinguishable); no 1-5 canvas jump; disposition undo requires draft surface; hold budget invisible.
Sam: canvas-app focus invisible (hard blocker); LensSwitcher tablist lacks roving tabindex/arrow keys; 10/11px meta ~4.2:1. Good: palette dialog aria-modal, disposition aria-labels, aria-keyshortcuts on sign.
Agentic engineer: handoff real (push + PR works) but no visible agent-waiting bridge.

## Minor Observations

- --chip-radius=8px mis-named (chip corner is 6px)
- Internal issue refs in user copy ("#21 steps", "lands with #19")
- Infinite animations reduced-motion-guarded (good)
- "The engine returned nothing." terse, no diagnosis

## Questions

1. Is Files earning its tab or is it the UI canvases were meant to retire?
2. tokens.css vs DESIGN.md — which is authoritative when they disagree?
3. Does the zoom ladder communicate the decomposition or just implement it invisibly?
