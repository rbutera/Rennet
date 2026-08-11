# Rennet site (pre-launch status page)

The honest pre-launch surface for Rennet: a status page, not a marketing page, waitlist-free by instruction and by taste (Branding Plan §2, "The honest pre-launch version").

> **Build-only. Not deployed.** Deploying anything for Rennet is a Rai-only action (`docs/Rennet Navi Handoff.md`, RAI-ONLY actions). This directory builds a static site locally; it does not publish it.

## What is here

- `index.html`, `styles.css`, `scheme-toggle.js`: the hand-authored page. The only JavaScript is the light/dark toggle.
- `buildlog.json`: the dated one-line build log, source for both the on-page log and the Atom feed.
- `favicon.svg`: the mark on the dark app-icon ground.
- `build.mjs`: the build. Zero npm deps (Node stdlib only), so it runs in an isolated worktree with no install.
- `brand/`: the wordmark mark, lockup, and the 16/32/64/512 renders (see `brand/README.md`).
- `serve.mjs`: a local static preview server (local only, not a deploy path).

## Build

```sh
node build.mjs        # emits dist/
node serve.mjs        # preview dist/ at http://127.0.0.1:4321
```

`build.mjs` copies the app's real `packages/ui/src/tokens.css` into `dist/tokens.css`, so the site and the product consume one token file and structurally cannot drift. It refuses to build if that file is missing.

## Honesty, by construction

This page makes **zero network requests at runtime**: no fonts fetched, no analytics, no third-party anything, no `fetch`. There is nothing to sign up for and no form of any kind. It therefore makes no automated health or status claim that could silently go stale and render a hollow green tick. The one status claim on the page is the dated honesty line, which is a human statement, set in one place (`DOGFOOD_SINCE` in `build.mjs`) and meant to move.

`DOGFOOD_SINCE` is currently unset, so the page renders the pre-dogfood honest line rather than inventing a start date. Rai sets the real date when daily-driver review begins.

## Deviation from the plan, stated

The Branding Plan names Vite + TypeScript for the build. Vite is not installed in this isolated worktree, and the site is a single static page, so the build is a Node script that emits identical static output with no install step and no network. Moving to Vite later is a drop-in when the site graduates past one page (the plan's own escape hatch is Astro at ~5 pages); nothing here blocks that.
