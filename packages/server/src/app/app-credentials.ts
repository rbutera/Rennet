// The names the daemon's app-tools server and the sidecar spawn share
// (`session-thread-briefing`, "The app-tools server mirrors the board server").
//
// A LEAF module, for the same reason `board/board-credentials.ts` is one: `t3/sidecar.ts`
// needs the environment-variable name and nothing else, and importing it from the listener
// would drag the whole app-tools surface — the command registry, the dispatch types, the
// HTTP layer — into a module whose job is process supervision. Nothing here imports
// anything at all.

/**
 * The name the session thread's app-tools server is bound to on the thread.
 *
 * A TOML bare key, because Codex writes it into a dotted config path; and a name the
 * sidecar's own server (`t3-code`) and a user's own Codex config are not plausibly going
 * to carry, because a collision is REFUSED by name at the adapter rather than merged.
 */
export const APP_MCP_SERVER_NAME = "rennet_app";

/** The environment variable the harness child reads the process bearer out of. */
export const APP_BEARER_ENV_VAR = "RENNET_APP_BEARER";

// ── Why there is no per-thread token, where a seat has one ──────────────────────
// The board server derives a per-seat token into the address path because a seat's
// address NAMES the board its calls write: two seats of one lane share a board, and the
// token is what says which voice wrote an element. An app-tools address names nothing a
// call could not otherwise reach — every tool is a command the reviewer can run from the
// app, and the dispatch is the same one the WS listener calls. So the thread id in the
// path is IDENTITY, not a capability: it is what the server stamps an authored act with
// (`{ kind: "orchestrator", id: <threadId> }`), and the process bearer in the sidecar's
// environment is the whole credential.
//
// Adding a per-thread secret here would buy nothing — a caller holding the bearer is
// already inside this boundary, exactly as `deriveSeatToken` says — and would cost the
// property that makes the url stable: both providers fix a session's MCP configuration
// when the harness child is created, so a thread's url must be reproducible for the
// thread's whole life or its next turn is refused by name.
