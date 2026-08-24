# Board-UX prototype (spike)

The living UX prototype for the board/harness-shell redesign — ticket
[rbutera/Rennet#458](https://github.com/rbutera/Rennet/issues/458) (map
[#452](https://github.com/rbutera/Rennet/issues/452)). It began as a v0.dev
export (the prompt-0 harness shell) and continues locally with Claude as the
generator after v0 credits ran out. **This is a prototype, not app code**:
styling stays minimal and neutral; UX structure, density, and interaction
states are the deliverable. It is deliberately excluded from the pnpm
workspace and every repo gate.

## Authority and history

- The canonical prompt set, every ruling (R1–R16 plus later ones), and the
  full iteration log live in ONE comment on #458:
  <https://github.com/rbutera/Rennet/issues/458#issuecomment-5387762167>.
  Read it before changing the prototype; append to it (edit the comment via
  `gh api repos/rbutera/Rennet/issues/comments/5387762167 -X PATCH -F body=@file`)
  when a session produces new rulings.
- Vocabulary comes from root `CONTEXT.md` (board block kinds, code block
  card, reference chip, Source, Rennet host). The murder-board map issues
  (#452 and children) are the design authority — NOT the shipped lens code
  in `packages/app-ui`, which the redesign replaces.
- Screenshots worth keeping go to `wireframes/` at the repo root
  (`prototype-shell-*.png`, `lens-*.png`, `reference-v0-shell.png`).

## Run it

```sh
cd spikes/board-prototype
pnpm install --ignore-workspace   # plain `pnpm install` resolves the workspace root and fails
node_modules/.bin/next dev -p 3947
```

To view from another tailnet machine: `tailscale serve --bg 3947` — the
hostname is already in `next.config.mjs` `allowedDevOrigins` (without that,
cross-origin dev requests 403 and HMR dies; add new hostnames there).

## What's inside

- **Shell** (`components/app-shell.tsx`): collapsible left sidebar (projects
  grouped by source, sessions nested, search ⌘P, settings/help/update
  bottom-anchored when collapsed), chat column with speech-bubble user turns
  and harness-derivable tool-use lines, main surface with view switcher +
  "Hand off" CTA.
- **Add project / Add remote** (`components/add-project-dialog.tsx`,
  `add-remote-dialog.tsx`): source toggle + the in-app directory browser
  (no detected-dirs list — ruled out), pairing by address + one-time code.
  UI-driven acts do NOT narrate into the chat (ruling); only conversational
  asks produce orchestrator turns.
- **Directory browser** (`components/directory-browser.tsx`): ported from
  `packages/app-ui/src/components/directory-browser.tsx` with the daemon's
  `fs.listDir` RPC swapped for `lib/fake-fs.ts` (in-memory trees per source
  kind). Keep the port faithful — breadcrumb, typed path bar, keyboard nav,
  repo badges, unreadable rows, invalid-path handling.
- **Lens boards** (`components/lens-board.tsx`, `lib/lens-data.ts`): the five
  lenses as document-flow boards of typed elements (prose, code, callout,
  finding, annotation, thread, decision, requirement, noise-group) with
  foldable sections (fold = gist + counts). View switcher: Reading order /
  Spec / Decisions / Flagged / Noise / Diff (Diff is a placeholder — its own
  story).
- **Fixtures** (`lib/fixtures/*.ts`): generated from the REAL merged PR
  [#438](https://github.com/rbutera/Rennet/pull/438) — real paths, hunks,
  line numbers, honest coverage counts, one cross-model disagreement. To
  regenerate or add a lens fixture, fan out an agent that reads
  `gh pr diff <n> --repo rbutera/Rennet` and conforms to `lib/lens-data.ts`;
  never invent APIs the diff doesn't contain.

## Working agreement for future sessions

1. Features-only prompts; the prototype owns its layout. Restate a component
   tree and get Rai's confirmation before structural changes.
2. Minimal styling, one font; no invented activity labels — every tool-use
   line must be derivable from a real harness.
3. No explanatory chrome or self-promises in the UI; labels name things.
4. Record every ruling on the #458 canonical comment as it happens, and
   resteer later stories/tracker issues the same session.
5. Verify changes live (Playwright against localhost) before reporting them;
   `npx tsc --noEmit` is the spike's only gate.
