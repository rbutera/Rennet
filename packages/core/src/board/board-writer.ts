/**
 * The board writer — what a board tool call actually does (`lens-board-tools` D4/D5).
 *
 * Pure: no I/O, no model, no Node. It holds one board, applies one tool call at a time,
 * and answers each call with either an outcome or a refusal. The daemon's loopback MCP
 * server (group 2) and the drafting runtime (group 3) are the callers; nothing calls it
 * yet, which is why this ships on its own.
 *
 * ── Ids and structure (D4) ───────────────────────────────────────────────────────
 * The HOST mints every id and returns it; a child names its PARENT and the host keeps
 * the parent's `children` in step. So the parenting graph is a forest, and every other
 * reference names an element minted earlier — a reference can only point backwards in
 * time. That is what makes a dangling reference and a reference cycle unconstructible
 * rather than checked.
 *
 * It is not left to that argument alone, because the boundary does not constrain what
 * KIND a reference names — `checkReferences` asks only whether the board holds the id.
 * So `alternative_ids`, `evidence_ref_ids`, `scenario_ids`, `trace_ref_ids` and
 * `code_ref_ids` can all name an ancestor section and close a loop through the
 * host-maintained `children` edge, which is the one edge that runs forward. Every
 * mutation therefore goes through {@link BoardWriter.introducedViolations}, which
 * re-runs the boundary tier — including `element-reference-resolves`, which owns both
 * the dangle and the cycle — and refuses any call that would make the board worse than
 * it found it. The invariant is the ordering; the check is what proves it, and
 * `board-writer.test.ts` attempts a cycle on both the add path and the update path.
 *
 * ── Validation (D5) ──────────────────────────────────────────────────────────────
 * A refusal is the BOUNDARY tier: the same rule functions `lint` runs, over the board
 * the call would produce, reporting only what the call INTRODUCED. That is why a
 * refusal already names the field and says what would be admissible — the messages are
 * the lint messages, not a second vocabulary written to sit beside them.
 *
 * `finish` is the FINISH tier over the whole board, and it returns pointers only: a
 * rule id, an element ref and one sentence. No board, no draft, no restated
 * instructions — the seat is holding all of that already. The sentence stays, because
 * it is the correction; see {@link FinishPointer}.
 */

import {
  type Author,
  type BoardDocument,
  type BoardTarget,
  type BoardTool,
  boardToolsByName,
  type DraftBoard,
  type DraftElement,
  type DraftKind,
  type LensAbsenceReason,
  parseDraft,
  resolveBoardDocument,
  settleAbsentReasonFor,
  TYPED_KINDS_BY_TARGET,
  type Violation,
} from "@rennet/protocol";
import { type BoardRegister, type LintContext, type LintTarget, lintTier } from "./lint";

// ── Results ──────────────────────────────────────────────────────────────────

/**
 * One pointer from `finish`: which rule, which element (and field, where the rule
 * knows it), and one sentence. Structurally a {@link Violation} — the pointer grammar
 * the repair channel already speaks.
 *
 * **A pointer carries its message, and that is the contract.** "Pointers only" in the
 * spec means the verdict does not re-send the board, the draft or the base prompt —
 * all of which the seat is already holding — and not that a pointer is an address with
 * no words. The words are the correction: a rule id and an element ref tell a seat
 * WHERE, and the sentence is the only part that tells it WHAT, for a handful of tokens.
 * Recorded here because the alias to the full {@link Violation} would otherwise read as
 * an oversight next to a doc that says "pointers only".
 *
 * What is genuinely unbounded is the LIST: a board with many violations returns many
 * pointers, and nothing caps that yet. It is a group-3 item, named in the PR.
 */
export type FinishPointer = Violation;

/** What a successful call gives back. */
export type BoardToolOutcome =
  /** An `add`/`cite`/`update` — the host-minted id of the element it touched. */
  | { readonly kind: "element"; readonly id: string }
  | { readonly kind: "removed"; readonly ids: readonly string[] }
  | { readonly kind: "document" }
  | { readonly kind: "absent"; readonly reason: LensAbsenceReason; readonly note: string }
  | { readonly kind: "settled" }
  | { readonly kind: "pointers"; readonly pointers: readonly FinishPointer[] }
  /**
   * A `write_board` — how many entries the payload placed, which of them were not applied
   * and why, and (when all of them were) whether the board then settled or came back with
   * pointers.
   *
   * The refusals are PER ENTRY on purpose. The boundary tier refuses one call at a time,
   * and a batched verb that answered "something in your 121 entries was refused" would
   * make the seat resend the batch to find out which — turning one round trip back into
   * several and distorting the very figure this verb exists to move (#869).
   *
   * `accepted + refusals.length` is always the payload's entry count: every entry is
   * either on the board or in this list.
   */
  | {
      readonly kind: "wrote";
      readonly accepted: number;
      readonly refusals: readonly BoardBatchRefusal[];
      readonly settled: boolean;
      readonly pointers?: readonly FinishPointer[];
    };

/**
 * One entry of a `write_board` payload that did not land.
 *
 * Two different things, which is what `causedBy` separates. Without it, ONE refusal reads
 * as several unrelated ones: the spike's drive had `calls[60] add_section` refused for a
 * vocabulary rule, and then `calls[61]`, `[64]`, `[65]`, `[68]`, `[71]`, `[72]` and `[73]`
 * each came back "This board holds no `sec-cap-lbd`" because they hung under the section
 * that was never minted. One genuine defect, eight refusal sentences, and a seat reading
 * that list has to work out for itself that seven of them are the same one.
 */
export interface BoardBatchRefusal {
  /** The entry's 0-based position in `calls`, so the seat can find it without a search. */
  readonly index: number;
  readonly tool: string;
  readonly refusal: string;
  /**
   * The position of the entry whose refusal made this one impossible — set when this entry
   * names an element an EARLIER refused entry would have created, so it was never applied
   * at all.
   *
   * Always the ROOT of the chain, never the immediate parent: a grandchild of a refused
   * section points at the section, so a cascade of any depth reads as one cause.
   */
  readonly causedBy?: number;
}

/**
 * The answer to one call. A refusal costs no attempt (D6) — the seat reads it and fixes
 * the thing inside the same turn — so it is an ordinary result here, never a throw.
 */
export type BoardToolResult =
  | { readonly ok: true; readonly outcome: BoardToolOutcome }
  | { readonly ok: false; readonly refusal: string };

/** How the board stands: still being written, finished, or declared absent. */
export type BoardWriterState = "drafting" | "settled" | "absent";

/**
 * What one accepted write did to the board (`lens-board-tools` D11, task 4.1).
 *
 * The DIFF, not the board. A call adds one element and may touch one other — the parent
 * whose `children` grew, or the group a member was re-parented out of — so what a reader
 * needs to stay equal to the board is those elements and their positions, and the ids a
 * removal took. Publishing the whole board per call would be quadratic in the board's own
 * size, which is exactly what the surface it feeds is trying not to be.
 *
 * Emitted only for a call the writer ACCEPTED. A refusal changed nothing, so it publishes
 * nothing; the seat reads the refusal and fixes the thing inside the same turn (D6).
 */
