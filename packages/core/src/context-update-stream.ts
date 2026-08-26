import type { CanvasAngle, CanvasChangeNotification, DispositionType } from "@rennet/protocol";
import type { CanvasChangeFeed } from "./canvas-change-feed";
import type { ViewState } from "./canvas-ops";

// ─────────────────────────────────────────────────────────────────────────────
// The context-update stream (issue #13; Canvas Paradigm §3.2) — user acts pushed
// into the orchestrator's context as structured events, plus the post-commit
// change feed consumed in store/seq order. R35: NOT an Rx pipeline. It is a merge
// over one seq space of (a) direct user-act events and (b) issue #10's
// `CanvasChangeFeed` notifications; consumers may coalesce but never reorder.
//
// The one time-based coalescer is the `{viewing}` deixis batcher: a hand-rolled
// bounded buffer under an INJECTED clock — coalesce-by-canvas (later replaces
// earlier), window measured from first-buffer so no key is starved, and NEVER
// SILENT (a coalesced delivery states the seq range it covers). Every delivered
// event is appended to the open-assembled-prompt log — the byte-for-byte
// inspectable shared state (DSL §6.3 doctrine). ⛔ No dwell/pace metrics anywhere:
// a `{viewing}` names the canvas/cohort, never a duration.
// ─────────────────────────────────────────────────────────────────────────────

/** A covering seq range (store-commit order); `from`..`to` inclusive. */
export interface SeqRange {
  from: number;
  to: number;
}

/**
 * A delivered context-update event, carrying its store `seq`. `covers` appears on
 * the coalesced kinds (`viewing`, `changed`) and names the seq range one delivery
 * stands for — the "never silent" guarantee made concrete.
 */
export type DeliveredEvent =
  | { event: "selected"; anchor: string; elementSummary: string; excerpt?: string; seq: number }
  | { event: "disposed"; anchor: string; type: DispositionType; body: string; seq: number }
  | {
      event: "proposal-adjudicated";
      proposalId: string;
      outcome: "accepted" | "dismissed";
      editedPayload?: string;
      seq: number;
    }
  | {
      event: "viewing";
      canvasId: string;
      cohortId?: string;
      angle?: CanvasAngle;
      seq: number;
      covers: SeqRange;
    }
  | { event: "changed"; canvasId: string; elementKey: string; seq: number; covers: SeqRange };

/**
 * A user act as the host pushes it (carrying the store `seq` of that commit). The
 * `kind` mirrors the delivered `event` name. A `viewing` act is deixis and goes
 * through the batcher; the other three deliver immediately in seq order.
 */
export type UserAct =
  | { kind: "selected"; anchor: string; elementSummary: string; excerpt?: string; seq: number }
  | { kind: "disposed"; anchor: string; type: DispositionType; body: string; seq: number }
  | {
      kind: "proposal-adjudicated";
      proposalId: string;
      outcome: "accepted" | "dismissed";
      editedPayload?: string;
      seq: number;
    }
  | { kind: "viewing"; canvasId: string; cohortId?: string; angle?: CanvasAngle; seq: number };

// ── The viewing deixis batcher (hand-rolled, injected clock) ──────────────────

export interface ViewingBatcherOptions {
  /** The injected clock — tests drive it explicitly, no real timers. */
  now: () => number;
  /** How long a canvas's viewing may buffer before it must flush (from first buffer). */
  windowMs?: number;
  /** The bounded-buffer cap; over it, the OLDEST buffered canvas is FLUSHED (never dropped). */
  maxBufferedCanvases?: number;
}

interface BufferedViewing {
  canvasId: string;
  cohortId?: string;
  angle?: CanvasAngle;
  from: number;
  to: number;
  bufferedAt: number;
}

const DEFAULT_WINDOW_MS = 250;
const DEFAULT_MAX_BUFFERED = 64;

/**
 * The `{viewing}` batcher. Coalesces by canvas key: a later viewing REPLACES the
 * earlier one's latest cohort/angle and WIDENS the covered seq range, so one
 * delivery stands for every coalesced viewing and states its range. The window is
 * measured from the FIRST buffer of a key so a rapidly-navigating user cannot
 * starve a key forever. Over the buffer cap the oldest key is flushed, not
 * dropped (never silent).
 */
export class ViewingBatcher {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxBufferedCanvases: number;
  /** Insertion-ordered pending viewings, keyed by canvasId. */
  private readonly buffer = new Map<string, BufferedViewing>();

  constructor(options: ViewingBatcherOptions) {
    this.now = options.now;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxBufferedCanvases = options.maxBufferedCanvases ?? DEFAULT_MAX_BUFFERED;
  }

