---
title: Marketing screenshots
description: How the product screenshots on rennet.dev are captured from the shipped app, and how to regenerate them.
---

The product images on the marketing site are captures of the shipped desktop app reviewing an invented fixture branch. This page says where they come from and how to make them again after the app's chrome changes.

## Regenerate

```sh
pnpm nx run rennet-marketing:screenshots
```

The target is not cached. It builds the desktop app if it needs to, launches it under Playwright's Electron driver, seeds the fixture, captures every surface at a device scale factor of 2, and writes the optimised PNGs into `apps/marketing/public/product/`. Commit those. The raw captures land in `apps/marketing/.screenshots-raw/`, which git ignores.

Nothing model-backed runs. The app is launched with the same model-free environment the hermetic e2e specs use (`RENNET_DISABLE_HARNESS=1`, a throwaway `HOME`, a PATH holding only `node` and `git`), so no `claude` or `codex` binary is found and nothing leaves the machine. The drafting attempt fails honestly and the board is seeded in its place.

## What is in the picture

The fixture is `atlas`, a small TypeScript HTTP service written for this purpose, on a branch `feat/rate-limiting` that adds per-organisation rate limiting: a token bucket, a store interface with memory and Redis implementations behind a fail-open wrapper, middleware, config, an API-doc contract change, an OpenSpec change, a test file still uncommitted in the working tree, and the lockfile and import-order churn a real branch carries. The five lens boards read like a settled council run over that branch: a reading order with real code refs, five decisions, three findings (one high, with Claude and Codex disagreeing on its severity), a Design board grounded in the spec, and per-hunk noise verdicts. Every code ref is resolved by looking up the cited line in the fixture file, so a line number on the board cannot drift from the code.

It is a fixture, not a client repository, a real pull request, or anyone's data. The page caption says so.

## Where the pieces live

| Piece | Path |
| --- | --- |
| The repository and the board | `apps/desktop/e2e/marketing-fixture.ts` |
| The capture (launch, seed, screenshot) | `apps/desktop/e2e/marketing-screenshots.capture.ts` |
| The Playwright config that runs only the capture | `apps/desktop/playwright.screenshots.config.ts` |
| PNG optimisation (palette quantisation through `sharp`) | `apps/marketing/scripts/optimize-screenshots.mjs` |
| The Nx target | `screenshots` in `apps/marketing/project.json` |
| The page that shows them | `apps/marketing/src/pages/index.astro` |

The capture file is not a `*.spec.ts`, so `pnpm nx run rennet-desktop:e2e` and `pnpm check` never run it; the desktop `lint` and `typecheck` targets still cover it.

## Captured surfaces

The page shows one surface, captured at 1536×1024 CSS pixels (3072×2048 device pixels), once with `prefers-color-scheme: light` and once with `dark`: `review-sequence-{light,dark}.png`, the Sequence lens with every section open, so the first step's cited spec lines are in frame beneath its prose. The page shows the light capture under the light scheme and the dark capture under the dark scheme.

Only what the page uses is captured and committed: every PNG in `public/product/` ships with the site. To add a surface, add a `selectLens` (or `openDiffView`) and a `capture(page, retina, name, scheme)` call in the capture file, then reference the file from the page; the optimiser picks up every PNG in the raw directory. The device scale factor is set through a CDP session the capture keeps open, because Chromium on macOS ignores `--force-device-scale-factor` and Playwright's own viewport emulation pins the factor to 1.

## When to regenerate

Regenerate when the review board, the top bar, or the sidebar change shape, and when the fixture changes. A capture that shows chrome the app no longer has is the same defect as copy that describes a feature the app no longer has. Look at the output before committing it: the PNGs are the claim, and the build does not check them.
