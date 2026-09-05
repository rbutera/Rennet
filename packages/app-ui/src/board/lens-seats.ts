import {
  type LaneLatest,
  type LaneSeat,
  type LaneThreadRef,
  LENS_KINDS,
  type LensKind,
  type LensLane,
} from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// WHICH SEAT IS WRITING WHICH BOARD (lens-board-tools 5.1/5.7, D12/D16c).
//
// The bench used to own this derivation and draw it as five readers under a slab.
// The bench is gone; the answer it computed is not, because the rail, the seat widget
// and the transcript drawer all need the same one — and they must never disagree about
// it, which is why there is exactly one function here and three callers of it.
//
// The inputs are both things the daemon already publishes, and nothing here invents a
// state that neither of them said:
//
//   • the generation's LANES, and whether that generation is RUNNING — `GenerationLanes`.
//     A lane carries its status, its seats, each seat's thread and each seat's latest
//     line; `running` says whether any of that is still true. They are separate fields
//     because a preparation that FAILED or was CANCELLED keeps its lanes: they are the
//     record of a run that is over, and reading them as live is how a cancelled review
//     came to say "the seat is still writing" over a screen that also said "cancelled".
//   • the per-lens BOARD READ — `board.read`'s resolution, which is the only thing that
//     answers for a generation with no lanes left in flight (an old review, a frozen
//     generation drill-down), and which is also what a stopped run falls back to.
//
// THREE THINGS THIS ANSWERS, and they are not the same question:
//
//   • `register` — what the rail shows. Every lens has one from the first frame (5.1),
//     including during capture, where all five are honestly `waiting`.
//   • `seated` — whether a lane for this lens exists at all. The seat widget is gated on
//     it, because "Design seat · waiting" over a capture that has opened no lane names a
//     seat that does not exist.
//   • `drafting` — whether this lens's board is being written RIGHT NOW. It gates the
//     board's own in-progress copy and its placeholder row, and it is the strictest of
//     the three: it needs a running generation AND a lane of its own that has not reached
//     a terminal state. During capture no lane is open and nothing is being written, so
//     no board says it is; after a cancel or a failure nothing is running, so no board
//     says it is either. The deleted bench had the same rule and said why: "an empty
//     bench is honest, five invented 'queued' readers would not be.
// ─────────────────────────────────────────────────────────────────────────────

/** Reader-facing lens names — the id vocabulary (`manifests/`) is lower-case. */
export const LENS_LABEL: Record<LensKind, string> = {
  design: "Design",
  sequence: "Sequence",
  decisions: "Decisions",
  flagged: "Flagged",
  noise: "Noise",
};

/**
 * What a lens's seat is doing. Five of these are the states the spec enumerates
 * (`live-board-workspace`: "waiting, working, settled, failed, or absent"); `none` is
 * the sixth and it is not a seat state at all — it is "this generation is not running
 * and this lens has no board", which is the honest answer for a historical generation
 * that never drafted one. Painting that as `waiting` would promise a board that is
 * never coming; painting it `absent` would claim a settled result nobody recorded.
 */
export type SeatRegister = "waiting" | "working" | "settled" | "absent" | "failed" | "none";

/**
 * How the lens's stop is CUT on the rail — the register said a second way, in shape
 * rather than colour (#818, D12). The vocabulary is the bench's core-sample vocabulary
 * verbatim, because it is the same device at rail scale: `lens-switcher.tsx`'s own
 * comment already called the stop "the same device the bench's core samples hang on".
 * The register a reader must tell apart is carried by the CUT, never by the hue — the
 * hue says which lens this is, so a failed Design lane must not turn red.
 */
export type SeatCut = "unstarted" | "open" | "clean" | "seamed" | "snapped" | "empty";

/** One voice at a lens: a seat with its own thread and its own live line. A lane that
 *  predates `seats` (or has none yet) speaks with one voice, the lane's own. */
export interface SeatVoice {
  readonly seat: string;
  /** Named only when the lane has more than one voice — a single seat is just the lens. */
  readonly name?: string;
  readonly provider?: LaneSeat["provider"];
  readonly thread?: LaneThreadRef;
  readonly latest?: LaneLatest;
  /** What this voice is saying, and whether it is said quietly. */
  readonly speech: SeatSpeech;
}

