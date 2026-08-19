// Deep-link routing (issue #383 M1, task 6.2). The daemon's attention pushes carry a
// daemon-relative `rennet://…` path (the planner's `deepLinkFor`); a tapped push also
// carries the `deviceId` that identifies WHICH paired daemon it came from (the app pairs
// one device per daemon). This module is the pure routing table: parse a `rennet://` path
// into a target, and turn a (daemonId, target) into the expo-router href the app navigates
// to. No React Native import, so it unit-tests directly (the routing-table test).
//
// Routes are scoped by daemon id (the Paseo shape: many daemons coexist in one nav tree).

import {
  type AttentionAction,
  attentionActionSchema,
  MAX_ATTENTION_ACTIONS,
} from "@rennet/protocol";
import { z } from "zod";

/** A parsed attention target — the surface the user should land on. */
export type LinkTarget =
  | { readonly kind: "review"; readonly reviewId: string; readonly surface: ReviewSurface }
  | { readonly kind: "project"; readonly projectId: string };

/** The review surfaces a deep-link can name (the taxonomy's landing surfaces). */
export type ReviewSurface = "digest" | "ask" | "error" | "handoff" | "publish";

const REVIEW_SURFACES: ReadonlySet<string> = new Set([
  "digest",
  "ask",
  "error",
  "handoff",
  "publish",
]);

/**
 * Parse a daemon-relative `rennet://…` deep-link into a target. Returns null for anything
 * unrecognised (a malformed or future path is ignored, never crashes the router).
 * Accepts `rennet://review/<id>/<surface>` and `rennet://project/<id>`.
 */
export function parseDeepLink(url: string): LinkTarget | null {
  const withoutScheme = url.startsWith("rennet://") ? url.slice("rennet://".length) : url;
  const [head, id, surface] = withoutScheme.split("/");
  if (head === "review" && id) {
    const resolved: ReviewSurface =
      surface && REVIEW_SURFACES.has(surface) ? (surface as ReviewSurface) : "digest";
    return { kind: "review", reviewId: id, surface: resolved };
  }
  if (head === "project" && id) {
    return { kind: "project", projectId: id };
  }
  return null;
}

/**
 * The expo-router href for a target under a specific daemon. `ask` lands on the live turn screen
 * (the ask is answered there, wireframe 22) and `publish` on the publish preview (wireframe 23) —
 * both M2 surfaces. `handoff` lands on the digest (its dedicated surface is secondary per the
 * ideation doc; the review is fully readable there — no dead link, no lie).
 */
export function routeHref(daemonId: string, target: LinkTarget): string {
  const base = `/daemon/${encodeURIComponent(daemonId)}`;
  if (target.kind === "project") {
    return `${base}/project/${encodeURIComponent(target.projectId)}`;
  }
  const review = `${base}/review/${encodeURIComponent(target.reviewId)}`;
  switch (target.surface) {
    case "error":
      return `${review}/error`;
    case "ask": // the live turn screen — reattach paint + live stream + the ask card
      return `${review}/turn`;
    case "publish": // the publish preview → one-tap post
      return `${review}/publish`;
    case "digest":
    case "handoff":
      return `${review}/digest`;
  }
}

/**
 * The review id an ASK deep-link names (`rennet://review/<id>/ask`), or undefined for any other
 * link (#382 M2). One source for the reviewId a shade answer targets — the live tap handler, the
 * background task, and the category-registration path all resolve it here, never their own regex.
 */
export function askReviewIdOf(deepLink: string | undefined): string | undefined {
  if (!deepLink) return undefined;
  const target = parseDeepLink(deepLink);
  return target?.kind === "review" && target.surface === "ask" ? target.reviewId : undefined;
}

/** A parsed pairing offer — the daemon URL, the one-time code, and a suggested name. */
export interface PairingOffer {
  readonly url: string;
  readonly code: string;
  readonly name: string;
}

/**
 * Parse a pairing link (the QR the desk mints, or a pasted link) into an offer. The link is
 * `rennet://pair?url=<ws-url>&code=<code>&name=<label>`. Returns null if it is not a pairing
 * link or is missing the url/code — the scanner then keeps scanning rather than pairing wrong.
 */
export function parsePairingLink(link: string): PairingOffer | null {
  const trimmed = link.trim();
  const match = /^rennet:\/\/pair\?(.*)$/.exec(trimmed);
  if (!match) return null;
  const params = new Map<string, string>();
  for (const pair of (match[1] ?? "").split("&")) {
    const [key, value] = pair.split("=");
    if (key) params.set(key, decodeURIComponent(value ?? ""));
  }
  const url = params.get("url");
  const code = params.get("code");
  if (!url || !code) return null;
  return { url, code, name: params.get("name") || "daemon" };
}

/** The push-notification data payload the daemon posts and the app reads on tap. Parsed (never
 *  blindly cast) via {@link parseAttentionPushData} — the payload is untrusted input (#382 M2
 *  findings 3 + 11), and a shade answer binds to `attentionId`. */
export interface AttentionPushData {
  /** Identifies which paired daemon the push is for (one device per daemon). */
  readonly deviceId?: string;
  readonly deepLink?: string;
  readonly family?: string;
  /** The ask's attention id (#382 M2 finding 3): a shade answer invokes `review.ask` with it so the
   *  daemon consumes exactly this ask (dedup + forgery guard). Present on ask-pending pushes. */
  readonly attentionId?: string;
  /** The ask's answer chips (ask-pending only). Bounded + refined by the protocol schema. */
  readonly actions?: readonly AttentionAction[];
}

/** Validate a push notification's untrusted `data` payload into an {@link AttentionPushData}, or
 *  null when it is not an object / fails validation (#382 M2 findings 3 + 11 — parse before use).
 *  Unknown keys are stripped; `actions` are validated per the protocol's bounded/unique-id schema. */
export function parseAttentionPushData(raw: unknown): AttentionPushData | null {
  const parsed = attentionPushDataSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const attentionPushDataSchema = z.object({
  deviceId: z.string().min(1).optional(),
  deepLink: z.string().min(1).optional(),
  family: z.string().min(1).optional(),
  attentionId: z.string().min(1).optional(),
  actions: z.array(attentionActionSchema).max(MAX_ATTENTION_ACTIONS).optional(),
});

/**
 * Resolve a tapped push into an href, given a lookup from the daemon's device id to the
 * app's local daemon id. Returns null when the daemon is unknown (unpaired/revoked) or the
 * link is unrecognised — the caller then falls back to the home list rather than a bad route.
 */
export function resolvePushHref(
  data: AttentionPushData,
  daemonIdForDevice: (deviceId: string) => string | undefined,
): string | null {
  if (!data.deviceId || !data.deepLink) return null;
  const daemonId = daemonIdForDevice(data.deviceId);
  if (!daemonId) return null;
  const target = parseDeepLink(data.deepLink);
  if (!target) return null;
  return routeHref(daemonId, target);
}
