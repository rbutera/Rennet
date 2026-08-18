# Rennet wireframes (canonical)

The blessed lo-fi wireframe set for Rennet. These are the design source of truth: build UI to match them.

- `*.png` — rendered screens, flow order (`00-legend` … `17-flow-overview` … `18-navigation-model`).
- `src/*.html` — self-contained HTML for each screen (generated from the builders below).
- `src/kit.mjs` — the shared design system: CSS tokens, chrome, and the stroke icon set. Study this first; it defines the visual language.
- `src/*.mjs` builders — `frame00.mjs`, `onboarding.mjs`, `projectslist.mjs`, `frame05.mjs`, `review.mjs`, `finalize.mjs` each emit one or more frames.
- `gen-wireframe-gallery.mjs` — assembles all PNGs into a single self-contained `gallery.html`.

## Pipeline

```sh
# 1. HTML frames  ->  src/*.html
node wireframes/src/build.mjs

# 2. HTML  ->  PNG at 2x (1440px logical width), via the repo's Playwright Chromium
node wireframes/src/render.mjs                 # all frames
node wireframes/src/render.mjs 04a-projects-list   # one frame

# 3. PNGs  ->  gallery.html
node wireframes/gen-wireframe-gallery.mjs

# 4. serve gallery.html at 127.0.0.1:8791 (sits behind `tailscale serve` on :9443)
node wireframes/serve.mjs
```

Badges are derived from each frame's filename prefix (`05-project-detail` → badge `05`), so a new screen can be inserted (e.g. `04a-projects-list`) without renumbering the frames after it.

Version marker lives in `gen-wireframe-gallery.mjs` (the hero kicker + footer) and each frame's `title`. Current: **v4.2** (v4.1 plus the GitHub device sign-in pass — first-run's skippable Connect-GitHub card and the Settings account rows, replacing the gh-CLI piggyback). v4.1 was v4.0 plus the mobile set (frames `19`–`24`, the phase 6 gate's wireframe pass for issue #382, built by `src/mobile.mjs`; each phone screen names the protocol commands and event topics it consumes).
