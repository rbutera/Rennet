# Tasks — wayfinding-polish (#297)

Gate: `NX_DAEMON=false pnpm check` (green = exit 0 AND `Successfully ran target`). Red-proof each behaviour first. Only `packages/ui/src`. NO protocol/schema change — persistence is renderer `localStorage`; labels come from already-loaded data. Reuse the existing surface-stack model in `nav/history.ts`; keep pure logic in that module so it is DOM-free unit-testable. No permission step / no gate anywhere (Rule Zero).

## 1. Study the substrate
- [ ] 1.1 Read `nav/history.ts` (`Surface`, `navHistoryReducer`, `crumb`, actions), `components/breadcrumb.tsx`, `command/commands.ts` (the Navigate group) + `components/command-palette.tsx`, and `app.tsx` around the reducer (`~319`), the ⌘[/⌘] + bootstrap effects (`~497-536`), `navigationSurface` (`~1750`), the first-run loading return (`~1789`), and the front-door/project renders (`~1878-1912`). Confirm the `Project`/review type field that holds a human name.

## 2. Slice A — human-readable crumb labels
- [ ] 2.1 Give `crumb(stack, labels?)` an optional resolver `{ project(id), review(id) }`; for `project`/`review` use the resolved name and FALL BACK TO THE ID when undefined (`projects`/`draft`/`paper` keep their fixed words). No fabricated labels. Keep `labels` optional so existing callers compile.
- [ ] 2.2 In `app.tsx`, build the resolver from data already held (the open `projectDetail` name, the open `review` title/name; other ids resolve by the same map, id-fallback) and pass it to `deriveCrumb`.
- [ ] 2.3 Test: `crumb` resolves names and falls back to id for unknown ids; fixed-word surfaces unchanged.

## 3. Slice B — recents log + palette Recent group
- [ ] 3.1 In `nav/history.ts`: `surfaceIdentity(surface)`, `recordRecent(recents, surface)` (dedupe by identity, unshift most-recent-first, cap ~8). Pure, no DOM.
- [ ] 3.2 In `app.tsx`, maintain a recents list, recording on every landing (push / forward / ascend / bootstrap restore).
- [ ] 3.3 Add a palette **Recent** group (`command/commands.ts` + `command-palette.tsx`) listing each recent by its resolved label (Slice A), excluding the current surface; each action `navigate(push(surface))`.
- [ ] 3.4 Tests: `recordRecent` dedupes + caps + orders; the palette Recent group renders resolved labels, excludes the current surface, and its action navigates.

## 4. Slice C — persistence (localStorage) with an honest floor
- [ ] 4.1 In `nav/history.ts`: pure `serialize(state)` / `parse(raw)` for `{ version, stack, future, recents }`, and `hydrate(stored, bootstrapReviewId?)` → `NavHistoryState` (+ recents). `hydrate` MUST: yield the clean default on absent/malformed/version-mismatched input (never throw); NOT duplicate the bootstrap-restored review if the stored tip already is it; and FLOOR a stored tip whose review is stale/absent to its nearest resolvable ancestor (`project`, else `projects` root), clearing `future` — never land on a dead review/draft/paper surface.
- [ ] 4.2 In `app.tsx`: persist `{stack, future, recents}` to `localStorage` (one versioned key) on change, guarded so absent/throwing storage silently degrades to session-only (no crash). On boot, hydrate the reducer + recents from storage and reconcile with `app.bootstrap` per 4.1 (fix the current unconditional review push so it does not stack a duplicate).
- [ ] 4.3 Tests: valid blob restores stack+future+recents; malformed/absent/version-mismatch → clean default; bootstrap review not duplicated; stale stored tip floors to nearest ancestor; `serialize`→`parse` round-trips.

## 5. Slice D — onboarding root crumb
- [ ] 5.1 The first-run/loading frame (`app.tsx ~1789`, the `review === undefined` return) must carry the same root breadcrumb the front door shows. Reuse `Breadcrumb` with a root-only ("Projects") crumb; do not fabricate deeper crumbs before the stack exists.
- [ ] 5.2 Test: the first-run/loading frame renders the root breadcrumb.

## 6. Prove it
- [ ] 6.1 Each slice red-proofed (revert the branch → its test reddens). Keep every existing nav/breadcrumb/palette test green (or port).
- [ ] 6.2 Full gate green; only `packages/ui/src` changed; state the tip sha + gate total.
