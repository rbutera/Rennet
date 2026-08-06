---
tags: [rennet, architecture, evidence]
categories: [project]
status: active
created: 2026-08-05
updated: 2026-08-05
related: ["[[Rennet Contracts and Rulings]]", "[[Rennet Architecture Contracts]]"]
source: codex
---

# Rennet Spike: TypeScript LSP Ladder

## Verdict

**Promote native TypeScript 7 `tsgo --lsp --stdio` to the first Tier 1 choice for repositories that already select TypeScript 7.** Keep Tier 0 available and retain the existing fallback ladder for TypeScript 6 and earlier.

The calibrated driver first proved hover, definition, references, and prepare-rename on a two-symbol project. It then ran three fresh-process probes against a shallow checkout of `microsoft/TypeScript` containing 81,397 files, opening `src/compiler/checker.ts` and using `createTypeChecker` as the positive control.

| Measurement | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| Initialize | 38.87 ms | 37.05 ms | 37.45 ms | 37.45 ms |
| First hover | 78.35 ms | 75.47 ms | 66.43 ms | 75.47 ms |
| Server RSS | 348.33 MB | 345.95 MB | 345.02 MB | 345.95 MB |

Every run returned a hover, one definition location, three reference locations, and a valid prepare-rename response. The server advertised all four capabilities. The tested build was `@typescript/native-preview` 7.0.0-dev.20260707.2.

Driver and calibrated fixture: [lsp-ladder spike](../spikes/lsp-ladder/).

## Limits

This proves protocol support and a cold-open operating point on one unusually large public repository. It does not justify enabling rename in Rennet's product surface, measure multiple concurrently active servers, or prove every monorepo/reference layout. Rennet should expose definition and hover first, keep references behind the same health gate, and continue to omit rename from v1 UI.
