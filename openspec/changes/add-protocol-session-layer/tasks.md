# Tasks — add-protocol-session-layer (#376)

## 1. Session schemas

- [ ] 1.1 Create `packages/protocol/src/session.ts`: `helloFrameSchema`, `serverInfoFrameSchema`, `requestFrameSchema`, `responseFrameSchema`, `rpcErrorFrameSchema`, `progressEventFrameSchema`, `askStreamEventFrameSchema`; discriminated union `sessionFrameSchema` over `type`; inferred types exported. Frames are tolerant (default Zod object stripping — NOT `.strict()`); payload schemas (`projectProcessEventSchema`, `reviewAskStreamEventSchema`) imported from `index.ts`, never copied.
- [ ] 1.2 `PROTOCOL_VERSION = 1`, `MIN_COMPATIBLE_PROTOCOL_VERSION = 1`, and `checkProtocolCompatibility(mine, theirs)` per design D4 (discriminated result, not boolean).
- [ ] 1.3 `parseSessionFrame(value: unknown): SessionFrame` mirroring `parseCommandInput` style; `request.command` refined against `isCommandName`.
- [ ] 1.4 Re-export everything from `packages/protocol/src/index.ts` so `@rennet/protocol` root stays the only import surface.

## 2. Tests (`packages/protocol/src/session.test.ts`)

- [ ] 2.1 Round-trip every frame type: build → JSON.stringify → JSON.parse → `parseSessionFrame` → deep-equal (payload fields intact).
- [ ] 2.2 Unknown-field tolerance: each frame type with an extra unknown top-level field parses successfully and the unknown field is stripped. Red-proof: assert first that a `.strict()` variant WOULD reject it (prediction named before running), then the real schema accepts.
- [ ] 2.3 Version-window helper: compatible same-version, compatible within window, incompatible client-too-old, incompatible server-too-old — each with the expected `reason`.
- [ ] 2.4 `request` with a name not in `commandDefinitions` fails parse; a valid command name passes.
- [ ] 2.5 `rpcError` accepts both a known enum code and a novel string code.

## 3. Docs (same change — definition of done)

- [ ] 3.1 New page `docs/src/content/docs/developing/reference/protocol-compatibility.md`: the discipline (append-only wire schemas; one `PROTOCOL_VERSION` + min-compat window; features gated once on `serverInfo.features.*`, no fallback paths; `COMPAT(name)` shims with removal dates; tolerant decoders on inbound frames), the frame vocabulary table, and the D1 strict-vs-tolerant rule. Follow `developing/contributing/docs-style-guide.md` and `good-docs-standard.md`.
- [ ] 3.2 Register the page in `docs/astro.config.mjs` (Reference section) — Starlight fails the build on unregistered pages.
- [ ] 3.3 Link the page from `app-server-plan.md` (phase 0 row / relevant section).

## 4. Gate

- [ ] 4.1 `NX_DAEMON=false pnpm check` from the worktree root: exit 0 AND output contains `Successfully ran target`. Zero changes outside `packages/protocol` and `docs/`.
