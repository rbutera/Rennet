// The pure half of `rennet review` (headless-review-cli, issue #379 / #71), kept out of
// `cli.ts` so the parts with no daemon can be tested without one: the argument grammar, the
// preparation-record-to-lines fold, the `lensDraft`-frame-to-line fold, the document shape,
// and where the document lands. `cli.ts` owns the socket, the poll and the writes; this file
// owns everything a fixture can decide on its own.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type CommandOutput,
  currentGenerationId,
  type ForgeRepoIdentity,
  LENS_KINDS,
  type LensDraftEvent,
  type LensKind,
  type LensLane,
  REVIEW_CLI_FEATURE,
  type Review,
  type SessionPreparation,
  sameForgeRepository,
} from "@rennet/protocol";

/** The default review timeout: half an hour, matching the desktop's patience for a generation. */
export const DEFAULT_REVIEW_TIMEOUT_SECONDS = 1800;

/**
 * The oldest daemon `rennet review` can drive (headless-review-cli D11): the server semver this
 * seam ships in. The real gate is the `review-cli` FEATURE FLAG in the handshake, not a version
 * compare; this string only NAMES the version in the refusal so the reviewer knows what to
 * update to. Read from `packages/server/package.json` at authoring time.
 */
export const MIN_REVIEW_CLI_DAEMON_VERSION = "0.1.5";

/**
 * The connect-time capability check (headless-review-cli D11). A daemon that predates the
 * headless review seam never advertises the `review-cli` feature and its `repository.identify`
 * is an unknown command, so the CLI would review against the wrong repo or base silently. This
 * returns the refusal body (the caller prefixes `rennet review:`) when the flag is missing, or
 * `undefined` when the daemon supports the seam. The daemon's own version is named when the
 * handshake carried one, so `rennet review needs ... this daemon is v0.1.4` reads truthfully.
 */
export function reviewCliUnsupportedMessage(
  features: Readonly<Record<string, boolean>> | undefined,
  daemonVersion: string | undefined,
): string | undefined {
  if (features?.[REVIEW_CLI_FEATURE] === true) return undefined;
  const seen =
    daemonVersion === undefined || daemonVersion.length === 0
      ? "an older build"
      : `v${daemonVersion}`;
  return `needs a daemon that supports the headless review CLI (Rennet server >= ${MIN_REVIEW_CLI_DAEMON_VERSION}); this daemon is ${seen}. Update the daemon (stop it and relaunch the newer build), then rerun.`;
}

/** One project.detail PR row, reduced to the fields PR-target scoping reads (headless-review-cli D11). */
export interface ScopablePr {
  readonly number: number;
  /** The row's canonical `owner/name`, the daemon-produced identity (never CLI-spelled). */
  readonly repository: string;
  /** The provider-qualified identity, when the row carries one; used to break same-slug forge ties. */
  readonly forgeRepository?: ForgeRepoIdentity;
}

/** The standing checkout's daemon-resolved identity (headless-review-cli D11). */
export interface StandingRepository {
  readonly repository: string;
  readonly forgeRepository?: ForgeRepoIdentity;
}

/** What `resolvePrTarget` decided: the one standing-repo row, nothing by that number, or a refusal. */
export type PrTargetResolution<Row extends ScopablePr> =
  | { readonly kind: "found"; readonly row: Row }
  | { readonly kind: "not-listed" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] };

/**
 * Is this PR row in the standing repository? When both carry a provider-qualified identity, compare
 * that (so a GitHub `acme/widget` checkout never matches a GitLab `acme/widget#7` row, same slug,
 * different forge); otherwise fall back to the `owner/name` slug the older project-detail producers
 * and local-only repos still carry.
 */
function prIsInStandingRepo(pr: ScopablePr, standing: StandingRepository): boolean {
  if (pr.forgeRepository !== undefined && standing.forgeRepository !== undefined) {
    return sameForgeRepository(pr.forgeRepository, standing.forgeRepository);
  }
  return pr.repository === standing.repository;
}

