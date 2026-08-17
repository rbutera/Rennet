# Design — add-codex-app-server

## 1. Transport verdict: `codex exec --json`, app-server deferred behind the seam

The issue's letter says `codex app-server` JSON-RPC. The live evidence says exec:

- **The consumers are single-turn.** `packages/core/src/harness-run-turn.ts:174` ("Each call creates a fresh capable session (slice-1 adapters are single-turn)") and every `HarnessPort` consumer (`finding-verification-backend`, `knowledge-enrichment`, `context-ask-backend`, `ci-refinement-backend`, `turn-metrics`) create → send one prompt → drain → close. Nothing consumes steering, mid-turn injection, or thread resume — the only things app-server offers that exec does not.
- **The approval apparatus is struck.** The Rule Zero amendment (issue body, 2026-08-11) removed the eleven fail-closed server-initiated approval requests, approval binding, and invalidation-on-interrupt. Those approvals only exist on the app-server protocol; they were its main structural requirement. `codex exec` is non-interactive and has no approvals — it *is* the permissive posture.
- **The protocol is volatile, as the issue itself warns.** Installed `codex` 0.146.0: `app-server` is labeled `[experimental]`, and its shape has already drifted from the issue's `--stdio` description to a daemon/proxy model with `generate-ts --experimental` bindings. Implementing "only the consumed subset" of it, when the consumed subset is one turn, reduces to what exec already does.

So: `CodexAdapter implements HarnessPort` with an **injected transport** (§2). When a future wave actually consumes steering or resume (`codex exec resume` exists too, note), an app-server transport implements the same seam; the adapter, conformance suite, and consumers don't move. The change keeps the issue's slug.

## 2. The seam: `CodexTurnTransport`, mirror of `ClaudeQueryFn`

```ts
// packages/adapters/src/codex-adapter.ts
export interface CodexTurnSpec {
  readonly cwd: string;          // the review worktree — a real repo, unlike the utility port's scratch
  readonly prompt: string;
  readonly model?: string;       // codex's own default when absent; council passes e.g. "gpt-5.6-sol"
  readonly outputSchema?: unknown;
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
  readonly signal?: AbortSignal;
}
export type CodexTurnTransport = (spec: CodexTurnSpec) => AsyncIterable<unknown>; // raw JSONL frames
```

The adapter consumes raw frames and owns normalization, seq, outcome, and error mapping — exactly the `ClaudeAdapter`/`ClaudeQueryFn` split (`claude-adapter.ts:516`, `claude-query.ts`). Tests inject fake transports; the composition root supplies the real spawn.

## 3. The real spawn (composition root, `@rennet/adapters`)

Reuses `codex-exec.ts`'s four proven gotchas (stall on user config, stdin hang, `-o` capture) with the agentic deltas:

```
codex exec --json
  --ignore-user-config
  -C <spec.cwd>                       # a real repo; NO --skip-git-repo-check
  --dangerously-bypass-approvals-and-sandbox
  [-m <model>]
  [--output-schema <tmp/schema.json>] [-o <tmp/last-message>]
  [-c mcp_servers.<name>.url=<url>]…  # canvasOps@2 loopback (§5)
  <prompt>                            # stdin: "ignore"
```

