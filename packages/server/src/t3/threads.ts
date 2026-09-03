// Thread bindings (t3code-sidecar-chat 3.2; seat bindings from t3-lens-threads 1.1).
//
// Two kinds share one durable file, and BOTH are keyed on the REPOSITORY ROOT first,
// never on `Project.id` or `openPath`: a workspace maps many repos to one project, and
// two repos on the same branch must resolve to two threads rooted in two checkouts.
//
//   session  (repositoryRoot, sessionId)             — the review's own conversation
//   seat     (repositoryRoot, generationId, seat)     — one board seat of one generation
//
// The T3 project a thread hangs off is the one whose `workspaceRoot` is that checkout,
// created on first use.
//
// Persisted as one JSON file under the sidecar's private base dir, so the binding
// survives a daemon restart and stays beside the state it points into.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { ModelSelection, T3Client } from "./client";
import { sidecarBaseDir } from "./sidecar";

/** One thread per seat per generation. Flagged runs two, one per provider. */
export const SEAT_KINDS = [
  "design",
  "sequence",
  "decisions",
  "flagged-claude",
  "flagged-codex",
  "noise",
  "round-report",
] as const;
export type SeatKind = (typeof SEAT_KINDS)[number];

/** How a seat names itself in a thread title. */
const SEAT_LABELS: Readonly<Record<SeatKind, string>> = {
  design: "Design",
  sequence: "Sequence",
  decisions: "Decisions",
  "flagged-claude": "Flagged (Claude)",
  "flagged-codex": "Flagged (Codex)",
  noise: "Noise",
  "round-report": "Round report",
};

/**
 * The identity a thread is bound to, beside its repository root. A binding is looked up
 * on a POSITIVE match of every field of one arm — never on the absence of a field, which
 * is what makes two repos in one workspace resolve to two threads rather than one.
 */
export type ThreadBindingKey =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "seat"; readonly generationId: string; readonly seat: SeatKind };

const bindingSchema = z.object({
  // Rows written before seat bindings existed carry no `kind`; they are session rows.
  kind: z.enum(["session", "seat"]).default("session"),
  repositoryRoot: z.string(),
  /**
   * Which session owns this thread. For a `session` row it is half the KEY (and holds the
   * review id, which is what `chat.t3Session` and the handoff bind on). For a `seat` row
   * it is provenance only — the key there is (root, generation, seat) — recorded so
   * archiving a session can find every thread it left behind. Absent on a seat row
   * written before this field existed; those are cleaned up when their repo is.
   */
  sessionId: z.string().optional(),
  generationId: z.string().optional(),
  seat: z.enum(SEAT_KINDS).optional(),
  projectId: z.string(),
  threadId: z.string(),
  createdAt: z.string(),
  /** Only on a `pendingDeletions` row: how many sweeps have tried and failed. */
  attempts: z.number().int().nonnegative().optional(),
});
export type ThreadBinding = z.infer<typeof bindingSchema>;

/**
 * Threads whose `thread.delete` failed, kept OUT of the live bindings.
 *
 * Two things have to be true at once and they pull apart: an archived session must not
 * keep a live binding (an un-archive would rebind to a thread nobody can reach), and a
 * transcript that still exists in the sidecar must not lose its only handle. So the row
 * moves here — invisible to `findBinding`, so the session still gets a fresh thread — and
 * the next sweep retries it. Capped by {@link PENDING_DELETION_MAX_ATTEMPTS} so a thread
 * the sidecar genuinely no longer has drains out instead of being retried forever.
 */
const fileSchema = z.object({
  bindings: z.array(bindingSchema),
  pendingDeletions: z.array(bindingSchema).default([]),
});

/** How many sweeps a failed deletion is retried before the row is dropped. */
export const PENDING_DELETION_MAX_ATTEMPTS = 5;

export function bindingsPath(dataDir: string): string {
  return join(sidecarBaseDir(dataDir), "thread-bindings.json");
}

function readFile(dataDir: string): z.infer<typeof fileSchema> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(bindingsPath(dataDir), "utf8")));
    return parsed.success ? parsed.data : { bindings: [], pendingDeletions: [] };
  } catch {
    return { bindings: [], pendingDeletions: [] };
  }
}

export function readBindings(dataDir: string): ThreadBinding[] {
  return readFile(dataDir).bindings;
}

