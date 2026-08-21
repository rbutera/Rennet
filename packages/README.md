# Packages

Rennet's shared packages follow these enforced dependency boundaries. Each arrow points to a package that the package on the left may import.

```text
protocol     -> types
instructions -> types
core         -> types, protocol, instructions
adapters     -> types, protocol, instructions, core
server       -> types, protocol, instructions, core, adapters
client       -> types, protocol
ui           -> types, theme
app-ui       -> types, protocol, theme, ui
```

`ui` is the presentation kit and imports only `types` and `theme`; `app-ui`
holds the Rennet-aware components and may also import `protocol` and `ui`.
`types` and `theme` import no Rennet package. The [monorepo map](../docs/developing/reference/monorepo-map.md) lists every package. `scripts/check-boundaries.mjs` checks the package manifests and uses forbidden imports to prove the boundary rules can fail.

The [architecture contracts](../docs/developing/concepts/architecture-contracts.md) define runtime ownership. The [dependency standard](../docs/developing/reference/dependency-standard.md) governs package selection, versions, licences, and overlapping tools.
