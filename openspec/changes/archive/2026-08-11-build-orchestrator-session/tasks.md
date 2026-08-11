## 1. The lean bootstrap (core)

- [x] 1.1 `orchestrator-primer.ts`: primer input shapes — B1 `ReviewIdentity` (reused from canvasOps), B2 `RepoFreshness`, B3 `CanvasStateSummary` (counts only), B5 `PrimerToolEntry`, B6 `RunLedgerHeadline`
- [x] 1.2 The versioned protocol card: `PROTOCOL_CARD` constant + `PROTOCOL_CARD_VERSION`, faithful to Orchestrator Context Access §4 — four-actor contract, the two principles, what it can never do, the ask protocol incl. "never answer from recall — retrieve or ask first"
- [x] 1.3 `toolIndexFromSurface(tools)`: B5 derived from the live `CANVAS_OPS_TOOLS` — name + a terse when-to-use one-liner per tool (honest about what is attached)
- [x] 1.4 `assemblePrimer(inputs)`: deterministic assembly (stable ordering) → `PrimerManifest` {version, cardVersion, text, digest (node-free `sha256Hex`), bytes, sections}; ≤ 4 KB
- [x] 1.5 B3 answers "where are we / what have I not looked at" from counts alone — the unread/coverage numbers are IN the primer text (no tool call needed)

## 2. The context-update stream (core)

- [x] 2.1 `context-update-stream.ts`: the event union — `{selected}`, `{disposed}`, `{proposal-adjudicated}` (outcome + editedPayload), `{viewing}` — each carrying a store `seq`; a `DeliveredEvent`
- [x] 2.2 `ViewingBatcher`: hand-rolled, under an injected clock — bounded buffer, coalesce-by-key (later viewing for a canvas replaces earlier), **never silent** (a coalesced delivery carries the `covers` seq range), `flushDue(now)`
- [x] 2.3 Change-feed consumption: subscribe to #10's `CanvasChangeFeed`; a notification becomes an ordered `{changed}` invalidation-hint event (seq range preserved) — R35, not Rx
- [x] 2.4 `PromptContextLog`: append-only, ordered; `entries()`, `serialize()` (byte-for-byte inspectable panel); turn watermark so `nextTurnContext()` returns events since the last turn
- [x] 2.5 Request-time view injection (Q5): `buildRequest(question, view)` carries the current canvas/lens/cohort/selection so "this" resolves without restating

## 3. The session shell + attachment (core + adapters)

- [x] 3.1 `orchestrator-session.ts`: `bootOrchestratorSession(inputs)` — fresh by default (OQ9), assembles the primer, records the digest in provenance, wires the stream, exposes the attached tool index (from `CANVAS_OPS_TOOLS`), primer manifest, request builder, and open-assembled-prompt panel
- [x] 3.2 The attached surface is exactly the `canvasOps@2` registry and contains no user-only/engine-only op (#49 item 3, structural)
- [x] 3.3 Re-export the three modules from `packages/core/src/index.ts`
- [x] 3.4 `orchestrator-session-server.ts` (adapters): `attachOrchestratorSession(backend, inputs)` boots the core session AND builds the in-process `canvasOps@2` MCP server (#12's `createCanvasOpsServer`), returning `{session, mcpServer}`; re-export from `adapters/index.ts`

## 4. Verification

- [x] 4.1 Core tests (primer): a full-review fixture boots a primer ≤ 4 KB; B3 answers "where are we / what have you not looked at" from the primer text with no tool call; assembly is deterministic (same state → identical bytes AND identical digest); the card matches `PROTOCOL_CARD` and is versioned; the digest is recorded in provenance
- [x] 4.2 Core tests (stream): a user selection appears in the next-turn context (fixture-asserted); a question asked while on the decisions lens carries `angle: "decisions"` at request time; the viewing batcher coalesces two viewings of one canvas into one delivery that states the covered seq range and is never silent; consumers coalesce, never reorder; every pushed event is present byte-for-byte in the open-assembled-prompt panel; a change-feed notification is delivered as an ordered event
- [x] 4.3 Adapters test: `attachOrchestratorSession` returns a session whose tool index equals the canvasOps@2 registry and an MCP server registering that exact tool set — without spawning a model (fake SDK loader)
- [x] 4.4 `pnpm check` green across all projects (zero errors + `Successfully ran target`), independently re-verified with the real checker (`tsc6`) on the touched packages