/** The threads a previous sweep could not delete. Never matched by {@link findBinding}. */
export function readPendingDeletions(dataDir: string): ThreadBinding[] {
  return readFile(dataDir).pendingDeletions;
}

function writeFile(dataDir: string, next: z.infer<typeof fileSchema>): void {
  const path = bindingsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next)}\n`);
  renameSync(tmp, path);
}

function writeBindings(dataDir: string, bindings: ThreadBinding[]): void {
  writeFile(dataDir, { ...readFile(dataDir), bindings });
}

/** Every field of the key, and the checkout, must match — a silent field never matches. */
function matches(row: ThreadBinding, repositoryRoot: string, key: ThreadBindingKey): boolean {
  if (row.repositoryRoot !== repositoryRoot || row.kind !== key.kind) return false;
  return key.kind === "session"
    ? row.sessionId === key.sessionId
    : row.generationId === key.generationId && row.seat === key.seat;
}

/**
 * Every binding owned by any of these session or review ids, whatever its kind.
 *
 * Deliberately NOT scoped by repository root: a session's own thread is rooted at the
 * review's checkout while its seat threads are rooted at the drafting worktree, so a
 * root-scoped sweep would leave every seat thread behind. Session and review ids are
 * minted uuids, so matching on them alone cannot reach another session's rows.
 */
export function findBindingsForSessions(dataDir: string, ids: readonly string[]): ThreadBinding[] {
  const wanted = new Set(ids);
  return readBindings(dataDir).filter(
    (row) => row.sessionId !== undefined && wanted.has(row.sessionId),
  );
}

/** Drop every binding naming one of these threads. Idempotent. */
export function removeBindings(dataDir: string, threadIds: readonly string[]): void {
  const dropped = new Set(threadIds);
  const remaining = readBindings(dataDir).filter((row) => !dropped.has(row.threadId));
  writeBindings(dataDir, remaining);
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface SweepThreadsInput {
  readonly dataDir: string;
  /** Session/review ids whose threads are being retired. Empty ⇒ retry the pending only. */
  readonly ids: readonly string[];
  /** Delete one thread in the sidecar. A rejection defers the row instead of losing it. */
  readonly deleteThread: (threadId: string) => Promise<void>;
  readonly warn?: (message: string) => void;
}

/**
 * Delete every thread bound to these ids, plus whatever a previous sweep could not.
 *
 * The live binding is dropped whatever the sidecar says — a binding pointing at a thread
 * nobody can reach would rebind an un-archived session to a ghost. What is NOT dropped is
 * the handle: a failed delete moves to `pendingDeletions`, so the transcript that still
 * exists can be found and deleted on the next sweep (review finding 2). Returns how many
 * threads were actually deleted. Never throws.
 */
export async function sweepThreads(input: SweepThreadsInput): Promise<number> {
  const warn = input.warn ?? console.warn;
  const pending = readPendingDeletions(input.dataDir);
  const pendingIds = new Set(pending.map((row) => row.threadId));
  const bindings = input.ids.length === 0 ? [] : findBindingsForSessions(input.dataDir, input.ids);
  const targets = [...pending, ...bindings.filter((row) => !pendingIds.has(row.threadId))];
  if (targets.length === 0) return 0;

  let deleted = 0;
  const deferred: ThreadBinding[] = [];
  for (const row of targets) {
    try {
      await input.deleteThread(row.threadId);
      deleted += 1;
    } catch (error) {
      const attempts = (row.attempts ?? 0) + 1;
      warn(
        `rennet: T3 thread ${row.threadId} was not deleted (attempt ${attempts}): ${describeError(error)}`,
      );
      if (attempts < PENDING_DELETION_MAX_ATTEMPTS) deferred.push({ ...row, attempts });
      else warn(`rennet: giving up on T3 thread ${row.threadId} after ${attempts} attempts`);
    }
  }

  const swept = new Set(targets.map((row) => row.threadId));
  const file = readFile(input.dataDir);
  writeFile(input.dataDir, {
    bindings: file.bindings.filter((row) => !swept.has(row.threadId)),
    pendingDeletions: deferred,
  });
  return deleted;
}

export function findBinding(
  dataDir: string,
  repositoryRoot: string,
  key: ThreadBindingKey,
): ThreadBinding | undefined {
  return readBindings(dataDir).find((row) => matches(row, repositoryRoot, key));
}

/** The thread title a seat gets: the branch it is reading, then the lens. */
export function seatThreadTitle(branch: string, seat: SeatKind): string {
  const named = branch.trim() === "" ? "review" : branch.trim();
  return `${named} — ${SEAT_LABELS[seat]}`;
}

export interface BindThreadInput {
  readonly dataDir: string;
  readonly client: T3Client;
  /** The checkout the binding names; the thread's cwd. */
  readonly repositoryRoot: string;
  readonly key: ThreadBindingKey;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  /** The owning session, recorded on a seat row so archiving can find it. */
  readonly sessionId?: string;
}

/** One creation per (data dir, repository root, key) in flight at a time. */
const bindingsInFlight = new Map<string, Promise<ThreadBinding>>();

function flightKey(input: BindThreadInput): string {
  const key = input.key;
  return JSON.stringify([
    input.dataDir,
    input.repositoryRoot,
    key.kind,
    key.kind === "session" ? key.sessionId : [key.generationId, key.seat],
  ]);
}

/**
 * The thread bound to this key on this repository, created on first use with the
 * checkout as its working directory in full-access mode. Idempotent per key, and
 * single-flighted: the seats ask together, and a check-then-create per caller made two
 * threads for one key with one binding surviving, so identical concurrent asks share
 * the one creation.
 */
export function bindThread(input: BindThreadInput): Promise<ThreadBinding> {
  const key = flightKey(input);
  const inFlight = bindingsInFlight.get(key);
  if (inFlight) return inFlight;
  const binding = findOrCreateBinding(input).finally(() => bindingsInFlight.delete(key));
  bindingsInFlight.set(key, binding);
  return binding;
}

async function findOrCreateBinding(input: BindThreadInput): Promise<ThreadBinding> {
  const existing = findBinding(input.dataDir, input.repositoryRoot, input.key);
  if (existing) return existing;
  const projectId = await input.client.ensureProject(
    input.repositoryRoot,
    basename(input.repositoryRoot),
  );
  const threadId = await input.client.createThread({
    projectId,
    title: input.title,
    modelSelection: input.modelSelection,
  });
  const binding: ThreadBinding = {
    repositoryRoot: input.repositoryRoot,
    ...(input.key.kind === "session"
      ? { kind: "session" as const, sessionId: input.key.sessionId }
      : {
          kind: "seat" as const,
          generationId: input.key.generationId,
          seat: input.key.seat,
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        }),
    projectId,
    threadId,
    createdAt: new Date().toISOString(),
  };
  // Re-read before writing: another bind for a different key may have landed meanwhile.
  writeBindings(input.dataDir, [...readBindings(input.dataDir), binding]);
  return binding;
}

/**
 * The re-sweep a ROUND owes an archive it outlived (second-interval review finding 2).
 *
 * Archiving is the deletion boundary, and the archive path aborts and awaits the session's
 * PREPARATION before sweeping — but a round is driven by the durable coordinator, takes no
 * abort signal, and nothing tracks it. So a round drafting a returned generation keeps
 * going straight through an archive: its board seats bind fresh seat threads under the
 * session id AFTER the sweep has already passed, the archive answers "deleted N threads",
 * and five orphans appear behind it that nobody sweeps — which an un-archive then resolves
 * against, one thread per ghost.
 *
 * So the round runs the SAME sweep again on its way out, when the session it drafted for is
 * archived by then. Idempotent (the sweep deletes what it finds and drops those bindings,
 * nothing more), and for the ordinary live session it calls `forgetSession` not at all.
 */
export async function sweepIfArchived(
  session:
    | { readonly id: string; readonly reviewId?: string; readonly archivedAt?: number }
    | undefined,
  forgetSession: (ids: readonly string[]) => Promise<number>,
  /**
   * The session's context files, purged on the same terms as its threads
   * (session-context-files): a round that ran through an archive wrote them after
   * `session.archive` had already purged, so the round owes the same second pass.
   */
  purgeContext?: (sessionId: string) => void,
): Promise<void> {
  if (session?.archivedAt === undefined) return;
  purgeContext?.(session.id);
  // BOTH ids, exactly as `session.archive` sweeps: the seat threads are bound under the
  // session id, the session's own thread under the review id.
  await forgetSession([session.id, ...(session.reviewId === undefined ? [] : [session.reviewId])]);
}
