# Design — adopt-codex-app-server

## Verified ground (empirical, this machine + lancelot, 2026-08-17)

- macOS ChatGPT.app bundles `Contents/Resources/codex` (codex-cli 0.144.2, arm64 Mach-O) — spawnable, `app-server` subcommand present.
- Live handshake: newline-delimited JSON-RPC 2.0 over stdio (NO LSP Content-Length framing). `initialize` with `{clientInfo:{name,title,version}}` answers with `{userAgent, codexHome, platformFamily, platformOs}`; the bundled binary reports `codexHome: ~/.codex` — **auth is shared with the codex CLI** (same auth.json home).
- Windows ChatGPT desktop is the `OpenAI.Codex` Store package; `app\resources\codex.exe` exists next to `ChatGPT.exe` but WindowsApps ACLs deny out-of-package execution ("Access is denied") and the AppxManifest exposes no ExecutionAlias. Not drivable — Windows rides the npm codex CLI (0.147.0 verified, has `app-server`).
- Machine-generated protocol schema (v1 + v2) dumped via `codex app-server generate-json-schema --out <dir>`; the v2 surface Rennet needs, with exact method names:
  - `initialize` (then the required `initialized` notification) → `thread/start` (approvalPolicy, sandbox, …) → `turn/start` `{threadId, input, cwd, model, effort, sandboxPolicy, approvalPolicy, outputSchema, …}`. The wire omits the `jsonrpc` member; the server can also send requests (approvals) that must be answered.
  - `turn/interrupt` `{threadId, turnId}`.
  - Streaming: `turn/started`, `item/started`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/reasoning/*`, `item/completed`, `thread/tokenUsage/updated` (ThreadTokenUsage/TokenUsageBreakdown), terminal `turn/completed` `{threadId, turn: {id, items, status, error?, durationMs}}`; `TurnError {message, codexErrorInfo}`.
  - Input variants: text, image, localImage, skill, mention — image attachment is first-class.
  - `outputSchema` on `turn/start` is first-class — replaces `--output-schema` + last-message file capture, **no scratch files on the turn path at all**.
  - Auth surface: `account/read`, `account/login/start`, `account/login/completed` notification.

## Decisions

### D1 — Turn-scoped app-server child, one thread, one turn

Keep the shipped session model: spawn `codex app-server` per turn, `initialize` → `thread/start` → `turn/start`, consume until `turn/completed`/`turn/failed`, then terminate the child. No daemon mode, no thread reuse, no session pooling — that is a later optimization with real lifecycle questions (stale cwd, config drift) and zero present need. The transport interface stays "one async turn in, frames out", so the adapter and every consumer are untouched by the swap.

### D2 — Transport seam and naming

`createCodexTurnTransport` keeps its name and injected-deps shape (spawn fn, locus) but speaks JSON-RPC: compose spawn argv (`codex app-server`), write newline-delimited requests, parse stdout lines, route notifications into the existing native-frame normalization. The line protocol is ~30 lines (readline over stdout, JSON.parse, id-correlation map); **no new dependency**.

**Config isolation (verified empirical correction):** `codex app-server` REJECTS `--ignore-user-config` ("unexpected argument" — tested against the real binary), so the flag cannot be carried over from the exec transport. Determinism is instead pinned for the load-bearing key: the spawn composes a FULL-TABLE `-c mcp_servers=<inline TOML>` override, which REPLACES the entire `mcp_servers` table (never merges), so ONLY Rennet's canvasOps MCP server (or none, `mcp_servers={}`) is configured for the child regardless of the user's `~/.codex` config. Other user config keys load as they do for every rich client of the app-server — the exec-era "one-shot must not inherit the full agent config" isolation is not achievable via a flag here, and only the MCP surface is load-bearing for a turn.

### D3 — Frame mapping

| app-server (v2) | adapter event |
| --- | --- |
| `thread/start` response + `turn/started` | `session.started` |
| `item/agentMessage/delta` | streamed assistant text |
| `item/commandExecution/*`, `item/fileChange/*`, `item/reasoning/*`, `item/started`/`item/completed` | normalized item events / passthrough (never dropped) |
| `thread/tokenUsage/updated` | usage (replaces codex-session-usage file reads on this path) |
| `item/completed` carrying the `agentMessage` item | final message text (structured output when `outputSchema` set) |
| `turn/completed` status completed | `session.ended` completed with the accumulated final message + usage |
| `turn/completed` status failed | `failed` outcome; `TurnError.message` verbatim |
| `turn/completed` status interrupted | `cancelled` outcome (this is the interrupt ack; not the RPC response) |
| JSON-RPC error response / process exit pre-terminal | `HarnessError` (origin transport/harness per class) |

### D4 — Capability posture (Rule Zero)

`thread/start`/`turn/start` compose the full-access sandbox policy and never-ask approval policy — the app-server peers of `--dangerously-bypass-approvals-and-sandbox`. Server-initiated approval requests (`ServerRequest` approvals) are made unreachable by policy; if one arrives anyway it is answered affirmatively and surfaced as evidence. No approval plumbing enters the adapter.

### D5 — Discovery

- macOS candidates, in preference order: PATH/known-dir codex CLI (existing probes) → `/Applications/ChatGPT.app/Contents/Resources/codex` → `~/Applications/ChatGPT.app/...`. Same executability/version probe as today; candidate provenance recorded ("chatgpt-desktop-bundle").
- App-server capability probe on the chosen candidate: spawn `app-server`, send `initialize`, require a response line (bounded timeout), kill. Failure → `unavailable` with detail; never fall back silently to exec mode.
- Windows: no Store-bundle candidate (ACL-locked, verified); health detail for absent codex names the CLI install remedy.
- WSL distro discovery unchanged (asdf paired-node launch pattern carries over: the launcher argv gains `app-server` after the codex js path).

### D6 — canvasOps MCP attach

`codex app-server` accepts the same `-c key=value` config overrides as every codex subcommand; the canvasOps MCP loopback URL keeps riding spawn-time config overrides exactly as the exec transport did. Distro-reachability logic (wsl-remainder) is untouched.

### D7 — codex-exec.ts (utility executor)

The one-shot utility executor (`createCodexExecutor`) also moves to the app-server transport so there is ONE native surface (shared turn runner, no prompt-flag drift). `codex exec` composition is deleted with the old transport.

### D8 — Version floor

App-server v2 surface requires a recent codex; the recorded floor for the swapped adapter is the app-server handshake itself (D5's probe), with tested versions recorded via the existing conformance artifact — not a hand-pinned semver. Verified working: 0.144.2 (bundled), 0.146.0 (mac CLI), 0.147.0 (win CLI).

### D9 — Docs

New Developing reference page `codex-app-server.md`: framing, method surface used, frame mapping table, discovery candidates (ChatGPT desktop macOS; Windows Store ACL ceiling + CLI remedy), shared `~/.codex` auth, schema-dump provenance. `harness-adapters.md` codex section rewritten; Using-side setup guidance updated ("have ChatGPT desktop on a Mac → codex works with no CLI install").

## Rejected

- **Daemon/proxy mode** (`app-server daemon`): shared state across turns, no present need. Revisit if spawn latency ever matters.
- **Attaching to an already-running app-server** (raised by Rai 2026-08-17; probed live before rejecting): ChatGPT desktop's own app-server is a private stdio child (observed: `codex app-server --analytics-default-enabled` under ChatGPT.app) — another process's stdio is not attachable. The `~/.codex/app-server-control/app-server-control.sock` daemon that was also running belongs to codex's SSH remote-control bootstrap, not the desktop app; it refused raw JSONL (silence), refused plain HTTP (connection failed), reports remote control `disabled`, and `codex app-server proxy` behavior drifted between the two installed versions (bundled 0.144: silent close; CLI 0.146: "control socket is already in use"). The surface is websocket-over-upgrade, auth-gated (`--ws-auth`), and upstream-flagged experimental. Meanwhile the reuse that matters already holds by construction: a spawned child shares `CODEX_HOME` — same login, same account, threads visible to the desktop app's rollout store. Revisit as an attach-first seam if OpenAI stabilizes the control socket.
- **Keeping exec as fallback for old binaries**: two native surfaces to test forever; discovery instead reports honest unavailability with the version found (D5/D8).