/** What a voice is saying, and whether it is said quietly (a promise or a lull, not work
 *  in progress). Read off the arm that HAS the words — never guessed. */
export interface SeatSpeech {
  readonly text: string;
  readonly quiet: boolean;
}

export interface LensSeatState {
  readonly lens: LensKind;
  readonly label: string;
  readonly register: SeatRegister;
  readonly cut: SeatCut;
  readonly voices: readonly SeatVoice[];
  /**
   * The lanes this lens's board is the complement of and is therefore waiting on (D16c).
   * Non-empty only for Noise, and only while a sibling has not reached a terminal state.
   * An empty list on a `waiting` Noise entry means it is about to start, not that it is
   * waiting on nothing knowable.
   */
  readonly waitingOn: readonly LensKind[];
  /** A settled lane that was re-cut this generation — the rail's seam. */
  readonly reworked: boolean;
  /**
   * A lane for this lens exists — the daemon opened one, so there is or was a seat. False
   * during capture, when no lane has been opened yet, and false for a lens a generation
   * never ran. The seat widget is gated on it: a widget naming a seat that does not exist
   * is the same class of lie as a board that says it is being written when it is not.
   */
  readonly seated: boolean;
  /**
   * This lens's board is being written RIGHT NOW: the generation is running and this
   * lens's own lane says a seat is working. The board's in-progress mark, its "still
   * being written" line and its placeholder row are all gated on this, and so is the
   * rail's `open` cut.
   *
   * It is exactly `register === "working"`, and deliberately NOT "has a lane that has not
   * settled". A lane can exist, be non-terminal and have nothing being written: during
   * capture, before kickoff, and — for the whole core fan-out — on the derived Noise lane
   * whose board is the complement of four lanes that have not settled (#865). Reading a
   * non-terminal lane as drafting is what put "IN PROGRESS · This board is still being
   * written" over a lane with no thread and no seat.
   */
  readonly drafting: boolean;
}

/**
 * The generation's lanes and whether it is still going.
 *
 * `running` is NOT derivable from the lanes: a cancelled preparation keeps the lanes it
 * had, frozen at whatever status they held, and a preparation cancelled during capture
 * keeps none at all. Both are records of a run that is over, and only the preparation's
 * own status says so.
 */
export interface GenerationLanes {
  readonly lanes: readonly LensLane[];
  readonly running: boolean;
}

export type LensSeatStates = Readonly<Record<LensKind, LensSeatState>>;

/** The one field of a board resolution this derivation reads. Structural on purpose:
 *  `board-data.ts` imports THIS module, so this module must not import it back. */
export interface LensReadStatus {
  readonly status: "valid" | "absent" | "failed" | "missing" | "pending" | "invalid";
}

const PROVIDER_NAME: Readonly<Record<LaneSeat["provider"], string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
};

/** The lens a lane id names, or `undefined` for a lane this client has never heard of. */
function lensOf(id: string): LensKind | undefined {
  return (LENS_KINDS as readonly string[]).includes(id) ? (id as LensKind) : undefined;
}

function registerOfLane(lane: LensLane): SeatRegister {
  // `queued` (the generation has not kicked off) and `waiting` (this lane's board is the
  // complement of siblings that have not settled) are both honestly "not started". They
  // are two states on the wire because the daemon can tell them apart and the rail
  // sentence differs — a waiting lane names who it is waiting on — but neither is work.
  if (lane.status === "queued" || lane.status === "waiting") return "waiting";
  if (lane.status === "running") return "working";
  if (lane.status === "failed") return "failed";
  if (lane.status === "absent") return "absent";
  return "settled";
}

/** The register a board read alone can establish, for a generation with no lane in
 *  flight. `missing` is deliberately NOT an answer here — its caller decides between
 *  `waiting` (a live generation) and `none` (a settled one) from the lanes. */
function registerOfRead(read: LensReadStatus): SeatRegister | undefined {
  switch (read.status) {
    case "valid":
      return "settled";
    case "absent":
      return "absent";
    case "failed":
      return "failed";
    // An unreadable or malformed board is a read fault, not a seat state: the board
    // surface says so in its own words (`BoardAccount`) and the rail claims nothing.
    case "invalid":
      return "none";
    case "pending":
      return "waiting";
    default:
      return undefined;
  }
}

