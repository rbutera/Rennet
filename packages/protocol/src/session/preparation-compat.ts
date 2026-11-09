// What a peer that negotiated an older protocol version is sent instead of the preparation
// states it cannot parse (review-preparation-reliability, protocol version 4).
//
// COMPAT(protocol v3): version 4 added the `awaiting` preparation state, the `workspace`
// preparation stage and the `tool-install-output` progress event. Each extends a CLOSED union a
// version-3 decoder rejects whole, so a v3 client that negotiated with a v4 daemon would drop
// every `session.list` answer that held one. The daemon therefore presents them to a v3
// connection in the v3 vocabulary: `awaiting` as `capturing`, the `workspace` stage as
// `capture`, and no install output at all (a v3 client never starts an install).
// Remove when MIN_COMPATIBLE_PROTOCOL_VERSION is at least 4.

import type { SessionPreparation } from "./model";

/** The protocol version that introduced `awaiting`, stage `workspace` and install output. */
export const PREPARATION_STATES_PROTOCOL_VERSION = 4;

/** `preparation` as a peer that negotiated `version` can parse it. */
export function preparationForProtocol(
  preparation: SessionPreparation,
  version: number,
): SessionPreparation {
  if (version >= PREPARATION_STATES_PROTOCOL_VERSION) return preparation;
  // Waiting on the reviewer's answer is, to a v3 client, preparation still under way: it
  // shows the capture presence and Cancel, which is the honest part of what it can show.
  if (preparation.status === "awaiting") return { status: "capturing", step: "capturing-change" };
  if (
    (preparation.status === "failed" || preparation.status === "cancelled") &&
    preparation.stage === "workspace"
  ) {
    return { ...preparation, stage: "capture" };
  }
  return preparation;
}

function sessionRowForProtocol(row: unknown, version: number): unknown {
  if (row === null || typeof row !== "object") return row;
  const preparation = (row as { preparation?: unknown }).preparation;
  if (preparation === undefined || preparation === null || typeof preparation !== "object") {
    return row;
  }
  return {
    ...(row as Record<string, unknown>),
    preparation: preparationForProtocol(preparation as SessionPreparation, version),
  };
}

/**
 * A command's output as a peer that negotiated `version` can parse it: every session row it
 * carries — under `session` (the single-session writes) or `sessions` (`session.list`) —
 * with its preparation in that version's vocabulary. Anything else passes through untouched.
 */
export function commandOutputForProtocol(output: unknown, version: number): unknown {
  if (version >= PREPARATION_STATES_PROTOCOL_VERSION) return output;
  if (output === null || typeof output !== "object" || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  let next: Record<string, unknown> | undefined;
  if (record.session !== undefined) {
    next = { ...record, session: sessionRowForProtocol(record.session, version) };
  }
  if (Array.isArray(record.sessions)) {
    next = {
      ...(next ?? record),
      sessions: record.sessions.map((row) => sessionRowForProtocol(row, version)),
    };
  }
  return next ?? output;
}

/** Whether a progress event of `kind` exists for a peer that negotiated `version`. */
export function progressEventForProtocol(kind: string, version: number): boolean {
  return kind !== "tool-install-output" || version >= PREPARATION_STATES_PROTOCOL_VERSION;
}
