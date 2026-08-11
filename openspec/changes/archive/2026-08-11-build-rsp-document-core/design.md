## Context

The Surfacing DSL plan specifies eleven document types, a validator with a stable rule catalogue, and a routing subsystem. This slice implements only the document CORE — the machinery every document type shares — so that #8 (angle generation) can add body schemas against a gate that already exists. The governing ratified decisions: "agents surface, the validator decides"; the validator structurally cannot see guidance; decisions are never capped (no `maxItems` anywhere); ordering is logical, agent-owned. Deterministic validation is a mechanism, not the product's purpose.

## Goals / Non-Goals

**Goals:**

- A universal envelope and provenance block, as `import-nothing` types in `packages/types`, that a phone or third party can depend on.
- A node-free validator in `packages/protocol` that is a pure function of `(document, patchset, offeredManifest, settings)` and runs standalone against a fixture manifest with zero app context.
- The anchor grammar and a total resolution function with exactly four outcomes, ambiguity failing closed.
- One fixture per universal validator rule in both directions, plus the acceptance cases (fabricated id, paraphrased quote, `x` round-trip, unknown docType).

**Non-Goals:**

- Per-docType body schemas and their body rules (V100+, V300+, …) — these land with #8.
- Model routing, the retry loop, `validation.report` emission back to the harness, `docId` minting (an adapter concern), and the full `inputDigest` fingerprint over config/instructions.
- Any `maxItems` / item-count cap: decisions are never capped.

## Decisions

### The core is split types-vs-protocol, matching the existing arrows

RSP data shapes join `Patchset`/`Review` in `packages/types` (import-nothing); the zod schemas, canonical serialisation, anchor parser, resolution function, and validator join the command schemas in `packages/protocol` (types + zod only). This keeps `packages/protocol` the portable contract layer a mobile client imports, so the validator carries no `node:*` — the SHA-256 the input digest needs is a pure implementation verified against NIST vectors rather than `node:crypto` or async Web Crypto.

### The validator walks an opaque body generically

Because per-docType body schemas are #8, the validator cannot depend on body shape. Instead it walks the body and enforces the universal contract structurally: any string that begins `rennet:` is an anchor to resolve; any object carrying both an `anchor` and a `quote` string is an evidence binding to byte-match. This is exactly what a standalone conformance oracle must do, and it means the gate is real before a single angle schema exists.

### Precise, non-overlapping error codes

The rule catalogue is faithful but each code owns a distinct trigger so every fixture is unambiguous: an unknown docType or unsupported version is V001 (rejected loudly); an envelope/provenance shape error is V002; the two required capability names with three layers each is V003; document and quote byte limits are V004; an out-of-bounds or malformed anchor is V005; a quote byte-mismatch is V006; an anchor kind or side outside the closed vocabulary is V007; an id absent from the offered manifest (agent-minted) is V008; an `inputDigest` mismatch is V009. Resolution failures split cleanly: a minted id (present nowhere) is V008, everything else that fails to resolve is V005.

### Admission granularity is registry-driven

A `DOC_TYPE_REGISTRY` declares each type's admission kind (graph = atomic, collection = item-wise, per §4.3) and, for collections, the JSON Pointer to its item array. `decision.record` (`/body/decisions`) and `test.mapping` (`/body/edges`) carry pointers now because the DSL gives those body shapes explicitly; the other collection types are registered item-wise but validated atomically until #8 lands their body pointers — stricter, never a silent mis-admission. An item-wise document is admitted whole (its envelope is sound) while invalid items are dropped and counted; the rejected count is always present, never a silent per-item drop.

### No cap anywhere

`SizeLimits` carries `documentBytes` (a whole-document DoS guard) and `quoteBytes` only. There is deliberately no item-count limit — a cap can hide the one decision you must answer for. `documentBytes` bounds total serialized size and rejects rather than truncating; it is not a limit on how many items a document may carry.

## Risks / Trade-offs

- The `inputDigest` is scoped to the patchset id plus the offered manifest, not the full fingerprint (config, instructions, snapshot sections) the plan eventually wants. Mitigation: V009 is a real, recomputed equality check now; broadening the fingerprint is additive when routing lands.
- Four collection types are registered item-wise but validated atomically pending their #8 body pointers. Mitigation: this is the safe direction (whole-document rejection), and the item-wise mechanism is proven both directions on `decision.record`.
- A hand-written SHA-256 is a place bugs hide. Mitigation: it is verified against NIST known-answer vectors and cross-checked against `node:crypto` across ASCII, multibyte, and block-boundary lengths.