/**
 * Scope `--pr <n>` to the STANDING repository (headless-review-cli D11). A branch NAME and a PR
 * NUMBER are each unique only within one repo, so `prs.find(pr => pr.number === n)` project-wide
 * captures the wrong repo in a workspace. Match on `(number, standing repository)`: exactly one
 * standing-repo row is `found`; no row anywhere by that number is `not-listed`; and rows exist by
 * that number but none is the standing repo's (a cross-repo collision, or a #n that lives only in
 * a sibling) is `ambiguous`, carrying every `owner/name#number` candidate so the refusal names
 * them rather than taking a project-wide first hit. The standing identity is the daemon's own
 * (repository + forgeRepository) for the checkout, so the match cannot drift from what the row
 * carries, and a same-slug cross-forge collision is decided by forge, not name.
 */
export function resolvePrTarget<Row extends ScopablePr>(
  prs: readonly Row[],
  prNumber: number,
  standing: StandingRepository,
): PrTargetResolution<Row> {
  const matches = prs.filter((pr) => pr.number === prNumber);
  if (matches.length === 0) return { kind: "not-listed" };
  const scoped = matches.filter((pr) => prIsInStandingRepo(pr, standing));
  const only = scoped.length === 1 ? scoped[0] : undefined;
  if (only !== undefined) return { kind: "found", row: only };
  return { kind: "ambiguous", candidates: matches.map((pr) => `${pr.repository}#${pr.number}`) };
}

/** One usage line for every `rennet review` refusal, so the flags cannot drift. */
export const REVIEW_USAGE =
  "Usage: rennet review <base>..<head> [path] | rennet review --pr <number> [path]   [--data-dir <dir>] [--out <file>] [--timeout <seconds>]";

/** The options every review invocation shares, whichever target it names. */
interface ReviewOptions {
  readonly path?: string;
  readonly dataDir?: string;
  readonly out?: string;
  readonly timeoutMs: number;
}

/** What `parseReviewTarget` resolved from argv: a range, a PR, or a usage refusal. */
export type ReviewTarget =
  | ({ readonly kind: "range"; readonly base: string; readonly head: string } & ReviewOptions)
  | ({ readonly kind: "pr"; readonly number: number } & ReviewOptions)
  | { readonly kind: "usage"; readonly message: string };

function usage(message: string): ReviewTarget {
  return { kind: "usage", message };
}

/**
 * Parse `rennet review`'s argv. One positional range (`<base>..<head>`) plus an optional
 * path, OR `--pr <n>` plus an optional path — never both, and a range must carry `..`. The
 * refusals are the controls in tasks.md 2.2: no target, a range and a PR together, a range
 * with no `..`, a non-numeric `--pr`, and more paths than the form allows.
 */
export function parseReviewTarget(argv: readonly string[]): ReviewTarget {
  let parsed: { values: Record<string, string | undefined>; positionals: string[] };
  try {
    const result = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        "data-dir": { type: "string" },
        out: { type: "string" },
        pr: { type: "string" },
        timeout: { type: "string" },
      },
    });
    parsed = { values: result.values, positionals: result.positionals };
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }

  let timeoutMs = DEFAULT_REVIEW_TIMEOUT_SECONDS * 1000;
  if (parsed.values.timeout !== undefined) {
    const seconds = Number(parsed.values.timeout);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      return usage(`--timeout '${parsed.values.timeout}' is not a positive number of seconds`);
    }
    timeoutMs = seconds * 1000;
  }
  const shared: ReviewOptions = {
    path: undefined,
    dataDir: parsed.values["data-dir"],
    out: parsed.values.out,
    timeoutMs,
  };

  if (parsed.values.pr !== undefined) {
    if (parsed.positionals.some((positional) => positional.includes(".."))) {
      return usage("name a range OR --pr, not both");
    }
    if (parsed.positionals.length > 1) return usage("expected at most one path with --pr");
    const number = Number(parsed.values.pr);
    if (!Number.isInteger(number) || number <= 0) {
      return usage(`--pr '${parsed.values.pr}' is not a pull request number`);
    }
    return { kind: "pr", number, ...shared, path: parsed.positionals[0] };
  }

  const rangeArg = parsed.positionals[0];
  if (rangeArg === undefined) {
    return usage("name a range (<base>..<head>) or a pull request (--pr <number>)");
  }
  if (!rangeArg.includes("..")) {
    return usage(`'${rangeArg}' is not a range (expected <base>..<head>)`);
  }
  if (parsed.positionals.length > 2) return usage("expected a range and at most one path");
  const separator = rangeArg.indexOf("..");
  const base = rangeArg.slice(0, separator);
  const head = rangeArg.slice(separator + 2);
  if (base === "") return usage(`'${rangeArg}' has no base (expected <base>..<head>)`);
  return { kind: "range", base, head, ...shared, path: parsed.positionals[1] };
}