export interface BoardWrite {
  /** Elements this call added or changed, each at its index in the board's element list. */
  readonly changed: readonly { readonly index: number; readonly element: DraftElement }[];
  /** Ids this call took off the board, the removed element's whole subtree included. */
  readonly removed: readonly string[];
  /** The document, when this call set it. */
  readonly document?: BoardDocument;
  /** How the board stands after the call. */
  readonly state: BoardWriterState;
}

/**
 * Told about every accepted write, in the order the writer applied them.
 *
 * Never throws into the call it describes: a publication seam is decoration over a seat's
 * work, and a broken observer must not refuse a write the board already took.
 */
export type BoardWriteObserver = (write: BoardWrite) => void;

// ── Options ──────────────────────────────────────────────────────────────────

export interface BoardWriterOptions {
  /** Which board this is: one of the five lenses, or the round-report seat. */
  readonly target: LintTarget;
  /**
   * The patchset knowledge every boundary rule reads, WITHOUT its lens: the lens is
   * {@link BoardWriterOptions.target}, and the writer sets it.
   *
   * It used to be a whole {@link LintContext} whose `lens` was documented as having to
   * match `target` and was never checked — so a Flagged writer could be handed a Noise
   * lint context, hand out Flagged verbs, and let `scaffold-is-noise-lane` through
   * because the rules believed they were linting Noise. One source, no agreement to
   * keep.
   */
  readonly lint: Omit<LintContext, "lens">;
  /** The seat that wrote each element. Host-supplied: it is on no tool input. */
  readonly author: Author;
  /**
   * WHO wrote the prose this writer is handed (#877). `authored` — the default, and every
   * seat — means a model chose each sentence, so every rule has a writer to address.
   * `transcribed` means the HOST is quoting the project's own artifacts verbatim, and the
   * {@link VOICE_RULES} are skipped for it: a rule that tells a writer to pick different
   * words has no subject when nobody picked. Every other rule runs unchanged, so a
   * transcription is still refused for a board a reader cannot follow.
   *
   * `assembleDesignBoard` is the only `transcribed` caller today. Read {@link BoardRegister}
   * before adding a second: the register is a claim that the host wrote none of the prose,
   * and a seat handed it would escape the voice screen it exists to be held to.
   */
  readonly register?: BoardRegister;
  /**
   * Prefixes every minted id. Flagged runs two seats over one board (D9); giving each
   * writer its own prefix is what makes the ids they receive unable to collide when the
   * two are not sharing one counter.
   */
  readonly idPrefix?: string;
  /** The typed-kind assignment, overridable so a test can vary it. */
  readonly typedKinds?: Readonly<Record<BoardTarget, readonly DraftKind[]>>;
  /**
   * Told about every accepted write, so the board can be published as it is written
   * (D11, task 4.1). Absent ⇒ nothing is published and the writer behaves exactly as
   * before; a board with no observer is the direct-call shape a unit test builds.
   */
  readonly onWrite?: BoardWriteObserver;
}

/**
 * One voice writing into a board: who is speaking, and the prefix its minted ids carry.
 *
 * Flagged is two seats over ONE board (D9). Two `BoardWriter`s hold two element lists, so
 * they are two boards however their ids are prefixed; the one board is a single writer
 * handed a voice per call. {@link BoardWriter.voice} is that handle, and the daemon's
 * board server gives each of the lane's two addresses one of them.
 */
export interface BoardVoice {
  readonly author: Author;
  /**
   * Prefixes the ids THIS voice is handed. Ids cannot collide without it either — the two
   * voices share one mint counter — but the prefix is what makes an id say, on sight,
   * which seat was given it.
   */
  readonly idPrefix?: string;
}

/** One voice's handle on a shared board. Every read is of the WHOLE board, not this voice's share. */
export interface BoardVoiceWriter {
  /** Apply one tool call as this voice. */
  readonly call: (name: string, rawInput?: unknown) => BoardToolResult;
  readonly toolNames: () => readonly string[];
  readonly board: () => DraftBoard;
  readonly status: () => BoardWriterState;
  readonly declaredAbsence: () =>
    | { readonly reason: LensAbsenceReason; readonly note: string }
    | undefined;
  /** What the last `finish` said — the whole content of a repair turn (D6). */
  readonly lastVerdict: () => readonly FinishPointer[] | undefined;
  /** How THIS voice left the board, which on a two-seat lane is not the board's state. */
  readonly voiceStatus: () => BoardWriterState;
  /** The absence THIS voice declared. */
  readonly voiceAbsence: () =>
    | { readonly reason: LensAbsenceReason; readonly note: string }
    | undefined;
  /** What THIS voice's last `finish` said. */
  readonly voiceVerdict: () => readonly FinishPointer[] | undefined;
  /**
   * How many board tool calls THIS voice has made, refusals included (task 4.3).
   *
   * Refusals count because the seat made them and the provider billed them; a count that
   * only saw the accepted calls would report a seat that fought the boundary ten times as
   * cheaper than one that got it right first go. Monotonic over the lane's life, so a
   * turn's own figure is the difference across it.
   */
  readonly callCount: () => number;
}

// ── Host-owned values (on no tool input; the host writes them) ───────────────

/** What the host stamps on each kind, over and above the `author` every kind carries. */
const HOST_DEFAULTS: Readonly<Partial<Record<DraftKind, Readonly<Record<string, unknown>>>>> = {
  // A drafted finding is `open` and has no cross-seat agreement yet: `reconcileFindings`
  // stamps concurrence and accord when both Flagged voices have settled.
  finding: { status: "open", concurrence: [] },
  // A member of a derived board is host-placed and host-stamped (D16f): membership is a
  // POSITION — a changed region no other board cited — so `verdict` is `noise` and the
  // judge is `deterministic` on every member, always. Neither is on any tool input; this
  // is where they are written, and `placeMembers` is the only caller that reaches it.
  noise_verdict: { judge: "deterministic", verdict: "noise" },
  // Maintained from the parent each call names.
  section: { children: [] },
  order_step: { children: [] },
};

/** How many ids a refusal lists before it says how many more there are. */
const HELD_ID_SAMPLE = 20;

/**
 * The byte bounds on ONE entry's refusal in a `write_board` answer (#869).
 *
 * A tool result is billed exactly like a prompt, and CLAUDE.md's rule — every dynamic
 * interpolation declares a byte bound at its call site — has always been written about
 * prompts. #871 is that rule going unwritten on the refusal path: a boundary refusal
 * enumerated 1,252 element ids into one tool result. This verb multiplies whatever ONE
 * refusal costs by the entry count, so both bounds are declared here.
 *
 * `NAME` is a payload-supplied name quoted back (an entry's `tool`, or the local name a
 * cascade attributes). `SENTENCE` is the whole refusal, including the ones the board wrote
 * itself: those are already bounded by {@link HELD_ID_SAMPLE} for the sample they carry,
 * but the id they ECHO is whatever the seat typed, which is #871's shape. Clipping here
 * bounds this verb's own path without reaching into a refusal the ordinary calls share —
 * every honest refusal is a few hundred bytes and never sees this. How MANY of them one
 * tool result carries is bounded where the result is rendered.
 *
 * Neither cap touches identity: a local name is matched RAW and clipped only for quoting,
 * so a long name still resolves and still cascades.
 */
