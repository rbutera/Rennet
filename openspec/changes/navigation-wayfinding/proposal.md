# navigation-wayfinding

**Issue:** #297 (v4.0 navigation model). **Owner:** Claude (Zone A / renderer). **Review:** dual (Opus + Codex).
**Wireframe:** v4.0 `18-navigation-model` (the authoritative spec) + the chrome on 05/06/06a/12/13/16. **Depends on:** nothing.

## Why

Rennet has rich screens but **no wayfinding**: navigation is a boolean precedence chain (`atFrontDoor`, `directEntry`, `view`, `destinationView` in `app.tsx`). You can't tell where you are, there's no back, and leaving a review dumps you at the front door instead of the project you came from. #297 mapped it and Rai resolved the model (frame `18-navigation-model`). This builds that model's **wayfinding spine**.

## What Changes

Per frame `18-navigation-model` — a **hybrid spine** with a strict destination grammar:

- **A location/history model.** Replace the ad-hoc booleans with an explicit **surface stack**: `projects` (front door) → `project` (project detail) → `review` → `draft` → `paper`. Navigating to a **surface** pushes it (recorded in history); switching a **lens** or opening an **overlay** does not.
- **Breadcrumb** (title-bar): the chain from root to the current surface (`Projects › orbital › feat/rate-limiting › Draft`). Each crumb ascends to that tier. Lenses never appear in the crumb.
- **Left nav rail**: compact controls — **Back / Forward** (also `⌘[` / `⌘]`), **Home**, **Projects**, and the current review-context stack.
- **Back from a review lands on Project detail** — the review's real home — not the front door (today's `setAtFrontDoor(true)` skips it).
- **The peer / child / overlay law.** Lenses (Files · Spec · Sequence · Decisions · Flagged · Noise) are **peers** — tabs on one bar; switching one never moves the crumb or records history. Draft · Paper · Re-review are **children** — they extend the crumb and are recorded. Conversation/Ask, the symbol inspector, the palette, and Settings-return are **overlays** — they touch neither crumb nor history and close back to where you were.
- **Command palette — a Navigate group** on every screen (Go to project…, Open review…, Back, Forward, Go to Draft/Paper, Open Settings) + recent locations on an empty query. The retired **`claims` lens command is dropped**.
- **Settings is orbital** — reachable from anywhere, returns to the origin surface. The legacy "Review directly" door (`directEntry`) becomes **palette-only** (its drawn affordance is removed).

## Acceptance

- The surface stack drives the app: opening a project → project detail; opening a review from it → review (crumb `Projects › project › review`); Draft/Paper extend the crumb. **Back** pops to the prior surface; **Forward** re-pushes. `⌘[`/`⌘]` do the same.
- **Back from a review lands on Project detail**, not the front door (red-proof: the transition test asserts the popped surface is `project`, not `projects`).
- Switching a **lens** does NOT change the crumb or push history (red-proof: after a lens switch, the history length and crumb are unchanged).
- The palette offers the **Navigate group** and NO `claims` lens command (red-proof: a `claims` command must be absent).
- **No gate introduced** (Rule Zero): every navigation is a plain move — no confirmation, no are-you-sure, no capability denial. Back out of a mid-edit draft just navigates away; the draft state persists (state preservation, not a prompt).
- Full gate green.

## Impact

- **`packages/ui/src`** only. A new **navigation model** (a `useNavHistory` hook or store over the surface stack), a **Breadcrumb** component, a **NavRail** component, keybinding wiring, `app.tsx` rewired off the booleans onto the model, and the `command/` palette gaining the Navigate group + dropping `claims`. Zone A.
- No protocol/core/adapters/desktop-main/persistence change. History + open-review state are in-session UI state (not persisted this change).
- Dual review (Opus + Codex): verify the peer/child/overlay law holds (a lens switch never records history; a surface always does), back-lands-on-project-detail, and that no navigation act introduces a gate.

## Deferred

- **The unified chat-style conversation panel** (frame 06's right-margin reshape: icon-per-ask-type + Messenger reply chips + expand-to-fullscreen). It is the review's *content*, not wayfinding — a separate follow-up change. This change keeps the existing conversation margin.
- **Persisting** history / recent-locations across app restarts (session-only here).
- **Predecessor patchset browsing** — the patchset trail stays list-only (resolved decision 4).
- Onboarding-frame (02/03) root-crumb escapes — the in-project journey is the priority.
