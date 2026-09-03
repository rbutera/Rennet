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
});
export type ThreadBinding = z.infer<typeof bindingSchema>;

const fileSchema = z.object({ bindings: z.array(bindingSchema) });

export function bindingsPath(dataDir: string): string {
  return join(sidecarBaseDir(dataDir), "thread-bindings.json");
}

export function readBindings(dataDir: string): ThreadBinding[] {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(bindingsPath(dataDir), "utf8")));
    return parsed.success ? parsed.data.bindings : [];
  } catch {
    return [];
  }
}

function writeBindings(dataDir: string, bindings: ThreadBinding[]): void {
  const path = bindingsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ bindings })}\n`);
  renameSync(tmp, path);
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