const BATCH_NAME_CAP = 60;
const BATCH_SENTENCE_CAP = 500;

/**
 * What a host-placed member's `reason` says before the seat writes one.
 *
 * The schema requires a reason and the derivation genuinely has one — this region is here
 * because no other board cited it, which is the whole definition. It is a true sentence
 * rather than a placeholder, so a board whose seat died mid-turn still reads honestly.
 */
const DERIVED_MEMBER_REASON = "No other lens board cited this changed region.";

/** How one voice left the board: its own settlement, its own absence, its own verdict. */
interface VoiceRecord {
  state: BoardWriterState;
  absence?: { reason: LensAbsenceReason; note: string };
  verdict?: readonly FinishPointer[];
  /** Every call this voice made, refusals included. See `BoardVoiceWriter.callCount`. */
  calls: number;
}

// ── The writer ───────────────────────────────────────────────────────────────

export class BoardWriter {
  private readonly options: BoardWriterOptions;
  private readonly tools: ReadonlyMap<string, BoardTool>;
  private elements: DraftElement[] = [];
  private document: BoardDocument | undefined;
  private minted = 0;
  private state: BoardWriterState = "drafting";
  private absence: { reason: LensAbsenceReason; note: string } | undefined;
  /**
   * The ids the HOST placed, so `remove_element` can refuse one (D16). Empty on every
   * board but a derived one, which is why the refusal reads as a property of the board
   * rather than a per-lens conditional.
   */
  private readonly hostPlaced = new Set<string>();
  /** The pointers the last `finish` returned; `[]` when it settled, `undefined` before any. */
  private verdict: readonly FinishPointer[] | undefined;
  /**
   * How each VOICE left the board, keyed by the author id it writes under (D9).
   *
   * The board has one state and the Flagged lane has two seats, and the lane needs both
   * facts: `status()` says whether the board as a whole is finished, and this says whether
   * THIS seat settled — which is what decides whether that seat's turn spent an attempt
   * and whether reconciliation may run yet. Reading the board's state per seat would make
   * one voice's `finish` settle the other voice's lane, and one voice's next element
   * un-settle a lane that really had finished.
   */
  private readonly byVoice = new Map<string, VoiceRecord>();

  private readonly lint: LintContext;
  /** See {@link BoardWriterOptions.register}. Every board is authored unless said otherwise. */
  private readonly register: BoardRegister;

  constructor(options: BoardWriterOptions) {
    this.options = options;
    this.lint = { ...options.lint, lens: options.target };
    this.register = options.register ?? "authored";
    this.tools = boardToolsByName(options.target, options.typedKinds ?? TYPED_KINDS_BY_TARGET);
  }

  /** The tools this seat is given, in the order the surface builds them. */
  toolNames(): readonly string[] {
    return [...this.tools.keys()];
  }

  /** The board as it stands. Readable at any moment — a partial board is kept, not hidden. */
  board(): DraftBoard {
    return this.document === undefined
      ? { elements: [...this.elements] }
      : { document: this.document, elements: [...this.elements] };
  }

  /**
   * Drafting, settled by `finish`, or settled absent.
   *
   * A settlement is a statement about the board as it stood when `finish` returned, so
   * any later mutation takes it back to `drafting` ({@link BoardWriter.reopen}). The
   * seat is NOT refused — writing after a finish is ordinary work, and refusing it would
   * be a restriction dressed as bookkeeping. What is not allowed is this method going on
   * reporting a settlement over a board that has moved since.
   */
  status(): BoardWriterState {
    return this.state;
  }

  /** The absence a `settle_absent` declared, with the note the seat wrote. */
  declaredAbsence(): { readonly reason: LensAbsenceReason; readonly note: string } | undefined {
    return this.absence;
  }

  /**
   * What the last `finish` said: the pointers it returned, `[]` when it settled the
   * board, `undefined` when the seat never called it.
   *
   * This is the whole content of a repair turn (D6). A turn that ends unsettled spends an
   * attempt, and the follow-up carries this and nothing else — the base prompt and every
   * element the seat wrote are already in the thread and on the board, so re-sending
   * either is paying twice for what the seat is holding.
   *
   * The three states are distinguishable on purpose. `undefined` says the turn died
   * before asking, so the follow-up has no verdict to carry and says so; `[]` says the
   * board settled and something moved afterwards; a non-empty list is the correction.
   */
  lastVerdict(): readonly FinishPointer[] | undefined {
    return this.verdict;
  }

  /**
   * The ids the host placed on this board, in placement order (D16).
   *
   * A derived board's members are the host's: it works out the complement, writes it, and
   * the seat groups and explains it. They are named here so the lane can tell what it
   * placed from what the seat wrote, and so `remove_element` can refuse one.
   */
  hostPlacedIds(): readonly string[] {
    return [...this.hostPlaced];
  }

  /**
   * Place the members of a HOST-DERIVED board (D16), one `code_ref` + one member element
   * per region, and return the member ids.
   *
   * Not a tool and not reachable from one: no verb creates a member, because a member the
   * seat could add would be a region another board cited, which the ruling forbids. The
   * boundary tier is not run over these because the host is not guessing — the regions ARE
   * the patchset's changed regions, so the citation they carry resolves by construction,
   * and the one thing that could fail (`scaffold-is-noise-lane`) is the derived lens's own
   * lane.
   *
   * `verdict` and `judge` come from {@link HOST_DEFAULTS} and are constants (D16f). The
   * `reason` each member starts with is the derivation's own factual account; the seat
   * refines it with `update_*`, which is the only verb it has for a member.
   */
  placeMembers(
    kind: DraftKind,
    regions: readonly { path: string; side: "base" | "head"; start: number; end: number }[],
  ): readonly string[] {
    // COPIED, not aliased: this method pushes into `this.elements` in place, so holding
    // the array itself would compare the list against itself and find nothing changed.
    const before = [...this.elements];
    const placed: string[] = [];
    for (const region of regions) {
      const citationId = this.mintId();
      this.elements.push({
        id: citationId,
        kind: "code_ref",
        data: {
          author: this.options.author,
          path: region.path,
          side: region.side,
          start_line: region.start,
          end_line: region.end,
        },
      } as DraftElement);
      const memberId = this.mintId();
      this.elements.push({
        id: memberId,
        kind,
        data: {
          author: this.options.author,
          ...(HOST_DEFAULTS[kind] ?? {}),
          hunk: citationId,
          reason: DERIVED_MEMBER_REASON,
        },
      } as DraftElement);
      this.hostPlaced.add(citationId);
      this.hostPlaced.add(memberId);
      placed.push(memberId);
    }
    // The board moved, so any settlement over the board as it was no longer holds.
    this.reopen();
    // Published like any other write (D11): a host-placed member is an element the
    // reviewer sees on the board, and it lands BEFORE the seat's first turn. A stream
    // that only carried the seat's calls would show a derived board arriving out of
    // nowhere at settle.
    this.publishWrite(before, this.document);
    return placed;
  }

