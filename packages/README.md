# Packages

Rennet's shared packages follow these enforced dependency boundaries. Each arrow points to a package that the package on the left may import.

```text
protocol     -> (no Rennet package)
instructions -> protocol
core         -> protocol, instructions
adapters     -> protocol, instructions, core
server       -> protocol, instructions, core, adapters
client       -> protocol
ui           -> protocol, theme
app-ui       -> protocol, theme, ui
```

`protocol` is the base layer: its Zod schemas are the single source of truth for the wire types, and the TypeScript types are `z.infer` exports from `protocol`. `ui` is the presentation kit and imports only `protocol` and `theme`; `app-ui`
holds the Rennet-aware components and may also import `ui`.
`protocol` and `theme` import no Rennet package. The [monorepo map](../docs/developing/reference/monorepo-map.md) lists every package. `scripts/check-boundaries.mjs` checks the package manifests and uses forbidden imports to prove the boundary rules can fail.

The [architecture contracts](../docs/developing/concepts/architecture-contracts.md) define runtime ownership. The [dependency standard](../docs/developing/reference/dependency-standard.md) governs package selection, versions, licences, and overlapping tools.
