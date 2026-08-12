# Design — navigation-wayfinding (#297)

## The model: one surface stack, lenses and overlays beside it

The whole navigation reduces to one idea from frame `18`: **a stack of surfaces**. Everything else is classified against it.

- A **Surface** is a location that has a place in the hierarchy and in history. The surface stack is the source of truth:
  - `{ kind: "projects" }` — the front door.
  - `{ kind: "project", projectId }` — project detail.
  - `{ kind: "review", reviewId }` — an open review (its lens is internal state, NOT part of the surface identity).
  - `{ kind: "draft", reviewId }` — the collation draft.
  - `{ kind: "paper", reviewId }` — the sign paper.
- **Lens** (Files · Spec · Sequence · Decisions · Flagged · Noise) is the review surface's internal tab. Switching it changes what the review shows; it does NOT push a surface or move the crumb. It stays where it is today (`view` + the canvas lens), just decoupled from history.
- **Overlay** (Conversation/Ask, symbol inspector, command palette, and the Settings sheet) opens *over* the current surface and closes back to it. Overlays never enter the stack or the crumb.

## The navigation store (`packages/ui/src/nav/`)

A small, pure, unit-testable model — `useNavHistory` (a hook over `useReducer`, or a tiny store), returning:
- `stack: Surface[]` (the hierarchical path to the current surface) and `current` (its tip).
- `future: Surface[]` (the forward stack for redo).
- `push(surface)` — navigate to a child/sibling surface (clears `future`).
- `back()` / `forward()` — pop/re-push across `future`.
- `ascendTo(index)` — a breadcrumb click: truncate the stack to that tier.
- `replaceTop(surface)` — swap the tip without a history entry (e.g. re-review swaps the review's patchset in place — same surface identity, no new crumb).
- `crumb: CrumbSegment[]` — derived from `stack` (label + the target it ascends to). Lenses are never segments.

The reducer laws are the acceptance's red-proofs: `push` grows history; `back` lands on the *prior surface*; a lens switch calls none of these. Pure functions → hermetic tests, no DOM.

## Breadcrumb + NavRail (`packages/ui/src/components/`)

- **`Breadcrumb`** renders `crumb` in the title bar (the kit's `crumb()` frame-18 form): `Home ⌂ · Projects › project › review › Draft`, each segment a button → `ascendTo`. The execution-mode pill + patchset chip stay in the title bar's right slot (unchanged).
- **`NavRail`** — the compact left rail: Back / Forward buttons (disabled at the ends), Home, Projects. Buttons call `back`/`forward`/`push({projects})`/`push({project})`.
- Both are pure presentational components driven by the store — no bridge calls, so they unit-test with fixtures.

## Wiring `app.tsx` off the booleans

`atFrontDoor`, `directEntry`, and `destinationView` are removed; the surface stack replaces them. The existing `screen` resolution (~app.tsx:1611) becomes a switch on `current.kind`. The transitions that set `setAtFrontDoor(false)` on open become `push(...)`; `backToProjects`/the Projects button become `push({projects})` (or `ascendTo(root)`); the draft/paper opens become `push({draft})`/`push({paper})`. **Back from a review** = `back()`, which lands on the `project` surface (its parent in the stack), fixing the front-door skip. The `directEntry` legacy door is removed from the drawn UI and offered only as a palette command. `view`/lens state stays exactly as-is (peers).

Keybindings: `⌘[` → `back()`, `⌘]` → `forward()`, wired where the existing global key handling lives (mirror the command-palette `⌘K` wiring).

## Palette (`packages/ui/src/command/`)

Add a **Navigate** command group to `buildCommands`: Go to project…, Open review…, Back, Forward, Go to Draft/Paper (when in a review), Open Settings, and recent locations on an empty query. **Remove the `claims` lens command** (a retired angle). The palette is an overlay — its commands call the store's navigation, they don't themselves become history.

## Rule Zero

Navigation is pure reachability. NOTHING here confirms, warns, blocks, or gates. Backing out of a mid-edit draft just navigates away and the draft state persists (state preservation, never an are-you-sure). No command denies a capability. The spine adds places you can go; it never adds a step you must clear.

## What stays untouched

The review's lens rendering, the diff, the dispositions, the collation draft, the paper, the delta-account panel, and the conversation margin all render as they do today — only *how you move between surfaces* changes. The unified conversation panel (frame 06) is a deferred follow-up.
