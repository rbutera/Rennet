# shadcn/ui (Base UI) Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution model chosen by Rai: **wave per section, one PR per wave, Opus implementation agents, dual review gate (Opus + Codex) per wave.** `pnpm check` green before every push.

**Goal:** Replace Rennet's hand-rolled UI layer with vendored shadcn/ui components on Base UI, themed to Affineur's Bench, across all surfaces including `app.tsx`.

**Architecture:** New `packages/ui` (`@rennet/ui`) is the vendored component kit — shadcn core on its Base UI default plus primitive-agnostic libs (shiki, react-resizable-panels, react-markdown), importing only `@rennet/theme`/`@rennet/types`. The existing UI package is renamed `packages/app-ui` (`@rennet/app-ui`) and holds Rennet's composites/screens, refactored wave-by-wave onto the kit. Theming is a single `@theme inline` extension in `packages/theme/src/theme.css` mapping shadcn semantic names onto `--rn-*` tokens — no shim, no second palette source.

**Tech Stack:** React 19.2.8, Tailwind v4 (CSS-first), shadcn/ui core on `@base-ui/react` (MIT), lucide-react, class-variance-authority + clsx + tailwind-merge, shiki, react-resizable-panels, react-markdown. Vite 8 / Electron 43 / Vitest 4 + happy-dom unchanged.

**Spec:** This document's *Decisions* section below (product decisions grilled with Rai, 2026-08-20; no separate spec file).

## Decisions (the spec)