export function speechOf(lane: LensLane, latest: LaneLatest | undefined): SeatSpeech {
  switch (lane.status) {
    case "queued":
      return { text: "queued", quiet: true };
    // The lane's own words. WHO it waits on is the derivation's answer, not the lane's
    // (`waitingOn` + `waitingOnLine`), and the rail and the widget print that instead.
    case "waiting":
      return { text: "waiting on the other lenses", quiet: true };
    case "running":
      // No projection yet is its own honest state: the thread exists, nothing has come
      // off it. Saying "reading the change" here would be an invention.
      if (latest === undefined) return { text: "under way", quiet: true };
      return { text: latest.text, quiet: latest.kind === "idle" };
    case "drafted":
      return { text: "drafted", quiet: false };
    case "done":
      return {
        text: lane.verdict === "carrying-forward" ? "carrying forward" : "reworked",
        quiet: false,
      };
    default:
      // `absent` and `failed` both carry the drafter's own reason.
      return { text: lane.reason, quiet: lane.status === "absent" };
  }
}

export function voicesOf(lane: LensLane): readonly SeatVoice[] {
  const seats = lane.seats ?? [];
  if (seats.length === 0) {
    const latest = lane.status === "running" ? lane.latest : undefined;
    return [
      {
        seat: lane.id,
        ...(lane.thread === undefined ? {} : { thread: lane.thread }),
        ...(latest === undefined ? {} : { latest }),
        speech: speechOf(lane, latest),
      },
    ];
  }
  return seats.map((seat) => {
    const latest = lane.status === "running" ? seat.latest : undefined;
    return {
      seat: seat.seat,
      provider: seat.provider,
      ...(seats.length > 1 ? { name: PROVIDER_NAME[seat.provider] } : {}),
      ...(seat.thread === undefined ? {} : { thread: seat.thread }),
      ...(latest === undefined ? {} : { latest }),
      speech: speechOf(lane, latest),
    };
  });
}

function cutOf(register: SeatRegister, reworked: boolean): SeatCut {
  switch (register) {
    case "failed":
      return "snapped";
    case "absent":
      return "empty";
    case "waiting":
      return "unstarted";
    case "working":
      return "open";
    case "none":
      return "unstarted";
    default:
      return reworked ? "seamed" : "clean";
  }
}

/**
 * A lens answered for by its board read alone: no lane, or a lane on a generation that
 * has stopped. `running` decides the one case the read cannot answer — a `missing` board
 * on a live generation is a lane not opened yet (`waiting`), and on a stopped one is
 * simply nothing (`none`).
 *
 * `seated` carries whether a lane exists even here, because a cancelled generation's
 * frozen lane is still a seat that ran: its transcript is worth reaching, and the widget
 * is what reaches it.
 */
function fromReadAlone(
  lens: LensKind,
  read: LensReadStatus,
  running: boolean,
  lane?: LensLane,
): LensSeatState {
  const register = registerOfRead(read) ?? (running ? "waiting" : "none");
  return {
    lens,
    label: lane !== undefined && lane.label.length > 0 ? lane.label : LENS_LABEL[lens],
    register,
    cut: cutOf(register, false),
    voices: lane === undefined ? voiceFromRead(lens, register) : voicesOf(lane),
    waitingOn: [],
    reworked: false,
    seated: lane !== undefined,
    // Never: either no lane exists, or the generation carrying it has stopped.
    drafting: false,
  };
}

/** The quiet, board-only voice for a lens with no lane — the read's own account, so a
 *  settled review's rail says what its boards say and never invents a seat. */
function voiceFromRead(lens: LensKind, register: SeatRegister): readonly SeatVoice[] {
  const text =
    register === "settled"
      ? "drafted"
      : register === "failed"
        ? "this lens failed to generate"
        : register === "absent"
          ? "nothing to draft"
          : register === "waiting"
            ? "queued"
            : "no board for this generation";
  return [{ seat: lens, speech: { text, quiet: register !== "settled" && register !== "failed" } }];
}