/** The seconds-since-mint prefix every progress line carries, so a CI log keeps the timing. */
export function formatElapsed(elapsedMs: number): string {
  return `[+${Math.max(0, Math.floor(elapsedMs / 1000))}s] `;
}

/** The two capture steps, spelled the way a terminal reads them (D6). */
function captureStepLabel(step: "resolving-repository" | "capturing-change"): string {
  return step === "resolving-repository" ? "resolving repository" : "capturing change";
}

/** The lens-lanes a preparation record carries, whatever settled state it is in. */
function lanesOf(preparation: SessionPreparation | undefined): readonly LensLane[] {
  if (preparation === undefined) return [];
  if (preparation.status === "drafting") return preparation.lanes;
  if (preparation.status === "failed" || preparation.status === "cancelled") {
    return preparation.lanes ?? [];
  }
  return [];
}

/** One lens lane's status line, with the verdict or reason the settled state carries. */
function laneStatusLine(lane: LensLane): string {
  switch (lane.status) {
    case "done":
      return `${lane.id}  done  ${lane.verdict}`;
    case "absent":
      return `${lane.id}  absent  ${lane.reason}`;
    case "failed":
      return `${lane.id}  failed  ${lane.reason}`;
    default:
      return `${lane.id}  ${lane.status}`;
  }
}

/**
 * The lines a preparation-record transition prints (D6, tasks.md 3.1). Pure over the two
 * records and the elapsed clock: the capture step when it changes, each lane's status when
 * it changes (a lane not previously seen is compared against `queued`, its starting state,
 * so an ordinary first paint of a queued lane prints nothing), and each seat's live line
 * when its text changes, named by seat and provider under the lane's own name. Only a
 * `running` lane carries seats, which is why a settled lane prints one status line and no
 * seat lines.
 */
export function foldPreparationLines(
  previous: SessionPreparation | undefined,
  next: SessionPreparation | undefined,
  elapsedMs: number,
): string[] {
  const prefix = formatElapsed(elapsedMs);
  const lines: string[] = [];
  if (next === undefined) return lines;

  if (next.status === "capturing") {
    const nextStep = captureStepLabel(next.step);
    const previousStep =
      previous?.status === "capturing" ? captureStepLabel(previous.step) : undefined;
    if (nextStep !== previousStep) lines.push(`${prefix}capturing  ${nextStep}`);
    return lines;
  }

  const previousLanes = new Map(lanesOf(previous).map((lane) => [lane.id, lane]));
  for (const lane of lanesOf(next)) {
    const before = previousLanes.get(lane.id);
    if (lane.status !== (before?.status ?? "queued")) {
      lines.push(`${prefix}${laneStatusLine(lane)}`);
    }
    const beforeSeatText = new Map(
      (before?.seats ?? [])
        .filter((seat) => seat.latest !== undefined)
        .map((seat) => [seat.seat, seat.latest?.text]),
    );
    for (const seat of lane.seats ?? []) {
      if (seat.latest === undefined) continue;
      if (seat.latest.text !== beforeSeatText.get(seat.seat)) {
        lines.push(`${prefix}${lane.id}  ${seat.seat} (${seat.provider}): ${seat.latest.text}`);
      }
    }
  }
  return lines;
}

