import type {
  AttentionEventFrame,
  CommandInput,
  CommandName,
  CommandOutput,
  ProjectDetailProgressEvent,
  ProjectProcessEvent,
  RennetBridge,
  ReviewAskStreamEvent,
  RoundEvent,
  UpdateReadyInfo,
} from "@rennet/protocol";
import { parseCommandInput } from "@rennet/protocol";

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
  openFullDiskAccessSettings?: () => Promise<boolean>;

  readonly #handlers: MemoryBridgeHandlers;
  readonly #progress = new KeyedEmitter<ProjectProcessEvent>();
  readonly #detailProgress = new KeyedEmitter<ProjectDetailProgressEvent>();
  readonly #askStream = new KeyedEmitter<ReviewAskStreamEvent>();
  readonly #roundProgress = new KeyedEmitter<RoundEvent>();
  readonly #attention = new Emitter<AttentionEventFrame>();
  readonly #updateReady = new Emitter<UpdateReadyInfo>();

  constructor(
    handlers: MemoryBridgeHandlers = {},
    options: {
      readonly platform?: string;
      readonly version?: string;
      readonly openFullDiskAccessSettings?: () => Promise<boolean>;
    } = {},
  ) {
    this.#handlers = handlers;
    this.platform = options.platform;
    this.version = options.version;
    this.openFullDiskAccessSettings = options.openFullDiskAccessSettings;
  }

  invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>> {
    // PARSE EVERY INVOCATION against the real wire schema, before anything else. The daemon
    // parses; a stub that does not is a stub that answers commands the wire would reject, and
    // the whole suite then agrees with a client that cannot talk to the daemon. That is exactly
    // how `load-${slug}` / `reattach-${reviewId}` — ids `commandIdSchema` (z.uuid()) refuses —
    // shipped a dead chat dock and a dead `/s/:slug` past a green test run (F1 6.2). Throwing
    // synchronously is deliberate: a client-side wire violation is a defect in the CALLER, not a
    // command outcome a surface should get to render an error state for.
    parseCommandInput(name, input);
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

  onRoundProgress(reviewId: string, listener: Listener<RoundEvent>): () => void {
    return this.#roundProgress.subscribe(reviewId, listener);
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

  /** Push one live round-progress event to the review's subscribers (C15 3.1). */
  emitRoundProgress(reviewId: string, event: RoundEvent): void {
    this.#roundProgress.emit(reviewId, event);
  }

  emitAttention(event: AttentionEventFrame): void {
    this.#attention.emit(event);
  }

  emitUpdateReady(info: UpdateReadyInfo): void {
    this.#updateReady.emit(info);
  }
}

/**
 * A `patchset.readSpan` that refuses in the same SHAPE as the real daemon — a rejection
 * carrying a specific, path-bearing reason — for the surfaces that must render an
 * unreadable citation honestly.
 *
 * Shape, deliberately not wording. The daemon says `line 20` for a single-line span and
 * `lines 20–24` for a range; this always says `lines 20–20`. That divergence is the point,
 * not an oversight: if this stub reproduced the daemon's sentence exactly, the app-ui tests
 * and the handler could drift into agreeing with each other, and a wrong sentence would
 * look verified from both ends. The daemon's actual wording is pinned ONCE, against the
 * real handler over real dispatch, in `apps/desktop/src/citation-span.integration.test.tsx`.
 * Here the only claim is the one these surfaces owe: whatever reason the daemon gives, the
 * reviewer sees THAT reason — so a test asserts this stub's own sentence reaches the DOM.
 *
 * Written as a stub that rejects rather than as a MISSING handler, because the two prove
 * different things. A missing handler makes `MemoryBridge` reject with its own "no handler
 * for command" text — a fact about the test harness, not about the product — and asserting
 * a fixed surface line against it let the unbound-dispatch defect (`patchset.readSpan`
 * throwing in the shipped app for two workstreams) sit behind four green tests that all
 * read as coverage.
 */
export const SPAN_OUTSIDE_CAPTURE = "is outside the diff this patchset captured";

/** The refusing handler itself — hand it to a MemoryBridge as `"patchset.readSpan"`. */
export const refusesSpanRead: CommandHandler<"patchset.readSpan"> = (input) => {
  throw new Error(
    `${input.path} lines ${input.startLine}–${input.endLine} (${input.side}) ${SPAN_OUTSIDE_CAPTURE}.`,
  );
};
