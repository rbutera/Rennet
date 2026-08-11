# Rennet wireframes (canonical)

The blessed lo-fi wireframe set for Rennet. These are the design source of truth: build UI to match them.

- `*.png` — rendered screens, flow order (`00-legend` … `18-flow-overview`).
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
```

Badges are derived from each frame's filename prefix (`05-project-detail` → badge `05`), so a new screen can be inserted (e.g. `04a-projects-list`) without renumbering the frames after it.

Version marker lives in `gen-wireframe-gallery.mjs` (the hero kicker). Current: **v3.2**.
