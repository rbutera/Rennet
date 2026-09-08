import type { RspTokenUsage } from "@rennet/protocol";

export interface CodexExecRequest {
  /**
   * Which seat is asking (`board.lens-draft.flagged-codex`, `delta-digest`, …): logs,
   * the measurement tap and test attribution only. One executor is shared by every
   * utility port, so without it a recorded turn cannot say which seat spent the tokens.
   * Never reaches the model.
   */
  readonly label?: string;
  /** The Codex model, e.g. "gpt-5.6-luna". Passed to `codex exec -m`. */
  readonly model: string;
  /** The reasoning effort, e.g. "low". Passed to `-c model_reasoning_effort=`. */
  readonly effort: string;
  /** The fully-assembled prompt (system + user + any fed-back rejection report). */
  readonly prompt: string;
  /** The JSON schema constraining the output (`--output-schema`); omitted when the
   *  docType has no body schema in this slice. */
  readonly outputSchema?: unknown;
  /**
   * The raw response budget in UTF-8 bytes, enforced by the executor BEFORE it parses
   * the final message. Mirrors `SessionSpec.outputByteCap` on the session path; the
   * port never sees the raw bytes, so the check cannot live here. Absent ⇒ no cap.
   */
  readonly outputByteCap?: number;
  /**
   * The turn's working directory (locus-native). Absent ⇒ the executor's own repo
   * root — Rennet reviews git repositories, so every utility seat starts inside the
   * checkout it is reasoning about, and there is no no-repo utility call (W5).
   * Present ⇒ a NARROWING override for a caller that means a specific other
   * checkout (the knowledge swarm's evidence-reading seats, #460).
   */
  readonly cwd?: string;
  /**
   * Optional explicit MCP policy for this turn. Absent keeps the executor's
   * composition-level policy; an empty table starts no MCP sidecars. Codex's
   * native repository and shell tools are independent of this table.
   */
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
  readonly signal?: AbortSignal;
}

/** The result of one `codex exec` call: the parsed final structured message. */
export interface CodexExecResult {
  /** The parsed body captured from `-o <file>` (the final structured message). */
  readonly output: unknown;
  /** Best-effort token usage; Codex exposes little/none per call on subscription. */
  readonly tokens?: RspTokenUsage;
  /**
   * The model Codex ACTUALLY ran, read best-effort from the correlated session log
   * (#74 MED-3). Present when the log was found and named a model; absent otherwise,
   * so a consumer reports the OBSERVED model when known and falls back to the
   * requested model rather than claiming a runtime pick it could not confirm.
   */
  readonly model?: string;
  /** The `codex` binary version, when the composition root discovered it. */
  readonly harnessVersion?: string;
}

export type CodexExecutor = (req: CodexExecRequest) => Promise<CodexExecResult>;
