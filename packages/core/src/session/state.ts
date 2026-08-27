import {
  type Claim,
  type SessionModel,
  SessionModelSchema,
  type SessionThread,
  SessionThreadSchema,
} from "@rennet/protocol";

/**
 * `core/session/state.ts` — the durable-session state machine (#466 res. 1–2,
 * B09 cluster 1). Pure transitions over the B03-frozen `SessionModelSchema`:
 * the shapes are consumed unchanged, never re-modeled. No I/O, no model, no
 * Node — the file-backed `SessionStore` (adapters) persists what these return.
 *
 * The session is the first-class durable root: one chat owns the harness
 * cursor, the threads, and the claim. A review attaches 1:0..1 by reference;
 * a no-target session upgrades in place when a target binds; the claim locks
 * on bind (a new target then requires a NEW session); archive is the only
 * release (v1 soft delete via `archivedAt`).
 */

/** Non-deterministic inputs a mint needs, injected so the layer stays pure. */
export interface MintSessionDeps {
  /** The session id source. Defaults to `crypto.randomUUID()`. */
  id?: () => string;
  /** The creation clock (epoch ms). Defaults to `Date.now()`. */
  now?: () => number;
}

/**
 * Mint a fresh session for a project with NO claim (#466 res. 2). A no-target
 * session carries no claim and no review; it upgrades in place when a target
 * binds (`bindTarget`) or a review attaches (`attachReview`).
 */
export function mintSession(projectId: string, deps: MintSessionDeps = {}): SessionModel {
  const id = (deps.id ?? (() => crypto.randomUUID()))();
  const now = (deps.now ?? (() => Date.now()))();
  return SessionModelSchema.parse({ id, projectId, threads: [], createdAt: now });
}

/**
 * Bind a target (branch + PR as ONE claimed thing, `ClaimSchema`) to a session.
 * A no-target session upgrades IN PLACE — same id, claim set. A session that
 * already holds a claim is LOCKED: rebinding is refused, because once a target
 * is claimed and its boards can be minted, a new target is a new session
 * (#466 res. 11). Archive is the only release; this never clears a claim.
 */
export function bindTarget(session: SessionModel, claim: Claim): SessionModel {
  if (session.claim !== undefined) {
    throw new Error(
      `session ${session.id} already claims ${session.claim.branch}; a new target requires a new session`,
    );
  }
  return { ...session, claim };
}

/**
 * Attach a review to a session by reference (1:0..1, `reviewId` — referenced,
 * not absorbed; #466 res. 1). Idempotent for the same review; a session already
 * attached to a DIFFERENT review is refused (at most one review per session).
 */
export function attachReview(session: SessionModel, reviewId: string): SessionModel {
  if (session.reviewId !== undefined && session.reviewId !== reviewId) {
    throw new Error(
      `session ${session.id} already holds review ${session.reviewId}; a session attaches at most one review`,
    );
  }
  return { ...session, reviewId };
}

/**
 * Append an anchored/plain thread reference to a session (#466 res. 7). Thread
 * CONTENT lives only in the transcript; the session holds the anchor→thread
 * reference (plus the ask riding on the anchored arm). Parsed through the frozen
 * `SessionThreadSchema` union, so `{threadId, ask}` without an anchor is refused
 * here, not silently stored.
 */
export function addThread(session: SessionModel, thread: SessionThread): SessionModel {
  const parsed = SessionThreadSchema.parse(thread);
  return { ...session, threads: [...session.threads, parsed] };
}

/**
 * Archive a session — the ONLY release (#466 res. 2, v1 soft delete). Stamps
 * `archivedAt`; the record survives so it can be read back archived. Idempotent:
 * an already-archived session keeps its original `archivedAt`.
 */
export function archive(session: SessionModel, now: () => number = () => Date.now()): SessionModel {
  if (session.archivedAt !== undefined) return session;
  return { ...session, archivedAt: now() };
}
