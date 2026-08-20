# Rennet wireframes

These low-fidelity screens describe product behavior, information hierarchy, and navigation flow. They are not the visual authority. Use root [`DESIGN.md`](../DESIGN.md) and current application code for color, material, typography, spacing, and component styling.

The canonical documentation states whether a behavior is current or planned. If a wireframe conflicts with the documentation or code, use the documentation and code.

- `*.png` contains rendered screens in flow order.
- `src/*.html` contains a self-contained HTML render for each screen.
- `src/kit.mjs` contains shared wireframe tokens, chrome, and icons.
- `src/*.mjs` contains the frame builders.
- `gen-wireframe-gallery.mjs` assembles `gallery.html`.

## Build the gallery

```sh
node wireframes/src/build.mjs
node wireframes/src/render.mjs
node wireframes/gen-wireframe-gallery.mjs
node wireframes/serve.mjs
```

To render one frame, pass its filename stem:

```sh
node wireframes/src/render.mjs 04a-projects-list
```

The preview server listens on `127.0.0.1:8791`.

Each filename begins with its gallery badge. The letter suffix in `04a-projects-list` inserts a screen without renumbering the rest. Mobile frames `19` through `24` come from `src/mobile.mjs` and name the protocol commands and event topics they use.
