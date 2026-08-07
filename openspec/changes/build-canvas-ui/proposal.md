## Why

Rennet is, at its core, "a bunch of canvases the agent fills and the user interacts with" (Product and Vision §4.2; [[Rennet Canvas Paradigm]]). Issue #10 shipped the canvas state model — the four-layer `Canvas` projection, the deterministic placement, the actor-partitioned command vocabularies. What is missing is the surface itself: the canvases **on screen**, the thing the reviewer actually reads and clicks. This is the flagship visible slice, and it must make the product's four frozen principles legible in pixels: aggressive roll-up by default, approve at ANY granularity, free zoom in and out anywhere, smooth and quick (Contracts §1).

## What Changes

- Add the glass design token system to `packages/ui` (`tokens.css`), ported from the ratified mood board (`prototypes/moodboard/assets/tokens.css`): glass chrome, opaque `--code-bg`, paper tokens, backlight blue `--private` (#85C4DC, the system's only inner glow), amber for blast/disagreement, no fourth hue. Dark is the default; the bright-room scheme composes under `[data-scheme="light"]`. The token file is the ONLY place raw hex lives — a lint rule forbids hardcoded hex anywhere else in the UI package.
- Add the canvas rendering surface to `packages/ui` (`canvas/` logic + `components/`): a `CanvasWorkspace` that is a pure, controlled function of the five `Canvas` objects (from #10, in `@rennet/types`) plus a `RennetBridge` (from `@rennet/protocol`) — the projector stays engine-side; the UI never runs it (the `layer:ui` boundary allows only `types` + `protocol`).
  - **Lens switcher** across the six angles: five selectable canvases (spec/sequence/decisions/claims/noise) plus blast-radius as an amber overlay TOGGLE that paints the others — never its own selectable canvas/queue.
  - **Roll-up rendering**: decisions cohorts collapsed by default with honest counts; expand/collapse is navigation ONLY and never read state (coverage keeps reporting collapsed content as unread).
  - **Zoom at any point**: roll-up → cohort → element → the diff itself, traversable both directions, keyboard-first.
  - **Approve at any granularity**: approve / request-change / comment / question at whole-roll-up, cohort, partial selection, or single anchor. A group act is ONE user act that fans out to per-anchor L2 dispositions.
  - **L3 rendering**: orchestrator annotations visually distinct as the agent's hand (glass chrome — never L1 analysis or L2 human judgment); proposal elements rendered next to their target with accept / edit / dismiss affordances, edit-then-accept first-class, and only acceptance creates L2.
  - **Diff surface**: a windowed `CodeView` only (R16), node-count bounded so a large diff never renders the naive full DOM tree.
  - **Fixed-point rule**: the hunk under the cursor never moves on lens rotation.
- Add the R35 renderer subscription contract (`canvas/feed.ts`): a `CanvasFeedSource` the UI binds through `useSyncExternalStore`, with a stated owner and disposal point (unmount / review close) and a leak test; ephemeral view state is `zustand`. Live updates are invalidation hints — the store stays truth. No RxJS.
- Add the `no-hardcoded-hex` lint rule to `eslint.config.mjs` scoped to `packages/ui` non-test source, plus a red/green test through the ESLint Node API.
- Wire `CanvasWorkspace` into `RennetApp` as an additive view (fixtures-backed until the engine feed lands), preserving the review-capture flow and its e2e selectors untouched.

## Capabilities

### New Capabilities

- `canvas-ui`: the glass token system, the five canvases + blast-radius overlay rendered on screen, roll-up/zoom/approve-at-any-granularity, L3 annotations + proposals, the windowed `CodeView`, the R35 subscription lifecycle, and the hardcoded-hex lint enforcement.

## Impact

- Adds `packages/ui/src/tokens.css`, `packages/ui/src/canvas/*`, `packages/ui/src/components/*`; extends `packages/ui/src/index.ts` and `app.tsx`. Adds one scoped ESLint rule to `eslint.config.mjs`. No new package, no new runtime dependency (React + zustand already present), no dependency-arrow change: the architecture and licenses gates are untouched.
- `layer:ui` stays clean: the UI consumes the `Canvas` shape from `@rennet/types` and dispatches `canvas.*` commands through the `@rennet/protocol` bridge; it never imports `@rennet/core` and never runs the projector.
- Seam with #17 honoured: this slice owns zoom/roll-up/read + the approve affordance and basic disposition creation (approve/request-change/comment/question at any granularity, group-act fan-out). #17 owns the deep comment/question authoring UX (inline refinement, batch adjudication view, orphan tray) — clean extension points are left; the batch-adjudication view and orphan tray are NOT built here.
- Deferred to follow-up: the engine-real canvas feed (a `canvas.snapshot` read command + change-feed emission wiring, #31); TanStack Query invalidation on that feed (the invalidation callback seam is in place); the `@pierre/diffs` node-count re-measure inside Electron under CPU throttling (Pierre is not yet a dependency — the node-count DISCIPLINE is enforced here by windowing + test); the comment-refinement authoring UX (#17/#19).
