# Board-prototype feature inventory

Swept at 45a98307.

**Purpose.** This checklist is the exhaustive record of what the board prototype
actually does. It is used twice:

1. **As input to the implementation plan ([#489](https://github.com/rbutera/rennet/issues/489))** — every line below is a
   behavior the prototype proved. The plan must account for each one, whether by
   scheduling it, deferring it explicitly, or ruling it out. Nothing gets dropped
   by being forgotten.
2. **As the verification instrument after implementation** — a reviewer opens the
   real client and walks every line, ticking the box only when the real product
   does the stated thing. An unticked line is either unbuilt work or a
   deliberate, recorded decision not to build it.

Each line states a claim someone can check by looking at a running client, and
names the prototype code that establishes it. Paths are relative to
`spikes/board-prototype/`. Ruling references (`R1`–`R58`) point at the canonical
comment on [#458](https://github.com/rbutera/Rennet/issues/458#issuecomment-5387762167); scenario references point at `SCENARIOS.md`.

Two sections at the end are not requirements-as-built: **Prototype-only / not
for import** lists demo scaffolding the real client must not inherit, and
**Open build items** lists what is unbuilt or built wrong, tracked on [#492](https://github.com/rbutera/rennet/issues/492).

The sweep originally raised a third list — surfaces the prototype carried that
no ruling covered. Rai ruled on all of it: nearly every line was asked-for
behavior the ruling log had simply never caught up with, and it was promoted to
rulings **R59–R68** ([the drift-blessing batch](https://github.com/rbutera/Rennet/issues/458#issuecomment-5430439010)). Those R-numbers are annotated
onto the checklist lines they govern.

---

## 1. Shell & sidebar

### Frame

- [ ] The application frame is a fixed full-viewport three-region split: sidebar, chat column, main surface, with no page scroll on the frame itself — `components/shell.tsx` (R1, R10)
- [ ] The sidebar and the chat column live outside the routed content, so their state survives every navigation — `components/shell.tsx`
- [ ] The chat column is never unmounted; it is hidden by animating its wrapper width to zero and marking it `inert` — `components/shell.tsx` (R47 amendment)
- [ ] The chat column renders only when the active route resolves to a review session; on takeover routes (settings, new chat, archived, map, indexing) the surface is full width — `components/shell.tsx` (#476)
- [ ] The chat column keeps the last session's transcript identity while a takeover route is open, so returning does not reset the conversation — `components/shell.tsx`
- [ ] A draggable divider between the chat column and the main surface resizes the chat by pointer-capture drag — `components/resize-handle.tsx` (R35 amendment)
- [ ] The chat column has a 320px minimum and the main surface a 400px minimum; the chat's maximum is whatever the container leaves, with no arbitrary cap — `components/resize-handle.tsx`
- [ ] Double-clicking the divider resets the chat width to 420px — `components/resize-handle.tsx`
- [ ] The divider tints on hover and again while active, marking the grab zone — `components/resize-handle.tsx`
- [ ] Dragging the divider suppresses the width transition, which re-arms 200ms after the drag stops — `components/shell.tsx` (R47 amendment)
- [ ] One chat width is shared by the scenario shell and a freshly minted session — `lib/store.ts`, `components/session-view.tsx`
- [ ] While a drag is in progress, text selection and the cursor are locked to `col-resize` document-wide — `components/resize-handle.tsx`

### Sidebar structure

- [ ] The sidebar collapses between a 256px full panel and a 48px icon rail, animating width on one persistent element while the content swaps inside it — `components/app-sidebar.tsx` (R1, R47 amendment)
- [ ] The expanded sidebar header carries the real Rennet lockup as vector artwork, scheme-swapped between light and dark files, never rendered as a font — `components/app-sidebar.tsx`
- [ ] Both the expanded panel and the rail carry a collapse/expand control — `components/app-sidebar.tsx`
- [ ] The top action block is ordered Search → New Chat → Add Project → Add Environment — `components/app-sidebar.tsx` (R35 sidebar rework, R56 amendment)
- [ ] The Search row shows a `⌘P` key hint and opens the command menu — `components/app-sidebar.tsx` (R7, #477)
- [ ] New Chat opens a project-picker popover with a searchable project list and a "New Project" escape at the bottom — `components/app-sidebar.tsx` (R2)
- [ ] Add Project opens the Add Project dialog — `components/app-sidebar.tsx`
- [ ] Add Environment opens the pairing dialog — `components/app-sidebar.tsx` (R56 amendment)
- [ ] The collapsed rail carries Search above New Chat at the top, and Update, Help, Settings bottom-anchored in that order — `components/app-sidebar.tsx` (R15, R16)
- [ ] There is no "PROJECTS" section label; host group headers are the only section headers — `components/app-sidebar.tsx` (R35 sidebar rework)
- [ ] Host group headers show a monitor glyph for the local machine and a server glyph for remote environments — `components/app-sidebar.tsx` (R3)
- [ ] No IP address and no use of the word "daemon" appears anywhere in sidebar copy — `components/app-sidebar.tsx` (R3, R13)

### Projects in the sidebar

- [ ] Each project row carries a fold chevron, its per-project glyph, its display name, and a right-aligned count of non-archived sessions — `components/app-sidebar.tsx`
- [ ] A project still being processed replaces the session count with a spinner and the word "indexing" — `components/app-sidebar.tsx`
- [ ] Clicking a project row folds or unfolds its session list, animating through the shared collapse primitive — `components/app-sidebar.tsx` (R47)
- [ ] The project holding the active session is force-expanded, so navigation always lands on a visible highlighted row — `components/app-sidebar.tsx`
- [ ] A project's session list ends with a ghost "New Chat" row whose plus glyph rotates on hover — `components/app-sidebar.tsx`
- [ ] Right-clicking a project opens a context menu with View Context Map, Rename, Project Settings, and a destructive Remove project… — `components/app-sidebar.tsx`
- [ ] Renaming a project happens inline in the row; Enter commits, Escape cancels, and an emptied name falls back to the `org/repo` default — `components/app-sidebar.tsx` (R67)
- [ ] Remove project opens a confirmation naming the project, the number of sessions it will take with it (archived included), and stating the repository on disk is untouched — `components/app-sidebar.tsx` (R66)
- [ ] Remove-project and remove-environment are the only two destructive confirmations in the product — `components/app-sidebar.tsx`, `components/settings-view.tsx` (R66)
- [ ] Removing the project you are currently standing inside (its map, indexing, or one of its sessions) navigates away instead of stranding you on a dead route — `components/shell.tsx`

### Sessions in the sidebar

- [ ] Every session row leads with its review-target icon: branch glyph for your branch, pull-request for your PR, incoming pull-request for a teammate PR — `components/target-badge.tsx`, `components/app-sidebar.tsx` (R36 icon language)
- [ ] A session needing you renders its own target icon in the accent color rather than a badge or pill — `components/target-badge.tsx` (R36 icon language)
- [ ] A reviewed session shows a green tick beside its title, not a row beneath it — `components/app-sidebar.tsx` (R36 icon language)
- [ ] A pinned session shows a small pin glyph beside its title — `components/app-sidebar.tsx` (R67)
- [ ] Unread orchestrator activity shows as a verdigris dot beside the title, and the active session never shows it — `components/app-sidebar.tsx`, `lib/sidebar-data.ts` (R53)
- [ ] The active session is marked by row highlight alone; there is no gold active dot — `components/app-sidebar.tsx` (R53)
- [ ] Each session row shows a second, muted line with its relative time — `components/app-sidebar.tsx`
- [ ] Right-clicking a session opens Pin/Unpin, Rename, Archive — `components/app-sidebar.tsx` (R67)
- [ ] Renaming a session happens inline with the target icon still showing; Enter commits, Escape cancels, an emptied title keeps the old one, and the field auto-selects on focus — `components/app-sidebar.tsx` (R67)
- [ ] Pinned sessions surface in a dedicated Pinned section at the top of the tree, labelled with the project name and time — `components/app-sidebar.tsx` (R67)
- [ ] The Pinned section is absent entirely when nothing is pinned — `components/app-sidebar.tsx` (R67)
- [ ] Archiving the session you are currently viewing navigates away from it — `components/shell.tsx` (R67)
- [ ] An Archived entry appears at the sidebar's foot with a count exactly when at least one session is archived — `components/app-sidebar.tsx` (R67)

### Update, Help, Settings

- [ ] An Update control sits at the sidebar's foot (accent-filled, with a refresh glyph) and in the collapsed rail — `components/app-sidebar.tsx` (R15)
- [ ] The Update control opens a dialog titled "Update Available" listing what the release contains, with Later and Update Now — `components/app-sidebar.tsx` (R15)
- [ ] The Help control opens a popover with Documentation, Keyboard Shortcuts, Replay Tour, and Report an Issue — `components/app-sidebar.tsx` (R16, #476)
- [ ] Help → Keyboard Shortcuts navigates to the keybindings settings page — `components/app-sidebar.tsx` (#476)
- [ ] Help → Replay Tour clears the seen-state and re-arms the coach marks — `components/app-sidebar.tsx`, `lib/tour.ts` (R55)
- [ ] "Contact support" does not appear in the Help menu — `components/app-sidebar.tsx` (#476)
- [ ] The Settings control opens the settings takeover — `components/app-sidebar.tsx`

### Top bar (main surface header)

- [ ] The main-surface header is 56px tall — `components/main-surface.tsx` (R51)
- [ ] Header height is two deliberate tiers: session surfaces (the board bar, the chat-pane header, the run route) run 56px, and takeover surfaces (New Chat, Settings, Archived, Context Map, Indexing) run 40px — `components/main-surface.tsx`, `components/chat-column.tsx`, `components/settings-view.tsx` (R51, R60)
- [ ] The header is a three-column grid: left slot (back arrow, chat-expand, trail), centered lens switcher, right slot (History · Map · Diff) — `components/main-surface.tsx` (R49 amendment, R51)
- [ ] When the chat column is collapsed, the header's left slot shows an expand-chat control followed by the two-line session trail — `components/main-surface.tsx` (R52 amendment)
- [ ] The session trail is two lines: session title over target-icon + `project › target` words, with "· needs you" as words beside the accent icon, never a pill — `components/location-trail.tsx` (R51, R52 amendment)
- [ ] The same trail component renders in the chat-pane header and in the main top bar — `components/location-trail.tsx`, `components/chat-column.tsx` (R52 amendment)
- [ ] A back arrow appears in the header's left slot exactly when the current view is not a lens board — `components/main-surface.tsx`
- [ ] The back arrow returns to the view you came from, not the browser's history stack — `components/main-surface.tsx`
- [ ] There is no back button inside a session; the sidebar and the trail are the way around — `components/chat-column.tsx` (R52)

---

## 2. Navigation & state

### Routes

- [ ] `/` redirects to `/new-chat`, so a first run lands on the empty front door rather than auto-starting a session — `app/page.tsx` (R54, R55 amendment)
- [ ] `/s/<slug>` is a review session's board — `app/s/[slug]/page.tsx` (#480)
- [ ] `/s/<slug>/run` is the live round run, deep-linkable cold — `app/s/[slug]/run/page.tsx` (#480)
- [ ] `/new-chat?project=<id>` is the pre-session target picker — `app/new-chat/page.tsx`
- [ ] `/archived` is the archived-sessions surface — `app/archived/page.tsx`
- [ ] `/projects/<id>/indexing` is the post-add processing view — `app/projects/[id]/indexing/page.tsx`
- [ ] `/projects/<id>/map` is the standalone context map — `app/projects/[id]/map/page.tsx`
- [ ] `/settings/<page>?project=<id>` is the settings takeover, deep-linkable per page — `app/settings/[page]/page.tsx` (#476)
- [ ] `/api/source?path=&line=` returns a ±8-line slice of a real repo file — `app/api/source/route.ts` (R23)
- [ ] `/api/source?path=&start=&end=` returns an exact span, which beats the ±context default — `app/api/source/route.ts` (R26)
- [ ] `/api/source` refuses any path that escapes the repo root — `app/api/source/route.ts`
- [ ] `/api/source` returns an honest 404 for an unreadable file rather than empty content — `app/api/source/route.ts`

### URL contract

- [ ] `?view` selects the non-lens surface: `diff`, `map`, `handoff`, or `rounds`; the lens board is the omitted default — `components/main-surface.tsx` (#480)
- [ ] `?lens=<lensId>` selects the active lens board and is preserved across view toggles — `components/main-surface.tsx` (#480)
- [ ] An unknown `?view` or `?lens` value falls back to the board and the first available lens rather than erroring — `components/main-surface.tsx`
- [ ] `?view=rounds` is only honored when the session has at least one completed round — `components/main-surface.tsx` (R57)
- [ ] `?view=diff&file=<path>` lands the diff surface scrolled to that file's card, and the URL stays shareable — `components/diff-view.tsx`, `components/code-block.tsx` (R41)
- [ ] The `?file` jump fires once on mount, so scrolling elsewhere afterwards does not fight the param — `components/diff-view.tsx`
- [ ] `?project=<id>` on New Chat and Settings selects the project, resolving by id then by name — `app/new-chat/page.tsx`, `app/settings/[page]/page.tsx` (R52 amendment)
- [ ] An unresolvable `?project` value falls back to a real project instead of minting a session into a ghost — `app/new-chat/page.tsx` (R52 amendment)
- [ ] `?tour=reset` wipes the coach-mark seen-state at load — `lib/tour.ts` (R55 amendment)
- [ ] View toggles use replace, not push, so toggling Map/Diff/hand-off does not spam browser history — `components/main-surface.tsx`

### Slug resolution and session identity

- [ ] A slug that names a scenario resolves to that scenario's board and session — `lib/resolve-slug.ts`
- [ ] A slug that names a known session with no scenario behind it renders an honest empty placeholder naming the session — `app/s/[slug]/page.tsx`, `lib/resolve-slug.ts` (#480)
- [ ] A slug matching nothing renders the same honest placeholder rather than crashing — `app/s/[slug]/page.tsx`
- [ ] Selecting a session anywhere routes by its scenario id when one maps, else by its raw session id — `lib/resolve-slug.ts`
- [ ] Visiting a scenario route adds that scenario's sidebar session row idempotently — `app/s/[slug]/page.tsx`, `lib/store.ts` (R54)
- [ ] The sidebar's active-session highlight is derived from the route, never stored — `components/shell.tsx`, `lib/store.ts` (#480)
- [ ] The trail reads the live session record, so a rename shows immediately, falling back to the scenario fixture before the row exists — `components/shell.tsx`, `app/s/[slug]/page.tsx`
- [ ] The run route bounces to the board when the session's hand-off is not a rounds hand-off — `app/s/[slug]/run/page.tsx`
- [ ] The run route bounces to the board when its round has already completed, so revisiting it never phantom-restarts the round — `app/s/[slug]/run/page.tsx`
- [ ] The already-ran guard is captured at mount, so completing a round does not race its own forward navigation — `app/s/[slug]/run/page.tsx`

### Store

- [ ] One store owns all interaction state, split into ui, sidebar, run, and review slices — `lib/store.ts` (#480)
- [ ] Nothing in the store persists across a reload — `lib/store.ts` (#480)
- [ ] The ui slice holds sidebar open, chat open, chat width, add-project/add-remote/command-menu open flags, and appearance (scheme, resolved scheme, theme pack, code theme) — `lib/store.ts`
- [ ] The sidebar slice holds the host tree and every mutation on it: add/remove project, add/rename/remove host, rename project, set project icon, rename session, pin, archive, mint session, add scenario session, stamp session subtitle — `lib/store.ts`
- [ ] The run slice holds greeting-open, the viewed-delta section set, per-finding status, minted-session turns, boards-ready, and the minted session's descriptor — `lib/store.ts`
- [ ] The review slice holds per-line code comments keyed by path then line, quote threads, the focused thread, staged asks, and the retired ledger — `lib/store.ts`, `components/code-comments.tsx` (R24)
- [ ] A comment made on any code surface is the same object as one made in chat, because there is one comment store — `components/code-comments.tsx` (R24)
- [ ] Adding a project flips its sidebar row to indexing and settles it after processing completes — `lib/store.ts`
- [ ] Removing a host drops every project and session under it, and is never offered for the local machine — `lib/store.ts`, `components/settings-view.tsx` (R56 second amendment)

---

## 3. Board

### Composition and the document substrate

- [ ] A board renders as a document in reading order: a title, an optional intro, then sections of typed elements — `components/lens-board.tsx` (law 5, #457)
- [ ] The element vocabulary is a closed set: prose, spec-header, what-changes, capability-grid, task-progress, code, code-ref, callout, finding, annotation, thread, decision, requirement, noise-group — `lib/lens-data.ts` (#462)
- [ ] An unknown element kind renders nothing rather than breaking the board — `components/lens-board.tsx`
- [ ] The board's document column is 760px wide by default and 960px for structured-artifact boards that declare `wide` — `components/lens-board.tsx`, `lib/fixtures/design.ts`
- [ ] The board title is an `h1`, section titles are `h2` wrapping their fold button, kickers and card titles are `h3`, and in-card detail subheads are `h4` — `components/lens-board.tsx` (R38)
- [ ] The heading disclosure pattern is heading-wraps-button, never button-wraps-heading — `components/lens-board.tsx` (R38)
- [ ] The type ramp is board title 24, section title 18, kicker 12, card title 16, detail subhead 14 — `components/lens-board.tsx` (R40, R41)
- [ ] Vertical rhythm encodes hierarchy: 32px between sections, 24px between sibling items, 16px at a sub-block boundary, 8px within a block — `components/lens-board.tsx` (R43)
- [ ] The board intro routes through the same rich-text pipeline as every other prose field, so it carries citations, code chips and bullets — `components/lens-board.tsx` (R39 amendment)
- [ ] Every board declares its skipped hunks as data with a reason per hunk, and none of it renders on the surface — `lib/lens-data.ts`, `lib/fixtures/sequence.ts` (R19)

### Sections and the fold grammar

- [ ] Every section folds to a one-line gist and unfolds to its elements — `components/lens-board.tsx` (law 6, law 7)
- [ ] A folded section's gist renders as a full-width readable block below the heading, never truncated beside the title — `components/lens-board.tsx` (R42)
- [ ] Clicking either the section header or the gist expands the section — `components/lens-board.tsx` (R42)
- [ ] Section counts, when present, render on their own smaller line beneath the gist — `components/lens-board.tsx` (R44)
- [ ] Section counts name domain objects (findings, steps, decisions, requirements), never element kinds — `lib/fixtures/*.ts` (R44)
- [ ] Every board opens with all sections folded, except Flagged, which opens unfolded — `components/main-surface.tsx`, `components/lens-board.tsx` (R44)
- [ ] A fixture-level `startFolded` flag folds a section even on a board that would otherwise open it — `lib/lens-data.ts`, `lib/fixtures/flagged.ts` (R25)
- [ ] Both the folded and unfolded states stay mounted, so fold and unfold animate through the shared collapse primitive — `components/lens-board.tsx` (R47)
- [ ] The fold animation is a 200ms grid-rows transition that respects `prefers-reduced-motion` — `components/collapse.tsx` (R47)
- [ ] Closed content is marked `inert`, so a folded section is out of the tab order — `components/collapse.tsx` (R47)
- [ ] A section may carry a delta badge (added / modified) beside its title — `components/lens-board.tsx`
- [ ] A section may carry a right-aligned monospace provenance chip naming the artifact file it renders — `components/lens-board.tsx`, `lib/fixtures/design-gen0.ts`
- [ ] Sections carry stable ids and are anchor-scrollable, with scroll margin so the heading is not clipped — `components/lens-board.tsx`

### Board prose and reading affordances

- [ ] Backticked terms render as plain monospace, never as boxed pills — `components/rich-text.tsx` (R23, R25)
- [ ] A full `path:line` citation renders as a clickable chip labelled with the short `basename:line`, with the full path on hover — `components/rich-text.tsx` (R25)
- [ ] Clicking a citation chip fetches the real cited lines from the checkout and reveals them as a code block below the paragraph; clicking again folds it away — `components/rich-text.tsx`, `app/api/source/route.ts` (R23)
- [ ] `**bold**` renders as real bold; no literal asterisks ever appear on a surface — `components/rich-text.tsx` (R45)
- [ ] A paragraph whose every line starts with `- ` renders as a bulleted list, with each line keeping the full token pipeline — `components/rich-text.tsx` (R39)
- [ ] Requirement prose bolds the normative grammar (SHALL, SHALL NOT, MUST, WHEN, THEN, AND, IF, WHILE, WHERE) — `components/rich-text.tsx`
- [ ] The prose pipeline is a deliberate markdown subset — code chips, citations, bullets, spec keywords, bold — not a general parser — `components/rich-text.tsx` (R45)
- [ ] Prose never contains code bytes emitted by an agent; code arrives by citation and is hydrated from the source — `lib/lens-data.ts` (R26)
- [ ] A `code-ref` element hydrates its exact cited span from the file, so line numbering cannot drift from the citation — `components/rich-text.tsx`, `components/lens-board.tsx` (R26)
- [ ] A citation that cannot be read from the checkout says so in one honest line instead of failing silently — `components/rich-text.tsx`, `components/code-tabs.tsx`
- [ ] Scrollbars are themed rather than left as default chrome — `app/globals.css` (R25)

### Selection controls on board prose

- [ ] Highlighting any board prose shows a floating toolbar above the selection — `components/selection-toolbar.tsx` (R27)
- [ ] The board toolbar's verbs are Comment, Request Changes, and Explain — `components/selection-toolbar.tsx` (R27, R30)
- [ ] The toolbar flips below the selection when the selection sits too close to the viewport top for the tallest panel — `components/selection-toolbar.tsx`
- [ ] The toolbar is positioned inside the scrolling board, so it travels with the text it anchors to instead of dying on scroll — `components/selection-toolbar.tsx`
- [ ] Escape, or a click outside the panel, dismisses the toolbar — `components/selection-toolbar.tsx`
- [ ] Comment opens a mini editor quoting the highlighted span and taking a question; Cmd/Ctrl+Enter saves — `components/selection-toolbar.tsx` (R27)
- [ ] Saving a selection comment mints a quote-anchored composer chip from the same store as code-line comments — `components/selection-toolbar.tsx`, `lib/composer-badges.ts` (R27, R24)
- [ ] Request Changes on a highlight opens the same editor asking what change is requested, and stages a request-change ask carrying the quoted span as its provenance — `components/selection-toolbar.tsx` (R30)
- [ ] A highlight request-change also mints the quote thread and a receipt reply, and the ask claims that thread so it counts as one item — `components/selection-toolbar.tsx`, `components/main-surface.tsx` (R50 third amendment)
- [ ] Explain opens a thread with an "Explain this." opener and is a real action, not a hover hint — `components/selection-toolbar.tsx` (R28)
- [ ] Explain threads are questions, not review content: they never raise the exit count — `components/code-comments.tsx`, `components/main-surface.tsx`
- [ ] There is no per-block hover toolbar on board content — `components/lens-board.tsx` (R27)

### Durable quote highlights and threads

- [ ] Commented prose keeps a durable highlight: an accent wash with an underline edge, cloned across line wraps — `components/rich-text.tsx` (R28)
- [ ] Clicking a highlight opens a tooltip thread above it carrying the opening comment, every reply, and a follow-up input — `components/rich-text.tsx` (R28)
- [ ] Enter in the follow-up input sends; the reply lands in the same thread and an orchestrator reply follows — `components/rich-text.tsx` (R28)
- [ ] A newly created thread opens its tooltip immediately — `components/rich-text.tsx`, `lib/store.ts`
- [ ] Escape or an outside click closes an open thread tooltip — `components/rich-text.tsx`
- [ ] Highlighting maps display text (short chips, stripped backticks) back to the raw source string, snapping quotes to token boundaries — `components/rich-text.tsx` (R28)
- [ ] A multi-paragraph quote keeps its composer chip but gets no inline highlight — `components/rich-text.tsx` (R28)
- [ ] A quote spanning a bolded run keeps its thread chip but loses its inline highlight — `components/rich-text.tsx` (R45)
- [ ] The highlight is a `role="button"` span, not a nested `<button>`, so citation chips inside the highlighted prose stay clickable — `components/rich-text.tsx`
- [ ] Overlapping highlights are resolved left to right; the later overlapping one is skipped rather than corrupting the paragraph — `components/rich-text.tsx`

### Code blocks

- [ ] One code-block component serves every code surface in the product: chat tool output, board code elements, excerpt tabs, and click-to-reveal panels — `components/code-block.tsx` (R24, R9)
- [ ] A code block card has a header with the file path, the rendered line range (`L42–L58`, or `L42` for one line), and a Copy control — `components/code-block.tsx` (R9)
- [ ] Copy shows a Copied confirmation for 1.5 seconds and no-ops silently when the clipboard is unavailable — `components/code-block.tsx`
- [ ] The filename in a code-block header is a link: hovering decorates it and clicking deep-links into the Diff view landed on that file — `components/code-block.tsx` (R41)
- [ ] Code is syntax-highlighted through shiki, with the language inferred from the file extension when not declared — `components/code-block.tsx`, `lib/code-highlighter.ts` (R9)
- [ ] An unknown language falls back to plain-text tokenization rather than failing — `lib/code-highlighter.ts`
- [ ] Line numbers are absolute to the file, anchored to the block's declared start line — `components/code-block.tsx` (R9)
- [ ] Highlighted lines are tinted to mark the lines under discussion — `components/code-block.tsx`
- [ ] Hovering a line replaces its line number with a `+`; clicking it opens the line-comment editor — `components/code-block.tsx` (R14)
- [ ] A line that already carries a comment shows a persistent message glyph instead of the hover `+` — `components/code-block.tsx`
- [ ] A line carrying a staged request-change ask reads danger red (row, gutter and glyph); a plain comment or cited line reads evidence green — `components/code-block.tsx`
- [ ] The line-comment editor offers Delete (only when a comment exists), Cancel, Request Changes, and Save — `components/code-block.tsx`
- [ ] Escape in the line-comment editor cancels it — `components/code-block.tsx`
- [ ] Save keeps a local comment; saving empty text clears it — `components/code-block.tsx`
- [ ] Request Changes saves the comment and stages a request-change ask carrying the real diff position — `components/code-block.tsx` (R36)
- [ ] A code block awaiting highlighting shows a pulsing skeleton of the right line count, not a spinner or blank — `components/code-block.tsx`
- [ ] The gutter is sticky horizontally, so line numbers stay visible while scrolling long lines — `components/code-block.tsx`
- [ ] The open line-comment editor spans the card's full width regardless of horizontal scroll position — `components/code-block.tsx`

### Multi-site evidence and anchor reveals

- [ ] An element citing several places at once renders one tabbed code viewer with quiet pill tabs, one visible card at a time — `components/code-tabs.tsx` (R23)
- [ ] The tab strip is hidden when there is only one excerpt — `components/code-tabs.tsx`
- [ ] Tab labels are `basename:line` with the full path on hover — `components/code-tabs.tsx` (R25)
- [ ] An anchor reveal renders a row of `basename:line` chips; clicking one fetches the real lines and shows them below, clicking the active one folds it away — `components/code-tabs.tsx` (R23)
- [ ] A fetched anchor slice is cached, so re-opening the same chip does not refetch — `components/code-tabs.tsx`

### Element anatomy

- [ ] A prose element renders as paragraphs split on blank lines, constrained to a readable measure — `components/lens-board.tsx`
- [ ] A callout renders as a bordered box in one of two tones, warn or info — `components/lens-board.tsx`
- [ ] An annotation renders as a pin glyph, its anchor chip, and its text — `components/lens-board.tsx`
- [ ] A thread element renders as a left-ruled exchange: user messages as speech bubbles, orchestrator messages as undecorated prose — `components/lens-board.tsx` (R6)
- [ ] No lens board ships an authored conversation; threads are records of real exchanges only — `lib/fixtures/*.ts` (R17)
- [ ] A decision renders its statement as body text (a sentence, not a title), its why, its not-taken alternatives, and its evidence — `components/lens-board.tsx` (R38, R48)
- [ ] A decision reconstructed rather than stated by the implementer wears an "inferred" chip — `components/lens-board.tsx`, `lib/fixtures/decisions.ts`
- [ ] A decision with multiple excerpts renders the tabbed viewer; one with plain anchors renders the chip row — `components/lens-board.tsx` (R23)
- [ ] A requirement renders its short name as a heading with an added/modified delta badge, its verbatim SHALL text, its WHEN/THEN scenarios as a marked list, and its coverage chip plus related-file chips — `components/lens-board.tsx`
- [ ] A covered requirement's chip reads "covered by N hunks · M tests" in green; partial appends "· partial" in amber; unimplemented reads "unimplemented · 0 hunks" in amber — `components/lens-board.tsx`
- [ ] A requirement with no coverage relation renders no chip at all, rather than a zero-valued one — `components/lens-board.tsx` (SCENARIOS.md `propose`)
- [ ] A noise group renders its label, a "rule" or "model judged" chip, its reason, and one row per hunk with path and summary — `components/lens-board.tsx`
- [ ] A noise group can be dismissed, which dims it in place and flips its control to "not noise?"; it is never dropped — `components/lens-board.tsx`

### Design (spec) board anatomy

- [ ] The spec header names the change, the added/modified capability counts, the task tally, the discovered format and source path, and a raw ⌘R control — `components/lens-board.tsx` (spec-lens rebuild)
- [ ] The spec header carries the distilled why as one paragraph, not the raw proposal — `components/lens-board.tsx`
- [ ] The spec header carries a row of artifact chips (proposal.md, design.md, spec deltas, tasks.md), each jumping to its section — `components/lens-board.tsx`
- [ ] The what-changes spine renders tagged rows beside an impact box, and is derived from declared spec deltas rather than from hunks — `components/lens-board.tsx`, `lib/fixtures/design-gen0.ts`
- [ ] The capability grid renders one card per capability with its slug, delta badge, requirement count and scenario count, jumping to its section; added capabilities carry a green left edge — `components/lens-board.tsx`
- [ ] Task progress renders one bar per task group with a done/total readout and an overall tally in the kicker, and a completed group's bar reads green — `components/lens-board.tsx`
- [ ] A proposal-stage Design board shows tasks 0/N and no coverage chips anywhere — `lib/fixtures/design-gen0.ts` (SCENARIOS.md `propose`)

### Findings (Flagged) anatomy

- [ ] A finding is document flow, not a boxed card: severity chip, claim as the title, concurrence badge, then body, subheaded details, fix callout, and anchor — `components/lens-board.tsx` (R23)
- [ ] Severity renders as a chip reading high (danger), medium (warn), or low (neutral) — `components/lens-board.tsx`
- [ ] Cross-model agreement renders as "concur 2/2" in green when both seats raised it, or "Claude only"/"Codex only" in the machine's register when they disagree — `components/lens-board.tsx`
- [ ] Each finding folds to its claim row on its own, independently of its section — `components/lens-board.tsx` (R61)
- [ ] A finding's fix renders as an actionable callout under a "Fix" kicker — `components/lens-board.tsx` (R23)
- [ ] The fix callout carries Dismiss, Discuss, and Request This Change — `components/lens-board.tsx` (R29, R61)
- [ ] Discuss creates a local comment citing the fix and moves focus to the orchestrator chat to discuss it — `components/lens-board.tsx` (R68, R24; **unbuilt — see #492**)
- [ ] Request This Change stages a request-change ask carrying the fix text, a `finding: <claim>` provenance, and the finding's code anchor — `components/lens-board.tsx` (R29, R36)
- [ ] Once staged, the control becomes its own receipt reading "Staged · Request Change ✓", and clicking it again unstages — `components/lens-board.tsx` (R29)
- [ ] Dismissing a finding dims it in place, folds it, and offers "Dismissed · Undo"; it never disappears — `components/lens-board.tsx` (R61)
- [ ] A dismissed finding can still be peeked open — `components/lens-board.tsx` (R61)
- [ ] Dismiss is hidden while an ask is staged from the finding, so the reviewer must unstage first — `components/lens-board.tsx` (R61)
- [ ] Both exits — requesting the fix and dismissing — clear the finding from the Flagged count — `components/lens-board.tsx`, `components/main-surface.tsx` (R61)
- [ ] A dismissed finding announces ", dismissed" to a screen reader without adding visible chrome — `components/lens-board.tsx`

### Lens switcher

- [ ] The lens switcher is a centered segmented control with one segment per lens the session has: Design, Sequence, Decisions, Flagged, Noise, in that order — `components/main-surface.tsx`, `components/view-switcher.tsx`
- [ ] Each segment carries its own icon: drafting compass, ordered list, commit, flag, muted volume — `components/main-surface.tsx` (R35 icons)
- [ ] A lens the session does not have is an absent segment, never a disabled one — `components/main-surface.tsx` (SCENARIOS.md `propose`)
- [ ] Diff is not a lens segment; it sits beside Map as a raw-source toggle — `components/main-surface.tsx` (issue #475)
- [ ] Segment labels drop below 46rem of header width, leaving an icon rail with the names kept in title and aria-label — `components/view-switcher.tsx` (R35 responsive)
- [ ] Lens segments are 13px with size-4 icons and grow to fill the 56px bar's height — `components/view-switcher.tsx` (R51)
- [ ] The Flagged segment carries a red count badge of findings not yet dismissed or requested, in the same red as the exit FAB's pip — `components/main-surface.tsx`, `components/view-switcher.tsx` (R61)
- [ ] The Flagged count badge announces ", N open" to a screen reader — `components/view-switcher.tsx` (R61)
- [ ] A lens whose board has round-touched sections the reviewer has not opened carries a small gold dot on its segment — `components/main-surface.tsx`, `components/view-switcher.tsx` (R58)
- [ ] The open-findings count outranks the delta dot when both would apply on the same segment — `components/view-switcher.tsx` (R61)
- [ ] The delta dot announces ", changed this round" to a screen reader — `components/view-switcher.tsx` (R58)
- [ ] The lens switcher shows no segment as active while a non-lens view (Map, Diff, hand-off, History) is open — `components/main-surface.tsx`

### Delta marks and generation drill-down

- [ ] The composition stamps `delta: "new" | "reworked"` on each section it touched; absence means the section carried forward — `lib/lens-data.ts` (R58)
- [ ] Round-touched sections open expanded while carried sections fold to their gists, so the board's fold shape is the delta view — `components/lens-board.tsx` (R58)
- [ ] A touched section shows a small gold dot before its title — `components/lens-board.tsx` (R58)
- [ ] The gold dot is aria-hidden, with an sr-only ", new this round" / ", reworked this round" suffix keeping the heading outline honest — `components/lens-board.tsx` (R58, R38)
- [ ] Interacting with a section — folding, unfolding, or clicking its gist — clears its dot for good — `components/lens-board.tsx`, `lib/store.ts` (R58)
- [ ] Clearing the last unopened touched section on a lens clears that lens segment's rollup dot — `components/main-surface.tsx` (R58)
- [ ] No prose diffing, side-by-side generations, per-section "unchanged" badges, banner or show-changes toggle appears anywhere — `components/lens-board.tsx` (R58)
- [ ] The delta axis is orthogonal to the spec-delta axis (added / modified / removed) and the two render differently — `lib/lens-data.ts`, `components/lens-board.tsx` (R58)
- [ ] Generation 1 stays reachable as a start-folded drill-down section on the regenerated board, labelled with its generation and round — `lib/fixtures/flagged-gen2.ts` (R58, SCENARIOS.md `returned`)
- [ ] A regenerated board's intro states its generation and round in one quiet line, not as chrome prose — `lib/fixtures/flagged-gen2.ts` (SCENARIOS.md `returned`)
- [ ] Flagged carries only what is currently flagged; a round's addressed account is never a Flagged section — `lib/fixtures/flagged-gen2.ts` (SCENARIOS.md `returned`)
- [ ] A returned round's addressed account appends to the bottom of Sequence as "Round N · Addressed", newest last, so repeated rounds grow the walk chronologically — `lib/fixtures/sequence.ts` (SCENARIOS.md `returned`)

---

## 4. Diff view

- [ ] The Diff surface renders the raw patchset in GitHub's Files-changed shape — `components/diff-view.tsx` (issue #475)
- [ ] Diff is reached from the right half of the Map·Diff pill in the header — `components/main-surface.tsx` (R49 amendment)
- [ ] The surface has two independent scroll frames: the diff cards on the left and the changed-file list on the right — `components/diff-view.tsx`
- [ ] A summary line above the cards reads "N files changed", total additions, total deletions, the five-square proportion chip, and a right-aligned "n / N viewed" tally — `components/diff-view.tsx`
- [ ] The right rail carries a filter field over the changed-file tree — `components/diff-view.tsx`
- [ ] The file tree groups files by directory, with the directory as a header and the basenames indented beneath — `components/diff-view.tsx`
- [ ] Each tree row shows its file's own additions and deletions — `components/diff-view.tsx`
- [ ] Clicking a tree row smooth-scrolls the cards frame to that file's card — `components/diff-view.tsx`
- [ ] A file marked viewed reads struck through in the tree — `components/diff-view.tsx`
- [ ] Filtering hides non-matching files from both the tree and the cards, and an empty result says which query matched nothing — `components/diff-view.tsx`
- [ ] Each file card's header carries a collapse chevron, a file glyph, the monospace path, a status chip, a copy-path control, the +A/−D counts, the five-square chip, and a Viewed checkbox — `components/diff-view.tsx`
- [ ] A renamed file renders `old path → new path` in its header — `components/diff-view.tsx`
- [ ] An added file wears a green ADDED chip; a renamed file wears a neutral RENAMED chip; a modified file wears no chip — `components/diff-view.tsx`
- [ ] Copy path confirms with a tick for 1.5 seconds and no-ops silently when the clipboard is unavailable — `components/diff-view.tsx`
- [ ] Marking a file viewed collapses its card and increments the viewed tally — `components/diff-view.tsx`
- [ ] File cards collapse and expand through the shared collapse primitive — `components/diff-view.tsx` (R47)
- [ ] The five-square chip fills green in proportion to additions and red for the rest, and reads all-muted when a file has no changes — `components/diff-view.tsx`
- [ ] Hunks render unified with dual old/new line-number gutters — `components/diff-view.tsx`
- [ ] Each hunk carries an `@@ -a,b +c,d @@` header row, with counts derived from the hunk's own lines — `components/diff-view.tsx`, `lib/diff-data.ts`
- [ ] Added rows tint green, deleted rows tint red, and a `+`/`−` marker column sits between the gutters and the content — `components/diff-view.tsx`
- [ ] Hunk content is shiki-highlighted, tokenized as one slab so mixed old/new lines stay aligned — `components/diff-view.tsx`
- [ ] Line comments key on NEW-side line numbers — `components/diff-view.tsx`
- [ ] A deletion row carries no comment affordance, because it has no new-side line — `components/diff-view.tsx`
- [ ] The diff's line-comment editor is the same component as the board's and the chat's, with the same Save / Request Changes / Delete behavior — `components/diff-view.tsx`, `components/code-block.tsx`
- [ ] Request Changes from a diff line saves the comment locally and stages an ask with that file and line as its diff position — `components/diff-view.tsx` (R36)
- [ ] A diff line carrying a staged request-change reads danger red; a plain comment reads evidence green — `components/diff-view.tsx`
- [ ] Span selection inside the diff gets the same Comment / Request Changes / Explain toolbar as board prose — `components/diff-view.tsx` (R27, R30)
- [ ] The syntax theme in the diff follows the same code-theme setting as every other code surface — `components/diff-view.tsx`, `lib/code-theme.ts`

---

## 5. Chat & orchestrator presence

- [ ] The chat column is a persistent dock beside the active surface, with a header, a scrolling conversation, and a composer — `components/chat-column.tsx` (law 2)
- [ ] The chat-pane header is 56px and carries the two-line session trail plus a collapse control, matching the main bar — `components/chat-column.tsx` (R52 amendment)
- [ ] There is exactly one chat-pane header component; no surface renders a bespoke chat bar — `components/chat-column.tsx` (R52)
- [ ] Collapsing the chat reveals the same trail and an expand affordance in the main top bar — `components/main-surface.tsx` (R52)
- [ ] The whole conversation — turns, tool lines, composer — rides one centered 720px column, so a widened chat does not stretch edge to edge — `components/conversation-pane.tsx`, `components/input-bar.tsx` (R36 layout fix)
- [ ] The conversation scrolls to the newest turn whenever a turn arrives — `components/conversation-pane.tsx`
- [ ] User turns render as right-aligned speech bubbles at 85% of the column width with a timestamp beneath — `components/turn.tsx` (R6)
- [ ] Orchestrator turns render as undecorated prose; neither speaker carries a "you"/"orchestrator" label — `components/turn.tsx` (R6)
- [ ] A turn's anatomy is optional short lead prose → thinking → tool calls → final prose — `components/turn.tsx` (R5)
- [ ] Final prose never renders before the last activity step in the turn has resolved — `components/turn.tsx` (R5)
- [ ] A thinking block streams its paragraphs one at a time, then collapses to "Thought for Ns" — `components/thought-block.tsx` (R5)
- [ ] A collapsed thinking block can be re-opened by clicking it — `components/thought-block.tsx`
- [ ] A historical thinking block renders already-collapsed with its recorded duration, never replaying — `components/thought-block.tsx` (R46)
- [ ] Tool activity renders as inline single-line steps with an icon, a label, and an optional detail — `components/action-step.tsx` (R4, shell iteration log)
- [ ] A running step spins its icon in the machine's register and reads in full-contrast text; a done step reads muted with a static icon — `components/action-step.tsx`
- [ ] A running step resolves on its own and can swap to a done label and done detail — `components/action-step.tsx`
- [ ] Every activity label is derivable from a real harness; no invented gerunds appear — `lib/scenarios/*.ts`, `components/run-view.tsx` (R4)
- [ ] Step state is announced to screen readers as "running" or "done" — `components/action-step.tsx`
- [ ] Turns appended live animate in word by word; historical turns render instantly as records — `components/streaming-prose.tsx`, `components/turn.tsx` (R46)
- [ ] Switching sessions replaces the whole transcript and never replays the arrival animation — `components/chat-column.tsx` (R46)
- [ ] The word-reveal animation is a staggered CSS animation-delay across all words, continuous across paragraph breaks — `components/streaming-prose.tsx`, `app/globals.css`
- [ ] An orchestrator turn can interleave prose and code blocks in reading order, and those code blocks carry the same per-line comment affordance as everywhere else — `components/turn.tsx` (R24)
- [ ] The composer is a growing textarea between 36px and 200px tall — `components/input-bar.tsx`
- [ ] Enter sends and Shift+Enter inserts a newline; IME composition never triggers a send — `components/input-bar.tsx`
- [ ] The send control is disabled while the composer is empty — `components/input-bar.tsx`
- [ ] Pasting an image into the composer attaches it as a badge with a thumbnail and the file name — `components/input-bar.tsx` (R14)
- [ ] Every code-line comment appears above the composer as a removable reference chip — `components/input-bar.tsx`, `lib/composer-badges.ts` (R14)
- [ ] Hovering a code-comment chip shows a preview card with the file path, the line number, and the comment text — `components/input-bar.tsx`
- [ ] Every quote thread appears above the composer as a removable chip showing the quoted span — `components/input-bar.tsx` (R27)
- [ ] Removing a chip removes the underlying object: the comment, the thread, or the image — `components/chat-column.tsx`
- [ ] The composer's placeholder is "message the orchestrator" — `components/input-bar.tsx`
- [ ] The chat is the command surface: acts invoked conversationally produce orchestrator turns with tool lines — `lib/scenarios/teammate-transcript.ts` (law 4, UI-acts ruling)
- [ ] Acts invoked through the UI (adding a project, changing a setting) produce no orchestrator turn — the surface state carries them — `components/add-project-dialog.tsx` (UI-acts ruling)
- [ ] The orchestrator narrates staging in the transcript when an exchange produces a finding ("Staged · request change · …") — `lib/scenarios/rounds.ts` (law 9, R29)

---

## 6. Hand-off & exits

### The exit FAB and the ask basket

- [ ] The exit CTA is a gold pill-shaped floating action button anchored bottom-right of the view region — `components/main-surface.tsx` (R49)
- [ ] The FAB's label is target-aware: "Write Review" on a teammate PR, "Continue" on your branch or your PR — `components/main-surface.tsx`, `lib/scenarios/*.ts` (R35 amendment)
- [ ] The FAB's label drops below 54rem of pane width, leaving the icon and the count — `components/main-surface.tsx` (R49)
- [ ] The FAB toggles the hand-off view and yields (shrinking and fading out, pointer-events off) while the hand-off is open — `components/main-surface.tsx` (R49)
- [ ] The FAB carries a single deep-red count pip; the inline "· n" in the button text does not exist — `components/fab-pips.tsx`, `components/main-surface.tsx` (R50 second amendment)
- [ ] The pip count is derived from review content — staged asks plus unclaimed line comments plus unclaimed quote threads — not accumulated from events — `components/main-surface.tsx` (R50 second amendment)
- [ ] An ask claims the comment or thread it was born from, so a highlight request-change counts as one item, not two — `components/main-surface.tsx` (R50 third amendment)
- [ ] Explain threads never count toward the pip — `components/main-surface.tsx`, `components/code-comments.tsx`
- [ ] Undo of any kind decrements the count, and opening the hand-off does not clear it — `components/main-surface.tsx` (R50 second amendment)
- [ ] The count reads the same after any navigation, because it is derived rather than stored — `components/main-surface.tsx` (R50 second amendment)
- [ ] Staging anything into the review flies a small red bubble from the acting element to the FAB over roughly 420ms — `components/fab-pips.tsx` (R50)
- [ ] The pip pops when the flight lands, or immediately when there is no source element to fly from — `components/fab-pips.tsx` (R50)
- [ ] The pop rides the gesture, not the count, so route transitions and scenario seeding never animate it — `components/fab-pips.tsx`
- [ ] Composite actions batch inside an 80ms window and collapse to one bubble in the dominant register — `lib/fab-signal.ts` (R50 amendment)
- [ ] A genuinely later orchestrator event falls outside the window and pips on its own — `lib/fab-signal.ts` (R50 amendment)
- [ ] The FAB's accessible name carries the count when there is one — `components/main-surface.tsx`
- [ ] The acting element is recovered from focus rather than wired per call site, so no staging path can drift out of the animation — `lib/fab-signal.ts` (R50)

### Asks

- [ ] The staged unit is an ask: text, intent (comment or request-change), a provenance source string, an optional diff anchor, and an optional originating thread — `components/code-comments.tsx` (R29)
- [ ] An ask carrying a diff position becomes a line comment; an ask without one travels in the review body — `components/handoff-view.tsx` (R36)
- [ ] No chrome copy explains the body-versus-line routing; placement under the section header is the whole statement — `components/handoff-view.tsx` (law-10 sweep)
- [ ] Findings never auto-stage; staging is always an act — `components/lens-board.tsx` (R29)
- [ ] Every staging control is its own receipt and its own undo — `components/lens-board.tsx` (R29)

### The hand-off view

- [ ] The hand-off is a view toggle on the main surface, exactly like Map and Diff — `components/main-surface.tsx` (R31)
- [ ] The hand-off dispatches by entry mode: a teammate PR gets the Post Review lane; your branch gets the rounds lanes — `components/handoff-view.tsx` (R31)
- [ ] The Map·Diff pill is still reachable while the hand-off is open, and the back arrow leaves it — `components/main-surface.tsx`

### Post Review lane (teammate PR)

- [ ] The lane's heading is "Post Review · <PR ref>" with a pull-request glyph — `components/handoff-view.tsx` (R35 title case)
- [ ] The verdict is a three-option segmented control — Approve, Request Changes, Comment — each with its own status dot — `components/handoff-view.tsx` (R33)
- [ ] The verdict is proposed from the review's own acts: any request-change proposes Request Changes, any other ask proposes Comment, nothing proposes Approve — `components/handoff-view.tsx` (R33)
- [ ] The proposal states its arithmetic beside the control ("proposed from your review · N request changes · M comments") — `components/handoff-view.tsx` (R33)
- [ ] The verdict is always flippable, and an overridden verdict says so and offers "use proposal" to revert — `components/handoff-view.tsx` (R33)
- [ ] An approving review is first-class: the drafted Approve opener is grounded in what was walked and cleared — `components/handoff-view.tsx` (R33)
- [ ] The living draft is rendered exactly as it will post, so there is no separate preview stage — `components/handoff-view.tsx` (R31, #435)
- [ ] The review body runs in the sans face with the rest of the conversation surfaces, not serif — `components/handoff-view.tsx` (R40)
- [ ] The opener is drafted from the verdict and the staged asks and rewrites itself when the verdict flips — `components/handoff-view.tsx` (R32)
- [ ] Each body ask renders with an intent tag and a provenance line above its prose — `components/handoff-view.tsx`
- [ ] An ask staged since the last look streams its block into the draft in place — `components/handoff-view.tsx` (R32)
- [ ] Line comments render as discrete cards grouped by file path, each carrying its click-to-reveal anchor and its intent tag — `components/handoff-view.tsx` (R36)
- [ ] A line-comment card exposes Edit and Delete on hover or focus — `components/handoff-view.tsx`
- [ ] Editing a line comment is an inline textarea; Cmd/Ctrl+Enter saves, Escape cancels — `components/handoff-view.tsx`
- [ ] Deleting a line comment retires it to the ledger and unstages its ask — `components/handoff-view.tsx` (R32)
- [ ] Highlighting draft prose shows Revise, Drop, and Explain instead of the board verbs — `components/selection-toolbar.tsx`, `components/handoff-view.tsx` (R30)
- [ ] Revise takes an instruction and re-streams the affected block after a visible working beat — `components/handoff-view.tsx` (R32)
- [ ] Revise works on the opener as well as on any ask block — `components/handoff-view.tsx`
- [ ] Drop retires the block to the Retired ledger with a reason and unstages its ask — `components/handoff-view.tsx` (R32)
- [ ] Explain answers with the block's provenance inline in the panel — `components/handoff-view.tsx` (R30)
- [ ] A reviewer's revision survives a verdict switch — the edit wins over regeneration — `components/handoff-view.tsx`
- [ ] The Retired drawer lists each retired block struck through, with its reason and a Restore control — `components/handoff-view.tsx` (R32)
- [ ] Restoring a retired block re-stages it with its original intent, source and code anchor — `components/handoff-view.tsx` (R32)
- [ ] Restoring the retired opener puts it back as an override rather than re-staging an ask — `components/handoff-view.tsx`
- [ ] The residue line is the bare count: "N threads · M code comments stay local" — no reassurance clause — `components/handoff-view.tsx` (law-10 sweep)
- [ ] The lane ends in one large Post Review action — `components/handoff-view.tsx`, `components/handoff-action.tsx` (R35 title case)
- [ ] Post Review shows the submission in flight, keeping full contrast rather than dimming — `components/handoff-action.tsx`
- [ ] The posted state names the PR, the verdict, the line-comment count and the body, and links to the posted review — `components/handoff-view.tsx`
- [ ] There is no explanatory copy about freezing, consent, or what will post — `components/handoff-view.tsx` (law 10, law-10 sweep)

### Rounds lanes (your branch)

- [ ] The rounds hand-off is one goal in two states, and the page's shape states which one you are in — `components/rounds-lanes.tsx` (R37)
- [ ] While asks remain, the page is "Changes" with the ask count beside the heading — `components/rounds-lanes.tsx` (R37)
- [ ] Each ask renders as a card with an intent pill, its provenance, its text, and its anchor reveal — `components/rounds-lanes.tsx` (R37)
- [ ] Highlighting an ask's text gives the same Revise / Drop / Explain steering as the review draft — `components/rounds-lanes.tsx` (R30)
- [ ] Revise on an ask re-streams that card's text after a working beat — `components/rounds-lanes.tsx`
- [ ] Drop on an ask retires it to the ledger with a "dropped from the round" reason and unstages it — `components/rounds-lanes.tsx`
- [ ] Explain on an ask names its source and its anchor — `components/rounds-lanes.tsx`
- [ ] Dispatch Round sits beneath the ask cards and is inert while nothing is staged — `components/rounds-lanes.tsx` (R34)
- [ ] While asks remain, the pull request is one muted destination line at the foot: its glyph and title, never competing for attention — `components/rounds-lanes.tsx` (R37)
- [ ] There is no "This Round" wrapper card, no "ripening" language, and no Dispatch side-caption — `components/rounds-lanes.tsx` (R37, law 10)
- [ ] When no asks remain and the PR is ready, the page IS the pull request: title as heading, description rendered, Open Pull Request primary — `components/rounds-lanes.tsx` (R37)
- [ ] The PR description renders a minimal markdown subset — `## ` headings and bold spans — through the same rich-text pipeline — `components/rounds-lanes.tsx`
- [ ] Open Pull Request shows the submission in flight, then swaps to a receipt naming the opened PR number and linking to it — `components/rounds-lanes.tsx`, `components/handoff-action.tsx`
- [ ] With no asks and an unripe PR, the page states "Nothing staged yet." rather than showing a thin fake PR — `components/rounds-lanes.tsx`
- [ ] Work orders exist only on your branch; a teammate PR never offers a rounds lane — `components/handoff-view.tsx` (R31)
- [ ] There is no self-review lane; rounds continue identically after the PR is open — `components/rounds-lanes.tsx` (R34)

---

## 7. Rounds

### Dispatch and the live round

- [ ] Dispatching a round navigates to the session's run route — `app/s/[slug]/page.tsx`, `components/main-surface.tsx`
- [ ] The round run view names the round and the branch at the top — `components/run-view.tsx`
- [ ] The run's prep steps are "Created detached worktree" (naming branch and round) and "Applied the round's asks" (with the ask count) — `components/run-view.tsx` (R34)
- [ ] The worker's activity renders as a bordered table under a "Round Worker" kicker, each row progressing queued → running → its detail — `components/run-view.tsx`
- [ ] The worker table appears only once the worker phase is about to begin — `components/run-view.tsx`
- [ ] The run then shows the gate running (`pnpm check`) and resolving to its project count — `components/run-view.tsx`
- [ ] The run then shows the round committing, with the commit count — `components/run-view.tsx`
- [ ] The run's last line is "Drafting the round report", resolving to "verified against the round's diff" — `components/run-view.tsx` (R57)
- [ ] The round is dispatched one at a time — the run route owns the whole surface until it completes — `app/s/[slug]/run/page.tsx` (R34)
- [ ] Completing the round stamps the session row's subtitle, arms the greeting, and navigates to the returned session — `app/s/[slug]/run/page.tsx`
- [ ] Every run label derives from Rennet's own round pipeline — `components/run-view.tsx` (R4)

### The round report as greeting

- [ ] Returning from a round fills the main surface with the round report — `app/s/[slug]/page.tsx`, `components/round-report.tsx` (R57)
- [ ] The report opens with a greeting paragraph stating what the round did, where it ran, and how the gate came back — `components/round-report.tsx` (R34, R57)
- [ ] The report lists one item per ask with its outcome: Addressed (green tick), Partial (amber dashed circle), Untouched (muted minus), or Beyond the Asks (verdigris sparkle) — `components/round-report.tsx` (R34, R57)
- [ ] Each report item names the ask it traces back to and carries a note explaining the outcome — `components/round-report.tsx` (R57)
- [ ] A report item carries a click-to-reveal anchor into the code where one applies — `components/round-report.tsx` (R57)
- [ ] Every outcome is verified against the round's diff, never taken from the worker's word — `lib/scenarios/returned.ts` (R57)
- [ ] Unrequested work the round did is surfaced as a "Beyond the Asks" item rather than hidden — `components/round-report.tsx` (R34, R57)

### Progressive reveal

- [ ] The report is readable immediately while the lens drafters regenerate live beneath it — `components/round-report.tsx` (R57)
- [ ] The regeneration block lists every lens with its own state: queued, carrying forward, re-drafting, or its result detail — `components/round-report.tsx` (R57)
- [ ] Carried lenses complete as carry-forwards; touched lenses re-draft and report their result counts — `components/round-report.tsx` (R57)
- [ ] The regeneration then shows "Cleaning up drafts · post-process pass" and "Composed generation 2" — `components/round-report.tsx` (R39, R57)
- [ ] The regeneration kicker reads "Regenerating the Boards" while it runs and "Regenerated the Boards" when it finishes — `components/round-report.tsx`
- [ ] "View the New Boards" appears only when the new generation composes; there is never a disabled button waiting to enable — `components/round-report.tsx` (R57)
- [ ] The surface never locks while the regeneration runs — `components/round-report.tsx` (R57)
- [ ] The step labels read "post-process pass" and never "unslop" — internal vocabulary stays internal — `components/round-report.tsx`, `components/run-view.tsx` (R39)

### The rounds ledger (History)

- [ ] A History control joins the header pill row beside Map·Diff exactly when the session has a completed round, and is absent otherwise — `components/main-surface.tsx` (R57)
- [ ] The History control's label folds to the bare icon at 66rem of header width, earlier than Map/Diff's 54rem, so it never touches the centered lens pill — `components/main-surface.tsx` (R57)
- [ ] The History control toggles `?view=rounds` and reads as pressed while that view is open — `components/main-surface.tsx`
- [ ] The ledger lists one row per round: "Round N", when it ran, and a tally derived from its items — `components/round-report.tsx` (R57)
- [ ] The tally is derived from the report's own item statuses, not stored separately — `components/round-report.tsx` (R57)
- [ ] Rounds are listed newest first, and the newest is selected on open — `components/round-report.tsx`
- [ ] Selecting a round renders its full report beneath the list, so earlier reports stay readable forever — `components/round-report.tsx` (R57)
- [ ] A settled report in the ledger wears a collapsed retrospective activity line reading "Regenerated the boards · N reworks · generation M" — `components/round-report.tsx` (R32 amendment, R57)
- [ ] Expanding that line shows the round's trigger queue and its turn anatomy — `components/round-report.tsx` (R32 amendment)
- [ ] The drafting activity feed belongs to the rounds regeneration, never to the Write Review lane — `components/round-report.tsx`, `components/handoff-view.tsx` (R32 amendment)

### After the round

- [ ] The regenerated boards are a new generation with delta marks; the prior generation is frozen as drill-down — `lib/scenarios/returned.ts`, `lib/fixtures/flagged-gen2.ts` (R34, R58)
- [ ] Asks, threads and highlights re-anchor by quote match across a regeneration — `components/rich-text.tsx` (R34)
- [ ] The PR lane is ripe after the round returns, offering one Open Pull Request action — `lib/scenarios/returned.ts`, `components/rounds-lanes.tsx` (R34, R37)
- [ ] The returned session's transcript is the pre-round transcript plus the dispatch and return turns, not a replacement — `lib/scenarios/returned.ts` (law 3)

---

## 8. Settings & Help

- [ ] Settings takes over the whole view including the chat column; the chat and board stay mounted so their state survives the visit — `components/settings-view.tsx`, `components/shell.tsx` (#476, R22 amendment)
- [ ] Settings leaves by the back arrow or Escape, and shows an `esc` key hint in its header — `components/settings-view.tsx` (#476)
- [ ] Settings is split into four pages — Environments, Appearance, Keyboard Shortcuts, Projects — listed in a left nav with icons — `components/settings-view.tsx`, `lib/settings-data.ts` (#476)
- [ ] Every settings section states its backing file as a monospace caption (`client-settings.json`, `daemon-settings.json`, or `.rennet/` in the project) — `components/settings-view.tsx` (#476)
- [ ] Every layered value renders a provenance chip naming the rung it resolved from (builtin / detected / global / repo) — `components/settings-view.tsx` (#476)

### Environments page

- [ ] The page is titled "Environments"; the local machine keeps its own name, "This Machine" — `components/settings-view.tsx` (R56 amendment)
- [ ] The Environments section header carries its own Add Environment button, a second entry point beside the sidebar's — `components/settings-view.tsx` (R56 amendment)
- [ ] Each environment renders as one card — `components/settings-view.tsx` (R56 second amendment)
- [ ] The card header shows the OS glyph (macOS, Linux, or Windows, with WSL taking the Windows mark plus a mono "WSL" chip), the name, and either the mono address or a "Local" chip — `components/settings-view.tsx`, `lib/os-glyphs.ts` (R56 second amendment)
- [ ] The environment name renames inline; Enter commits, Escape cancels, an emptied name keeps the old one — `components/settings-view.tsx`
- [ ] A rename flows through to the sidebar's host group header — one hosts state — `components/settings-view.tsx`, `lib/store.ts` (R56 second amendment)
- [ ] Remove is offered on remote environments only, never on the local machine — `components/settings-view.tsx` (R56 second amendment)
- [ ] Remove opens the one sanctioned destructive confirmation, naming the project and session counts it takes with it and stating the machine itself is untouched — `components/settings-view.tsx`
- [ ] The daemon meta line reads the version when reachable, and "Not connected — daemon unreachable, version unknown" when nothing can be asked — `components/settings-view.tsx` (R56 second amendment)
- [ ] An unreachable host that was seen before reads "Not connected — last seen running Rennet daemon v<n>" rather than inventing current state — `components/settings-view.tsx`
- [ ] Reconnect appears only when the host is unreachable — `components/settings-view.tsx` (R56 second amendment)
- [ ] Update Daemon appears only when that host actually has an update — `components/settings-view.tsx` (R56 second amendment)

### Source control detection

- [ ] Each environment card carries a Source Control section listing that host's VCS and forge tooling — `components/settings-view.tsx` (R56)
- [ ] There is no dedicated Providers page; detection lives on the host it belongs to — `components/settings-view.tsx` (R56)
- [ ] Each row shows the official mark, the tool label, the tool's own version line, a status chip, an honest one-line helper, and an enable toggle — `components/settings-view.tsx` (R56)
- [ ] Status is one of Available, Not Authenticated, Not Installed, Unreachable — `lib/settings-data.ts` (R56)
- [ ] A row with no detected version shows no version rather than a guess — `components/settings-view.tsx` (R56 second amendment)
- [ ] The helper names the exact command that fixes the state, with backticked commands rendered as code — `components/settings-view.tsx`, `lib/settings-data.ts` (R56)
- [ ] GitHub rides `gh`, GitLab rides `glab`, Bitbucket takes an API token, and Azure DevOps does not appear — `lib/settings-data.ts` (R56, #483, #484)
- [ ] There is no OAuth-shaped connect ceremony anywhere in the source-control rows — `components/settings-view.tsx` (R56, #483)
- [ ] A disconnected environment shows one honest line ("Connect <host> to detect its tooling.") instead of fake detection rows — `components/settings-view.tsx` (R56)
- [ ] The GitHub mark scheme-swaps between its black and white forms; the others read on both schemes — `components/settings-view.tsx`

### Agents and review roles

- [ ] Each environment card carries an Agents section listing the coding harnesses detected on that host — `components/settings-view.tsx` (R62)
- [ ] Agent rows use the same shape as source-control rows: official mark, label, version line, status chip, honest helper, enable toggle — `components/settings-view.tsx` (R62)
- [ ] Disabling an agent rules it out of reviews on that host without uninstalling anything — `components/settings-view.tsx` (R62)
- [ ] A Review section on the card exposes Model Mappings, and is absent entirely when no agents were detected — `components/settings-view.tsx` (R62)
- [ ] Edit Mappings is inert until at least one agent is enabled, and says so in its hint — `components/settings-view.tsx` (R62)
- [ ] The mappings dialog is a table of review roles against two columns, Dual Harness and Single Harness — `components/settings-view.tsx` (R62)
- [ ] The column headers ARE the review-mode switch; the selected header carries the tick and the other column dims and locks — `components/settings-view.tsx` (R62)
- [ ] There is no separate Review Mode row — `components/settings-view.tsx` (R62)
- [ ] The Dual column is unavailable until both agents are enabled, and hovering anywhere in it says which agent would unlock it — `components/settings-view.tsx` (R62)
- [ ] Losing the second agent settles the mode as Single regardless of what was clicked — `components/settings-view.tsx` (R62)
- [ ] Single Harness auto-detects its provider, preferring Claude, and its subheading names it — `components/settings-view.tsx` (R62)
- [ ] Each role names the models it may take and its effort level; an editable cell opens a searchable model picker — `components/settings-view.tsx` (R62)
- [ ] A role that does not run in a given mode renders an em dash, not a fake assignment — `components/settings-view.tsx` (R62)
- [ ] A role changed from its default gains a "Reset to default" control — `components/settings-view.tsx` (R62)
- [ ] The role list covers Orchestrator, Context-Map Workers, Confirmation Worker, Lens Drafters, Flagged Second Seat, Adjudication, Post-Process Pass, and Utility — `lib/settings-data.ts` (#460, #464, R62)

### Appearance page

- [ ] Scheme is a light / dark / system segmented control — `components/settings-view.tsx`
- [ ] "system" resolves through `matchMedia` and re-applies when the OS scheme changes — `components/appearance-sync.tsx`
- [ ] The theme pack is a row of live-applying pill options — `components/settings-view.tsx`, `lib/theme-packs.ts` (#481, R64)
- [ ] The code theme is a separate row of live-applying pill options, independent of the interface theme — `components/settings-view.tsx`, `lib/code-theme.ts` (R64)
- [ ] "Follow scheme" resolves the code theme to the light or dark variant of the current scheme — `lib/code-theme.ts` (R64)
- [ ] Changing the code theme re-highlights every code surface, including the diff — `components/code-block.tsx`, `components/diff-view.tsx` (R64)
- [ ] The resolved scheme stamps `data-scheme` and the `dark` class on the document root; the theme pack stamps `data-rn-theme`, with the default pack clearing the attribute — `components/appearance-sync.tsx` (R64)

### Keyboard shortcuts page

- [ ] The page lists every named command with its binding, filterable by name — `components/settings-view.tsx`, `lib/settings-data.ts` (#476)
- [ ] Escape in the filter clears the filter before it can close settings — `components/settings-view.tsx`
- [ ] Each row exposes a Change control on hover — `components/settings-view.tsx` (#476)
- [ ] An empty filter result says which query matched nothing — `components/settings-view.tsx`
- [ ] The registry names Search ⌘P, Command Menu ⌘K, New Chat ⌘N, Toggle Sidebar ⌘B, Toggle Chat ⌘J, Settings ⌘, — `lib/settings-data.ts` (R7)

### Projects page

- [ ] The page scopes to one project through an inline picker grouped by environment — `components/settings-view.tsx` (#476)
- [ ] The picker follows the active project by default, resolved from the `?project` param — `app/settings/[page]/page.tsx` (#476)
- [ ] Identity exposes the project's display name with the `org/repo` default as its placeholder — `components/settings-view.tsx`
- [ ] A renamed project gains a Reset control that restores the `org/repo` default — `components/settings-view.tsx`
- [ ] Clearing the name on blur restores the default rather than leaving it empty — `components/settings-view.tsx`
- [ ] Identity exposes a grid of project glyphs as a radio group, applying live to the sidebar — `components/settings-view.tsx`, `components/project-icon.tsx` (R65)
- [ ] Worktrees exposes the location directory and the naming pattern — `components/settings-view.tsx` (#476, R63)
- [ ] The naming pattern offers insertable tokens: `{project}`, `{branch}`, `{pr}`, `{user}`, `{date}` — `components/settings-view.tsx`, `lib/settings-data.ts` (R63)
- [ ] A live preview shows the resolved worktree path, with slashes in a branch name flattened to dashes — `components/settings-view.tsx`, `lib/settings-data.ts` (R63)
- [ ] Repository exposes Review Context (local vs git-visible) with its provenance chip — `components/settings-view.tsx` (#476)
- [ ] Repository states whether the review context is promoted — `components/settings-view.tsx`
- [ ] "Runs on" is a displayed detected fact with its provenance chip and host glyph, with no editable override on the surface — `components/settings-view.tsx` (R22 amendment, #476)
- [ ] An Issue Tracker section names the tracker whose referenced tickets are fetched for the review agents — `components/settings-view.tsx` (#461, #487)
- [ ] The tracker choice is github / jira / linear / none, each with its provenance chip — `components/settings-view.tsx`, `lib/settings-data.ts` (#461)
- [ ] The scout's tracker pick lands as "detected"; a user's pick lands on the global rung — `components/settings-view.tsx`, `lib/settings-data.ts` (#461, #476)
- [ ] GitHub states that it rides the `gh` CLI on that host and exposes no further fields — `components/settings-view.tsx` (#461, #483)
- [ ] JIRA and Linear expose a project key, a base URL, and the name of the env var holding the token — `components/settings-view.tsx` (#461)
- [ ] The token itself is never entered or stored — only the env var's name, read on the host — `components/settings-view.tsx`, `lib/settings-data.ts` (#461)
- [ ] Switching to a REST tracker seeds its token env var with the provider's conventional name — `components/settings-view.tsx` (#461)
- [ ] Switching away from a REST tracker drops its fields rather than leaving them stranded — `components/settings-view.tsx`
- [ ] A project whose scout found no tracker reads "none" rather than a guess — `lib/settings-data.ts` (#461)
- [ ] Escape inside a tracker field blurs the field rather than closing settings — `components/settings-view.tsx`
- [ ] Guidance lists the repo rules the review agents read, each with a severity chip — `components/settings-view.tsx` (#476)
- [ ] A guidance rule edits inline: severity segmented control, Save, Cancel, Delete — `components/settings-view.tsx` (guidance amendment)
- [ ] Enter saves a guidance rule and Escape closes only the editor, never the settings view — `components/settings-view.tsx` (guidance amendment)
- [ ] An Add Rule control sits at the bottom of the guidance list — `components/settings-view.tsx` (guidance amendment)
- [ ] Saving with empty text is refused — `components/settings-view.tsx`

### Archived surface

- [ ] Archived sessions live at their own main-surface location, leaving by back arrow or Escape with an `esc` hint — `components/archived-view.tsx`
- [ ] The header shows the archived count when there is one — `components/archived-view.tsx`
- [ ] With nothing archived, the surface says so and tells you how sessions get there — `components/archived-view.tsx`
- [ ] Archived sessions are searchable by session title or project name — `components/archived-view.tsx`
- [ ] Escape in the search field clears the search before it can close the view — `components/archived-view.tsx`
- [ ] Archived sessions sort by recent, project, or title through a radio group — `components/archived-view.tsx`
- [ ] Recency sorting parses the fuzzy sidebar times ("now", "1h", "2d", "3w") into a real order — `components/archived-view.tsx`
- [ ] Each archived row carries its target icon, title, reviewed tick, time, and a project chip with the project's glyph — `components/archived-view.tsx`
- [ ] Each archived row exposes an Unarchive control on hover or focus — `components/archived-view.tsx`
- [ ] Selecting an archived row opens that session — `app/archived/page.tsx`
- [ ] An empty search result says which query matched nothing — `components/archived-view.tsx`

---

## 9. Command menu

- [ ] `⌘P` (and `Ctrl+P`) toggles the command menu from anywhere — `components/command-menu.tsx` (R7)
- [ ] The sidebar's Search row and the rail's Search button open the same menu — `components/app-sidebar.tsx`, `components/command-menu.tsx`
- [ ] The menu is a modal command dialog with fuzzy filtering, arrow-key navigation, Enter to run, and Escape to close — `components/command-menu.tsx`, `components/ui/command.tsx` (#477)
- [ ] Every entry shows its group name beside its title — `components/command-menu.tsx`
- [ ] Sessions appear as entries, keyed by title with the project and host as extra keywords — `components/command-menu.tsx` (#477)
- [ ] Archived sessions are excluded from the menu — `components/command-menu.tsx`
- [ ] Running a session entry opens the chat and routes to that session — `components/command-menu.tsx`
- [ ] Each project contributes a "Context Map" entry and a "New Chat in <project>" entry — `components/command-menu.tsx` (#477)
- [ ] Each settings page is an entry: Environments, Appearance, Keyboard Shortcuts, Projects — `components/command-menu.tsx` (#477)
- [ ] Add Project and Add Environment are action entries — `components/command-menu.tsx` (#477)
- [ ] An empty result states that no commands match — `components/command-menu.tsx`
- [ ] Board and diff content is deliberately not searchable from the menu — `components/command-menu.tsx` (#477)
- [ ] The menu's open state lives in the store, so both the keybinding and the button drive one controlled component — `components/command-menu.tsx`, `lib/store.ts`

---

## 10. Add-project flow & scouting

### Add Project

- [ ] Add Project is a dialog with a source picker and an inline directory browser — `components/add-project-dialog.tsx`
- [ ] There is no detected-nearby-directories list and no recents — the browser IS the picker — `components/add-project-dialog.tsx` (detected-dirs ruling)
- [ ] The source picker lists every environment with its host glyph and a tick on the current one — `components/add-project-dialog.tsx` (R3)
- [ ] The source picker ends with an "Add Environment" escape that hands off to the pairing dialog — `components/add-project-dialog.tsx`
- [ ] Switching source clears the selected path and reloads the browser against that host's filesystem — `components/add-project-dialog.tsx`
- [ ] The Add action is inert until a folder is selected — `components/add-project-dialog.tsx`
- [ ] The dialog reopens in a clean state each time — `components/add-project-dialog.tsx`
- [ ] Adding a project produces no orchestrator turn; the sidebar state carries it — `components/add-project-dialog.tsx`, `components/shell.tsx` (UI-acts ruling)
- [ ] Adding a project navigates straight to its processing view — `components/shell.tsx`

### Directory browser

- [ ] The browser is the port of the shipped component, fed by the same `listDir` contract — `components/directory-browser.tsx`
- [ ] A breadcrumb shows the current path split into clickable segments, with the current segment marked and inert — `components/directory-browser.tsx`
- [ ] An Up control ascends one level and is inert at the root — `components/directory-browser.tsx`
- [ ] A typed path bar navigates on Enter — `components/directory-browser.tsx`
- [ ] Clicking a row descends into it — `components/directory-browser.tsx`
- [ ] Arrow keys move focus between rows, Enter descends, and Backspace ascends — `components/directory-browser.tsx`
- [ ] A folder containing a repository wears a "repo" badge — `components/directory-browser.tsx`
- [ ] An unreadable folder renders dimmed, is marked `aria-disabled`, and cannot be entered — `components/directory-browser.tsx`
- [ ] An invalid typed path shows an inline alert and invalidates the current selection — `components/directory-browser.tsx`
- [ ] An empty folder says "No folders here" — `components/directory-browser.tsx`
- [ ] An in-flight listing from a previous source can never win over the current one — `components/directory-browser.tsx`
- [ ] The list is a `listbox` with `option` rows and roving tabindex — `components/directory-browser.tsx`

### Add Environment (pairing)

- [ ] Pairing takes an address and a one-time code, never a bare code — `components/add-remote-dialog.tsx` (pairing ruling)
- [ ] The code field's helper names the `rennet pair` command and states that the link it prints fills both fields — `components/add-remote-dialog.tsx`
- [ ] Connect is inert until both fields carry a value — `components/add-remote-dialog.tsx`
- [ ] While connecting, the fields lock and the action shows a spinner — `components/add-remote-dialog.tsx`
- [ ] On success the dialog states which machine it connected to and offers Done and "Browse Its Projects" — `components/add-remote-dialog.tsx`
- [ ] "Browse Its Projects" reopens Add Project with the new environment preselected — `components/add-remote-dialog.tsx`, `components/shell.tsx`
- [ ] The dialog reopens in a clean state each time — `components/add-remote-dialog.tsx`
- [ ] The environment's name is derived from the address's first label — `components/add-remote-dialog.tsx`

### Project processing: the scout phase

- [ ] Adding a project opens a progress view, not a live-filling map — `components/project-indexing-view.tsx` (no-live-map ruling)
- [ ] The Add Project dialog stays a host + folder picker; everything after Add happens on this surface — `components/add-project-dialog.tsx`, `components/project-indexing-view.tsx` (#487)
- [ ] The scout runs as its own progression before context-map generation begins — `components/project-indexing-view.tsx` (#487)
- [ ] The scout's steps are: read the git remotes (naming the forge origin), checked for tracker markers and CI config, scout reading README/CONTRIBUTING/agent files, scout returned — `components/project-indexing-view.tsx` (#487, #461)
- [ ] The scout's return step states how many answers were detected and how many were guessed — `components/project-indexing-view.tsx` (#487)
- [ ] The deterministic pass runs before the model-backed scout seat, not after it — `components/project-indexing-view.tsx` (#461)
- [ ] Context-map generation starts exactly when the scout returns, never before — `components/project-indexing-view.tsx` (#487)
- [ ] The header status reads "scouting", then "indexing", then "indexed" — `components/project-indexing-view.tsx` (#487)

### Project processing: the prefilled questionnaire

- [ ] The questionnaire appears the moment the scout returns, while the map generates beneath it — `components/project-indexing-view.tsx` (#487)
- [ ] Its heading asks whether the prefilled answers look right and states that skipping is fine and everything stays editable in Settings — `components/project-indexing-view.tsx` (#487, #461)
- [ ] The questionnaire is never a gate: the map completes and the exits appear whether or not it is answered — `components/project-indexing-view.tsx` (#487, Rule Zero)
- [ ] Every answer carries a provenance chip reading "detected" or "guessed" — `components/project-indexing-view.tsx` (#487)
- [ ] A guessed answer's chip reads in the machine's register; a detected answer's reads neutral — `components/project-indexing-view.tsx` (#487)
- [ ] Every answer carries a one-line hint naming where it came from and what it is used for — `components/project-indexing-view.tsx` (#487)
- [ ] The prefilled answers are issue tracker, default branch, worktree location, gate command, and logo — `components/project-indexing-view.tsx` (#487, #461)
- [ ] An answer with a fixed option set renders as a segmented pick; the rest render as editable monospace inputs — `components/project-indexing-view.tsx` (#487)
- [ ] Escape inside a questionnaire field blurs the field rather than leaving the view — `components/project-indexing-view.tsx`
- [ ] The questionnaire's one action is "Looks right", which collapses it to a confirmation line stating the setup is saved and editable in Settings → Projects — `components/project-indexing-view.tsx` (#487)
- [ ] The project's own mark is one of the scout's prefilled answers, detected from the repo and shown with its provenance chip — `components/project-indexing-view.tsx` (R65, #487)
- [ ] The mark's hint states where it was found and that it is what shows in the sidebar — `components/project-indexing-view.tsx` (R65)
- [ ] The mark stays editable after the flow, in Settings → Projects → Identity — `components/settings-view.tsx`, `components/project-icon.tsx` (R65)
- [ ] The mark the scout detects and the mark Identity offers are the same product concern: the scout answers with a repo logo path while Identity offers a fixed glyph vocabulary, and the two are to be reconciled when this lands for real — `components/project-indexing-view.tsx`, `components/settings-view.tsx` (R65)
- [ ] The logo is a cosmetic answer and never enters agent context — `components/project-indexing-view.tsx` (R65, #461)

### Project processing: map generation and the exits

- [ ] The map steps are: scanned the working tree (file and scope counts), mapped imports across scopes, knowledge workers reading scopes (with a live N/M scope counter and hypothesis count), verifying hypotheses against cited evidence (resolving to confirmed/rejected counts), connected the dots across scopes — `components/project-indexing-view.tsx` (#460)
- [ ] A step appears only once it starts, spins while running, and ticks when done — `components/project-indexing-view.tsx`
- [ ] The verify step confirms hypotheses itself; the human is never a gate on it — `components/project-indexing-view.tsx` (#460)
- [ ] Leaving early (back arrow or Escape) does not cancel processing; the sidebar row carries the state — `components/project-indexing-view.tsx`
- [ ] The sidebar row's indexing spinner is synchronized with the processing timeline — `lib/store.ts`, `components/app-sidebar.tsx`
- [ ] On completion a "Context Map Ready" block states the scope count, file count, and confirmed/rejected statement counts — `components/project-indexing-view.tsx`
- [ ] The ready card's only action is "View Context Map" — `components/project-indexing-view.tsx` (#487)
- [ ] A full-width "Start a Review" call to action sits below the ready card and is the flow's primary exit — `components/project-indexing-view.tsx` (#487)
- [ ] Start a Review opens New Chat on the project just added — `components/project-indexing-view.tsx`, `app/projects/[id]/indexing/page.tsx` (#487)
- [ ] The CTA scrolls itself into view when it appears at the bottom of a scrolled timeline — `components/project-indexing-view.tsx` (#487)

### Context map

- [ ] The context map is reachable as a standalone full view, from the project's sidebar context menu, from the New Chat header, from the command menu, and from the processing ready block — `app/projects/[id]/map/page.tsx`, `components/app-sidebar.tsx`, `components/new-chat-view.tsx`, `components/command-menu.tsx` (no-live-map ruling)
- [ ] Leaving the map always lands on that project's New Chat — `app/projects/[id]/map/page.tsx` (no-live-map ruling)
- [ ] The map is also reachable inside a session from the left half of the Map·Diff pill — `components/main-surface.tsx` (R49 amendment)
- [ ] A base line names the repo, ref and object id the map was built from, with a freshness chip reading "● current" or "◐ building" — `components/context-map.tsx`
- [ ] The structure pane lists scopes with an importer count and a file count, and states the scope and file totals in its header — `components/context-map.tsx`
- [ ] Expanding a scope reveals its sample files — `components/context-map.tsx`
- [ ] The dependency neighborhood renders as an SVG with the selected scope at the center, importers on the left, imports on the right, and arrowed edges — `components/context-map.tsx`
- [ ] Neighborhood nodes are clickable and keyboard-activatable, re-centering the graph on the chosen scope — `components/context-map.tsx`
- [ ] A scope with no edges says so instead of rendering an empty graph — `components/context-map.tsx`
- [ ] The detail pane has Knowledge and Details tabs, with the knowledge tab showing its statement count — `components/context-map.tsx`
- [ ] Each knowledge statement shows its subject, confidence, status chip, claim, and evidence anchors — `components/context-map.tsx`
- [ ] A proposed statement offers confirm, reject, and discuss; confirmed and rejected statements show their state and drop the controls — `components/context-map.tsx`
- [ ] A rejected statement dims rather than disappearing — `components/context-map.tsx`
- [ ] A scope with nothing learned says so — `components/context-map.tsx`
- [ ] The Details tab lists the scope's name, root, file count, test count, imports and importers — `components/context-map.tsx`
- [ ] The shipped map's ask rail is absent; the session chat column plays that role — `components/context-map.tsx`

### New Chat

- [ ] New Chat is a full-view takeover with no chat column, since no session exists yet — `components/new-chat-view.tsx`
- [ ] Its header carries a back arrow, a `project › New Chat` trail, a Map control, and an `esc` hint — `components/new-chat-view.tsx`
- [ ] Escape closes the page — `components/new-chat-view.tsx`
- [ ] The headline reads "What should we review in <project>?" with the project name as a headline-sized inline picker — `components/new-chat-view.tsx`
- [ ] Changing the project resets the selected target and updates the URL — `components/new-chat-view.tsx`, `app/new-chat/page.tsx`
- [ ] The composer carries a target chip naming the current review target, with an X to reset it to the current checkout — `components/new-chat-view.tsx`
- [ ] Send is inert while the message is empty — `components/new-chat-view.tsx`
- [ ] The smart list is one list with no zones; a row's state gives it its look — `components/new-chat-view.tsx` (wireframe 05, R25 restyle)
- [ ] Tabs All / Needs you / Mine / Local / PRs each carry a live count — `components/new-chat-view.tsx`
- [ ] A text filter matches PR number, title, branch, repo and author, or branch and repo for a local row — `components/new-chat-view.tsx`
- [ ] Escape clears the filter first and only closes the page on a second press — `components/new-chat-view.tsx`
- [ ] "Current Checkout · main" is the pinned first row and the default target, annotated "no target — talk about the project" — `components/new-chat-view.tsx`
- [ ] A local row shows its branch in monospace, a "● dirty" mark when the working tree is dirty, an optional note, and its state chip — `components/new-chat-view.tsx`
- [ ] A dirty branch's glyph reads in the accent color — `components/new-chat-view.tsx`
- [ ] A PR row shows its title, CI state, state chip, then a second line with the number, branch, author mark, colored +adds/−dels, file count, and a "checked out locally" chip where it applies — `components/new-chat-view.tsx` (R25 restyle)
- [ ] CI collapses to a status dot except a failing CI, which stays a red "CI failing" chip — `components/new-chat-view.tsx` (R25 restyle)
- [ ] The state chip vocabulary is the unified target vocabulary: Needs you (filled accent), Merged (dimmed), Reviewed (green), Your PR, Teammate PR, Your branch — `components/new-chat-view.tsx`, `components/target-badge.tsx` (R35 target vocabulary)
- [ ] A merged row renders dimmed and lifts on hover — `components/new-chat-view.tsx`
- [ ] The repo column is dropped when the project has a single repo and returns for a multi-repo workspace — `components/new-chat-view.tsx` (R25 restyle)
- [ ] The selected row is marked with a tick, not a side stripe — `components/new-chat-view.tsx` (R25 restyle)
- [ ] Clicking a row starts the session — it is not merely a target selection — `components/new-chat-view.tsx` (R26 row-click ruling)
- [ ] A project with nothing to review says "no open branches or pull requests yet"; a filtered-out list says "nothing matches" — `components/new-chat-view.tsx`
- [ ] Starting a row with a scenario behind it opens that scenario's session and adds its sidebar row — `app/new-chat/page.tsx` (R54)
- [ ] Starting any other row mints a real session, derives its title from the target, and carries the typed ask in as the first turn — `app/new-chat/page.tsx`, `components/session-view.tsx` (R26 row-click ruling)

### Minted session and the run

- [ ] A minted session renders the same chat header and trail as a scenario session, never a bespoke bar — `components/session-view.tsx` (R52)
- [ ] A minted session's chat collapses through the same width pattern as the shell's — `components/session-view.tsx` (R52 amendment)
- [ ] The main surface of a minted session shows the run view until the boards are ready — `components/session-view.tsx`
- [ ] The run's prep lines differ by target kind: a PR gets fetch/worktree/read-diff/related-context; a branch gets working-tree/map-commits/read-diff/related-context — `components/run-view.tsx`
- [ ] The run then shows a five-row lens table where each lens progresses independently from queued → drafting → its result counts — `components/run-view.tsx`
- [ ] The lens table appears only once the drafting phase is about to begin — `components/run-view.tsx`
- [ ] The run then shows "Cleaning up drafts · post-process pass" and "Composed the board" — `components/run-view.tsx` (R39)
- [ ] When the run completes the surface swaps to the real board surface with its switcher, boards and exit CTA — `components/session-view.tsx`
- [ ] Every run label derives from Rennet's own pipeline: prep → lens drafting agents → post-process editor → orchestrator composes — `components/run-view.tsx` (R4)

---

## 11. Onboarding / coach marks

- [ ] Onboarding is contextual coach marks, never a linear N-of-M tour — `lib/tour.ts`, `components/coachmark.tsx` (R55)
- [ ] Exactly one mark is on screen at any time — `lib/tour.ts` (R55)
- [ ] Marks are chained per surface: dismissing one opens a short gap before the next on the same surface fires — `lib/tour.ts` (R55)
- [ ] The system carries nine marks: start-review, new-chat, smart-list, lenses, highlight, fab, verdict, draft, dispatch — `lib/tour.ts` (R55 + #487's ninth, R59)
- [ ] The start-review mark sits first in system order, so it outranks the sidebar's Start Here while the indexing CTA is on screen — `lib/tour.ts` (#487, R59)
- [ ] The start-review mark anchors the full-width Start a Review CTA and points at it from above — `lib/tour.ts`, `components/project-indexing-view.tsx` (#487, R59)
- [ ] The new-chat mark is the single first-run spotlight, armed only when there are no sessions anywhere — `components/app-sidebar.tsx` (R55)
- [ ] Marks anchor to chrome only — buttons, switchers, containers — never to board content — `lib/tour.ts`, `components/coachmark.tsx` (R55)
- [ ] A mark renders a spotlight cutout over its anchor plus an anchored card — `components/coachmark.tsx` (R55)
- [ ] The spotlight is a single box-shadow spread with pointer-events off, so the highlighted control stays clickable underneath it — `components/coachmark.tsx` (R55 amendment)
- [ ] The spotlight follows its anchor through scrolling and through the sidebar's width transition — `components/coachmark.tsx` (R55 amendment)
- [ ] The spotlight inherits its anchor's own border radius plus padding — `components/coachmark.tsx`
- [ ] Anchors resolve by a `data-tour="<id>"` attribute, so wiring a surface is one attribute on one element — `components/coachmark.tsx` (R55 amendment)
- [ ] A full-region anchor (the board) parks its card in the middle rather than off the viewport — `components/coachmark.tsx`, `lib/tour.ts` (R55 amendment)
- [ ] Interacting with the anchored thing retires its mark — you learned it by doing it — `components/coachmark.tsx` (R55)
- [ ] Every card carries a dismiss ✕ and a "Skip all tips" control — `components/coachmark.tsx` (R55, law 10)
- [ ] Escape or an outside press dismisses the active mark — `components/coachmark.tsx` (R55 amendment)
- [ ] "Skip all tips" retires the whole system for good — `lib/tour.ts` (R55)
- [ ] Seen-state and the skip-all flag persist across reloads — `lib/tour.ts` (R55)
- [ ] Help → Replay Tour clears seen-state and skip-all and re-arms the marks — `lib/tour.ts`, `components/app-sidebar.tsx` (R55)
- [ ] `?tour=reset` wipes the persisted record at load, for refinement — `lib/tour.ts` (R55 amendment)
- [ ] A failed write to persistent storage degrades to per-session memory rather than breaking — `lib/tour.ts`
- [ ] A mark whose surface unmounts leaves the running, and the next eligible mark takes over — `lib/tour.ts`
- [ ] Mark cards are titled and bodied in-world, and never explain the product to itself — `lib/tour.ts` (law 10)
- [ ] The spotlight and card animations respect `prefers-reduced-motion` — `components/coachmark.tsx`
- [ ] The mark card does not steal focus when it opens or when it closes — `components/coachmark.tsx`

---

## 12. Scenario machinery

- [ ] Four named scenarios exist: `teammate`, `rounds`, `returned`, `propose` — `lib/scenarios/index.ts` (SCENARIOS.md)
- [ ] A scenario carries an id, a project, a sidebar session record, a CTA label, a transcript, a partial map of lens boards, a hand-off mode, optional seed asks, and optional completed rounds — `lib/scenarios/index.ts` (SCENARIOS.md)
- [ ] A sidebar session row maps 1:1 to a scenario, and selecting it is the scenario switch — `lib/resolve-slug.ts`, `components/shell.tsx` (SCENARIOS.md)
- [ ] The registry is a lookup of fixtures, not a session engine — `lib/scenarios/index.ts` (SCENARIOS.md)
- [ ] The first run opens with zero sessions everywhere — no pinned, no archived — `lib/sidebar-data.ts` (R54)
- [ ] Each scenario's session row is earned by starting it from the smart list or by deep-linking its route, and it is added idempotently — `lib/store.ts`, `app/s/[slug]/page.tsx` (R54)
- [ ] `teammate` is a Needs-you teammate PR with all five lenses, a post-review hand-off, and a "Write Review" CTA — `lib/scenarios/teammate.ts` (SCENARIOS.md, R35 amendment)
- [ ] `rounds` is your branch pre-PR with all five lenses, two pre-staged real findings as asks, a rounds hand-off whose PR is not ready, and a "Continue" CTA — `lib/scenarios/rounds.ts` (SCENARIOS.md, R34)
- [ ] `returned` is the same session after round 1: generation-2 boards, one completed round in the ledger, and a ready PR — `lib/scenarios/returned.ts` (SCENARIOS.md, R57, R58)
- [ ] `propose` is a spec-only session carrying the Design board alone, so the switcher shows one lens segment — `lib/scenarios/propose.ts` (SCENARIOS.md)
- [ ] A scenario's pre-staged asks are seeded into the review store on entry, and the prior scenario's asks are cleared first so the count cannot drift — `components/scenario-seeder.tsx` (R29)
- [ ] Seeding is programmatic, not a gesture: it flies no bubbles and pops no pip — `components/scenario-seeder.tsx`, `lib/fab-signal.ts` (R50)
- [ ] Every board fixture is drafted from a real merged PR by agents running the real lens prompts, with real paths, hunks and line numbers — `lib/fixtures/*.ts` (SCENARIOS.md)
- [ ] Every citation in a board resolves against the actual repo checkout — `app/api/source/route.ts`, `lib/fixtures/*.ts` (SCENARIOS.md)
- [ ] Flagged fixtures carry a start-folded "Checked and Cleared" section recording what both seats verified and dismissed — `lib/fixtures/flagged.ts`, `lib/fixtures/b/flagged.ts` (R25)

---

## 13. Prototype-only / not for import

These are demo scaffolding. The real client must **not** inherit them; each line
here is a thing to delete, replace with a real source, or refuse to build.

- [ ] The scenario registry itself — a fixture lookup standing in for real sessions — `lib/scenarios/`
- [ ] The scenario seeder that stages asks on entry — `components/scenario-seeder.tsx`
- [ ] `DEFAULT_SCENARIO` and the fallback that makes a minted session render the teammate scenario's boards — `lib/scenarios/index.ts`, `components/session-view.tsx`
- [ ] Hardcoded scenario slugs in navigation fallbacks (`/s/teammate` after a stranded removal or archive) — `components/shell.tsx`
- [ ] The hardcoded `"s2"` session id stamped when a round completes — `app/s/[slug]/run/page.tsx`
- [ ] The hardcoded `p1` target in `addScenarioSession` — `lib/store.ts`
- [ ] Every board fixture file — the real client's boards come from the lens pipeline — `lib/fixtures/`
- [ ] The diff fixture, which is stale fictional auth-refactor content rather than the real patchset behind any current scenario — `lib/diff-data.ts`
- [ ] The transcript fixtures and the scripted follow-up exchange pairs the composer cycles through — `lib/conversation-data.ts`, `lib/scenarios/*-transcript.ts`
- [ ] The canned orchestrator replies for quote threads and Explain — `lib/quote-thread-demo.ts`
- [ ] The smart-list fixtures, including the `p2` furniture rows — `lib/smart-list-data.ts`
- [ ] The sidebar seed tree of fake hosts and projects (dev-box, gpu-01, billing-service, ranking-model, orbital) — `lib/sidebar-data.ts`
- [ ] The context-map fixtures (scopes, edges, knowledge statements, base oid) — `lib/context-map-data.ts`
- [ ] The settings fixtures: project settings, guidance rules, issue-tracker config, source-control detection, agent detection, review roles, environment info, latest-daemon version — `lib/settings-data.ts`
- [ ] The scout's hardcoded prefilled answers, which stand in for a real scout's findings — `components/project-indexing-view.tsx`
- [ ] The questionnaire's "Looks right" writing nothing but local state — `components/project-indexing-view.tsx`
- [ ] The tracker section's edits writing nothing but local state — `components/settings-view.tsx`
- [ ] The in-memory fake filesystem behind the directory browser — `lib/fake-fs.ts`
- [ ] `/api/source` reading the developer's own checkout two levels up — the real client hydrates from the captured patchset — `app/api/source/route.ts`
- [ ] The `code` element kind carrying literal code bytes; only `code-ref` survives — `lib/lens-data.ts` (R26)
- [ ] All simulated timelines and their magic constants: the run view, the round run, the regeneration, and project processing — `components/run-view.tsx`, `components/round-report.tsx`, `components/project-indexing-view.tsx`
- [ ] The `setTimeout` that settles a newly added project's indexing state — `lib/store.ts`
- [ ] The `window.__appStore` debug handle — `lib/store.ts`
- [ ] The pretend Reconnect and Update Daemon busy states that settle back to the same fixture state — `components/settings-view.tsx`
- [ ] Cosmetic settings toggles that flip local state and write no override: source-control enable, agent enable, model mappings, mode switch, review context segmented control — `components/settings-view.tsx`
- [ ] The simulated pairing handshake that always succeeds after two seconds — `components/add-remote-dialog.tsx`
- [ ] The simulated post/open-PR delay in the exit action — `components/handoff-action.tsx`
- [ ] The deterministic string-surgery stand-in for the orchestrator's rework of a span — `components/handoff-view.tsx`, `components/rounds-lanes.tsx`
- [ ] The quote-substring matching used to find which draft block a selection belongs to — `components/handoff-view.tsx`, `components/rounds-lanes.tsx`
- [ ] Hardcoded external URLs: the `acme/orbital` review link and the `rbutera/rennet/pull/438` PR link — `components/handoff-view.tsx`, `components/rounds-lanes.tsx`
- [ ] The hand-rolled theme-pack CSS blocks copied from upstream palettes — `app/globals.css`, `lib/theme-packs.ts`
- [ ] The copied `--rn-*` palette block; the real client imports `packages/theme` — `app/globals.css`
- [ ] `localStorage` as the coach-mark persistence layer; the product uses `client-settings.json` — `lib/tour.ts` (R55)
- [ ] The `generator: 'v0.app'` metadata left over from the export — `app/layout.tsx`
- [ ] The vendored `components/ui/*` primitives, which the real client takes from `packages/ui` — `components/ui/`
- [ ] The Update dialog's invented changelog bullets — `components/app-sidebar.tsx`

---

## 14. Open build items

Every other line in this file records behavior the prototype already has. This
section is the residue: work that is **not built**, or built wrong. It is not a
list of undocumented surfaces — that list existed, Rai ruled on all of it, and
the blessed behaviors were promoted to rulings R59–R68 and annotated into their
home sections above.

These four are tracked on **[#492](https://github.com/rbutera/rennet/issues/492)** and feed the [#489](https://github.com/rbutera/rennet/issues/489) plan's spike-polish lane.

- [ ] **Keybindings are advertised but unwired.** The registry lists ⌘P, ⌘K, ⌘N, ⌘B, ⌘J and ⌘, ; only ⌘P is bound, and R7 explicitly assigns ⌘K to the command menu. A settings page that lists a binding is a promise — wire them or cut the rows — `lib/settings-data.ts`, `components/command-menu.tsx` (R7, #492)
- [ ] **The impl↔test flip is unbuilt.** R41 records it living in the code-block header, right side beside Copy, with placement settled on #32 — `components/code-block.tsx` (R41, #32, #492)
- [ ] **`Discuss` on a finding's fix is inert.** R68 specifies it: create a local comment citing the fix, then move focus to the orchestrator chat — `components/lens-board.tsx` (R68, R24, #492)
- [ ] **The run route's header spacer is 40px.** R60 makes the run route a session surface, so it takes 56px; the minted session's own pre-boards spacer is already 56px, so the two disagree — `app/s/[slug]/run/page.tsx` vs `components/session-view.tsx` (R60, #492)

Two inert controls Rai did not rule on. They need a ruling before they need code, and are deliberately left open rather than guessed at:

- [ ] The spec-header's "raw ⌘R" control is inert, and its chord is in no keybinding registry — `components/lens-board.tsx`, `lib/settings-data.ts`
- [ ] The keyboard-shortcuts page's per-row "Change" control is inert — `components/settings-view.tsx`

One open architectural question, unchanged by this batch:

- [ ] The named "composition Board" of #457 Topology A has no surface: the prototype has lens boards and nothing that presents as the orchestrator-authored composition. The plan must decide whether it is a surface or whether the lens boards are it — `components/main-surface.tsx` (#457)
