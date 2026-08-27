# C13 — Onboarding coach marks · tasks

Serial clusters. Each cluster is one session. Search before implementing
(BUILD-LOOP §5) — the spike is reference, `coach/` does not exist yet.

## Cluster 1 — Mark model + store (`coach/`)

- [x] Create `packages/app-ui/src/coach/marks.ts`: port the `MarkId` union
      (nine ids, `start-review` first), `Mark` interface, `MARKS` array (spike
      copy verbatim — the teaching voice per R55), and `MARK_BY_ID`.
- [x] Create `coach/store.ts`: port the one-at-a-time election (first unseen
      registered mark in system order), register/unregister, dismiss (learned by
      ✕ or by using the anchor), `skipEverything`, `replay`, and the chain-delay
      gap between marks on the same surface.
- [x] Persistence is injected, not `localStorage`: the store reads initial
      `{ seen, skipAll }` from a snapshot the provider feeds (Cluster 3 supplies
      it from `settings.get`) and calls an injected `persist({seen,skipAll})` on
      every change. **No `localStorage`, no `?tour=reset`, no module-level
      mutable state** (S8) — the chain timer lives in the store, not at module
      scope.
- [ ] Unit-test the election + chain + skip/replay transitions (pure store).

## Cluster 2 — Typed anchor registry + Coachmark component

- [ ] `coach/registry.ts` (or a store slice): a `MarkId`-keyed registry.
      `useCoachAnchor(id)` returns a ref callback that registers/unregisters the
      element; the registry is closed over the `MarkId` union — an unknown id is
      a compile error, a **duplicate registration for one id is detected** (the
      S8 regression guard: dev-time throw/warn, never silently first-wins).
- [ ] Port `coach/coachmark.tsx` from the spike: spotlight portal + anchored
      Popover card + dismiss-on-pointerdown-inside-anchor + Skip-all button.
      Strip every `@/lib/*` import; anchor comes from the registry, **not**
      `document.querySelector`. Use `packages/ui` kit primitives (Popover);
      replace any `text-[Npx]` with theme tokens (fence rules 2, 5, 6).
- [ ] Any `switch` over `MarkId`/side gets an `assertNever` default (fence 9);
      no `store?.`/`?? []` phantom-null guards (fence 4).

## Cluster 3 — Persistence seam (protocol + core + data)

- [ ] `packages/protocol` `clientSettingsSchema`: add optional `coachmarks:
      { seen: MarkId[]; skipAll: boolean }` (additive, like `keybindings`).
- [ ] `settingsViewSchema` (`settings.get` output): surface `coachmarks`
      additively so the client reads initial state in one call.
- [ ] Add `settings.setCoachmarks` command (input `{ seen, skipAll }`, output the
      stored slice) mirroring `settings.setAppearance`/`setKeybinding`: a plain
      write, first click, no ceremony, refuses a malformed config (Rule 75).
- [ ] Core handler: write the slice through B10's file-config-store
      client-settings path (do NOT rebuild the engine). Register the command.
- [ ] `coach/` data wiring: read initial `{seen,skipAll}` from
      `useCommand("settings.get")`, persist via `useMutation("settings.setCoachmarks")`
      invalidating `settings.get`. No `bridge.invoke` in components (data seam).

## Cluster 4 — Anchor the marks + mount + replay

- [ ] Mount one active `Coachmark` at the shell (reads the elected mark).
- [ ] Attach `useCoachAnchor` at each of the nine anchors on landed surfaces —
      chrome only, never board content (marks anchor to buttons/switchers/
      containers): `start-review` (indexing ready CTA), `new-chat` + `smart-list`
      (new-chat-view), `lenses` (board lens switcher), `highlight` (board prose
      region), `fab` (handoff FAB), `verdict` (handoff-action / post-review-lane),
      `draft` (draft block), `dispatch` (rounds-lanes).
- [ ] Any anchor whose surface has not landed (blocked-by C3/C8/C12) passes
      `enabled={false}` — the mark simply never elects; no orphan, no crash.
- [ ] Wire sidebar "Replay Tour" (`shell/sidebar/sidebar.tsx:214`) to `replay()`.

## Cluster 5 — Packet verification

- [ ] `pnpm check` green (format, architecture, licenses, lint, typecheck, test,
      build).
- [ ] E2E on the real app — fresh profile shows the chain **in system order**,
      one mark at a time, chained per surface.
- [ ] Skip-all **persists across restart**: skip, reload, `settings.get` returns
      `skipAll:true`, no mark fires. Prove the `settings.setCoachmarks` round-trip.
- [ ] Replay from Help (sidebar Replay Tour) re-arms — every mark eligible again.
- [ ] **Every anchor resolves**: a test over all nine `MarkId`s asserts each
      elects a live registered element (no orphan).
- [ ] **Positive control (S8 regression)**: a deliberately duplicated anchor for
      one `MarkId` is caught by the registry guard — the test asserts it fails.
      A green run therefore proves the check can fail.
- [ ] Docs updated in the same change: using-side onboarding page (contextual,
      one-at-a-time, skip-all, replay from Help) + client-settings field list
      gains `coachmarks`.
- [ ] Output `<promise>C13-COMPLETE</promise>` and flip C13 in `BUILD-STATUS.json`.
