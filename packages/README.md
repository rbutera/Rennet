# Rennet packages

The monorepo is intentionally layered:

```text
types  ← imports nothing in-repo
protocol ← types
core ← protocol
adapters ← core + Node/Electron host capabilities
ui ← types + protocol + browser-safe dependencies
desktop ← the only Electron composition root
```

The current product and package contracts are in [the product vision](../docs/PRODUCT_VISION.md), [the rulings ledger](../docs/RULINGS_LEDGER.md), and [the architecture guide](../docs/ARCHITECTURE.md). The architecture guide also owns package selection, dependency overlap, toolchain, and licensing policy.
