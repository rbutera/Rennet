# Tasks — c10-settings-help (C10, #489)

Read `openspec/BUILD-LOOP.md`, `context.md`, then `proposal.md` (its Reconciliations are part of the spec) first. One cluster per session; the repo compiles and `sh -c 'pnpm nx affected -t lint,typecheck,test'` is green after every cluster. Sources of record: INVENTORY §8 (92 `[ws:C10]` claims, `spikes/board-prototype/INVENTORY.md` lines 573–687), the #476 settings decision, client asset §5 settings row (#489 comment 5431046569), autopsy S2/S5 fence (#489 comment 5431046732), spike reference read-only (`spikes/board-prototype/components/settings-view.tsx`, `lib/settings-data.ts`, `lib/os-glyphs.ts`, `lib/theme-packs.ts`, `lib/code-theme.ts`).

**Session-start bearing:** confirm the surface is still unbuilt on `main` before starting — `routes/app.tsx` should still mount the interim inline `SettingsScreen` (`/settings/:page`) and `<Interim screen="archived">`; `components/settings-screen.tsx` (1,137 lines, old Global/Repo/Keyboard/Pairing model) should still exist. Confirm the `settings.*` command set in `packages/protocol/src/commands/index.ts` still stops at `settings.get/guidance/setAppearance/setKeybinding/setRepoVisibility/setRepoLocus/pinRepoValue/resetRepoValue` (reconciliation 5 — the richer projections stub through the seam) and that `MemoryBridge` still has no `settings.*` handler. If B10 landed the engine, the seam binds live instead of stubbing (reconciliation 5 names the seam either way).

**The one structural rule, above every page (autopsy S2, the named sin):** a screen is a **directory**, a settings page is a **route** driven by the `/settings/:page` param and `?project`, **never a shadowed `useState`**. The old 1,137-line one-file `settings-screen.tsx` and the spike's 1,687-line `settings-view.tsx` are the exact pattern this change exists to end. Every page module below is its own file under `settings/`, reached by the route param — task 1.2 enforces it and task 9.2 proves it (cold deep-link).

---

## 1. Foundation — the route shell, the directory, the two shared atoms

- [ ] 1.1 Create `packages/app-ui/src/settings/` and port the takeover shell into `settings/settings-screen.tsx`: full-view takeover rendering over the whole shell **including the chat column**, with chat + board kept mounted underneath (cooperate with `shell/` — do not unmount them). Header carries the back-arrow and an `esc` key hint; Escape or back leaves to the prior surface. Left nav lists the four pages (Environments, Appearance, Keyboard Shortcuts, Projects) with icons. *(claims 575, 576, 577)*
- [ ] 1.2 **Structural rule task:** the active page is read from the **route param** (`/settings/:page`) and the Projects scope from **`?project`** — no `useState` page switch anywhere in `settings/`. Each page is its own module (`settings/environments/`, `settings/appearance.tsx`, `settings/shortcuts.tsx`, `settings/projects/`). Wire `routes/app.tsx` to mount `settings/settings-screen.tsx` at `ROUTES.settings`, deleting the interim inline wrapper. *(reconciliations 3, 4; autopsy S2)*
- [ ] 1.3 `settings/provenance-chip.tsx`: the shared chip naming the resolved rung (builtin/detected/global/repo), reused by every layered value. `settings/backing-file.tsx`: the shared monospace caption naming a section's backing file (`client-settings.json`, `daemon-settings.json`, or `.rennet/`). *(claims 578, 579)*
- [ ] 1.4 DOM test over `MemoryBridge`: the shell mounts, the `esc` hint shows, Escape leaves to the prior surface, and a mounted chat/board fixture survives the visit (assert not remounted). Cluster gate green. Commit.

## 2. The settings command seam (the single resolution point; `settings-data.ts` dies)

