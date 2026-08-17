# Tasks — adopt-codex-app-server

## 1. App-server transport (packages/adapters)

- [x] 1.1 Rewrite `createCodexTurnTransport` to spawn `codex app-server` and speak newline-delimited JSON-RPC 2.0 over stdio: `initialize` → `initialized` → `thread/start` → `turn/start` (input, cwd, model/effort, full-access sandbox policy, never-ask approvals, `outputSchema` when the spec carries one); id-correlation for responses, notification routing, turn-scoped child lifetime. No new dependency. Hermetic tests over an injected fake stdio pair cover the happy turn, streamed items, structured output, and strictly increasing `seq`.
- [x] 1.2 Frame mapping per design D3: `item/agentMessage/delta` and friends into the existing native-frame normalization (never dropped), `thread/tokenUsage/updated` into usage, `turn/completed` into the completed outcome with final agent message as structured output. Kill the exec-era last-message scratch-file capture on this path.
- [x] 1.3 Failure taxonomy per D3/spec: JSON-RPC error, `turn/completed`(failed) (TurnError.message verbatim — auth expiry must reach the outcome), pre-terminal process exit, spawn failure. `interrupt()`/`close()`/abort send `turn/interrupt` then kill the tree, awaiting transport completion. Tests fake each failure shape.
- [x] 1.4 Move `createCodexExecutor` (utility one-shot) onto the same turn runner; delete `codex exec` composition. Update its tests.
- [x] 1.5 Locus: spawn through `locusCommand` for WSL loci with distro-native `turn/start` cwd; no scratch translation needed on the turn path (stdio is locus-transparent). Host path spawns the host binary directly. Hermetic argv/cwd tests both loci.
- [x] 1.6 canvasOps: keep spawn-time `-c` config overrides carrying the loopback/distro-reachable MCP URL; assert unchanged reachability composition in tests.

## 2. Discovery (packages/adapters)

- [x] 2.1 Add macOS ChatGPT-desktop bundled candidates (`/Applications/ChatGPT.app/Contents/Resources/codex`, `~/Applications` variant) with provenance, ordered after CLI candidates; Windows adds NO Store-bundle candidate and the absent-codex health detail names the CLI install remedy.
- [x] 2.2 App-server handshake probe on the chosen candidate (spawn `app-server`, `initialize`, bounded wait, kill); failure → `unavailable` with detail naming the probe and found version. WSL asdf paired-node launcher gains `app-server` argv support.
- [x] 2.3 Update `codex-session-usage` composition where the turn path now sources usage in-protocol; keep file-based reads only where still load-bearing (or delete if dead — decide from references, not speculation). [Decision: KEPT — the turn/utility paths now source usage in-protocol from `thread/tokenUsage/updated`, but `codex-session-usage` is still referenced by the gated `dual-review-cost.real.test.ts` (`codexSessionsRoot`, `CodexSessionReadResult`), so it is not dead; the `onUsageMeasurement` hook still fires measured/unmeasured from the in-protocol usage.]

## 3. Desktop composition (apps/desktop MAIN)

- [x] 3.1 Re-point `getCodexResolution` composition to the app-server transport (all loci); memoization keys and locus threading unchanged. Grep-grade guard from wsl-remainder must stay green with exact counts updated if signatures move. [Transport/executor signatures preserved, so the guard's exact counts (6 getCodexResolution sites) are unchanged; the composition now threads `chosen.runtimePath` into both the executor and the transport.]

## 4. Docs (same change, definition of done)

- [x] 4.1 New `developing/reference/codex-app-server.md`: framing, exact method surface, frame-mapping table, discovery candidates + Windows Store ACL ceiling, shared `~/.codex` auth, schema-dump provenance (`codex app-server generate-json-schema`). Mermaid sequence diagram of the turn lifecycle.
- [x] 4.2 Rewrite the codex section of `developing/concepts/harness-adapters.md`; update Using-side setup guidance (macOS: ChatGPT desktop alone suffices; Windows: codex CLI install) and `windows-and-wsl.md` where it names codex invocation; delivery-order entry.

## 5. Live verification

- [ ] 5.1 Gated real test (`RENNET_LIVE_*`): one real app-server turn through the mac ChatGPT-bundled binary — discovery chooses it with the CLI absent from candidates, structured output round-trips, usage recorded.
- [ ] 5.2 Re-run the gated WSL live codex test on lancelot (now over app-server); re-run the win32 gate throttled.

## 6. Gate

- [ ] 6.1 `pnpm check` full gate with positive controls; push and verify remote ref.
