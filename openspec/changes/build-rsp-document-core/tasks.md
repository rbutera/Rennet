## 1. RSP types (types)

- [x] 1.1 Add the universal envelope (`RspEnvelope`): `rsp`, `docType`, `schemaVersion`, adapter-minted `docId`, `patchsetId`, `supersedes`, `provenance`, opaque `body`, `x` extension bag
- [x] 1.2 Add the provenance block (`RspProvenance`): harness/model/`modelReportedBy`/tier/route/`runId`, three-layer capability snapshot, `inputDigest`, token usage, reported-vs-derived USD split (never merged)
- [x] 1.3 Add the anchor grammar types (`AnchorKind`, `AnchorSide`, `AnchorSpan`, `ParsedAnchor`), lineage, and the four `ResolutionOutcome`s
- [x] 1.4 Add `OfferedManifest`/`ManifestOccurrence`/`LineageEntry`, `SettingsProjection`/`SizeLimits` (no item cap), `AdmissionKind`, and the `ValidationReport`

## 2. Canonical serialisation + digest (protocol)

- [x] 2.1 Add a pure, node-free SHA-256 verified against NIST vectors and cross-checked against `node:crypto` (red-then-green proven)
- [x] 2.2 Add `canonicalize` (recursively sorted keys, 2-space, LF) and `computeInputDigest` (order-independent over the offered manifest)

## 3. Anchor grammar + resolution (protocol)

- [x] 3.1 Add `parseAnchor` against the §3.1 grammar (side-qualified spans, pointer frags, symbol-path ids, chunk proposals); unknown kind/side and malformed reported distinctly
- [x] 3.2 Add `resolveAnchor` as a total function: `resolved`/`unresolved`/`superseded`/`orphaned`, ambiguity failing closed (never carries state)

## 4. The validator (protocol)

- [x] 4.1 Add the envelope + provenance zod schemas (V002) and the `DOC_TYPE_REGISTRY` (admission kind + item pointers + version window)
- [x] 4.2 Implement the universal rule catalogue V001, V003, V004, V005, V006, V007, V008, V009 over a generic body walk (resolve every anchor, byte-match every quote)
- [x] 4.3 Implement admission granularity: atomic documents reject wholesale; item-wise documents admit item-by-item with a mandatory visible rejected count
- [x] 4.4 Size limits reject, never truncate; no item-count cap anywhere (decisions are never capped)

## 5. Tests + gates

- [x] 5.1 One fixture per validator rule in both directions (pass + rejection with the right code)
- [x] 5.2 Acceptance: fabricated anchor id rejects (V008); paraphrased quote rejects on byte-match (V006); unknown `x` keys survive round-trip; unknown docType rejects loudly (V001)
- [x] 5.3 Acceptance: the validator runs standalone against a fixture manifest with zero app context
- [x] 5.4 Red-then-green proof on the V006 byte-match test (named test reddens on revert, restores green)
- [x] 5.5 Full `pnpm check` green across all 7 projects (format, architecture, licenses, lint, typecheck, test, build)
- [x] 5.6 File follow-up beads: #8 body schemas + body rules; remaining collection item pointers; adapter `docId` minting; full `inputDigest` fingerprint