  /**
   * This board, written by one named voice (D9). The board is the writer's; the voice
   * decides what an element's `author` says and what its id is prefixed with. Two voices
   * on one writer are Flagged's two seats: one element list, two authors, one mint
   * counter — which is why the ids they are handed cannot collide.
   */
  voice(voice: BoardVoice): BoardVoiceWriter {
    return {
      call: (name, rawInput) => this.call(name, rawInput, voice),
      toolNames: () => this.toolNames(),
      board: () => this.board(),
      status: () => this.status(),
      declaredAbsence: () => this.declaredAbsence(),
      lastVerdict: () => this.lastVerdict(),
      voiceStatus: () => this.voiceStatus(voice),
      voiceAbsence: () => this.voiceAbsence(voice),
      voiceVerdict: () => this.voiceVerdict(voice),
      callCount: () => this.callCount(voice),
    };
  }

  /** Every board tool call this voice has made, refusals included (task 4.3). */
  callCount(voice: BoardVoice | undefined): number {
    return this.byVoice.get(this.voiceKey(voice))?.calls ?? 0;
  }

  /** Apply one tool call. Never throws on bad input: a refusal is a result. `finish` and
   * every other argument-free verb take none. A `voice` overrides the writer's own author
   * and id prefix for this call, and nothing else. */
  call(name: string, rawInput?: unknown, voice?: BoardVoice): BoardToolResult {
    // Counted BEFORE the tool is even resolved, and for every arm below including the
    // refusals: the seat made a call and the provider billed it, whether or not this
    // board would take it (task 4.3).
    //
    // ONE `write_board` is ONE count, however many entries its payload carries — which is
    // the whole point of the verb and the figure #869 is trying to move. The entries reach
    // {@link BoardWriter.applyCall} directly, below the count, because the seat did not
    // make them and the provider did not bill them: they arrived inside this one call.
    this.countCall(voice);
    return this.applyCall(name, rawInput, voice);
  }

