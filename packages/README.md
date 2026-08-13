# Packages

The planned dependency order is:

```text
types <- protocol <- core <- adapters <- desktop
  ^         ^
  +---------+------------------------- ui
```

The package and licensing contracts are recorded in [contracts and rulings](../docs/src/content/docs/developing/reference/contracts-and-rulings.md) and [architecture contracts](../docs/src/content/docs/developing/concepts/architecture-contracts.md). Package selection and dependency overlap are governed by the [dependency standard](../docs/src/content/docs/developing/reference/dependency-standard.md).
