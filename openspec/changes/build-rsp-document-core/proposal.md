## Why

Every angle a fleet will emit (#8) — decompositions, decisions, claims, findings — has to land as a document that the app can trust without trusting the model that wrote it. That trust is a substrate, not a per-angle concern: one universal envelope, one provenance block, one anchor grammar, and one deterministic validator that admits or rejects. This slice builds that substrate so #8 can add per-docType body schemas on top of a gate that already resolves anchors, byte-matches quotes, enforces closed vocabularies, refuses agent-minted identity, and admits collections item-by-item. Deterministic validation here is a mechanism in service of digestibility, never the product's stated purpose.

## What Changes

- Add the RSP data types to `packages/types` (import-nothing): the universal envelope, the provenance block (harness/model/`modelReportedBy`/tier/route/`runId`, three-layer capability snapshot, `inputDigest`, token usage, and a reported-vs-derived USD split that is never merged), the anchor grammar (`kind`/`id`/side-qualified span/pointer/proposal), the four resolution outcomes, the offered manifest, the settings projection (no item cap: decisions are never capped), and the validation report.
- Add the RSP core to `packages/protocol` (node-free, the one package a phone imports): zod schemas for the envelope and provenance; canonical JSON serialisation (recursively sorted keys, 2-space, LF) shared with the future publish digest; a pure synchronous SHA-256 for the input digest; the anchor parser and the total resolution function (`resolved`/`unresolved`/`superseded`/`orphaned`, ambiguity failing closed); and the deterministic validator — a pure function of `(document, patchset, offeredManifest, settings)` with no network, model, or clock, standalone-runnable as the future conformance oracle.
- The validator walks the opaque body generically: it resolves every `rennet:` anchor and byte-matches every `{ anchor, quote }` evidence pair, so it enforces the universal contract with zero knowledge of the per-docType body shapes that land with #8.

## Capabilities

### New Capabilities

- `rsp-document-core`: The universal envelope, provenance block, anchor grammar, and total resolution function that every RSP document carries and every consumer reads.
- `rsp-validator`: The deterministic admission gate — universal rule catalogue (V001–V009), size limits that reject rather than truncate, and admission granularity (graph documents atomic, collection documents item-wise with a mandatory visible rejected count).

### Modified Capabilities

None.

## Impact

- Adds `packages/types/src/index.ts` RSP types, `packages/protocol/src/{rsp,sha256}.ts` (re-exported from `@rennet/protocol`), and their colocated tests. No new production dependency; SHA-256 is a pure node-free implementation verified against NIST vectors so `packages/protocol` stays portable.
- Deferred to follow-up beads (issue #6 is slice 1 of umbrella `workspace-3svrc`): the per-docType body schemas and per-body validator rules (V100+, V300+, …) land with #8; the remaining collection body pointers (claim/finding/anomaly/noise) are registered as item-wise but validated atomically until their body shapes exist; adapter-side `docId` minting (the validator only validates the ULID format); and extending `inputDigest` to the full fingerprint (config, instructions, snapshot sections) once routing lands.