  /**
   * Apply one tool call WITHOUT counting it as a provider round trip.
   *
   * The body {@link BoardWriter.call} used to hold, split out so `write_board` can drive
   * the same verbs the seat would have called one at a time — same tools, same parse, same
   * boundary tier, same refusal sentences, same publication — with the count staying on the
   * one call the seat actually made.
   */
  private applyCall(name: string, rawInput?: unknown, voice?: BoardVoice): BoardToolResult {
    const before = this.elements;
    const beforeDocument = this.document;
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return refuse(
        `There is no \`${name}\` on this board. This lens writes with: ${this.toolNames().join(", ")}.`,
      );
    }
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `\`${issue.path.join(".") || "(input)"}\`: ${issue.message}`)
        .join("; ");
      return refuse(`\`${name}\` did not accept its arguments — ${issues}.`);
    }
    const input = parsed.data as Record<string, unknown>;

    const result = ((): BoardToolResult => {
      switch (tool.verb) {
        case "set_document":
          return this.setDocument(tool, input);
        case "add":
          return this.add(tool, input, voice);
        case "update":
          return this.update(tool, input);
        case "remove_element":
          return this.remove(input);
        case "settle_absent":
          return this.settleAbsent(input);
        case "finish":
          return this.finish();
        case "write_board":
          return this.writeBoard(input, voice);
      }
    })();
    // A refusal changes nothing, including this: the seat has not settled and has not
    // un-settled, so the voice's record is exactly where it was.
    if (result.ok) {
      this.recordVoice(voice, result.outcome);
      this.publishWrite(before, beforeDocument);
    }
    return result;
  }

  /** The author id a voice writes under; the writer's own when a call names none. */
  private voiceKey(voice: BoardVoice | undefined): string {
    return (voice?.author ?? this.options.author).id;
  }

  /** This voice's own record, created on first sight. */
  private recordFor(voice: BoardVoice | undefined): VoiceRecord {
    const key = this.voiceKey(voice);
    const held = this.byVoice.get(key);
    if (held !== undefined) return held;
    const fresh: VoiceRecord = { state: "drafting", calls: 0 };
    this.byVoice.set(key, fresh);
    return fresh;
  }

  private countCall(voice: BoardVoice | undefined): void {
    this.recordFor(voice).calls += 1;
  }

  /**
   * Tell the observer what this accepted call did to the board (D11, task 4.1).
   *
   * The changed set is found by IDENTITY against the list as it stood: every mutation
   * path here rebuilds only the elements it touched (`adopt` and `withoutChildren` both
   * return the element unchanged when they change nothing, and `update` maps every other
   * element through untouched), so the elements that are not identical to one held before
   * are exactly the ones this call wrote. That is the diff, and it is why the stream is
   * bounded by the call rather than by the board.
   *
   * Never throws into the call: a publication seam is decoration over the seat's work,
   * and an observer that failed must not un-write a board the writer has already moved.
   */
  private publishWrite(
    before: readonly DraftElement[],
    beforeDocument: BoardDocument | undefined,
  ): void {
    const observer = this.options.onWrite;
    if (observer === undefined) return;
    const held = new Set<DraftElement>(before);
    const changed: { index: number; element: DraftElement }[] = [];
    this.elements.forEach((element, index) => {
      if (!held.has(element)) changed.push({ index, element });
    });
    const survivors = new Set(this.elements.map((element) => element.id));
    const removed = before
      .filter((element) => !survivors.has(element.id))
      .map((element) => element.id);
    try {
      observer({
        changed,
        removed,
        ...(this.document === beforeDocument || this.document === undefined
          ? {}
          : { document: this.document }),
        state: this.state,
      });
    } catch {
      // Diagnostics and surfaces never change the board they describe.
    }
  }

  /** How this voice left the board after the call it just made. */
  private recordVoice(voice: BoardVoice | undefined, outcome: BoardToolOutcome): void {
    const record = this.recordFor(voice);
    switch (outcome.kind) {
      case "settled":
        record.state = "settled";
        record.verdict = [];
        delete record.absence;
        break;
      case "absent":
        record.state = "absent";
        record.absence = { reason: outcome.reason, note: outcome.note };
        break;
      case "pointers":
        // A verdict that came back with work in it is not a settlement, and it does not
        // un-settle a voice that had already finished either — the board did not move.
        record.verdict = outcome.pointers;
        break;
      case "wrote":
        // A whole-board write is an authoring call AND the `finish` that follows it, so it
        // records both: the voice is drafting again, and then whatever its own finish said.
        // Reading it as an ordinary authoring call would leave a settled board recorded as
        // still drafting — the lane would wait for a turn that had already done its work.
        record.state = "drafting";
        delete record.absence;
        if (outcome.settled) {
          record.state = "settled";
          record.verdict = [];
        } else if (outcome.pointers !== undefined) {
          record.verdict = outcome.pointers;
        }
        break;
      default:
        // An authoring call. This voice is writing again, so whatever it said last about
        // being finished no longer describes the board.
        record.state = "drafting";
        delete record.absence;
        break;
    }
  }

  /**
   * How ONE voice left the board (D9): settled by its own `finish`, absent by its own
   * declaration, or still drafting.
   *
   * Distinct from {@link BoardWriter.status}, which is the board's. On a one-seat lane the
   * two agree; on Flagged they must not be conflated, because one seat finishing is not
   * the lane finishing and one seat writing again is not the other seat un-finishing.
   */
  voiceStatus(voice: BoardVoice | undefined): BoardWriterState {
    return this.byVoice.get(this.voiceKey(voice))?.state ?? "drafting";
  }

  /** The absence THIS voice declared, if it declared one. */
  voiceAbsence(
    voice: BoardVoice | undefined,
  ): { readonly reason: LensAbsenceReason; readonly note: string } | undefined {
    return this.byVoice.get(this.voiceKey(voice))?.absence;
  }

  /** What THIS voice's last `finish` said — the whole content of its repair turn (D6). */
  voiceVerdict(voice: BoardVoice | undefined): readonly FinishPointer[] | undefined {
    return this.byVoice.get(this.voiceKey(voice))?.verdict;
  }

  // ── Verbs ──────────────────────────────────────────────────────────────────

  private setDocument(tool: BoardTool, input: Record<string, unknown>): BoardToolResult {
    const alignment = this.checkListAlignment(tool, input);
    if (alignment !== undefined) return refuse(alignment);
    const authored = dataFromInput(tool, input, {});
    // `measure` is the target's, never the seat's: `resolveBoardDocument` is the one
    // place that decides it and it overrides whatever a board carries.
    const candidate = resolveBoardDocument(this.options.target, {
      ...(authored as BoardDocument),
      measure: "reading",
    });
    const next: DraftBoard = { document: candidate, elements: [...this.elements] };
    const structural = this.structuralRefusal(next);
    if (structural !== undefined) return refuse(structural);
    const introduced = this.introducedViolations(next);
    if (introduced.length > 0) return refuse(describe(introduced, tool, "/document"));
    this.document = candidate;
    this.reopen();
    return { ok: true, outcome: { kind: "document" } };
  }

  private add(
    tool: BoardTool,
    input: Record<string, unknown>,
    voice?: BoardVoice,
  ): BoardToolResult {
    const kind = tool.kind;
    if (kind === undefined) return refuse(`\`${tool.name}\` authors no element.`);

    const parentId = typeof input.parent_id === "string" ? input.parent_id : undefined;
    const parentRefusal = this.checkParent(parentId);
    if (parentRefusal !== undefined) return refuse(parentRefusal);

    const referenceRefusal = this.checkReferences(tool, input);
    if (referenceRefusal !== undefined) return refuse(referenceRefusal);

    const alignment = this.checkListAlignment(tool, input);
    if (alignment !== undefined) return refuse(alignment);

    const id = this.mintId(voice);
    const element = {
      id,
      kind,
      data: {
        author: voice?.author ?? this.options.author,
        ...(HOST_DEFAULTS[kind] ?? {}),
        ...dataFromInput(tool, input, {}),
      },
    } as DraftElement;

    const nextElements = [...this.elements, element];
    const withParent = parentId === undefined ? nextElements : adopt(nextElements, parentId, id);
    const next = this.withElements(withParent);

    const structural = this.structuralRefusal(next);
    if (structural !== undefined) {
      this.minted -= 1; // the call is refused, so the id was never handed out
      return refuse(structural);
    }
    const introduced = this.introducedViolations(next);
    if (introduced.length > 0) {
      this.minted -= 1;
      return refuse(describe(introduced, tool, id));
    }
    this.elements = withParent;
    this.reopen();
    return { ok: true, outcome: { kind: "element", id } };
  }

  private update(tool: BoardTool, input: Record<string, unknown>): BoardToolResult {
    const elementId = String(input.element_id);
    const index = this.elements.findIndex((element) => element.id === elementId);
    if (index === -1) return refuse(this.unheldMessage(elementId));
    const current = this.elements[index];
    if (current === undefined) return refuse(this.unheldMessage(elementId));
    if (current.kind !== tool.kind) {
      return refuse(
        `\`${elementId}\` is a \`${current.kind}\`, not a \`${tool.kind}\`. Use this board's \`${tool.kind}\` verb instead.`,
      );
    }
    const referenceRefusal = this.checkReferences(tool, input);
    if (referenceRefusal !== undefined) return refuse(referenceRefusal);

    const alignment = this.checkListAlignment(tool, input);
    if (alignment !== undefined) return refuse(alignment);

    // Parenting rides an UPDATE only on a host-derived kind (D16), where the seat's job
    // is to group members it did not create and there is no `add` call to have named a
    // parent on. `parent_id` is absent from every other update input, so this branch is
    // reached exactly when the tool surface offered the field.
    const reparentTo =
      "parent_id" in (tool.input as { shape: Record<string, unknown> }).shape &&
      typeof input.parent_id === "string"
        ? input.parent_id
        : undefined;
    const parentRefusal = this.checkParent(reparentTo);
    if (parentRefusal !== undefined) return refuse(parentRefusal);

    const patched = {
      ...current,
      data: {
        ...(current.data as Record<string, unknown>),
        ...dataFromInput(tool, input, current.data as Record<string, unknown>),
      },
    } as DraftElement;
    const patchedElements = this.elements.map((element, at) => (at === index ? patched : element));
    // Re-parenting is a MOVE, not a second membership: the element leaves whatever group
    // held it before. Without the removal a seat that changed its mind about a member's
    // pattern would leave it counted in two groups, which is exactly what
    // `derived-member-grouped` then refuses to settle over — a refusal for a thing the
    // tool did rather than for a thing the seat asked for.
    const nextElements =
      reparentTo === undefined
        ? patchedElements
        : adopt(
            patchedElements.map((element) => withoutChildren(element, new Set([elementId]))),
            reparentTo,
            elementId,
          );
    const next = this.withElements(nextElements);

    const structural = this.structuralRefusal(next);
    if (structural !== undefined) return refuse(structural);
    const introduced = this.introducedViolations(next);
    if (introduced.length > 0) return refuse(describe(introduced, tool, elementId));
    this.elements = nextElements;
    this.reopen();
    return { ok: true, outcome: { kind: "element", id: elementId } };
  }

  private remove(input: Record<string, unknown>): BoardToolResult {
    const elementId = String(input.element_id);
    if (!this.elements.some((element) => element.id === elementId)) {
      return refuse(this.unheldMessage(elementId));
    }
    const doomed = this.subtreeOf(elementId);
    // D16 — a member the host derived is not the seat's to remove: the complement is
    // total, and a board missing one of its members no longer accounts for the change.
    // The subtree is checked, not just the named element, so removing a group section
    // cannot take its members out sideways. The seat's OWN sections and prose still go.
    const derived = [...doomed].filter((id) => this.hostPlaced.has(id));
    if (derived.length > 0) {
      const named = derived
        .slice(0, HELD_ID_SAMPLE)
        .map((id) => `\`${id}\``)
        .join(", ");
      const more = derived.length - Math.min(derived.length, HELD_ID_SAMPLE);
      return refuse(
        `Removing \`${elementId}\` would take ${named}${more > 0 ? `, and ${more} more,` : ""} off this board. This board's members are the changed regions no other board cited — they are placed here by derivation, not by judgement, and removing one would leave part of the change accounted for nowhere. Group it and say why it is there instead.`,
      );
    }
    const survivors = this.elements
      .filter((element) => !doomed.has(element.id))
      // The host maintains `children`, so a removed child leaves its parent's list with
      // it. Every OTHER reference is the seat's, and a survivor still pointing at a
      // removed element is what the boundary check below refuses on.
      .map((element) => withoutChildren(element, doomed));
    const next = this.withElements(survivors);

    const structural = this.structuralRefusal(next);
    if (structural !== undefined) return refuse(structural);
    const introduced = this.introducedViolations(next);
    if (introduced.length > 0) return refuse(describe(introduced));
    this.elements = survivors;
    this.reopen();
    return { ok: true, outcome: { kind: "removed", ids: [...doomed] } };
  }

  private settleAbsent(input: Record<string, unknown>): BoardToolResult {
    const reason = settleAbsentReasonFor(this.options.target);
    if (reason === undefined) {
      // Unreachable through the surface: a target with no admissible absence is given
      // no settle-absent verb at all. Answered rather than thrown, because a tool call
      // is never a crash.
      return refuse(`The ${this.options.target} lens admits no absence.`);
    }
    const note = String(input.note);
    this.absence = { reason, note };
    this.state = "absent";
    return { ok: true, outcome: { kind: "absent", reason, note } };
  }

  /**
   * `write_board` — one payload carrying every call the seat would otherwise have made one
   * at a time (#869).
   *
   * Each entry goes through {@link BoardWriter.applyCall}, so this adds no authoring path:
   * the tools, the input parse, the boundary tier, the refusal sentences and the write
   * publication are the ones a one-at-a-time seat already gets. What it adds is the local
   * id map — a payload cannot name an id the host has not minted yet — the per-entry
   * refusal list, and the cascade attribution below.
   *
   * A refused entry does NOT roll the batch back. Rolling back would make one bad entry in
   * a hundred cost the seat the whole payload again, which is the round-trip cost this verb
   * exists to remove, reintroduced at the worst possible moment. What is accepted stays on
   * the board and the seat is told exactly which entries to redo.
   *
   * ── A refusal cascades, and it is reported as ONE cause ──────────────────────────
   * An entry that names an element an earlier REFUSED entry would have created cannot be
   * applied: the id was never minted. Applied anyway it reaches the boundary tier and comes
   * back "This board holds no `sec-cap-lbd`" — true, useless, and indistinguishable from a
   * seat that simply invented an id. The spike's drive turned one refused `add_section`
   * into eight refusal sentences that way.
   *
   * So a cascaded entry is NOT applied and its refusal carries {@link
   * BoardBatchRefusal.causedBy}, the position of the entry that actually failed. The cause
   * is the ROOT: a cascaded entry's own `local_id` inherits the same root, so a chain of
   * any depth points at the one thing the seat has to fix. Not applying it is the load-
   * bearing half — the seat gets the boundary tier's honest answer for the entries it got
   * wrong, and a plain statement of dependency for the ones it did not.
   *
   * `finish` runs only when every entry landed. A finish over a board that is knowingly
   * missing entries would return pointers about the missing elements, burying the refusals
   * that caused them under their own consequences.
   */
  private writeBoard(input: Record<string, unknown>, voice?: BoardVoice): BoardToolResult {
    const raw = String(input.board_json);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      return refuse(
        `\`board_json\` is not JSON — ${(error as Error).message}. Send one object \`{"calls":[…]}\`; nothing was written.`,
      );
    }
    const calls = (payload as { calls?: unknown } | null)?.calls;
    if (!Array.isArray(calls)) {
      return refuse(
        '`board_json` parsed but carries no `calls` array. Send `{"calls":[{"tool":"…", …}, …]}`; nothing was written.',
      );
    }

    /** A payload's own name for an element it created → the id the host minted for it. */
    const minted = new Map<string, string>();
    /** A payload's own name that will never be minted → the entry whose refusal is the cause. */
    const orphaned = new Map<string, number>();

    const refusals: BoardBatchRefusal[] = [];
    let accepted = 0;
    for (const [index, entry] of calls.entries()) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        refusals.push({
          index,
          tool: "(none)",
          refusal: 'entry is not an object. Each entry is one call: `{"tool":"…", …}`.',
        });
        continue;
      }
      const record = entry as Record<string, unknown>;
      const name = typeof record.tool === "string" ? record.tool : "";
      if (name.length === 0) {
        refusals.push({ index, tool: "(none)", refusal: "entry names no `tool`." });
        continue;
      }
      // RAW for identity, clipped only where it is quoted back — a name that resolves must
      // go on resolving however long the seat made it.
      const localId = typeof record.local_id === "string" ? record.local_id : undefined;
      /** Every entry that fails records its own name as unmintable, so the chain holds. */
      const orphan = (refusal: string, causedBy?: number): void => {
        refusals.push({
          index,
          tool: clip(name, BATCH_NAME_CAP),
          refusal: clip(refusal, BATCH_SENTENCE_CAP),
          ...(causedBy === undefined ? {} : { causedBy }),
        });
        if (localId !== undefined) orphaned.set(localId, causedBy ?? index);
      };

      const tool = this.tools.get(name);
      if (tool === undefined) {
        orphan(
          `There is no \`${clip(name, BATCH_NAME_CAP)}\` on this board. This lens writes with: ${this.toolNames().join(", ")}.`,
        );
        continue;
      }
      // `write_board` inside `write_board` is not a nesting the payload grammar admits, and
      // allowing it would let one entry's refusal list hide inside another's.
      if (tool.verb === "write_board") {
        orphan("`write_board` does not nest.");
        continue;
      }

      const call: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (key === "tool" || key === "local_id") continue;
        call[key] = value;
      }
      // Every id-bearing field, resolved through the local map: the two structural ones the
      // writer reads off the raw input, and every element-reference field the tool declares.
      // A name whose creating entry was refused stops the entry here rather than sending it
      // to the boundary tier to be told an id it never asked for is missing.
      let cause: { readonly at: number; readonly name: string } | undefined;
      const resolve = (value: unknown): unknown => {
        if (typeof value !== "string") return value;
        const held = minted.get(value);
        if (held !== undefined) return held;
        const from = orphaned.get(value);
        if (from !== undefined && cause === undefined) cause = { at: from, name: value };
        return value;
      };
      for (const key of ["parent_id", "element_id"]) {
        if (key in call) call[key] = resolve(call[key]);
      }
      for (const field of tool.fields) {
        if (field.source.form !== "element-ref" || !(field.name in call)) continue;
        const value = call[field.name];
        call[field.name] = Array.isArray(value) ? value.map(resolve) : resolve(value);
      }
      if (cause !== undefined) {
        orphan(
          `not applied — it names \`${clip(cause.name, BATCH_NAME_CAP)}\`, which calls[${cause.at}] was refused before creating.`,
          cause.at,
        );
        continue;
      }

      const result = this.applyCall(name, call, voice);
      if (!result.ok) {
        orphan(result.refusal);
        continue;
      }
      accepted += 1;
      if (localId !== undefined && result.outcome.kind === "element") {
        minted.set(localId, result.outcome.id);
      }
    }

    if (refusals.length > 0) {
      return { ok: true, outcome: { kind: "wrote", accepted, refusals, settled: false } };
    }
    const finished = this.finish();
    if (!finished.ok) return finished;
    const settled = finished.outcome.kind === "settled";
    return {
      ok: true,
      outcome: {
        kind: "wrote",
        accepted,
        refusals,
        settled,
        ...(finished.outcome.kind === "pointers" ? { pointers: finished.outcome.pointers } : {}),
      },
    };
  }

  private finish(): BoardToolResult {
    const pointers = lintTier(this.board(), this.lint, "finish", this.register);
    // Recorded whichever way it went, because a repair turn carries the last verdict and
    // nothing else (D6) and `[]` is a different fact from "never asked".
    this.verdict = pointers;
    if (pointers.length > 0) return { ok: true, outcome: { kind: "pointers", pointers } };
    this.state = "settled";
    return { ok: true, outcome: { kind: "settled" } };
  }

  // ── Refusal machinery ──────────────────────────────────────────────────────

  private mintId(voice?: BoardVoice): string {
    this.minted += 1;
    return `${voice?.idPrefix ?? this.options.idPrefix ?? ""}e${this.minted}`;
  }

  private withElements(elements: readonly DraftElement[]): DraftBoard {
    return this.document === undefined
      ? { elements: [...elements] }
      : { document: this.document, elements: [...elements] };
  }

  /** The ids the board holds, bounded — a tool result is not an inline payload. */
  private heldIds(): string {
    const ids = this.elements.map(({ id }) => id);
    if (ids.length === 0) return "the board is empty";
    const shown = ids.slice(0, HELD_ID_SAMPLE).join(", ");
    return ids.length > HELD_ID_SAMPLE
      ? `${shown}, and ${ids.length - HELD_ID_SAMPLE} more`
      : shown;
  }

  private unheldMessage(targetId: string): string {
    return `This board holds no \`${targetId}\`. It holds: ${this.heldIds()}.`;
  }

  /** D4 — a parent must be an element this board already holds, and must take children. */
  private checkParent(parentId: string | undefined): string | undefined {
    if (parentId === undefined) return undefined;
    const parent = this.elements.find((element) => element.id === parentId);
    if (parent === undefined) return this.unheldMessage(parentId);
    if (parent.kind !== "section" && parent.kind !== "order_step") {
      return `\`${parentId}\` is a \`${parent.kind}\`, which holds no children. A parent is a section or a step.`;
    }
    return undefined;
  }

  /** D4 — every reference argument names an element the board already holds. */
  private checkReferences(tool: BoardTool, input: Record<string, unknown>): string | undefined {
    const held = new Set(this.elements.map(({ id }) => id));
    for (const field of tool.fields) {
      if (field.source.form !== "element-ref") continue;
      const value = input[field.name];
      if (value === undefined) continue;
      const ids = Array.isArray(value) ? value : [value];
      for (const id of ids) {
        if (typeof id === "string" && held.has(id)) continue;
        return `\`${field.name}\` names \`${String(id)}\`, which this board does not hold. It holds: ${this.heldIds()}.`;
      }
    }
    return undefined;
  }

  /**
   * A list-valued structured field arrives as parallel arrays the seat keeps in step by
   * index. Two ways to get that wrong, and both used to pass silently: naming a
   * companion without its spine (the rebuilt list was sized off the spine, so an absent
   * spine wrote an EMPTY list over whatever was there), and giving the arrays different
   * lengths (the extras past the spine were dropped, and the entries the spine outran
   * were built missing a key).
   *
   * Both are refused here, naming the field and what would be admissible. This is not a
   * gate: it is the difference between a call doing what the tool says it does and a
   * call quietly discarding the seat's work. `update_*` promises "only the fields given
   * change", and an update that wipes a field it was not given is that promise broken.
   *
   * REACHABLE FROM `set_document` ONLY, today. Both branches need a group of two or
   * more parts, and `stats` on `set_document` is the only such group on any tool of any
   * target — every other list flattening carries one part, for which the spine is
   * always present and there is nothing to misalign. So the calls in `add` and `update`
   * cannot fire, and a mutation that deletes the `update` one reddens nothing: measured
   * PASS 273 FAIL 0. They stay because the reachable set is decided by the flattening
   * table, not by this file, and a kind gaining a second list part must not also have
   * to remember to re-add a guard. Do not read their presence as coverage.
   */
  private checkListAlignment(tool: BoardTool, input: Record<string, unknown>): string | undefined {
    const groups = new Map<string, { spine?: string; given: { name: string; length: number }[] }>();
    for (const field of tool.fields) {
      const source = field.source;
      if (source.form !== "json-part" || !source.many) continue;
      const group = groups.get(source.dataField) ?? { given: [] };
      // Field order is schema order, so the first part of a group is its spine.
      group.spine ??= field.name;
      const value = input[field.name];
      if (Array.isArray(value)) group.given.push({ name: field.name, length: value.length });
      groups.set(source.dataField, group);
    }

    for (const group of groups.values()) {
      if (group.given.length === 0) continue;
      const spineName = group.spine;
      const spine = group.given.find((entry) => entry.name === spineName);
      if (spine === undefined) {
        const named = group.given.map((entry) => `\`${entry.name}\``).join(", ");
        return `${named} needs \`${spineName}\` alongside it: this list is written whole, one entry per \`${spineName}\`. Give \`${spineName}\` too, or leave the list out entirely.`;
      }
      const mismatched = group.given.find((entry) => entry.length !== spine.length);
      if (mismatched !== undefined) {
        return `\`${mismatched.name}\` has ${mismatched.length} ${mismatched.length === 1 ? "entry" : "entries"} and \`${spine.name}\` has ${spine.length}. They are index-aligned: give exactly one \`${mismatched.name}\` per \`${spine.name}\`.`;
      }
    }
    return undefined;
  }

  /**
   * A mutation after a settlement un-settles the board. See {@link BoardWriter.status}:
   * the call goes through, and the claim that it finished does not survive it.
   */
  private reopen(): void {
    if (this.state !== "drafting") {
      this.state = "drafting";
      this.absence = undefined;
    }
  }

  /** The wire boundary: the board a call would produce must still parse as a draft. */
  private structuralRefusal(next: DraftBoard): string | undefined {
    const parsed = parseDraft(next);
    if (parsed.ok) return undefined;
    return `The call would not produce a valid element — ${parsed.issues
      .map((issue) => `\`${issue.path.join(".")}\`: ${issue.message}`)
      .join("; ")}.`;
  }

  /**
   * The boundary tier over the board the call WOULD produce, reporting only what the
   * call introduced. Comparing against what the board already carries is deliberate:
   * every call is checked, so the board is clean by induction, and a call is refused
   * for what IT did rather than for something a caller cannot fix from here.
   */
  private introducedViolations(next: DraftBoard): Violation[] {
    const before = new Set(
      lintTier(this.board(), this.lint, "boundary", this.register).map(violationKey),
    );
    return lintTier(next, this.lint, "boundary", this.register).filter(
      (violation) => !before.has(violationKey(violation)),
    );
  }

  private subtreeOf(rootId: string): Set<string> {
    const byId = new Map(this.elements.map((element) => [element.id, element]));
    const doomed = new Set<string>();
    const visit = (id: string): void => {
      if (doomed.has(id)) return;
      doomed.add(id);
      const element = byId.get(id);
      if (element === undefined) return;
      const children = (element.data as { children?: unknown }).children;
      if (!Array.isArray(children)) return;
      for (const child of children) if (typeof child === "string") visit(child);
    };
    visit(rootId);
    return doomed;
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

const refuse = (refusal: string): BoardToolResult => ({ ok: false, refusal });

/** Bounded for quoting back into a batch refusal. See {@link BATCH_NAME_CAP}. */
const clip = (text: string, cap: number): string =>
  text.length <= cap ? text : `${text.slice(0, cap)}…`;

const violationKey = (violation: Violation): string =>
  `${violation.ruleId} ${violation.elementRef} ${violation.message}`;

/**
 * The tool inputs a rule is ABOUT, for the rules that report against a whole element
 * rather than one of its fields. Without this a `cite` refusal named `e7` — an id the
 * host minted and then rolled back, so it names nothing the seat has ever seen or can
 * act on — where task 1.6 asks a refusal to name the field.
 */
const RULE_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "citation-resolves": ["path", "side", "start_line", "end_line"],
  "unresolvable-citation": ["path", "side", "start_line", "end_line"],
  "scaffold-is-noise-lane": ["path"],
};

/**
 * What a violation should be called in a refusal: the tool INPUT field it is about.
 *
 * A violation's `elementRef` is `<id>` or `<id>/<dataField>`, in the element vocabulary
 * — which is the right pointer for `finish`, where the seat holds the ids, and the
 * wrong one for a refusal, where the element does not exist and the id has been
 * returned to the pool. So a violation against the element this call touched is
 * translated: by its data field where it has one, and by {@link RULE_INPUT_FIELDS}
 * where the rule reports element-wide. A violation against any OTHER element keeps its
 * element ref, because that one really is on the board and the seat can address it.
 */
function pointerLabel(
  tool: BoardTool,
  touchedId: string | undefined,
  violation: Violation,
): string {
  const { elementRef, ruleId } = violation;
  if (touchedId === undefined) return `\`${elementRef}\``;

  // The touched thing is an element id, or the board-level `/document`. Anything that
  // is not a suffix of it belongs to another element and keeps its own ref.
  let suffix: string | undefined;
  if (elementRef === touchedId) suffix = undefined;
  else if (elementRef.startsWith(`${touchedId}/`)) suffix = elementRef.slice(touchedId.length + 1);
  else return `\`${elementRef}\``;

  if (suffix === undefined) {
    const own = new Set(tool.fields.map((field) => field.name));
    const about = (RULE_INPUT_FIELDS[ruleId] ?? []).filter((name) => own.has(name));
    return about.length > 0 ? about.map((name) => `\`${name}\``).join(", ") : `\`${tool.name}\``;
  }

  // A pointer into a structured field is NESTED and may carry a list index:
  // `source/line`, `sources/0/path`, `scenarios/2`. The flat input that owns it is
  // named by the data field and, where the pointer goes deeper, by the part —
  // `source/line` is `source_line`, `sources/0/path` is `source_paths`. Matching the
  // whole suffix as one data field found nothing and echoed `source/line` back at the
  // seat, which is not a field it can change.
  const segments = suffix.split("/").filter((segment) => !/^\d+$/.test(segment));
  const [dataField, part] = segments;
  const named = tool.fields.find((field) => {
    if (field.source.dataField !== dataField) return false;
    if (part === undefined) return field.source.form !== "json-part";
    return field.source.form === "json-part" && field.source.part === part;
  });
  return `\`${named?.name ?? suffix}\``;
}

