# Proposal — adopt-codex-app-server

## Why

Rennet's Codex seat shells out to `codex exec --json` per turn — a batch CLI surface OpenAI treats as secondary to the app-server protocol that their own products (ChatGPT desktop, the IDE extension) are built on. Driving `codex app-server` instead gives Rennet a long-lived JSON-RPC session with structured thread/turn/item semantics, richer streaming (agent message deltas, command execution items, token counts), first-class interrupt and auth methods — and it makes a user's existing **ChatGPT desktop install a usable Codex harness with zero extra installation on macOS**, because ChatGPT.app bundles the same `codex` binary and shares `~/.codex` auth (verified empirically on this machine: `/Applications/ChatGPT.app/Contents/Resources/codex`, codex-cli 0.144.2, `initialize` handshake answers over newline-delimited JSON-RPC and reports `codexHome: ~/.codex`).

## What Changes

- **BREAKING (internal): the Codex adapter's transport moves from per-turn `codex exec --json` argv to a per-turn-scoped `codex app-server` JSON-RPC session** (newline-delimited JSON-RPC 2.0 over stdio: `initialize` → `thread/start` → `turn/start`, streaming `item/*` notifications, `turn/interrupt` for kills). The adapter's public protocol surface (frames, error taxonomy, usage) is unchanged; only the native-frame source changes.
- Discovery learns the **ChatGPT-desktop-bundled codex binary** as a candidate: `/Applications/ChatGPT.app/Contents/Resources/codex` on macOS. On Windows the Store package (`OpenAI.Codex_*` under `C:\Program Files\WindowsApps`) is ACL-locked — its bundled `codex.exe` is not spawnable by other processes (verified: Access is denied; no ExecutionAlias in the AppxManifest) — so Windows support continues to route through an installed codex CLI, which ships the same `app-server` subcommand (verified on codex-cli 0.147.0).
- Candidate ordering and health stay evidence-derived: a candidate that cannot answer `initialize` is unavailable with the probe detail, never silently skipped.
- WSL loci keep working: the app-server child is spawned through the existing `locusCommand` seam exactly like the exec transport was.
- canvasOps bridging, structured output, and image attachments are re-expressed in app-server turn terms (or honestly recorded as gaps if the protocol lacks an equivalent — resolved in design from the machine-generated protocol schema).
- Docsite: a new Developing-side reference page documenting the codex app-server integration (protocol framing, method surface Rennet uses, discovery candidates including ChatGPT desktop, auth sharing via `~/.codex`), plus updates to `harness-adapters.md` and the Using-side harness setup guidance.

## Capabilities

### New Capabilities

_None — this re-implements the transport beneath the existing codex-harness-adapter capability._

### Modified Capabilities

- `codex-harness-adapter`: the injected transport contract becomes an app-server JSON-RPC session (thread/turn lifecycle, streamed items, interrupt); discovery/composition requirements gain the ChatGPT-desktop-bundled binary candidate on macOS and the honest Windows Store ACL ceiling.
- `harness-discovery`: candidate enumeration for Codex gains the ChatGPT desktop bundled-binary path (macOS) and the app-server capability probe (`app-server` subcommand present and `initialize` answers) as recorded evidence.

## Impact

- `packages/adapters`: `codex-turn-transport.ts` (replaced by an app-server session transport), `codex-exec.ts` (utility executor re-pointed or retained where `exec` remains the right tool), `codex-adapter.ts` (native frame mapping from `item/*` notifications), `harness-discovery.ts` (new candidate + probe), `codex-session-usage.ts` (token counts now arrive in-protocol).
- `apps/desktop`: composition root wiring (`getCodexResolution`), no IPC surface change.
- Docs: new reference page + `harness-adapters.md`, `windows-and-wsl.md`, delivery-order entry.
- No new npm dependency expected (JSON-RPC framing is newline-delimited JSON — a few lines, not a library).
- Machine evidence available to implementers: full protocol JSON schema dumped from the bundled binary (v1 + v2) during this proposal's research.