/**
 * The line a `lensDraft` frame prints (D6, tasks.md 3.2): `<lens>  wrote <n> element(s)`
 * for a write that touched elements. A `state`/`closed` frame carries no write and prints
 * nothing; an `opened` frame that opened an empty board likewise prints nothing.
 */
export function lensDraftLines(event: LensDraftEvent, elapsedMs: number): string[] {
  const prefix = formatElapsed(elapsedMs);
  const count =
    event.update.kind === "opened"
      ? event.update.elements.length
      : event.update.kind === "elements"
        ? event.update.changed.length
        : 0;
  if (count <= 0) return [];
  return [`${prefix}${event.lens}  wrote ${count} element${count === 1 ? "" : "s"}`];
}

/** `<dataDir>/reviews/<reviewId>.json`, a review's document beside every other keyed artifact.
 *  `dataDir` is resolved to an absolute path so an automated caller always finds the document at a
 *  stable location: a relative `--data-dir` (or a relative `RENNET_USER_DATA`) would otherwise make
 *  the default document path relative to the daemon's cwd. An already-absolute dataDir resolves to
 *  itself, so the daemon's own default path is unchanged. */
export function reviewDocumentPath(dataDir: string, reviewId: string): string {
  return resolve(dataDir, "reviews", `${reviewId}.json`);
}

/** One lens's board.read answer, reduced to the keys it actually carries: never `board: null`. */
type BoardReadOutput = CommandOutput<"board.read">;
type BoardEntry = {
  board?: BoardReadOutput["board"];
  absence?: BoardReadOutput["absence"];
  failure?: BoardReadOutput["failure"];
  failureAccount?: BoardReadOutput["failureAccount"];
};

function boardEntry(read: BoardReadOutput): BoardEntry {
  const entry: BoardEntry = {};
  if (read.board !== null) entry.board = read.board;
  if (read.absence !== undefined) entry.absence = read.absence;
  if (read.failure !== undefined) entry.failure = read.failure;
  if (read.failureAccount !== undefined) entry.failureAccount = read.failureAccount;
  return entry;
}

/** How a review's preparation finally stood when the CLI stopped watching it. */
export type ReviewOutcome = "settled" | "failed" | "cancelled" | "timeout";

/**
 * One lens's settled state in the document, DERIVED from its `board.read` answer rather than
 * from the ephemeral live preparation record. That is deliberate: the preparation lanes carry
 * live seat lines that vanish the moment a review settles, so a run that reattaches to an
 * already-settled review has no live record to read. Deriving from the persisted boards makes
 * the document the same whether this run drafted the review or reattached to it (D8), and it
 * never fabricates a verdict the durable state does not hold.
 */
export interface ReviewDocumentLane {
  readonly id: string;
  readonly status: "done" | "absent" | "failed" | "pending";
  readonly reason?: string;
}

function laneFromBoard(lens: LensKind, read: BoardReadOutput): ReviewDocumentLane {
  if (read.failure !== undefined) return { id: lens, status: "failed", reason: read.failure };
  if (read.absence !== undefined) return { id: lens, status: "absent", reason: read.absence };
  if (read.board !== null) return { id: lens, status: "done" };
  // Neither a board, an absence nor a failure: a lens the failed/timed-out generation never
  // settled. Honestly pending, never a false "done".
  return { id: lens, status: "pending" };
}

/** The JSON document `rennet review` writes and prints the path of (D7). */
export interface ReviewDocument {
  readonly schemaVersion: 1;
  readonly reviewId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly range: {
    readonly base: string;
    readonly head: string;
    readonly baseOid: string;
    readonly headOid: string;
    readonly source: string;
  };
  readonly generation: string;
  readonly startedAt: string;
  readonly settledAt: string;
  readonly outcome: ReviewOutcome;
  readonly reason?: string;
  readonly lanes: readonly ReviewDocumentLane[];
  readonly boards: Record<string, BoardEntry>;
  readonly review: Review;
}

