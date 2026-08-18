// The attention planner (issue #383 M1, attention-notifications spec). The daemon's
// closed six-event taxonomy and its presence-aware delivery decision. This module is
// PURE: it decides, per event and per connected client, who gets the live in-app event
// and whose device gets a push. The wiring that raises events from real sources and the
// Expo egress that posts the pushes live in the listener/egress modules; this is the
// law they route through, so it is unit-testable without a socket or a network.
//
// The taxonomy is CLOSED (spec: "nothing else pushes"): the six families below are the
// only attention events. Each carries its substance (the ask's question, the review's
// finding counts, the failure's truthful cause) and its daemon-relative deep-link path.

import type { AttentionItem } from "@rennet/protocol";
import type { PushRegistration } from "./push-token-store";

/** What `raiseAttention` is handed — an item without its derived id (the registry mints it). */
export type RaisedAttention = Omit<AttentionItem, "id">;

/**
 * The daemon's active-attention state (in-memory: attention is ephemeral and a restart
 * correctly drops it). Keyed by a DERIVED id `family:scope`, so re-raising the same family
 * on the same review REFRESHES rather than stacks (a review that finishes, then re-runs and
 * finishes again, shows one "review finished", not two), and clearing by review removes every
 * item on it. This is the single source of truth the needs-you badge and the clear broadcast read.
 */
export class AttentionRegistry {
  readonly #items = new Map<string, AttentionItem>();

  /** Raise (or refresh) an attention item; returns the stored item with its derived id. */
  raise(event: RaisedAttention): AttentionItem {
    const scope = event.reviewId ?? event.projectId ?? "-";
    const id = `${event.family}:${scope}`;
    const item: AttentionItem = { ...event, id };
    this.#items.set(id, item);
    return item;
  }

  /** Clear by review (every item on it) or by a single attention id; returns what was cleared. */
  clear(selector: { reviewId?: string; attentionId?: string }): AttentionItem[] {
    const cleared: AttentionItem[] = [];
    for (const [id, item] of this.#items) {
      const matches =
        (selector.attentionId !== undefined && id === selector.attentionId) ||
        (selector.reviewId !== undefined && item.reviewId === selector.reviewId);
      if (matches) {
        cleared.push(item);
        this.#items.delete(id);
      }
    }
    return cleared;
  }

  /** Every item still demanding attention (the needs-you set a fresh client hydrates). */
  active(): AttentionItem[] {
    return [...this.#items.values()];
  }
}

/**
 * The six event families — the closed taxonomy (spec). Sourced from the protocol's
 * `attentionItemSchema` so the wire enum and the planner never drift: nothing outside this
 * union raises attention. ask-pending: turn needs you; review-finished: pipeline outcome;
 * turn-failed: a turn failed/interrupted; handoff-completed; publish-ready; processing-finished.
 */
export type AttentionFamily = AttentionItem["family"];

/**
 * Delivery priority per family (ideation taxonomy). `high` families always reach every
 * client one way or the other. `silent` (processing finished) is an in-app update that
 * posts NO push — the phone learns it on next open, never buzzes for it. `normal` pushes
 * like `high` in M1 (there is no bandwidth filter yet to bypass); the field is carried on
 * the push so the client can rank, and reserves the high-priority bypass for the phase
 * that adds unfocused-event dropping.
 */
export type AttentionPriority = "high" | "normal" | "silent";

const FAMILY_PRIORITY: Record<AttentionFamily, AttentionPriority> = {
  "ask-pending": "high",
  "review-finished": "high",
  "turn-failed": "high",
  "handoff-completed": "normal",
  "publish-ready": "normal",
  "processing-finished": "silent",
};

/** The presence a shell reported (the `presence` frame), as the planner reads it. */
export interface PresenceState {
  readonly focused: boolean;
  readonly visible: boolean;
  readonly deviceClass: string;
  /** The review the shell is looking at right now — the focused-client push-suppression key. */
  readonly focusedReviewId?: string;
}

/** One connected socket the planner weighs: its device (if paired) and last-reported presence. */
export interface ConnectedClient {
  readonly connectionId: string;
  /** The authenticated device id for a projected connection; absent for loopback/pairing-only. */
  readonly deviceId?: string;
  /** The last presence this connection reported, or undefined if it never did (⇒ away). */
  readonly presence?: PresenceState;
}

/** The delivery decision for one event: which sockets get it live, which devices get pushed. */
export interface DeliveryPlan {
  /** Connection ids that receive the live in-app event (connected + focused on the affected review). */
  readonly live: readonly string[];
  /** Devices whose push token the daemon posts to (every registered device not covered live). */
  readonly push: readonly PushRegistration[];
  readonly priority: AttentionPriority;
}

/** The daemon-relative deep-link path for each family, given its ids. */
export function deepLinkFor(
  family: AttentionFamily,
  ids: { reviewId?: string; projectId?: string },
): string {
  switch (family) {
    case "ask-pending":
      return `rennet://review/${ids.reviewId ?? ""}/ask`;
    case "review-finished":
      return `rennet://review/${ids.reviewId ?? ""}/digest`;
    case "turn-failed":
      return `rennet://review/${ids.reviewId ?? ""}/error`;
    case "handoff-completed":
      return `rennet://review/${ids.reviewId ?? ""}/handoff`;
    case "publish-ready":
      return `rennet://review/${ids.reviewId ?? ""}/publish`;
    case "processing-finished":
      return `rennet://project/${ids.projectId ?? ""}`;
  }
}

/** Is this connection connected-and-focused on the event's review (⇒ live event, no push)? */
function isFocusedOn(client: ConnectedClient, reviewId: string | undefined): boolean {
  if (!reviewId) return false; // a project-scoped event has no review to be focused on
  const p = client.presence;
  // A backgrounded or hidden client is NOT focused even if it last reported this review.
  return !!p && p.focused && p.visible && p.focusedReviewId === reviewId;
}

/**
 * Decide delivery for one attention event. The base rule (spec): a client connected and
 * focused on the affected review gets the live event only; every other registered device
 * gets the push. A `silent` family posts no push (in-app only). A client that never reported
 * presence is treated as away — its device is push-eligible.
 */
export function planDelivery(
  event: Pick<AttentionItem, "family" | "reviewId">,
  clients: readonly ConnectedClient[],
  registrations: readonly PushRegistration[],
): DeliveryPlan {
  const priority = FAMILY_PRIORITY[event.family];
  const live: string[] = [];
  const liveCoveredDevices = new Set<string>();
  for (const client of clients) {
    if (isFocusedOn(client, event.reviewId)) {
      live.push(client.connectionId);
      if (client.deviceId) liveCoveredDevices.add(client.deviceId);
    }
  }
  // A silent family never buzzes a phone; the focused sockets still get the in-app event.
  const push =
    priority === "silent"
      ? []
      : registrations.filter((registration) => !liveCoveredDevices.has(registration.deviceId));
  return { live, push, priority };
}