/**
 * A refusal reads as the rules that refused it — the lint messages, verbatim — under
 * the name of the input the seat actually sent.
 */
function describe(violations: readonly Violation[], tool?: BoardTool, touchedId?: string): string {
  return violations
    .map((violation) => {
      const label =
        tool === undefined
          ? `\`${violation.elementRef}\``
          : pointerLabel(tool, touchedId, violation);
      return `${label} (${violation.ruleId}): ${violation.message}`;
    })
    .join(" ");
}

/** Append `childId` to `parentId`'s host-maintained `children`. */
function adopt(
  elements: readonly DraftElement[],
  parentId: string,
  childId: string,
): DraftElement[] {
  return elements.map((element) => {
    if (element.id !== parentId) return element;
    const data = element.data as Record<string, unknown>;
    const children = Array.isArray(data.children) ? data.children : [];
    return { ...element, data: { ...data, children: [...children, childId] } } as DraftElement;
  });
}

/** Drop `removed` ids from an element's host-maintained `children`. */
function withoutChildren(element: DraftElement, removed: ReadonlySet<string>): DraftElement {
  const data = element.data as Record<string, unknown>;
  if (!Array.isArray(data.children)) return element;
  const kept = data.children.filter((child) => !(typeof child === "string" && removed.has(child)));
  if (kept.length === data.children.length) return element;
  return { ...element, data: { ...data, children: kept } } as DraftElement;
}