/**
 * Every lens's seat state for one generation. Total over `LENS_KINDS` — the rail lists
 * all five from the first frame (D12), so this answers for all five whether or not any
 * of them has a lane or a board yet.
 */
export function lensSeatStates(
  generation: GenerationLanes | undefined,
  reads: Readonly<Record<LensKind, LensReadStatus>>,
): LensSeatStates {
  const byLens = new Map<LensKind, LensLane>();
  for (const lane of generation?.lanes ?? []) {
    const lens = lensOf(lane.id);
    if (lens !== undefined) byLens.set(lens, lane);
  }
  const running = generation?.running === true;

  const base = LENS_KINDS.map((lens): LensSeatState => {
    const lane = byLens.get(lens);
    const read = reads[lens];
    if (lane !== undefined) {
      const laneRegister = registerOfLane(lane);
      const terminal = laneRegister !== "waiting" && laneRegister !== "working";
      // A NON-TERMINAL lane on a generation that has STOPPED is a frozen record, not a
      // live seat: a cancel writes the lanes exactly as they stood, so a lane left at
      // `running` would go on animating over a screen that says the run was cancelled.
      // The board read is what answers for it instead, exactly as it answers for a lens
      // that never had a lane. A terminal lane keeps its own register either way — that
      // is a real result, and cancelling a generation does not un-draft what it drafted.
      if (!terminal && !running) {
        return fromReadAlone(lens, read, false, lane);
      }
      const reworked = lane.status === "done" && lane.verdict !== "carrying-forward";
      return {
        lens,
        label: lane.label.length > 0 ? lane.label : LENS_LABEL[lens],
        register: laneRegister,
        cut: cutOf(laneRegister, reworked),
        voices: voicesOf(lane),
        waitingOn: [],
        reworked,
        seated: true,
        // A seat is working on a generation that is still going, so this board is
        // genuinely being written into. A waiting or queued lane is not.
        drafting: laneRegister === "working",
      };
    }
    // NO LANE FOR THIS LENS. On a running generation its lane has not been opened yet,
    // which the rail shows as `waiting` — but nothing is being written, so `drafting` is
    // false and no board claims otherwise. Off a running generation the board read is the
    // only witness, and a missing board with no witness is `none`, never a promise.
    return fromReadAlone(lens, read, running);
  });

  // D16c — Noise is the COMPLEMENT of the other four, so it does not start until they
  // have settled and it names what it is waiting for. This is a client derivation over
  // states the daemon already published, not a second opinion about them: the lanes it
  // lists are exactly the ones whose own entry says they have not reached a terminal
  // state. It NEVER makes Noise read as working or failed — those come off its own lane.
  //
  // It names only lanes that are ACTUALLY still owed: a lane that EXISTS (the daemon
  // opened it) and has not reached a terminal state. So a stopped generation's Noise
  // entry names nobody — the whole derivation is gated on `running` — and a capture that
  // has opened no lane at all does not claim to be waiting on four lanes that are not
  // running. It is NOT `drafting`: a sibling that is queued or waiting is still owed, and
  // only a settled one is not.
  const noise = base.find((entry) => entry.lens === "noise");
  const owed = (entry: LensSeatState): boolean =>
    entry.lens !== "noise" &&
    entry.seated &&
    (entry.register === "working" || entry.register === "waiting");
  const waitingOn =
    noise !== undefined && noise.register === "waiting" && running
      ? base.filter(owed).map((entry) => entry.lens)
      : [];

  return Object.fromEntries(
    base.map((entry) => [
      entry.lens,
      entry.lens === "noise" && waitingOn.length > 0 ? { ...entry, waitingOn } : entry,
    ]),
  ) as LensSeatStates;
}

/** The sentence the rail and the widget both use for a waiting Noise entry. */
export function waitingOnLine(waitingOn: readonly LensKind[]): string {
  if (waitingOn.length === 0) return "waiting to start";
  const names = waitingOn.map((lens) => LENS_LABEL[lens]);
  const last = names.at(-1) ?? "";
  return names.length === 1
    ? `waiting on ${last}`
    : `waiting on ${names.slice(0, -1).join(", ")} and ${last}`;
}
