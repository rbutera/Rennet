# First-run welcome design QA

Source visual truth: `/Users/rai/.codex/visualizations/2026/08/28/01a04855-3c9c-7b82-91dc-47f2b003e1c5/rennet-welcome-flow/`

Approved source image: `/Users/rai/.codex/generated_images/01a04855-3c9c-7b82-91dc-47f2b003e1c5/exec-f7a78dd8-4402-404e-9386-8230446324e3.png`

Implementation: `packages/app-ui/src/welcome/first-run-welcome.tsx` rendered by the desktop application.

Target viewport: 1487 × 1058 CSS pixels at device scale factor 1.

Source pixels: 1487 × 1058. Implementation pixels: unavailable. No density normalization was possible.

State: first-run welcome, opening code flight through the assembled-logo appearance state, Affineur's Bench light theme.

## Full-view comparison evidence

Blocked. The approved source image was opened at original resolution, but the browser runtime reported no available browser and the production desktop implementation could not be captured through the permitted visual-QA surface. Source inspection, CSS inspection, DOM tests, and a successful build are not substitutes for rendered-pixel evidence.

## Focused region comparison evidence

Blocked for the same reason. The logo convergence, centered cycling tagline, appearance-card entrance, theme previews, bottom progress control, and responsive layout could not be compared from production-rendered pixels.

## Required fidelity surfaces

- Fonts and typography: the implementation uses the product display and sans-serif tokens in the intended regions; production rendering and wrapping were not visually verified.
- Spacing and layout rhythm: the approved full-window hierarchy, first-step header omission, logo breathing room, fixed tagline stage, appearance card, and bottom progress are represented in production CSS; rendered geometry was not visually verified.
- Colors and visual tokens: the implementation uses the existing Rennet surface, ink, accent, success, and theme-pack tokens and contains no decorative gradient; rendered colors were not sampled.
- Image quality and asset fidelity: the production component reuses the authored `RennetLockup`, `AgentMark`, and `ToolMark` assets. Their final scale and antialiasing were not visually verified.
- Copy and content: the approved responsibility line, cycling review words, detected-tool language, Dual Harness explanation, optional Full Disk Access language, and final New Chat action are present. Visual wrapping was not verified.
- States and interactions: DOM tests exercise the opening state, live appearance writes, harness configuration, Full Disk Access action, project addition, completion failure, missing-harness recovery, and final navigation. Browser interaction and console checks were unavailable.
- Responsiveness and accessibility: semantic controls, reduced-motion handling, focusable actions, and responsive CSS are present. Browser zoom and alternate viewport behavior were not visually verified.

## Findings

- P0: Production-rendered comparison evidence is missing.
  - Location: the complete first-run welcome.
  - Evidence: browser discovery returned an empty browser list, so no production screenshot could be captured at the source viewport.
  - Impact: visual fidelity cannot receive a passing design-QA result.
  - Fix: open a fresh-data desktop build through a supported visual-control surface, capture the opening and assembled appearance states at 1487 × 1058, exercise the five-step flow, check console errors, and compare the source and implementation captures together.

## Comparison history

No production visual-comparison iteration was possible. The interactive prototype itself was reviewed and refined with Rai before implementation, including code-fragment flight, logo spacing, tagline centering, continuous single-word cycling, first-page chrome removal, and bottom progress placement.

## Implementation checklist

1. Capture the production opening and assembled appearance states at the target viewport.
2. Compare full view and focused logo/tagline/appearance regions against the approved prototype.
3. Exercise every welcome step, reduced motion, dark appearance, missing harnesses, and the Full Disk Access recovery path.
4. Fix any P0–P2 mismatch and repeat the same-state comparison.

final result: blocked
