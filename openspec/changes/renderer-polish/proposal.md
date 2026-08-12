# renderer-polish

**Issues:** #223 (enhancement), #240 (polish). **Owner:** Navi (Zone A / renderer). **Review tier:** single Opus.
**Wireframes:** `11-symbol-inspector` for #223; none for #240. **Depends on:** a host-provided working-tree symbol lookup port for #223; nothing for #240.

## Why

Two small renderer seams make review context leak across the boundary the user is actually reading. The symbol inspector is correctly committed-by-default, but `reviewPinnedToHead()` (`apps/desktop/src/main/symbol-lookup-live.ts:44`) means a symbol that exists only in later working-tree edits cannot resolve. Separately, `CanvasWorkspace` owns one `hypothesisOpen` boolean (`packages/ui/src/components/workspace.tsx:335`) while `app.tsx` keeps that workspace mounted across reviews (`packages/ui/src/app.tsx:1767`), so review A's collapse choice silently becomes review B's.

## What Changes

- **#223 / `working-tree-symbol-inspection` — add a direct symbol-source choice.** Keep committed `base..head` lookup as the default. When the renderer is supplied a working-tree lookup port, show a compact `Committed` / `Working tree` selector in fixed workspace chrome. Switching source immediately re-runs the visible symbol through that port without moving the diff or changing peek-then-pin navigation.
- **#240 / `per-review-hypothesis-frame` — key collapse state by review.** Thread `reviewId` into `CanvasWorkspace` and store the hypothesis frame's expanded/collapsed value by that id. An unseen review starts expanded; returning to a review restores its own choice; regenerating a patchset under the same review keeps it.

## Acceptance

- A new review uses the committed symbol index by default; no working-tree lookup happens until the reviewer directly selects `Working tree`.
- With the working-tree port supplied, selecting `Working tree` re-resolves the current symbol and subsequent inspector navigation against the overlay, so a symbol present only in local edits appears. Switching back restores committed lookup immediately.
- The source control stays outside the floating/pinned card. Peek remains floating, pin remains a docked mini-browser, and source changes never reflow or navigate the diff.
- Collapsing the hypothesis frame on review A leaves a first visit to review B expanded; returning to A restores collapsed. A new patchset under A does not reset A's choice.
- Red-proof: removing source routing leaves the working-tree-only marker absent; replacing the keyed collapse map with the current boolean makes the A → B → A transition test fail.

## Impact

- **Renderer only:** `packages/ui/src/app.tsx`, `components/workspace.tsx`, `canvas/symbol.ts`, `styles.css`, and focused DOM tests.
- No protocol, core, adapters, desktop-main, package, dependency, or persistence change. The current committed lookup remains the live default.
- #223's renderer control is shown only when the host dependency supplies the second lookup port; this proposal does not fabricate working-tree answers from diff hunks.

## Deferred

- Generating/patching the ProjectSnapshot over the live working tree and transporting that lookup to the renderer. That is the declared #223 dependency because `reviewPinnedToHead` is owned by desktop main, outside this renderer-only change.
- Persisting either polish preference across app restarts; both are review-session UI state.
- Any adjacent inspector, hypothesis-content, snapshot-freshness, or navigation work.
- No consent step, approval ceremony, confirmation, capability denial, read-only posture, sandbox, or hardening task is part of this change.
