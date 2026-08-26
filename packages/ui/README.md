# @rennet/ui

The vendored shadcn/ui component kit, built on Base UI (`@base-ui/react`). This package owns Rennet's primitive components; `@rennet/app-ui` composes them into screens.

## Components

Badge, Button, Checkbox, Command (`cmdk`), Dialog, DropdownMenu, Input, Label, Popover, ScrollArea, Select, Separator, Sheet, Skeleton, Switch, Tabs, Textarea, Toast, Tooltip.

Every lucide glyph the kit renders (Select chevrons, Dialog/Sheet close, Checkbox/DropdownMenu check, Command search, Toast status) uses `strokeWidth={1.6}` — Rennet's line-icon identity, matching the `@rennet/app-ui` `Icon` wrapper so the whole app reads at one line weight.

## Conventions

- **Ownership model:** components are pulled with `npx shadcn add` and then owned here. Editing a pulled file is expected — keep edits theme/token-shaped (semantic Tailwind utilities that resolve to `@rennet/theme` `--rn-*` tokens) so a future re-pull diffs cleanly. Never hardcode hex/oklch (the `hex-lint` test enforces this; `design-ramp` enforces the type/radius ramp).
- **Primitive family:** Base UI is the primary family. Radix is not banned — a Radix dependency is fine where a shadcn component brings it (e.g. `cmdk` for the command palette). Avoid gratuitously running two different families for the same primitive.
- **Registry policy** and the license blocklist live in `docs/src/content/docs/developing/reference/dependency-standard.md`. Every pulled dependency must be MIT/permissive and pass the license gate.
- **Imports** are limited to `@rennet/protocol` and `@rennet/theme` (enforced by `scripts/check-boundaries.mjs`).