1. **Base UI supersedes React Aria** as the kit's primary primitive family (Rai, 2026-08-20). shadcn core has shipped Base UI variants of every component since Dec-2025 and defaults to Base UI since Jul-2026, so shadcn core *is* the Base UI registry. The package is `@base-ui/react` (MUI renamed it from the frozen `@base-ui-components/react@1.0.0-rc.0`; verify at install). **Radix is NOT banned** (Rai, 2026-08-20 — an earlier "no Radix" line was an over-inference, corrected): a Radix dependency is fine where a shadcn component brings it — notably `cmdk` for the command palette. The soft preference is to not run two *different* families for the *same* primitive gratuitously, but a pragmatic Radix/cmdk dep is acceptable, not a blocker.
2. **Registry policy:** shadcn core is primary. Other registries allowed case-by-case, license-verified **per component** at pull time (none admitted wholesale). Blocklist (checked 2026-08-20, re-verify at pull time): Origin UI (mixed licensing, parts not MIT), Aceternity (published proprietary terms), animate-ui (MIT + Commons Clause — forbids selling), Kibo UI + diceui (MIT but Radix-based — only if Base UI native falls short). Gap-fillers if needed: 9ui, basecn, baseui-cn (all MIT, Base UI).
3. **Theme:** Affineur's Bench identity kept. `palette.css` stays the only hex source. shadcn semantic tokens defined in `theme.css` `@theme inline`, mapped from `--rn-*`. Dark mode comes free (`--rn-*` already flips on `[data-scheme="dark"]`).
4. **Scope:** full sweep — all tiers T1 (primitives + overlays), T2 (command palette, resizable, markdown, toast), T3 (shiki, diff, lists/trees, icons), T4 (conversation surfaces re-platformed on shadcn's native Base UI AI-chat components — same UX, redesign is a later separate effort).
5. **Icons:** lucide-react replaces `icons.tsx`. `brand-mark.tsx` (wordmark glyph) stays.
6. **Structure:** vendored kit = new `packages/ui`; existing package renamed `packages/app-ui`. Boundary: `@rennet/ui` → {types, theme} only; `@rennet/app-ui` → {types, protocol, theme, ui}.
7. **Docs ride in the same wave as the change they describe** (project standing obligation).

## Global Constraints

- All new deps: exact version pins, `pnpm-lock.yaml` committed, version ≥ 7 days old (`minimumReleaseAge: 10080`). MIT/permissive license only; license gate must pass.
- No hardcoded hex in components — `packages/ui/src/hex-lint.test.ts` pattern + eslint rule apply to BOTH ui packages. Vendored code's `--color-*` utilities are fine (they resolve to tokens); literal hex/oklch is not — strip any from pulled components.
- Type/radius off-ramp forbidden: only the enumerated ramp (`text-2xs..2xl/display`, `rounded-micro/chip/control/surface/window` + the shadcn aliases defined in Wave 1). `design-ramp.test.ts` enforces.
- Radix/cmdk are acceptable where a shadcn component brings them (e.g. cmdk for the command palette) — not banned. The `@rennet/*` package-boundary arrows (kit imports only `types`+`theme`) and the license gate still apply to every dependency.
- Gate command: `pnpm check`. Run before every push. One nx invocation at a time per worktree.
- Semantic test-hook classNames (e.g. `canvas-app`) on existing components must survive refactors — tests select on them.
- Never bundle/commit anything from client repos; no AI attribution.

---

## Wave 0 — Rename + kit scaffold + rulings

One PR. Pure mechanics + the decision docs. No visual change.

### Task 0.1: Rename packages/ui → packages/app-ui

**Files:**
- Move: `packages/ui/` → `packages/app-ui/` (git mv, history-preserving)
- Modify: `packages/app-ui/package.json` (name → `@rennet/app-ui`)
- Modify: `packages/app-ui/project.json` (name → `rennet-app-ui`, sourceRoot + all target paths → `packages/app-ui/...`)
- Modify: `apps/desktop/package.json` (dep `@rennet/ui` → `@rennet/app-ui`)
- Modify: imports in `apps/desktop/src/renderer/index.tsx:3`, `apps/desktop/src/browser/entry.tsx:3`, `apps/desktop/src/persist-publish-privacy.test.ts:21`, `apps/desktop/src/main/occurrence-anchoring.integration.test.ts:22` (`"@rennet/ui"` → `"@rennet/app-ui"`)
- Modify: `scripts/check-boundaries.mjs` (map entry `@rennet/ui` → `@rennet/app-ui`, same permitted set for now; positive-control path `packages/ui/src/...` → `packages/app-ui/src/...`)
- Modify: `CLAUDE.md` package-boundaries paragraph; any `docs/` page naming `packages/ui` (grep `packages/ui` and `rennet-ui` across repo — includes `eslint.config.mjs`, `nx.json` input globs, `tsconfig.base.json` paths if present)

**Interfaces:**
- Produces: `@rennet/app-ui` exporting exactly what `@rennet/ui` exported (`ConnectionHost`, `Connection`, `ConnectionTarget`, `buildRowRegistry`, `Mark`, `placeMarks`, ...unchanged `src/index.ts`).

**Steps:**
- [ ] `git mv packages/ui packages/app-ui`
- [ ] Apply every rename listed above; `grep -rn '@rennet/ui"' --include='*.ts*' --include='*.json' .` and `grep -rn 'rennet-ui\|packages/ui' -r --exclude-dir=node_modules .` must return zero stale hits (the new `packages/ui` doesn't exist yet, so any hit is stale).
- [ ] `pnpm install` (workspace re-link), then `pnpm check`. Expected: green; boundary script prints its normal success line.
- [ ] Commit: `refactor(ui): rename packages/ui to packages/app-ui ahead of kit package`

### Task 0.2: Scaffold new packages/ui kit package

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/project.json`, `packages/ui/src/index.ts`, `packages/ui/README.md`
- Modify: `scripts/check-boundaries.mjs`, `packages/app-ui/package.json`

**Interfaces:**
- Produces: empty `@rennet/ui` package, nx project `rennet-ui`, importable by `@rennet/app-ui`.

**Steps:**
- [ ] `packages/ui/package.json`:

```json
{
  "name": "@rennet/ui",
  "version": "0.3.10",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@rennet/theme": "workspace:*",
    "@rennet/types": "workspace:*",
    "react": "19.2.8",
    "react-dom": "19.2.8"
  }
}
```

- [ ] `tsconfig.json` and `project.json`: copy `packages/app-ui`'s, path-adjusted, nx name `rennet-ui`, tags `["scope:rennet", "layer:ui-kit"]` (a DISTINCT tag from app-ui's `layer:ui` — add a matching `layer:ui-kit` block in `eslint.config.mjs` permitting only `layer:types` + `layer:theme`, add `layer:ui-kit` to `layer:ui`'s allowed deps, and add a check-boundaries positive control importing `@rennet/protocol` from the kit that expects `@nx/enforce-module-boundaries` to fail — a hoisted node_modules resolves a non-declared import, so the ESLint boundary is the real guard). `src/index.ts` starts as `export {};`.
- [ ] `check-boundaries.mjs` map becomes:

```js
["@rennet/ui", new Set(["@rennet/types", "@rennet/theme"])],
["@rennet/app-ui", new Set(["@rennet/types", "@rennet/protocol", "@rennet/theme", "@rennet/ui"])],
```

- [ ] Add `"@rennet/ui": "workspace:*"` to `packages/app-ui/package.json` dependencies.
- [ ] `packages/ui/README.md`: 5 lines — vendored shadcn kit on Base UI; pulls recorded in git history; edits after pull are allowed (shadcn ownership model) but keep them theme/token-shaped so future re-pulls diff cleanly; registry policy pointer to dependency-standard.
- [ ] Negative check: temporarily add `"@rennet/core": "workspace:*"` to the new package.json, run `node scripts/check-boundaries.mjs`, expect throw `@rennet/ui cannot depend on @rennet/core`; revert. (Positive control for the new arrow.)
- [ ] `pnpm install && pnpm check` green. Commit: `feat(ui): scaffold @rennet/ui vendored component kit package`

### Task 0.3: Ruling docs — dependency-standard + delivery-order

**Files:**
- Modify: `docs/src/content/docs/developing/reference/dependency-standard.md`
- Modify: `docs/src/content/docs/developing/reference/delivery-order.md`

**Steps:**
- [ ] dependency-standard: replace the React-Aria-Components renderer-stack selection with the Decisions §1–2 content above (Base UI as the primary family, shadcn core primary, registry policy + license blocklist with evidence, Radix/cmdk acceptable where a component brings it, soft "avoid gratuitously parallel families"). Date it 2026-08-20, Rai's decision.
- [ ] delivery-order: add the shadcn-port arc as current open desktop work (supersedes "no open desktop UI work"), listing Waves 0–7 of this plan, pointer to this file.
- [ ] `pnpm nx run docs:build` (or the docs project's build target per `pnpm nx show project docs`) green. Commit: `docs: record Base UI ruling and shadcn-port delivery arc`

---

## Wave 1 — Theme mapping + shadcn init + core primitives

One PR. Kit becomes real; nothing consumes it yet except smoke tests.

### Task 1.1: shadcn semantic tokens in theme.css

**Files:**
- Modify: `packages/theme/src/theme.css` (extend the existing `@theme inline` block)
- Modify: `packages/app-ui/src/hex-lint.test.ts` + `design-ramp.test.ts` only if the new names trip them (aliases contain no hex/literal sizes, so expected: no change; if design-ramp enumerates radius utility names, add the five shadcn aliases)

**Interfaces:**
- Produces: utilities `bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, `ring-ring`, `rounded-sm|md|lg|xl|2xl` (token-backed) etc., usable by vendored code untouched.

**Steps:**
- [ ] Append inside `@theme inline` in `theme.css`:

```css
  /* shadcn/ui semantic aliases — vendored kit vocabulary, all resolving to
   * --rn-* palette truth. No new colors exist here. */
  --color-background: var(--rn-canvas);
  --color-foreground: var(--rn-ink);
  --color-card: var(--rn-surface);
  --color-card-foreground: var(--rn-ink);
  --color-popover: var(--rn-overlay);
  --color-popover-foreground: var(--rn-ink);
  --color-primary: var(--rn-accent-fill);
  --color-primary-foreground: var(--rn-accent-ink);
  --color-secondary: var(--rn-raised);
  --color-secondary-foreground: var(--rn-ink);
  --color-muted: var(--rn-raised);
  --color-muted-foreground: var(--rn-ink-soft);
  --color-destructive: var(--rn-danger);
  --color-destructive-foreground: var(--rn-surface);
  --color-border: var(--rn-line);
  --color-input: var(--rn-line-strong);
  --color-ring: var(--rn-accent-line);
  /* radius aliases: shadcn classes ↔ Rennet ramp, 1:1 by value */
  --radius-sm: var(--radius-micro);
  --radius-md: var(--radius-chip);
  --radius-lg: var(--radius-control);
  --radius-xl: var(--radius-surface);
  --radius-2xl: var(--radius-window);
```

  Note the pre-existing `--color-accent: var(--rn-accent)` already occupies shadcn's `accent` slot — leave it; vendored components using `bg-accent` get Rennet gold, which is correct. Chart/sidebar token blocks are added in the wave that first pulls those components (5.4), not before.
- [ ] Run theme tests: `pnpm nx run rennet-theme:test` and `pnpm nx run rennet-app-ui:test` — hex-lint, design-ramp, palette-sync, theme.test all green.
- [ ] Commit: `feat(theme): shadcn semantic token aliases over --rn-* palette`

### Task 1.2: shadcn CLI config + base deps + cn()

**Files:**
- Create: `packages/ui/components.json`, `packages/ui/src/lib/utils.ts`, `packages/ui/src/index.css`
- Modify: `packages/ui/package.json`

**Steps:**
- [ ] Add deps (exact-pin the latest version that is ≥7 days old on install day; verify each with `npm view <pkg> time --json`): `@base-ui/react`, `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`.
- [ ] `packages/ui/src/index.css`:

```css
@import "tailwindcss";
@import "@rennet/theme/theme.css";
@import "tw-animate-css";
@source "./components";
```

- [ ] `packages/ui/components.json` (Base UI is the default; keep explicit):

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base",
  "tailwind": { "css": "src/index.css", "baseColor": "neutral", "cssVariables": true },
  "aliases": { "components": "@rennet/ui/components", "utils": "@rennet/ui/lib/utils", "ui": "@rennet/ui/components" }
}
```

  If the CLI rejects workspace aliases, use relative aliases (`~/components`) plus a tsconfig `paths` entry in `packages/ui/tsconfig.json` — whatever makes `npx shadcn add` write into `packages/ui/src/components/`. Record the working shape in the kit README.
- [ ] `src/lib/utils.ts`:

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] License gate: `pnpm nx run rennet:licenses` (all new deps MIT/ISC — lucide-react is ISC, permitted). `pnpm check` green. Commit: `feat(ui): shadcn CLI config, base deps, cn util`

### Task 1.3: Pull core primitive set + smoke tests

**Files:**
- Create (via `npx shadcn add`, Base UI variants): `packages/ui/src/components/{button,input,textarea,label,checkbox,switch,select,tabs,tooltip,popover,dialog,sheet,scroll-area,dropdown-menu,badge,skeleton,separator,toast}.tsx`
- Create: `packages/ui/src/components/smoke.test.tsx`
- Modify: `packages/ui/src/index.ts` (re-export every component)

**Steps:**
- [ ] From `packages/ui`: `npx shadcn@latest add button input textarea label checkbox switch select tabs tooltip popover dialog sheet scroll-area dropdown-menu badge skeleton separator toast`. Vendored files land in `src/components/`.
- [ ] Post-pull pass on every file: (a) imports resolve (`cn` from `@rennet/ui/lib/utils` or relative), (b) zero literal hex/oklch — any found gets replaced with the Task 1.1 semantic utilities, (c) any `size-*`/`text-*`/`rounded-*` outside the ramp gets mapped to the nearest ramp step, (d) icons are lucide only.
- [ ] Extend hex-lint + design-ramp coverage to the kit: create `packages/ui/src/hex-lint.test.ts` and `packages/ui/src/design-ramp.test.ts` by copying `packages/app-ui`'s and pointing their globs at `packages/ui/src` (same rules, second package; keep them separate files, not shared — the two packages' allowlists will diverge).
- [ ] `smoke.test.tsx` (happy-dom + testing-library, mirrors app-ui test setup):

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Button } from "./button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog";

test("button renders and clicks", async () => {
  let hits = 0;
  render(<Button onClick={() => hits++}>Ripen</Button>);
  await userEvent.click(screen.getByRole("button", { name: "Ripen" }));
  expect(hits).toBe(1);
});

test("dialog opens, traps focus, closes on escape", async () => {
  render(
    <Dialog>
      <DialogTrigger>open</DialogTrigger>
      <DialogContent><DialogTitle>Affinage</DialogTitle></DialogContent>
    </Dialog>,
  );
  await userEvent.click(screen.getByText("open"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
});
```