- `--dangerously-bypass-approvals-and-sandbox` is the deliberate Rule Zero posture, same as the Claude adapter's ungated `SESSION_ALLOWED_TOOLS` (claude-adapter.ts:44 comment): capable by default, Bash carries `git`, push works because Make-PR requires it. The flag's scary name is OpenAI's, not a reason to confine the acting path.
- `--ignore-user-config` stays even agentically: Rennet's session must be deterministic (the user's `~/.codex` plugins/MCP/hooks stalled the spike and would smuggle unknown tools into a review turn). Everything the session needs arrives as explicit `-c` overrides. Auth is untouched — `auth.json` is not config, and we never read it.
- Binary path from `discoverCodex` (`harness-discovery.ts:504`) — override → PATH/known dirs, proven by `--version`, shim-averse. Absolute path only.
- **Locus:** host only. `CodexTurnSpec.cwd` is a host path and the spawn is a plain host `execa`. The WSL seam (#334) lands where `checkpoint-store.ts` puts it — a `Locus` parameter on the composition root's spawn, `locusCommand`-wrapped — and is explicitly out of scope here.

## 4. Frame normalization

`codex exec --json` emits JSONL thread events. Tolerant structural decoders (never a strict schema on vendor frames), mapped to the existing `HarnessEvent` kinds:

| native frame (shape-matched) | event |
| --- | --- |
| `thread.started` / first frame | `session.started` (session ids minted by adapter regardless) |
| `item.started` with official `item.type` command/MCP/file change | `tool.started`, stable item id, classified as `exec`/`mcp`/`write` (`item.item_type` accepted only as compatibility fallback) |
| completed agent message item | `text.message` |
| completed command or MCP item | `tool.output`, stable item id, native result and status-derived success |
| completed file change item | paired `tool.started` + `tool.output` because Codex emits no start frame for it |
| `turn.completed` + captured `-o` last message | `session.ended` `completed`, `structuredOutput` parsed from the last-message capture, disjoint `usage` fields (`input = input_tokens - cached_input_tokens`, cache read, cache write, output), `costUsd` absent — codex reports none, the flag stays honestly false |
| `turn.failed` / error frame | `session.ended` `failed` with mapped `HarnessError` |
| anything else | `passthrough`, raw frame verbatim |

Every event carries the adapter's monotonic `seq` and the raw `native` frame (harness-adapter-protocol requirements — already promoted, not re-specced here).

Error mapping mirror of `mapClaudeError`: nonzero exit → class from stderr shape, `origin: "harness"`; spawn/ENOENT → `origin: "transport"`; provider throttle strings → `origin: "provider"`, `retryableSource: "inferred"` unless the frame says so.

The event stream is subscribe-once: a second `events` access throws before it can spawn another turn. Interrupt and close abort the turn, terminate the spawned process tree (including launcher descendants), and wait for the transport drain to finish.

## 5. canvasOps@2 external transport: loopback streamable HTTP, not a stdio shim

The live backend (`CanvasOpsBackend`) holds in-memory session state inside the desktop process. A stdio MCP server *spawned by codex* would be a child of codex with no channel to that state — it would need its own IPC bridge back to desktop. So the external transport is the desktop process itself listening:

- New `packages/adapters/src/canvas-ops-external.ts`: compiles the same neutral `CANVAS_OPS_TOOLS` catalogue (same zod compilation as `canvas-ops-server.ts`) into an `@modelcontextprotocol/sdk` `McpServer`, served on a `StreamableHTTPServerTransport` bound to `127.0.0.1` on an ephemeral port. Loopback only; the port is handed to the session spec, nothing is exposed off-host. Honest copy note, not a gate: this is a local listener, no Rennet backend.
- Codex reaches it via `-c mcp_servers.canvasops.url=http://127.0.0.1:<port>/mcp` — verified supported by installed codex (`codex mcp add --url <URL>`, "URL for a streamable HTTP MCP server").
- `@modelcontextprotocol/sdk` becomes a **declared** direct dependency of `@rennet/adapters`. It is already in the tree (the agent SDK depends on it, and `canvas-ops-server.ts` already imports its types undeclared — a phantom dep this change repairs). MIT; pin per dependency standard.
- The tool *contract* stays in core; both transports compile the same descriptors. `orchestrator-session-server.ts` gains a codex-slot sibling that boots the same core session and hands back the URL instead of the SDK instance. No `if (harness === X)` inside the interaction layer — the fork is in the composition root, which is where transport wiring lives.

## 6. Conformance suite (`packages/core/src/harness-conformance.ts`)

Pure over `HarnessPort` — a catalogue of named checks, each bound to exactly one `CapabilityName`:

- `structuredOutput`: turn with `outputSchema` completes with parseable structured output.
- `interrupt`: start drain, wait for an in-flight readiness event, call only `session.interrupt()`, then require `cancelled` and transport termination.
- `textDeltas`, `costUsd`: presence checks on the streamed/terminal frames.
- `reportsContextWindow`: actual normalized context-window capacity; token usage is not capacity and cannot pass the check.
- `resume`, `fork`, `toolGating`: no checks in this change → structurally false everywhere (absence of evidence is absence of capability). Not stubbed as passing.

Runner output is `CapabilityEvidence` for `buildCapabilities` (`harness.ts:95`). Layer attribution: fake-transport runs produce only `implementedByAdapter`; the gated real run produces `advertisedByHarness`/`availableInSession`. **Refuting controls:** every suite invocation runs every check against its own deliberately broken port and requires failure — if any broken variant passes, the suite refuses to certify.

**testedRange artifact:** `packages/adapters/src/harness-tested-range.json` — per-harness `{ min, maxTested }` entries. The gated real run updates it only when the complete result matches the harness's expected pass/fail matrix; partial success records nothing. Descriptors read the artifact; `CLAUDE_TESTED_RANGE` is deleted in favour of the explicitly permitted Claude migration seed (`min 2.0.0, maxTested 2.1.220`). Codex has no seed until its first genuine full-match real run writes one.

## 7. Desktop composition

The existing `orchestrator-chat` consumer resolves its assigned harness in `apps/desktop/src/main/index.ts`. Claude keeps the in-process SDK path. A Codex-selected assignment constructs `CodexAdapter` over the discovered-binary transport, attaches the same live canvasOps backend as an external loopback MCP server, and executes through `runCodexOrchestratorTurn`. A hermetic composition test injects the transport and proves this selection reaches it. The other structured-completion seats remain on `CodexUtilityPort`; this change adds no consumers beyond the spec.

## 8. Test strategy (red-first, no codex spend in the gate)

Every behavior lands test-first against **fake transports** (async-iterable frame arrays), in the existing hermetic pattern (`claude-adapter.test.ts` is the template):

1. Red: conformance suite against one broken fake per check — every control fires.
2. Red: `CodexAdapter` normalization/outcome/interrupt/error tests against fakes.
3. Red: external canvasOps server round-trip with an in-test MCP client (HTTP to loopback) — no codex involved.
4. Green: implement adapter, suite, transport.
5. Gated `.real.test.ts` (env-var opt-in, the `codex-utility-port.real.test.ts` pattern): suite vs real `codex` 0.146.0; orchestrator describe→read with codex picked; records testedRange. Not in `pnpm check`.

Positive controls throughout: the credential-read tripwire proven able to fire (claude-harness-adapter precedent), the conformance control, and the argv assertions on the pure builder (no spawn needed).

## 9. Docs (same change)

- `delivery-order.md`: wave-10 entry — #25 rescoped per this design (exec transport, app-server seam named), #41 unblocked next.
- New `docs/src/content/docs/developing/concepts/` page (or extend the harness section): the two-adapter architecture, the seam, derived capabilities, the conformance suite, and the honest egress line (codex is the user's binary on the user's subscription; canvasOps listener is loopback-only).

## Out of scope, named

- app-server JSON-RPC transport (seam reserved, §1–2).
- WSL codex locus (#334).
- #41 adjudication and #26 omp — consumers of this change, not parts of it.
- Any approval/consent apparatus (struck by the Rule Zero amendment; deliberately absent, including from tests).