/**
 * The document written when a review fails BEFORE a review id exists (a capture-stage failure:
 * repository resolution or change capture), so there is no review to load, no boards and no
 * lanes (c). It is discriminated from a `ReviewDocument` by `capture: "failed"`, and carries the
 * stable top-level fields an automated caller reads regardless of the document kind: `outcome`
 * and `reason`. Its purpose is that a caller ALWAYS finds a JSON file to parse rather than
 * nothing when a capture fails.
 */
export interface CaptureFailureDocument {
  readonly schemaVersion: 1;
  readonly capture: "failed";
  readonly sessionId: string;
  readonly projectId: string;
  readonly outcome: Exclude<ReviewOutcome, "settled">;
  readonly reason: string;
  readonly startedAt: string;
  readonly settledAt: string;
}

export interface CaptureFailureInput {
  readonly sessionId: string;
  readonly projectId: string;
  readonly outcome: Exclude<ReviewOutcome, "settled">;
  readonly reason: string;
  readonly startedAtMs: number;
  readonly settledAtMs: number;
}

/** Assemble the capture-stage failure document (c). No review is loaded because none exists yet. */
export function buildCaptureFailureDocument(input: CaptureFailureInput): CaptureFailureDocument {
  return {
    schemaVersion: 1,
    capture: "failed",
    sessionId: input.sessionId,
    projectId: input.projectId,
    outcome: input.outcome,
    reason: input.reason,
    startedAt: new Date(input.startedAtMs).toISOString(),
    settledAt: new Date(input.settledAtMs).toISOString(),
  };
}

export interface ReviewDocumentInput {
  readonly review: Review;
  readonly sessionId: string;
  readonly projectId: string;
  /** The head ref the CLI resolved, used when the captured patchset carries no branch name. */
  readonly requestedHead: string;
  readonly rounds: CommandOutput<"session.rounds">["records"];
  readonly boards: Record<LensKind, BoardReadOutput>;
  readonly outcome: ReviewOutcome;
  readonly reason?: string;
  readonly startedAtMs: number;
  readonly settledAtMs: number;
}

/**
 * Assemble the review document from the reads the driver ran: `review.load`, `session.rounds`
 * (for the current generation), and one `board.read` per lens, plus the timings. The range is
 * read off the active patchset's provenance; each lens's lane and its `boards` entry come from
 * its `board.read` answer, so an absent or failed lens lands as its typed absence or failure,
 * never as a fabricated empty board (D7).
 */
export function buildReviewDocument(input: ReviewDocumentInput): ReviewDocument {
  const { review } = input;
  const activePatchset =
    review.patchsets.find((patchset) => patchset.id === review.activePatchsetId) ??
    review.patchsets[review.patchsets.length - 1];
  const provenance = activePatchset?.repository;
  const generation = currentGenerationId(input.rounds, review.activePatchsetId);
  const boards: Record<string, BoardEntry> = {};
  const lanes: ReviewDocumentLane[] = [];
  for (const lens of LENS_KINDS) {
    boards[lens] = boardEntry(input.boards[lens]);
    lanes.push(laneFromBoard(lens, input.boards[lens]));
  }
  return {
    schemaVersion: 1,
    reviewId: review.id,
    sessionId: input.sessionId,
    projectId: input.projectId,
    repositoryRoot: review.repositoryRoot,
    range: {
      base: provenance?.baseRef ?? "",
      head: provenance?.headRef ?? input.requestedHead,
      baseOid: provenance?.baseOid ?? "",
      headOid: provenance?.headOid ?? "",
      source: activePatchset?.source ?? "local",
    },
    generation,
    startedAt: new Date(input.startedAtMs).toISOString(),
    settledAt: new Date(input.settledAtMs).toISOString(),
    outcome: input.outcome,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    lanes,
    boards,
    review,
  };
}
