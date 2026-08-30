import type { SidebarSession } from "@rennet/protocol";
import type { MemoryBridgeHandlers } from "../memory-bridge";

// ─────────────────────────────────────────────────────────────────────────────
// A stateful `session.*` store behind a MemoryBridge (C18). The sidebar's rows now
// arrive over `session.list` and every edit is a served write, so a test drives them
// the way the live client does: rename/pin/archive MUTATE this store, and the read
// invalidation makes the next `session.list` return the mutated rows. That is what
// makes "the edit survives a re-read" provable in a DOM test rather than asserted.
//
// Fixtures reach a surface only through the bridge (the import fence).
// ─────────────────────────────────────────────────────────────────────────────

/** A seed row — everything but `projectId`/`id` is optional, defaulted honestly. */
export interface SessionSeed {
  readonly id: string;
  readonly projectId: string;
  readonly title?: string;
  readonly target?: SidebarSession["target"];
  readonly targetState?: SidebarSession["targetState"];
  readonly unread?: boolean;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly reviewId?: string;
  readonly preparation?: SidebarSession["preparation"];
  readonly createdAt?: number;
}

const rowOf = (seed: SessionSeed): SidebarSession => ({
  id: seed.id,
  projectId: seed.projectId,
  title: seed.title ?? seed.id,
  target: seed.target ?? "your-branch",
  ...(seed.targetState ? { targetState: seed.targetState } : {}),
  ...(seed.unread ? { unread: true } : {}),
  ...(seed.pinned ? { pinned: true } : {}),
  ...(seed.archived ? { archived: true } : {}),
  ...(seed.reviewId === undefined ? {} : { reviewId: seed.reviewId }),
  ...(seed.preparation === undefined ? {} : { preparation: seed.preparation }),
  createdAt: seed.createdAt ?? Date.now(),
});

/**
 * The `session.*` handlers over an in-memory store seeded with `seeds`. Writes behave
 * like the host's: an emptied title falls back to the row's id-derived default (the host
 * falls back to the claimed branch), and `archived: false` restores.
 */
export function sessionHandlers(seeds: readonly SessionSeed[] = []): MemoryBridgeHandlers {
  const rows = new Map(seeds.map((seed) => [seed.id, rowOf(seed)]));
  const patch = (
    id: string,
    update: (row: SidebarSession) => SidebarSession,
  ): { session: SidebarSession | null } => {
    const row = rows.get(id);
    if (!row) return { session: null };
    const next = update(row);
    rows.set(id, next);
    return { session: next };
  };
  return {
    "session.list": () => ({ sessions: [...rows.values()] }),
    "session.rename": ({ sessionId, title }) =>
      patch(sessionId, (row) => ({ ...row, title: title.trim() || row.id })),
    "session.setPinned": ({ sessionId, pinned }) =>
      patch(sessionId, (row) => {
        const next = { ...row };
        if (pinned) next.pinned = true;
        else delete next.pinned;
        return next;
      }),
    "session.archive": ({ sessionId, archived }) =>
      patch(sessionId, (row) => {
        const next = { ...row };
        if (archived) next.archived = true;
        else delete next.archived;
        return next;
      }),
    "session.cancelPreparation": ({ sessionId }) =>
      patch(sessionId, (row) => {
        const preparation = row.preparation;
        if (preparation?.status !== "capturing" && preparation?.status !== "drafting") return row;
        return {
          ...row,
          preparation: {
            status: "cancelled",
            stage: preparation.status === "capturing" ? "capture" : "boards",
            ...(preparation.status === "drafting"
              ? { reviewId: preparation.reviewId, lanes: preparation.lanes }
              : {}),
          },
        };
      }),
    "session.retryPreparation": ({ sessionId }) =>
      patch(sessionId, (row) => {
        const lanes =
          row.preparation !== undefined && "lanes" in row.preparation
            ? (row.preparation.lanes ?? [])
            : [];
        return {
          ...row,
          preparation: row.reviewId
            ? { status: "drafting", reviewId: row.reviewId, lanes }
            : { status: "capturing", step: "resolving-repository" },
        };
      }),
  };
}