  /** Buffer a viewing, coalescing by canvas. Returns any event forced out by the cap. */
  push(act: {
    canvasId: string;
    cohortId?: string;
    angle?: CanvasAngle;
    seq: number;
  }): DeliveredEvent[] {
    const existing = this.buffer.get(act.canvasId);
    if (existing) {
      existing.cohortId = act.cohortId;
      existing.angle = act.angle;
      existing.from = Math.min(existing.from, act.seq);
      existing.to = Math.max(existing.to, act.seq);
      return [];
    }
    const evicted: DeliveredEvent[] = [];
    if (this.buffer.size >= this.maxBufferedCanvases) {
      const oldestKey = this.buffer.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.buffer.get(oldestKey);
        this.buffer.delete(oldestKey);
        if (oldest) evicted.push(toViewingEvent(oldest));
      }
    }
    this.buffer.set(act.canvasId, {
      canvasId: act.canvasId,
      cohortId: act.cohortId,
      angle: act.angle,
      from: act.seq,
      to: act.seq,
      bufferedAt: this.now(),
    });
    return evicted;
  }

  /**
   * Flush every buffered viewing whose covered range STARTS before `seq`,
   * oldest-first. An ordered (non-deixis) event at `seq` must not land in the log
   * ahead of a viewing that preceded it — this is how the stream keeps the merged
   * log seq-monotonic (R35: coalesce, never reorder) while still letting a burst
   * of viewings with no intervening ordered event coalesce.
   */
  flushBefore(seq: number): DeliveredEvent[] {
    const due: BufferedViewing[] = [];
    for (const [key, buffered] of this.buffer) {
      if (buffered.from < seq) {
        due.push(buffered);
        this.buffer.delete(key);
      }
    }
    due.sort((left, right) => left.from - right.from);
    return due.map(toViewingEvent);
  }

  /** Deliver each canvas whose window has elapsed as of `now`, oldest-first. */
  flushDue(now: number): DeliveredEvent[] {
    const due: BufferedViewing[] = [];
    for (const [key, buffered] of this.buffer) {
      if (now - buffered.bufferedAt >= this.windowMs) {
        due.push(buffered);
        this.buffer.delete(key);
      }
    }
    due.sort((left, right) => left.from - right.from);
    return due.map(toViewingEvent);
  }

  /** Deliver everything buffered regardless of window (turn boundary / session end). */
  drain(): DeliveredEvent[] {
    const all = [...this.buffer.values()].sort((left, right) => left.from - right.from);
    this.buffer.clear();
    return all.map(toViewingEvent);
  }

  pendingCount(): number {
    return this.buffer.size;
  }
}

function toViewingEvent(buffered: BufferedViewing): DeliveredEvent {
  const event: DeliveredEvent = {
    event: "viewing",
    canvasId: buffered.canvasId,
    seq: buffered.from,
    covers: { from: buffered.from, to: buffered.to },
  };
  if (buffered.cohortId !== undefined) event.cohortId = buffered.cohortId;
  if (buffered.angle !== undefined) event.angle = buffered.angle;
  return event;
}

// ── The stream ────────────────────────────────────────────────────────────────

export interface ContextUpdateStreamOptions {
  batcher: ViewingBatcher;
  /** Optional #10 change feed to consume; each notification becomes a `changed` event. */
  changeFeed?: CanvasChangeFeed;
  /** Which canvases to subscribe on the feed (default: none until `subscribeCanvas`). */
  canvasIds?: readonly string[];
}

/**
 * The context-update stream: pushes structured user acts into an append-only,
 * seq-ordered log (the open-assembled-prompt panel), consumes the change feed,
 * batches deixis, and exposes a per-turn watermark. Point events (selected /
 * disposed / proposal-adjudicated) deliver immediately in seq order; `viewing` is
 * coalesced by the batcher (the one allowed transformation, R35).
 */
export class ContextUpdateStream {
  private readonly batcher: ViewingBatcher;
  private readonly log: DeliveredEvent[] = [];
  private readonly unsubscribers: (() => void)[] = [];
  private turnWatermark = 0;

  constructor(options: ContextUpdateStreamOptions) {
    this.batcher = options.batcher;
    if (options.changeFeed) {
      for (const canvasId of options.canvasIds ?? []) {
        this.subscribeCanvas(options.changeFeed, canvasId);
      }
    }
  }

  /** Subscribe a canvas on the change feed; its notifications become ordered events. */
  subscribeCanvas(feed: CanvasChangeFeed, canvasId: string): void {
    const unsubscribe = feed.subscribe(canvasId, (notification) => this.onChange(notification));
    this.unsubscribers.push(unsubscribe);
  }