- [ ] 2.1 `packages/app-ui/src/settings/data/` — the one seam every value reads/writes through (`useCommand`/`useMutation` over `settings.*`). Bind the existing commands live (`settings.get`, `setAppearance`, `setKeybinding`, `setRepoVisibility`, `setRepoLocus`, `pinRepoValue`, `resetRepoValue`, `guidance`). Define the B10-absent projections (environments/hosts, source-control detection, agents detection, model mappings, project glyphs, worktree pattern, issue tracker) as typed reads through this seam, carrying the `{ value, layer }` provenance shape as the contract. *(reconciliations 5, 8; Objective "rewrite every value onto settings.* commands")*
- [ ] 2.2 Add `settings.*` handlers to `packages/app-ui/src/test/memory-bridge.ts` (and/or per-test fixtures) so every page is testable now — provenance chips render and edits persist **to the bridge**, never a hollow pass. The absent-projection reads surface an honest empty/deferred state, not a thrown render error (mirroring C4's citations seam).
- [ ] 2.3 Delete `spikes/`-shaped fixture dependence: confirm nothing under `settings/` imports the spike `lib/settings-data.ts` (it has no successor — reconciliation 8). Port only `lib/os-glyphs.ts`, `lib/theme-packs.ts`, `lib/code-theme.ts`, `project-icon.tsx` into `app-ui` (real libs, not fixtures) as their consuming pages need them. Cluster gate green. Commit.

## 3. Environments page — host cards + daemon

- [ ] 3.1 `settings/environments/environments-page.tsx`: page titled "Environments"; "This Machine" as the local card (never removable); remote hosts as cards. Section header carries its own **Add Environment** button (second entry point beside the sidebar's). *(claims 583, 584)*
- [ ] 3.2 `settings/environments/host-card.tsx`: one card per environment; header shows the OS glyph (macOS/Linux/Windows; WSL = Windows mark + mono `WSL` chip) via ported `os-glyphs.ts`, the name, and either the mono address or a "Local" chip. *(claims 585, 586)*
- [ ] 3.3 Inline rename: Enter commits, Escape cancels, an emptied name keeps the old one; a rename flows through to the sidebar host-group header (one hosts state — write through the seam/store, not a local copy). *(claims 587, 588)*
- [ ] 3.4 Remove offered on remote hosts only (never the local machine); Remove opens the one sanctioned destructive confirmation naming the project + session counts it takes and stating the machine itself is untouched. *(claims 589, 590)*
- [ ] 3.5 Daemon meta line: version when reachable; "Not connected — daemon unreachable, version unknown" when nothing can be asked; "Not connected — last seen running Rennet daemon v<n>" for a previously-seen unreachable host (never invents current state). Reconnect appears only when unreachable; Update Daemon appears only when that host has an update (button-only, reconciliation 6). *(claims 591, 592, 593, 594)*
- [ ] 3.6 DOM tests over `MemoryBridge`: local card has no Remove; remote rename flows to the sidebar header fixture; the three daemon states render from the projection; Remove confirmation names counts. Cluster gate green. Commit.

## 4. Environments — Source Control detection

- [ ] 4.1 `settings/environments/source-control.tsx`: each host card's Source Control section lists that host's VCS/forge tooling (no dedicated Providers page — detection lives on the host). *(claims 598, 599)*
- [ ] 4.2 Each row shares one shape: official mark, tool label, tool's own version line, status chip, honest one-line helper, enable toggle. Status is one of Available / Not Authenticated / Not Installed / Unreachable. A row with no detected version shows no version (no guess). The helper names the exact fix command with backticked commands rendered as code. *(claims 600, 601, 602, 603)*
- [ ] 4.3 Tooling set: GitHub rides `gh`, GitLab rides `glab`, Bitbucket takes an API token, Azure DevOps does not appear. **No OAuth-shaped connect ceremony anywhere** in these rows (Rule Zero, #483). A disconnected host shows one honest line ("Connect <host> to detect its tooling.") instead of fake rows. The GitHub mark scheme-swaps black/white; the others read on both schemes. *(claims 604, 605, 606, 607)*
- [ ] 4.4 DOM tests: the four statuses render their chip + helper; undetected version renders nothing; disconnected host shows the one honest line, not rows; Azure DevOps never appears. Cluster gate green. Commit.

## 5. Environments — Agents & review model mappings

- [ ] 5.1 `settings/environments/agents.tsx`: an Agents section on each card listing detected coding harnesses in the same row shape as source-control (mark, label, version, status chip, helper, enable toggle); disabling an agent rules it out of reviews on that host without uninstalling anything. *(claims 611, 612, 613)*
- [ ] 5.2 `settings/environments/model-mappings.tsx`: a Review section exposes Model Mappings, absent entirely when no agents were detected; Edit Mappings is inert until at least one agent is enabled and says so in its hint. *(claims 614, 615)*
- [ ] 5.3 The mappings dialog: a table of review roles × two columns (Dual Harness / Single Harness). The column headers **are** the review-mode switch — selected header carries the tick, the other column dims and locks; there is no separate Review Mode row. Dual is unavailable until both agents are enabled (hovering anywhere in it says which agent unlocks it); losing the second agent settles Single regardless of prior click; Single Harness auto-detects its provider (preferring Claude) and names it in the subheading. *(claims 616, 617, 618, 619, 620, 621)*
- [ ] 5.4 Each role names the models it may take + its effort level; an editable cell opens a searchable model picker; a role that does not run in a mode renders an em dash (not a fake assignment); a role changed from default gains a "Reset to default" control. Roles cover Orchestrator, Context-Map Workers, Confirmation Worker, Lens Drafters, Flagged Second Seat, Adjudication, Post-Process Pass, Utility (#460/#464). *(claims 622, 623, 624, 625)*
- [ ] 5.5 DOM tests over `MemoryBridge`: Review section absent with no agents; Edit Mappings inert until an agent enabled; header-switch tick + dim/lock; Dual locked until both agents, hover names the missing one; losing the second agent forces Single; em dash for a non-running role; Reset appears on a changed role. Cluster gate green. Commit.

## 6. Appearance page

- [ ] 6.1 `settings/appearance.tsx`: Scheme as a light/dark/system segmented control (salvage the live `settings.setAppearance` binding from the old file); "system" resolves through `matchMedia` and re-applies when the OS scheme changes (port `appearance-sync.tsx`). *(claims 629, 630)*
- [ ] 6.2 Theme pack row: live-applying pill options (port `lib/theme-packs.ts`). Code theme row: a **separate**, independent row of live-applying pills (port `lib/code-theme.ts`); "Follow scheme" resolves the code theme to the current scheme's light/dark variant. Changing the code theme re-highlights every code surface including the diff (`review/code-block.tsx`, `components/code-view.tsx`). *(claims 631, 632, 633, 634)*
- [ ] 6.3 The resolved scheme stamps `data-scheme` + the `dark` class on the document root; the theme pack stamps `data-rn-theme` (default pack clears the attribute). *(claim 635)*
- [ ] 6.4 DOM tests: scheme change stamps the root and persists to the bridge; system re-applies on a simulated `matchMedia` change; theme-pack and code-theme pills apply live and independently; code-theme change re-highlights a mounted code surface. Cluster gate green. Commit.

## 7. Keyboard Shortcuts page

- [ ] 7.1 `settings/shortcuts.tsx`: lists every named command with its binding, filterable by name; salvage the live `settings.setKeybinding` binding + `COMMAND_CATALOGUE` from the old file. Registry names Search ⌘P, Command Menu ⌘K, New Chat ⌘N, Toggle Sidebar ⌘B, Toggle Chat ⌘J, Settings ⌘, (R7). *(claims 639, 643)*
- [ ] 7.2 Escape in the filter clears the filter **before** it can close settings; each row exposes a Change control on hover (the remap *mechanics* are C11 — this page shows + routes the control, no recorder); an empty filter result says which query matched nothing. *(claims 640, 641, 642)*
- [ ] 7.3 Verify this page is the destination of the C3 "Help → Keyboard Shortcuts" popover action (reconciliation 1) — the nav target resolves to `/settings/shortcuts`; no Help popover is built here. DOM tests: filter narrows, Escape-clears-before-close, empty-result names the query, registry renders. Cluster gate green. Commit.

## 8. Projects page

- [ ] 8.1 `settings/projects/projects-page.tsx`: scopes to one project through an inline picker grouped by environment, following the active project by default, resolved from the **`?project`** param (not a `useState`). *(claims 647, 648)*
- [ ] 8.2 `settings/projects/identity.tsx`: display name with the `org/repo` default as placeholder; a renamed project gains a Reset restoring the `org/repo` default; clearing the name on blur restores the default (never empty); a project-glyph radio grid applying live to the sidebar (port `project-icon.tsx`). *(claims 649, 650, 651, 652)*
- [ ] 8.3 `settings/projects/worktrees.tsx`: exposes the location directory and the naming pattern; the pattern offers insertable tokens `{project}`/`{branch}`/`{pr}`/`{user}`/`{date}`; a live preview shows the resolved worktree path with branch-name slashes flattened to dashes. *(claims 653, 654, 655)*
- [ ] 8.4 `settings/projects/repository.tsx`: Review Context (local vs git-visible) with its provenance chip (salvage `settings.setRepoVisibility`); promotion state shown; **"Runs on" as a displayed detected fact with provenance chip + host glyph and NO editable override on the surface** (reconciliation 7, R22 amendment). *(claims 656, 657, 658)*
- [ ] 8.5 `settings/projects/issue-tracker.tsx`: an Issue Tracker section naming the tracker whose referenced tickets are fetched for review agents; choice is github/jira/linear/none each with a provenance chip; a scout pick lands "detected", a user pick lands on the "global" rung; a project whose scout found no tracker reads "none" (no guess). *(claims 659, 660, 661, 667)*
- [ ] 8.6 Tracker fields: GitHub states it rides the `gh` CLI on that host and exposes no further fields; JIRA/Linear expose a project key, a base URL, and the **name** of the env var holding the token (the token itself is never entered or stored — only the env-var name, read on the host); switching to a REST tracker seeds its token env var with the provider's conventional name; switching away drops its fields; Escape inside a tracker field blurs, never closes settings. *(claims 662, 663, 664, 665, 666, 668)*
- [ ] 8.7 `settings/projects/guidance.tsx`: lists the repo rules review agents read, each with a severity chip (salvage `settings.guidance`); a rule edits inline (severity segmented control, Save, Cancel, Delete); Enter saves and Escape closes only the editor (never the settings view); an Add Rule control sits at the bottom; saving with empty text is refused. *(claims 669, 670, 671, 672, 673)*
- [ ] 8.8 DOM tests over `MemoryBridge`: picker follows `?project`; identity reset/clear-on-blur/glyph-live; worktree token insert + slash-flatten preview; "Runs on" has no edit control; tracker provenance rungs (detected vs global), REST fields show env-var name only, seed-on-switch, drop-on-switch-away, Escape-blurs; guidance inline edit Enter-saves/Escape-closes-editor-only/empty-refused. Cluster gate green. Commit.

## 9. Archived surface (its own route, not a settings page)

- [ ] 9.1 `packages/app-ui/src/archived/archived-screen.tsx`: its own main-surface `/archived` location, leaving by back-arrow or Escape with an `esc` hint; header shows the archived count when there is one; with nothing archived, the surface says so and tells you how sessions get there. Wire `routes/app.tsx` to mount it at `ROUTES.archived`, replacing `<Interim screen="archived">`. *(claims 677, 678, 679, 686)*
- [ ] 9.2 Search + sort: searchable by session title or project name; Escape in the search field clears the search before it can close the view; an empty search result says which query matched nothing; sort by recent/project/title via a radio group; recency sorting parses the fuzzy sidebar times ("now"/"1h"/"2d"/"3w") into a real order. *(claims 680, 681, 682, 683, 687)*
- [ ] 9.3 Rows: each archived row carries its target icon, title, reviewed tick, time, and a project chip with the project's glyph; each row exposes an Unarchive control on hover/focus; selecting a row opens that session. *(claims 684, 685; and 686 = row-opens-session)*
- [ ] 9.4 DOM tests over `MemoryBridge`: empty state copy; count in header; search + Escape-clears-before-close + empty-result-names-query; three sort orders incl. fuzzy-time parse; row anatomy; Unarchive on hover; row-click routes to the session. Cluster gate green. Commit.

## 10. Gated: live wiring (deferred until B10) — clearly labeled, never a hollow pass elsewhere

> Everything above persists **to `MemoryBridge`** and is fully testable now. This cluster is the ONLY place real-file persistence + real detection live, and it stays isolated so nothing else blocks on B10.

- [ ] 10.1 When B10 serves the settings engine + file split, bind `settings/data/` reads to the live projections for environments/hosts, source-control detection, agents detection, model mappings, glyphs, worktree pattern, and issue tracker — the seam is the only file that changes (reconciliation 5). Until then, this task stays unchecked with this note; the pages already work over the bridge.
- [ ] 10.2 Real persistence to `client-settings.json` (scheme, keybindings, appearance, project glyphs, worktree pattern, tracker env-var names) and `daemon-settings.json` (daemon listener) — deferred to B10's file split. Real host/tool/harness **detection** (daemon version/reachability, `gh`/`glab` presence, harness discovery) — deferred to B10/adapters. Leave unchecked with the note; do not stub a fake filesystem in `app-ui`.

## 11. Barrels, dead-code sweep, docs

- [ ] 11.1 Delete `packages/app-ui/src/components/settings-screen.tsx` and its `.dom.test.tsx` (reconciliation 3 — its live bindings are salvaged into the page modules; confirm no live binding was lost). `settings/index.ts` + `archived/index.ts` barrel the public surface; `app-ui/src/index.ts` retargets the `SettingsScreen` export to the new module and adds the Archived screen.
- [ ] 11.2 Fence: confirm nothing in `packages/app-ui/src/settings/` or `archived/` imports from `spikes/` (`grep -rn "from \"[.@/].*spikes" packages/app-ui/src/settings packages/app-ui/src/archived` returns empty — record the grep). No `settings-data.ts` successor exists (reconciliation 8).
- [ ] 11.3 **Docs (definition of done):** rewrite `docs/developing/guides/settings-and-setup.md` — it describes the OLD "four tabs: Global, Repo, Keyboard, and Pairing" model (line 64) and a "Pairing tab"; the surface is now four **pages** (Environments, Appearance, Keyboard Shortcuts, Projects) with Environments as host cards carrying Source Control + Agents + daemon sections, and Projects carrying Issue Tracker + Runs-on + Guidance. Update the Global-settings/Repository/Provenance/Device-pairing sections to match (pairing now lives per-host on the Environments card). Grep the rest of `docs/` for other pages naming the old tab model and fix or record as no-op.
- [ ] 11.4 Full gate `sh -c 'pnpm check'` green (format, architecture, licenses — confirm zero new packages, not assume — lint, typecheck, test, build). Commit.

## 12. Verification (packet)

- [ ] 12.1 `pnpm check` green.
- [ ] 12.2 **Cold deep-link E2E:** `/settings/environments`, `/settings/appearance`, `/settings/shortcuts`, `/settings/projects?project=<id>` each render their own page cold (the route param drives the page, proving the structural rule). **Positive control shown once:** make the screen ignore the param and default a page — the non-target deep-links fail; restore param-driven routing, all green; record it.
- [ ] 12.3 **Persistence E2E:** change the scheme + a keybinding, assert both persist through the seam (to `MemoryBridge` now) and survive a remount of the SAME bridge; provenance chips show detected vs global on a layered value.
- [ ] 12.4 **Takeover E2E:** Escape returns to the prior surface with chat + board still mounted (assert not remounted through the visit).
- [ ] 12.5 INVENTORY §8 sweep: the 92 `[ws:C10]` claims spot-checked against the ported pages (mapping table below). Conscious divergences recorded: Help (no §8 claim) is C3's popover, not built here (reconciliation 1); Archived is a sibling route, not a settings page (reconciliation 2); live persistence/detection deferred to cluster 10 (reconciliation 5). Sigil `<promise>C10-COMPLETE</promise>` emitted in the completion report.
- [ ] 12.6 `BUILD-STATUS.json` left for the track manager to land (implementers do not touch it).

---

## Objective-clause → task map (the packet's Objective, clause by clause)

| Objective clause | Task(s) |
|---|---|
| Settings + Help per INVENTORY §8 (92 claims) | all of 3–9 (Help = reconciliation 1 / task 7.3) |
| full-view takeover (chat included, back/Esc out) | 1.1, 1.4, 12.4 |
| Environments (source-control detection + daemon per host) | 3.*, 4.* |
| Agents/review roles with Model Council mappings | 5.* |
| Appearance | 6.* |
| Keyboard shortcuts | 7.* |
| Projects incl. Issue Tracker section | 8.* |
| Archived | 9.* |
| Help = Documentation / Keyboard shortcuts / Report an issue | 7.3 (destination only; popover is C3) |
| Update button-only | 3.5 (reconciliation 6) |
| Port page layout, rewrite every value onto `settings.*` + detection projections | 2.1, 2.2 |
| `settings-data.ts` fixture dies; `{value, layer}` provenance is a keep | 2.1, 2.3, 1.3 |
| Settings page = route, never shadowed `useState` (autopsy S2) | 1.2, 12.2 |
| "Runs on" displayed detected fact, no override | 8.4 (reconciliation 7) |

## Claim → task map (92 `[ws:C10]` claims, grouped by page)

| Page / section (claim lines) | Count | Task(s) |
|---|---|---|
| General (575–579) | 5 | 1.1 (575–577), 1.3 (578–579) |
| Environments page (583–594) | 12 | 3.1 (583–584), 3.2 (585–586), 3.3 (587–588), 3.4 (589–590), 3.5 (591–594) |
| Source control detection (598–607) | 10 | 4.1 (598–599), 4.2 (600–603), 4.3 (604–607) |
| Agents & review roles (611–625) | 15 | 5.1 (611–613), 5.2 (614–615), 5.3 (616–621), 5.4 (622–625) |
| Appearance page (629–635) | 7 | 6.1 (629–630), 6.2 (631–634), 6.3 (635) |
| Keyboard shortcuts page (639–643) | 5 | 7.1 (639, 643), 7.2 (640–642) |
| Projects page (647–673) | 27 | 8.1 (647–648), 8.2 (649–652), 8.3 (653–655), 8.4 (656–658), 8.5 (659–661, 667), 8.6 (662–666, 668), 8.7 (669–673) |
| Archived surface (677–687) | 11 | 9.1 (677–679, 686), 9.2 (680–683, 687), 9.3 (684–685) |
| **Total** | **92** | |
