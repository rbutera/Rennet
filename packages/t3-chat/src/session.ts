// The daemon-brokered sidecar session (`chat.t3Session`) as T3's own environment
// registration. Pure: the mount registers this through the vendored environment catalog
// and everything downstream (bearer HTTP, the websocket ticket, thread subscriptions) is
// T3's client runtime doing what it does for any remote environment.

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";

/** The review's thread as the daemon reports it (protocol `t3ThreadBindingSchema`). */
export type SidecarThread =
  | { readonly status: "bound"; readonly threadId: string; readonly threadUrl: string }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * The daemon's `chat.t3Session` output (protocol `t3SessionSchema`), restated
 * structurally so this package's typecheck (upstream's tsconfig, which the vendored
 * source needs) never traverses @rennet/protocol; ./public.d.ts binds the two names.
 */
export interface SidecarSession {
  readonly origin: string;
  readonly wsUrl: string;
  readonly accessToken: string;
  readonly environmentId: string;
  /** Absent ⇔ no review was named; otherwise one arm or the other, never silence. */
  readonly thread?: SidecarThread;
}

/** One stable connection id: re-registering after a token refresh replaces, never adds. */
export const SIDECAR_CONNECTION_ID = "rennet-sidecar";
export const SIDECAR_LABEL = "Rennet sidecar";

/** The websocket BASE (origin only): T3's resolver appends `/ws` and the ticket itself. */
export function sidecarWsBaseUrl(session: Pick<SidecarSession, "wsUrl">): string {
  const url = new URL(session.wsUrl);
  return `${url.protocol}//${url.host}`;
}

export function sidecarRegistration(
  session: Pick<SidecarSession, "origin" | "wsUrl" | "accessToken" | "environmentId">,
): BearerConnectionRegistration {
  const environmentId = EnvironmentId.make(session.environmentId);
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId,
      label: SIDECAR_LABEL,
      connectionId: SIDECAR_CONNECTION_ID,
    }),
    profile: new BearerConnectionProfile({
      connectionId: SIDECAR_CONNECTION_ID,
      environmentId,
      label: SIDECAR_LABEL,
      httpBaseUrl: session.origin,
      wsBaseUrl: sidecarWsBaseUrl(session),
    }),
    credential: new BearerConnectionCredential({ token: session.accessToken }),
  });
}

/** A thread anywhere on the sidecar environment, as a memory-router path. */
export function sidecarThreadPath(ref: {
  readonly environmentId: string;
  readonly threadId: string;
}): string {
  return `/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}`;
}

/**
 * The mount's route for a brokered session: its bound thread, or HOME.
 *
 * Home is now a SETTLED absence and nothing else (#872). Before, it was also where the
 * thread route bounced when the environment snapshot did not yet carry a thread the daemon
 * had just made, and the mount rested there — under copy promising the thread was coming —
 * for the life of the session. `resolvePinnedThreadView` is what removed that second
 * meaning, so this function's answer and the words on screen agree again.
 */
export function sidecarSessionPath(session: SidecarSession): string {
  return session.thread?.status === "bound"
    ? sidecarThreadPath({
        environmentId: session.environmentId,
        threadId: session.thread.threadId,
      })
    : "/";
}

/** What the mount's thread route shows for the ONE thread that mount is pinned to. */
export type PinnedThreadView = "chat" | "syncing" | "gone";

/**
 * WHY THIS EXISTS, AND WHY IT NEVER SAYS "GO HOME" (#872).
 *
 * Upstream's thread route redirects to the thread list when the environment snapshot does
 * not carry the thread the URL names — correct in T3 Code, where the reader navigated there
 * and the list is somewhere to land. Rennet's mounts navigate to exactly one thread, chosen
 * by the daemon that created it moments earlier, and have nowhere to go: the redirect fired
 * on the first frame whenever the snapshot predated the thread (which is every session
 * opened after the environment has already bootstrapped), and `FollowPath` re-asserts the
 * path only when the path CHANGES — so nothing ever came back. One frame of a race, then a
 * dead dock for the rest of the session, under "Opening this review's thread."
 *
 * So the route waits instead, and says which wait it is in:
 *
 *   • `chat`    — the thread is here (or its shell is, which is enough to render).
 *   • `syncing` — the snapshot has not delivered it yet. A real wait: the sidecar has the
 *                 thread and its arrival is the socket's next job.
 *   • `gone`    — the sidecar says DELETED. A positive contradiction, not silence, so this
 *                 is the one absence the mount is allowed to state.
 */
export function resolvePinnedThreadView(input: {
  /** The environment snapshot has arrived. Nothing can be concluded from absence before it. */
  readonly bootstrapComplete: boolean;
  readonly detailExists: boolean;
  readonly draftExists: boolean;
  readonly shellExists: boolean;
  readonly deleted: boolean;
}): PinnedThreadView {
  if (input.detailExists || input.draftExists) return "chat";
  if (!input.bootstrapComplete) return input.shellExists ? "chat" : "syncing";
  if (input.deleted) return "gone";
  return input.shellExists ? "chat" : "syncing";
}