  /** Push a user act. `viewing` is batched; the rest deliver immediately. */
  push(act: UserAct): void {
    if (act.kind === "viewing") {
      const forced = this.batcher.push(act);
      for (const event of forced) this.deliver(event);
      return;
    }
    // An ordered event: flush any earlier-seq buffered viewing first so it cannot
    // land in the log AFTER this event (R35 — never reorder).
    this.flushViewingBefore(act.seq);
    if (act.kind === "selected") {
      const selected: DeliveredEvent = {
        event: "selected",
        anchor: act.anchor,
        elementSummary: act.elementSummary,
        ...(act.excerpt === undefined ? {} : { excerpt: act.excerpt }),
        seq: act.seq,
      };
      this.deliver(selected);
      return;
    }
    if (act.kind === "disposed") {
      this.deliver({
        event: "disposed",
        anchor: act.anchor,
        type: act.type,
        body: act.body,
        seq: act.seq,
      });
      return;
    }
    // proposal-adjudicated
    const adjudicated: DeliveredEvent = {
      event: "proposal-adjudicated",
      proposalId: act.proposalId,
      outcome: act.outcome,
      seq: act.seq,
    };
    if (act.editedPayload !== undefined) adjudicated.editedPayload = act.editedPayload;
    this.deliver(adjudicated);
  }

  /** Flush any viewing events whose window has elapsed as of `now`. */
  flushViewing(now: number): void {
    for (const event of this.batcher.flushDue(now)) this.deliver(event);
  }

  /** Flush all buffered viewings unconditionally (turn boundary / session end). */
  drainViewing(): void {
    for (const event of this.batcher.drain()) this.deliver(event);
  }

  private onChange(notification: CanvasChangeNotification): void {
    // A change-feed event is ordered too: flush earlier-seq buffered viewings
    // before it so the merged log stays seq-monotonic (R35).
    this.flushViewingBefore(notification.seqRange.from);
    this.deliver({
      event: "changed",
      canvasId: notification.canvasId,
      elementKey: notification.elementKey,
      seq: notification.seqRange.from,
      covers: notification.seqRange,
    });
  }

  /** Deliver every buffered viewing that precedes `seq` (keeps the log ordered). */
  private flushViewingBefore(seq: number): void {
    for (const event of this.batcher.flushBefore(seq)) this.deliver(event);
  }

  private deliver(event: DeliveredEvent): void {
    this.log.push(event);
  }

  /** The full ordered event log — the byte-for-byte inspectable shared state. */
  entries(): readonly DeliveredEvent[] {
    return this.log;
  }

  /** Events delivered since the last `startTurn()` — the orchestrator's next-turn context. */
  nextTurnContext(): readonly DeliveredEvent[] {
    return this.log.slice(this.turnWatermark);
  }

  /** Consume the next-turn context and advance the watermark; returns what was consumed. */
  startTurn(): readonly DeliveredEvent[] {
    const context = this.log.slice(this.turnWatermark);
    this.turnWatermark = this.log.length;
    return context;
  }

  /** Release every change-feed subscription (session end). */
  dispose(): void {
    // Never lose buffered deixis silently: drain it into the log before releasing
    // so the open-assembled-prompt record is complete at session end.
    this.drainViewing();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }
}

// ── Request-time view injection (Rai Q5) ──────────────────────────────────────

/** The user's current view, snapshotted INTO a request so "this" resolves. */
export interface OrchestratorViewContext {
  canvasId?: string;
  angle?: CanvasAngle;
  expandedCohorts: readonly string[];
  viewportAnchor?: string;
  selection?: string;
}

/** A request handed to the orchestrator: the question + the view + the pushed events. */
export interface OrchestratorRequest {
  question: string;
  viewContext: OrchestratorViewContext;
  contextEvents: readonly DeliveredEvent[];
}

/**
 * Build a request at ASK TIME, injecting the user's current view so references
 * like "this" resolve without the user restating context (Rai Q5). `contextEvents`
 * is the events pushed since the orchestrator's last turn — the stream keeps the
 * model current; this binds THIS ask to THIS view.
 */
export function buildOrchestratorRequest(
  question: string,
  view: ViewState,
  contextEvents: readonly DeliveredEvent[] = [],
): OrchestratorRequest {
  const viewContext: OrchestratorViewContext = {
    // Copy, don't alias: the request is a SNAPSHOT of the view at ask time, so a
    // later mutation of the caller's array must not rewrite an already-built request.
    expandedCohorts: [...view.expandedCohorts],
  };
  if (view.openCanvasId !== undefined) viewContext.canvasId = view.openCanvasId;
  if (view.angle !== undefined) viewContext.angle = view.angle;
  if (view.viewportAnchor !== undefined) viewContext.viewportAnchor = view.viewportAnchor;
  if (view.selection !== undefined) viewContext.selection = view.selection;
  return { question, viewContext, contextEvents };
}

// ── The open-assembled-prompt panel ───────────────────────────────────────────

/**
 * Render the byte-for-byte inspectable shared state: the primer text followed by
 * the ordered pushed events, one JSON line each. Every pushed event is present
 * verbatim — the conversation's shared state is inspectable (DSL §6.3 doctrine).
 */
export function renderOpenAssembledPrompt(
  primerText: string,
  events: readonly DeliveredEvent[],
): string {
  const lines = [primerText, "", "## context updates (pushed, seq order)"];
  for (const event of events) lines.push(`- ${JSON.stringify(event)}`);
  return lines.join("\n");
}