- [ ] `pnpm nx run rennet-ui:test` then `pnpm check` green. Commit: `feat(ui): vendor shadcn core primitives on Base UI`

---

## Wave 2 — Overlay surfaces onto kit Dialog/Sheet/Popover + Toast

One PR. The hand-rolled `role="dialog"`/overlay sites move to kit primitives; app gains a toast channel. Command palette is deliberately excluded (Wave 3).

**Delivered (2026-08-20):** five sites migrated — `update-ready.tsx` (Dialog + DropdownMenu, `modal={false}` to preserve click-through), `ask.tsx` and `conversation-cluster.tsx` (routing menus → Popover with `aria-haspopup="menu"` on the trigger), `connection-host.tsx` (switcher → named Popover; a wrong `role="menu"` on the pairing form dropped), plus the root `<Toaster/>` + a github-connect success toast. **Deferred, on review (Rule Zero):** `publish-sheet.tsx` and `collation-draft-canvas.tsx` are plain centered `fixed inset-0` modals with only a simple backdrop/aria wrapper (not a hand-rolled portal/focus-trap). A nominally behavior-preserving kit-Dialog migration would need to DISABLE modal focus/initial-focus/final-focus/Escape/outside-dismiss and rewrite ~50 container-scoped assertions across ~12 test files — making the primitive imitate the existing wrapper while adding portal risk around the hold-to-sign gesture. Not worth it; revisit if those surfaces are redesigned (they keep their own backdrop until then).

