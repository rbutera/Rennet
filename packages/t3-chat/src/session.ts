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
  readonly threadId?: string;
  readonly threadUrl?: string;
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

/** The memory-router path for the session's bound thread; home when none is bound yet. */
export function sidecarThreadPath(
  session: Pick<SidecarSession, "environmentId" | "threadId">,
): string {
  return session.threadId
    ? `/${encodeURIComponent(session.environmentId)}/${encodeURIComponent(session.threadId)}`
    : "/";
}
