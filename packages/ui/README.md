# @rennet/ui

The vendored shadcn/ui component kit, built on Base UI (`@base-ui/react`). This package owns Rennet's primitive components; `@rennet/app-ui` composes them into screens.

- **Ownership model:** components are pulled with `npx shadcn add` and then owned here. Editing a pulled file is expected — keep edits theme/token-shaped (semantic Tailwind utilities that resolve to `@rennet/theme` `--rn-*` tokens) so a future re-pull diffs cleanly. Never hardcode hex/oklch.
- **Primitive family:** Base UI only. No `@radix-ui/*`, and never the raw `cmdk` package (it depends on Radix) — use shadcn's Base UI Command.
- **Registry policy** and the license blocklist live in `docs/src/content/docs/developing/reference/dependency-standard.md`. Every pulled dependency must be MIT/permissive and pass the license gate.
- **Imports** are limited to `@rennet/types` and `@rennet/theme` (enforced by `scripts/check-boundaries.mjs`).