### Task 2.1: Toast provider + adoption sites

**Files:**
- Modify: `packages/app-ui/src/connection-host.tsx` (mount kit `<Toaster />` once at the root)
- Modify: `packages/app-ui/src/components/update-ready.tsx`, `github-connect.tsx`, `publish-sheet.tsx` (transient success/error feedback → `toast(...)`; persistent state UI stays)

**Steps:**
- [ ] Mount Toaster at root; convert each site's transient feedback; delete the bespoke transient-state code it replaces.
- [ ] Per site: run that component's existing tests (`pnpm nx run rennet-app-ui:test`); update selectors where markup changed but keep semantic hook classes.
- [ ] Commit per site or one commit: `feat(app-ui): kit toast channel for transient feedback`

### Task 2.2–2.7: Overlay migrations (one task per file)

**Files (one task each, same recipe):** `packages/app-ui/src/components/ask.tsx` (Dialog), `publish-sheet.tsx` (Sheet — it's an edge overlay), `update-ready.tsx` (Dialog), `collation-draft-canvas.tsx` (Dialog, large content), `connection-host.tsx` (Dialog for reconnect overlay), `conversation-cluster.tsx` (Popover/Dialog for its overlay parts only — the conversation body itself waits for Wave 6).

**Recipe per file:**
- [ ] Read the file's current overlay: identify open-state, dismissal paths (esc/backdrop/button), focus behavior, aria labels.
- [ ] Replace the hand-rolled portal/backdrop/aria scaffolding with kit `Dialog`/`Sheet`/`Popover`; keep the inner content JSX and all business logic; keep semantic classNames.
- [ ] Behavior parity checklist in the file's test: opens, esc closes, backdrop closes (where it did before), focus returns to trigger, `role="dialog"` + label present. Write/extend the vitest to assert each.
- [ ] Delete the now-dead bespoke overlay helpers in that file. `pnpm nx run rennet-app-ui:test` green.
- [ ] Commit: `refactor(app-ui): <file> overlay onto kit <primitive>`

Wave gate: `pnpm check`, plus manual run (`pnpm nx run rennet-desktop:serve` or the desktop dev target per `pnpm nx show project rennet-desktop`) clicking through every migrated overlay in light + dark.

---

## Wave 3 — Command palette, resizable panes, markdown

One PR. Markdown (3.3) is delivered; the command palette (3.1) uses the standard cmdk Command (Radix is fine — Rai, 2026-08-20); resizable (3.2) is dropped (no migration target).

> **3.1 note — use the standard cmdk Command.** `npx shadcn add command` pulls a Command that depends on `cmdk` (which brings `@radix-ui/*`). That is acceptable (the earlier "no cmdk/Radix" block was an over-inference, corrected by Rai 2026-08-20). Pull it, theme it onto the ramp, and wire `command-palette.tsx` over it.
>
> **3.2 DROPPED — no resizable panes exist to migrate.** Repo-wide search found no hand-managed split panes in `workspace.tsx`/`project-detail.tsx` (no pointer/drag handlers, no `onLayout`, no persisted sizes). The one two-column region is a fixed `flex` 1fr/1fr split with nothing to persist. Converting it to a draggable `ResizablePanelGroup` is net-new feature work (Rule Zero / YAGNI), not a migration — so `react-resizable-panels` was NOT added. Revisit only if a genuinely resizable surface is specced. (For the record, its latest is <7 days old; the correct pin would be `react-resizable-panels@4.12.2`, 2026-07-12, MIT.)

### Task 3.1: Command palette on shadcn Command (cmdk)

**Files:**
- Pull: `npx shadcn add command` (brings `cmdk` + its Radix deps — fine; exact-pin them, verify ≥7 days old + MIT)
- Modify: `packages/app-ui/src/components/command-palette.tsx` — becomes a thin wrapper: kit `CommandDialog` + `CommandInput` + `CommandList` fed from the existing command registry
- Keep: `packages/app-ui/src/command/commands.ts` (registry = domain data); delete its fuzzy-filter + keyboard-nav glue (kit Command owns filtering/nav)

**Steps:**
- [ ] Wire registry → `CommandItem`s (group by existing command categories); keep ⌘K binding wherever it's currently registered.
- [ ] Tests: palette opens on ⌘K, typing filters to expected command, Enter executes (spy on the command's run fn), esc closes. Port the existing command-palette tests to the new markup.
- [ ] Commit: `refactor(app-ui): command palette onto shadcn Command`

### Task 3.2: Resizable panes

**Files:**
- Pull: `npx shadcn add resizable` (wraps `react-resizable-panels`, zero-dep — exact-pin it)
- Modify: `packages/app-ui/src/components/workspace.tsx`, `project-detail.tsx` — hand-managed split panes → `ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle`

**Steps:**
- [ ] Map each existing pane split (identify them by width/flex state in the two files) onto panel groups; persist sizes where the current code persists them (zustand view state), via `onLayout` → existing store.
- [ ] Delete the bespoke drag/resize handlers. Tests: layout renders, `onLayout` writes store. Commit: `refactor(app-ui): workspace/project-detail panes onto Resizable`

### Task 3.3: Markdown rendering

**Files:**
- Add dep: `react-markdown` (exact-pin) to `packages/app-ui`
- Modify: PR-body/prose render sites — locate with `grep -rn 'dangerouslySetInnerHTML\|markdown' packages/app-ui/src` (publish-sheet draft preview, conversation prose)

**Steps:**
- [ ] Replace bespoke/plaintext prose rendering with `<ReactMarkdown>` + a small shared component `packages/app-ui/src/components/prose.tsx` styling via existing token utilities (serif voice per DESIGN.md).
- [ ] Test: renders emphasis/code/links from a fixture string; no raw HTML injection (react-markdown default = no `dangerouslySetInnerHTML`). Commit: `feat(app-ui): markdown prose rendering`

---

## Wave 4 — Full composite sweep + app.tsx split

One PR (largest; sub-task per cluster so review stays sane). Every inline-styled control across `packages/app-ui` moves to kit primitives.

### Task 4.1: app.tsx split

**Files:**
- Modify: `packages/app-ui/src/app.tsx` (3302 lines) → split into `src/app/{shell,review-workspace-route,navigation,providers}.tsx` keeping `app.tsx` as the re-export/composition root; NO behavior change, moves only. (Boundaries chosen at the top-level component seams already visible in the file — `RennetApp`, `ReviewWorkspace`, shell chrome.)

**Steps:**
- [ ] Move components verbatim, fix imports, `pnpm nx run rennet-app-ui:test` green after each move, commit per move: `refactor(app-ui): extract <part> from app.tsx`.

### Task 4.2–4.x: Control sweep, one task per cluster

Clusters (from the inventory; each = one commit): (a) buttons/inputs across `settings-screen.tsx`, `front-door.tsx`, `github-connect.tsx`; (b) tabs/badges/skeletons across `workspace.tsx`, `project-detail.tsx`, `flagged.tsx`, `decisions.tsx`, `progress-feed.tsx`; (c) selects/switches/checkboxes across `settings-screen.tsx`, `lens.tsx`, `granularity-author.tsx`; (d) remaining small components (`noise.tsx`, `batch-view.tsx`, `disposition*.tsx`, `coverage.tsx`, `orphan-tray.tsx`, `mark-index.tsx`, `pr-worktree-status.tsx`, `running-review.tsx`, `narration.tsx`, `flat.tsx`, `l3.tsx`, `hypothesis.tsx`, `destination-frame.tsx`, `project-processing.tsx`, `handoff-paper.tsx`, `delta-account-panel.tsx`, `context-manifest-panel.tsx`, `breadcrumb.tsx`).

**Recipe per cluster:**
- [ ] Per file: replace hand-rolled `<button class="...">`/inputs/tab strips with kit `<Button variant/size>`, `<Input>`, `<Tabs>` etc. Variant mapping: primary action → `default` (gold fill), secondary → `secondary`, borderless → `ghost`, destructive → `destructive`. Keep semantic classNames and all handlers/state.
- [ ] Visual identity check: no stock-zinc look may appear — if a kit variant fights the Bench look, adjust the kit component's variant classes once in `packages/ui` (owned code), never per-call-site.
- [ ] Existing tests green after each file; commit per cluster: `refactor(app-ui): <cluster> onto kit primitives`.

Wave gate: `pnpm check` + manual pass of every screen, light + dark.

---

## Wave 5 — Syntax, diff, icons, lists/trees

One PR.

### Task 5.1: shiki replaces bespoke highlighter

**Files:**
- Add dep: `shiki` (exact-pin) to `packages/app-ui`
- Modify: `packages/app-ui/src/components/code-view.tsx` — swap tokenizer calls to shiki's `codeToTokens` (keep row registry, mark placement, Pierre-direction rendering; shiki supplies tokens only, NOT the DOM)
- Delete: `packages/app-ui/src/syntax/highlight.ts`, `syntax/languages.ts` (23K) once no imports remain
- Theme: build a shiki dual theme from `--rn-*` (shiki CSS-variables theme: `defaultColor: false`, classes resolve through `--rn-code`/ink tokens) — no hex in TS

**Steps:**
- [ ] Wire `codeToTokens` with lazy language loading for the languages `languages.ts` currently supports (enumerate them from that file before deleting).
- [ ] Existing code-view tests green (token boundaries may shift; assert on text content + mark anchoring, not token counts). Delete dead files; `grep -rn 'syntax/highlight\|syntax/languages' packages` → zero. Commit: `refactor(app-ui): shiki tokenizer behind code-view`

**Implementation exception — eager sync grammar load, not lazy async (recorded post-review):** The "lazy per-language load" step above did NOT ship, and deliberately so. Rennet's tokenizer (`syntax/shiki.ts`) must be **synchronous**: `renderToStaticMarkup` runs no effects, and the symbol/code-view tests assert token classification on the FIRST render — a grammar cannot be fetched after mount without a flash of unhighlighted code and failing tests. Shiki's lazy path (`loadLanguage`) is async, so it is off the table. The tokenizer uses `createHighlighterCoreSync` and registers all nine grammars at module load. The cost is **~82KB gzip** of grammar JSON in the bundle, which is **accepted**: app-ui ships inside the Electron desktop renderer (a local asset load, not a web bundle served over the wire), so the eager-sync tradeoff is correct here. Do not "fix" this back to lazy async — it breaks the sync-first-render contract.

### Task 5.2: Diff rendering decision point

- [ ] After 5.1, evaluate: does code-view's own hunk rendering (now shiki-fed) meet the Pierre direction? If yes — done, add nothing. If unified/split hunk layout is still bespoke-painful, add `react-diff-view` (MIT, exact-pin) for hunk layout only, keeping shiki tokens + mark registry. Record verdict + reasoning in dependency-standard. Commit accordingly.

### Task 5.3: lucide-react icon swap

**Files:**
- Modify: every `icons.tsx` consumer (`grep -rn 'from "./icons"\|components/icons' packages/app-ui/src`)
- Delete: `packages/app-ui/src/components/icons.tsx`
- Keep: `brand-mark.tsx`

**Steps:**
- [ ] Build the name map first (bespoke icon → lucide equivalent) by reading `icons.tsx`'s export list; any icon with no lucide equivalent moves into `brand-mark.tsx` as a named export (expect: none or near-none).
- [ ] Swap per consumer file, `size-4`-style sizing via className, `strokeWidth={1.6}` where the 1.6px identity stroke matters (set once via a wrapper `Icon` defaults object if >3 sites need it).
- [ ] Delete `icons.tsx`; grep proves zero imports. Tests green. Commit: `refactor(app-ui): lucide-react icons, retire bespoke icon set`

### Task 5.4: Lists and trees

**Assessment (2026-08-20) — NO applicable migration target; no deps pulled (like 3.2 resizable / 5.2 diff).** Every candidate was read before touching anything; none is a real Data Table, Combobox, or a tree that composing kit primitives improves.

- **Data Table — none.** `flagged.tsx` and `decisions.tsx` are narrative finding/decision **card lists** (per-row severity chips, model-agreement/disagreement blocks, evidence chips, reconstructed-why prose, per-item jump/disposition affordances), not columnar sortable/filterable grids. `settings-screen.tsx` is tabs + settings forms already riding kit `Button`/`Input`; its `KeyboardPanel` is a per-row keybinding list with inline conflict notes + per-row Set/Unbind buttons — a list with per-item affordances, not a data grid. Forcing any onto `@tanstack/react-table` would be a restyle + behavior change, not a migration (Rule Zero / YAGNI). **`@tanstack/react-table` NOT added.**
- **Combobox — none.** No filterable single-select picker exists in the candidates (no `<select>`, no listbox/combobox roles; settings uses tabs + buttons + text inputs). **combobox NOT pulled.**
- **Trees — left bespoke.** `symbol-inspector.tsx` is not a tree at all — a flat sectioned panel (definition/references-by-file/neighbor chip lists + breadcrumb). `context-map-view.tsx` has a real bespoke file tree (`ScopeRow`→`DirRow` recursive→`FileRow`, local open-state, depth padding, selection, semantic `context-map-*` classNames + tests). It works, is small, and is lazy-rendered (children mount only when expanded) — **no virtualization need, so `react-arborist` NOT added.** The kit ships no Collapsible/Accordion; adding one purely to re-express a working tree would be net-new code + a ~170-line rewrite risking its dom tests, for a marginal `aria-expanded` gain — composing kit primitives adds nothing here, so the bespoke tree stays. (Cheap future nicety, out of scope for a port wave: add `aria-expanded={open}` to the scope/dir toggle buttons.)

Docs-only outcome: no code change, no chart/sidebar token aliases (nothing pulled demanded them), no dependency-standard entry needed (no dep decision was made).

**Files (original plan — not executed, see assessment above):**
**Files:**
- Pull: `npx shadcn add data-table combobox` (Base UI variants; data-table brings `@tanstack/react-table` — MIT, exact-pin, 7-day check)
- Modify: `packages/app-ui/src/components/flagged.tsx`, `decisions.tsx`, `settings-screen.tsx` list sections → Data Table/Combobox where they are actual tables/pickers (leave narrative lists alone)
- Modify: `context-map-view.tsx`, `symbol-inspector.tsx` — tree nav: first try composing kit primitives (Collapsible/ScrollArea) since both trees are bespoke-but-working; add `react-arborist` (MIT) ONLY if virtualized tree interaction is genuinely needed. Record verdict in dependency-standard either way.

**Steps:**
- [ ] Add chart/sidebar token aliases to `theme.css` only if a pulled component demands them; map: `--color-chart-1..5` → `--rn-accent, --rn-green, --rn-danger, --rn-ink-soft, --rn-accent-soft`.
- [ ] Migrate each surface; existing tests green; commit per surface.

---

## Wave 6 — Conversation surfaces on shadcn AI-chat (T4, re-platform only)

One PR. Same UX, new substrate. Redesign is explicitly out of scope (separate future effort).

### Task 6.1: Pull AI-chat components + map the surfaces

**Assessment (2026-08-20) — premise FALSIFIED; NO applicable migration target; no deps pulled (like Wave 3 command-palette / 3.2 resizable / 5.2 diff / 5.4 lists-trees).** The four AI-chat components were each fetched with `npx shadcn@latest view` and read before touching anything. They EXIST and install on Base UI, but they are full-screen **two-party chat** primitives — they do not fit Rennet's **anchored margin-rail private-review threads**, and forcing them would be a chat-bubble redesign (explicitly out of scope) that breaks the #85/#356 margin-rail identity. The conversation surfaces are already re-platformed onto the kit where a kit primitive applies.

- **Bubble / Message — no fit.** `@shadcn/message` + `@shadcn/bubble` are chat-bubble primitives: `data-align="start|end"`, `data-[align=end]:flex-row-reverse`, a `MessageAvatar`, `max-w-[80%]` self-ending bubbles, all on Tailwind semantic tokens (`bg-primary`, `text-primary-foreground`, `bg-muted`, `text-muted-foreground`). Rennet's `MessageCard` is a **full-width stacked review-annotation `<article>`** — author header, serif body, and `finding`/`draft comment`/`sub-thread` promote verbs — on Rennet's own `--rn-*` token vocabulary (`text-ink`, `bg-accent-soft`, `bg-raised`, `font-serif`), carrying the load-bearing `data-author` / `data-message-id` / `data-status` / `is-streaming` / `is-interrupted` hooks the tests select on. No left/right alignment, no avatars, no bubbles. Re-expressing it as chat bubbles is a redesign, not a re-platform. **NOT pulled.**
- **Message Scroller — no target.** `@shadcn/message-scroller` is a full-screen chat autoscroll pin-to-bottom container, and it pulls a NEW proprietary `@shadcn/react` runtime package (not `@base-ui/react`). Rennet's conversation has **no autoscroll**: the margin rail aligns each panel to its diff row via `useRailAlignments` (design #85/#356 — the identity), and streaming just appends `ThreadMessage`s that grow the panel in place. A pin-to-bottom scroller would CHANGE behavior and fight the rail geometry. **NOT pulled.**
- **Attachment — no target.** No attachment / context-chip concept exists anywhere in the conversation surfaces (grep-confirmed across `conversation-*.tsx` + `canvas/conversation.ts`). Nothing to migrate onto it. **NOT pulled.**
- **Already on the kit (nothing left to move):** the per-turn routing caret menu rides kit `Popover` (Wave 2), every glyph is lucide via the `Icon` wrapper (Wave 5.3), all colors are `--rn-*` tokens (hex-lint clean), and utility styling matches the kit's `cn` convention. The only overlay in these surfaces (the route menu) is already a kit primitive; there is **no remaining hand-rolled overlay / portal / focus-trap / scroll container** to re-platform. The fallback order below (9ui/basecn → Kibo) was not reached — no need for a chat substrate was found.

Docs-only outcome: no code change, no dependency-standard entry (no dep decision was made), conversation behavior and every semantic test-hook className unchanged.

**Files (original plan — not executed, see assessment above):**
- Pull: shadcn native Base UI AI-chat set — Bubble, Message, Message Scroller, Attachment (names per current shadcn docs; verify exact registry ids with `npx shadcn view` first)
- Modify: `packages/app-ui/src/components/conversation-host.tsx` (33K), `conversation-cluster.tsx` (29K), `conversation-panel.tsx`

**Steps (original plan — not executed):**
- [ ] Map: message rows → `Message`/`Bubble`, autoscroll behavior → `Message Scroller`, attachments/context chips → `Attachment`. All conversation domain logic (protocol wiring, streaming, marks) stays; only presentation swaps.
- [ ] The margin-rail conversation layout (design pass #85) is identity — keep the rail geometry, restyle kit components into it via kit-side variant edits, not per-site overrides.
- [ ] Behavior parity tests: streaming append renders, autoscroll pins to bottom until user scrolls up, attachment chips render, existing conversation tests green.
- [ ] If the native set proves insufficient for a specific need, the recorded fallback order is: compose from kit primitives → 9ui/basecn (MIT, Base UI) → Kibo (MIT, Radix-based — fine). Do not silently pick; record in dependency-standard if leaving shadcn core.
- [ ] Commit: `refactor(app-ui): conversation surfaces onto shadcn AI-chat primitives`

---

## Wave 7 — Cleanup + docs sweep + release

One PR.

- [ ] Dead-code hunt: `grep -rn 'role="dialog"' packages/app-ui/src` → only kit-rendered dialogs remain; delete any orphaned overlay/focus/portal helpers, the old fuzzy-filter, transient-toast bespoke code. `pnpm nx run rennet-app-ui:build` catches unused exports via tsc.
- [ ] Docs sweep: `packages/app-ui/DESIGN.md` + root `DESIGN.md` (component vocabulary now includes kit + semantic aliases), any docsite page showing component code, kit README final. Verify docs build.
- [ ] Update `delivery-order.md`: mark the arc delivered.
- [ ] Full `pnpm check`; manual light/dark pass of all screens; then normal release flow.

---

## Self-review notes

- Spec coverage: Decisions 1–2 → Tasks 0.3/1.2/1.3/3.1 (+ blocklist enforced by license gate); 3 → 1.1; 4 → Waves 2–6; 5 → 5.3; 6 → 0.1/0.2; 7 → doc steps embedded in every wave.
- Names used consistently: `@rennet/ui` (kit), `@rennet/app-ui` (composites), nx `rennet-ui`/`rennet-app-ui`, `cn` util, semantic aliases as defined in 1.1.
- Deliberate deferrals (not placeholders): exact dep versions resolved at install time (7-day rule makes hardcoding today's versions wrong); AI-chat registry ids verified at pull time (fast-moving upstream); chart/sidebar tokens deferred to first need (5.4).
