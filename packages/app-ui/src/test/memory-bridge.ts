import type {
  AttentionEventFrame,
  CommandInput,
  CommandName,
  CommandOutput,
  ProjectDetailProgressEvent,
  ProjectProcessEvent,
  RennetBridge,
  ReviewAskStreamEvent,
  UpdateReadyInfo,
} from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// MemoryBridge — the in-memory RennetBridge for tests and fixtures (C01, #489).
//
// A test hands per-command handlers, keyed by CommandName and typed through
// CommandInput<K>/CommandOutput<K>, so the stub cannot answer a command with the
// wrong shape. An un-handled command REJECTS loudly with its own name — never a
// silent `undefined` that a hook would fold into a false empty state. The five push
// channels are real subscribable emitters with `emit*` helpers so a test can drive
// live narration through the same surface the seam subscribes to.
//
// Fixture DATA lives behind a MemoryBridge (`test/fixtures/`), never as an importable
// module a surface could reach — the fence test (`fence.test.ts`) keeps that true.
// ─────────────────────────────────────────────────────────────────────────────

/** A per-command handler: receives the input, returns (or resolves) the command's output. */
export type CommandHandler<K extends CommandName> = (
  input: CommandInput<K>,
) => CommandOutput<K> | Promise<CommandOutput<K>>;

/** The handler table a MemoryBridge is constructed with — one typed entry per stubbed command. */
export type MemoryBridgeHandlers = {
  [K in CommandName]?: CommandHandler<K>;
};

type Listener<E> = (event: E) => void;

/** A keyed fan-out: listeners subscribe under a string key; an emit reaches only that key's set. */
class KeyedEmitter<E> {
  readonly #byKey = new Map<string, Set<Listener<E>>>();

  subscribe(key: string, listener: Listener<E>): () => void {
    let set = this.#byKey.get(key);
    if (!set) {
      set = new Set();
      this.#byKey.set(key, set);
    }
    set.add(listener);
    return () => {
      const current = this.#byKey.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.#byKey.delete(key);
    };
  }

  emit(key: string, event: E): void {
    for (const listener of [...(this.#byKey.get(key) ?? [])]) listener(event);
  }
}

/** An un-keyed fan-out for the daemon-wide / app-wide channels. */
class Emitter<E> {
  readonly #listeners = new Set<Listener<E>>();

  subscribe(listener: Listener<E>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: E): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

export class MemoryBridge implements RennetBridge {
  /** The host OS platform, settable per instance (mirrors {@link RennetBridge.platform}). */
  platform?: string;
  /** The host app version, settable per instance (mirrors {@link RennetBridge.version}). */
  version?: string;

  readonly #handlers: MemoryBridgeHandlers;
  readonly #progress = new KeyedEmitter<ProjectProcessEvent>();
  readonly #detailProgress = new KeyedEmitter<ProjectDetailProgressEvent>();
  readonly #askStream = new KeyedEmitter<ReviewAskStreamEvent>();
  readonly #attention = new Emitter<AttentionEventFrame>();
  readonly #updateReady = new Emitter<UpdateReadyInfo>();

  constructor(
    handlers: MemoryBridgeHandlers = {},
    options: { readonly platform?: string; readonly version?: string } = {},
  ) {
    this.#handlers = handlers;
    this.platform = options.platform;
    this.version = options.version;
  }

  invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>> {
    const handler = this.#handlers[name] as CommandHandler<K> | undefined;
    if (!handler) {
      return Promise.reject(new Error(`MemoryBridge: no handler for command "${name}"`));
    }
    // Resolve first so a synchronous throw inside a handler surfaces as a rejection,
    // not an escaped exception — every caller sees one uniform failure channel.
    return Promise.resolve().then(() => handler(input));
  }

  onProgress(commandId: string, listener: Listener<ProjectProcessEvent>): () => void {
    return this.#progress.subscribe(commandId, listener);
  }

  onProjectDetailProgress(
    commandId: string,
    listener: Listener<ProjectDetailProgressEvent>,
  ): () => void {
    return this.#detailProgress.subscribe(commandId, listener);
  }

  onAskStream(reviewId: string, listener: Listener<ReviewAskStreamEvent>): () => void {
    return this.#askStream.subscribe(reviewId, listener);
  }

  onAttention(listener: Listener<AttentionEventFrame>): () => void {
    return this.#attention.subscribe(listener);
  }

  onUpdateReady(listener: Listener<UpdateReadyInfo>): () => void {
    return this.#updateReady.subscribe(listener);
  }

  // ── Test-side emit helpers ────────────────────────────────────────────────
  emitProgress(commandId: string, event: ProjectProcessEvent): void {
    this.#progress.emit(commandId, event);
  }

  emitProjectDetailProgress(commandId: string, event: ProjectDetailProgressEvent): void {
    this.#detailProgress.emit(commandId, event);
  }

  emitAskStream(reviewId: string, event: ReviewAskStreamEvent): void {
    this.#askStream.emit(reviewId, event);
  }

  emitAttention(event: AttentionEventFrame): void {
    this.#attention.emit(event);
  }

  emitUpdateReady(info: UpdateReadyInfo): void {
    this.#updateReady.emit(info);
  }
}