/**
 * Rebuild an element's `data` from a flat tool input, using the tool's own field plan.
 * The plan is the derivation's other half: `protocol` decided which flat names exist and
 * where each lands, so nothing here re-states the mapping.
 */
function dataFromInput(
  tool: BoardTool,
  input: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // A `json` field arrives as its parts, so collect them before assembling.
  const single = new Map<string, Record<string, unknown>>();
  const listed = new Map<string, Map<string, unknown[]>>();

  for (const field of tool.fields) {
    const value = input[field.name];
    if (value === undefined) continue;
    const source = field.source;
    if (source.form === "scalar" || source.form === "element-ref") {
      out[source.dataField] = value;
      continue;
    }
    if (source.many) {
      const parts = listed.get(source.dataField) ?? new Map<string, unknown[]>();
      parts.set(source.part, Array.isArray(value) ? value : [value]);
      listed.set(source.dataField, parts);
    } else {
      const parts = single.get(source.dataField) ?? {
        ...((current[source.dataField] as Record<string, unknown> | undefined) ?? {}),
      };
      parts[source.part] = value;
      single.set(source.dataField, parts);
    }
  }

  for (const [dataField, parts] of single) out[dataField] = parts;
  for (const [dataField, parts] of listed) {
    // The list form is index-aligned, and `checkListAlignment` has already refused a
    // group whose spine is missing or whose arrays disagree — so by here the spine is
    // present and every companion is the same length. Sizing off the spine when it is
    // ABSENT is what wrote an empty list over a field the call never mentioned.
    //
    // The `continue` below is therefore UNREACHABLE through `call()` today, and no test
    // exercises it: a group only reaches `listed` when the input carried one of its
    // parts, and `checkListAlignment` refuses that group unless its spine is among them.
    // It stays because this helper is otherwise correct only by its caller's ordering,
    // and the failure it guards against is silent.
    const spine = tool.fields.find(
      (field) => field.source.form === "json-part" && field.source.dataField === dataField,
    );
    const spinePart =
      spine !== undefined && spine.source.form === "json-part" ? spine.source.part : undefined;
    const spineValues = spinePart === undefined ? undefined : parts.get(spinePart);
    if (spineValues === undefined) continue; // not this call's field to rewrite
    const entries: Record<string, unknown>[] = [];
    for (let index = 0; index < spineValues.length; index += 1) {
      const entry: Record<string, unknown> = {};
      for (const [part, values] of parts) {
        const value = values[index];
        if (value !== undefined) entry[part] = value;
      }
      entries.push(entry);
    }
    out[dataField] = entries;
  }
  return out;
}
