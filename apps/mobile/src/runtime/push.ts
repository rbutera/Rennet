// Push registration + tap routing (issue #383 M1, task 6.1/6.2). Asks for notification
// permission at the right moment (after pairing, not on cold launch), gets this install's
// Expo push token, and registers it with every paired daemon via `device.registerPush`. On a
// tapped push it resolves the daemon-relative deep-link back to a daemon and an href. All the
// Expo/RN calls live here (typecheck-only from tests); the routing itself is the pure table in
// lib/deep-links, unit-tested there.

import type { AttentionAction, AttentionFamily } from "@rennet/protocol";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { composeAskReply } from "../lib/ask-reply";
import { type AttentionPushData, resolvePushHref } from "../lib/deep-links";
import { newCommandId } from "../lib/ids";
import { askCategoryId, chipLabelForAction, shadeActionsFor } from "../lib/notification-actions";
import type { DaemonRegistry } from "./daemon-registry";

/** This device's platform tag for `device.registerPush`. */
export function platformTag(): "ios" | "android" {
  return Platform.OS === "android" ? "android" : "ios";
}

/** Ask for push permission (prompting only if not already decided). Returns whether granted. */
export async function ensurePushPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

/** This install's Expo push token, or null if permission is off or the service is unreachable. */
export async function getPushToken(projectId?: string): Promise<string | null> {
  try {
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return token.data;
  } catch {
    return null; // best-effort: no token ⇒ the in-app event path is still authoritative
  }
}

/**
 * Register (or re-register) this device's push token with every ATTENTION-CAPABLE paired daemon
 * (#383 batch). A daemon that does not advertise `attention` has no push pipeline, so registering
 * a token with it would be a lie — those are skipped. `disabledFamilies` carries the user's muted
 * families so the daemon suppresses their pushes. Non-fatal per daemon; a reconnect replays it.
 */
export async function registerPushWithAllDaemons(
  registry: DaemonRegistry,
  token: string,
  disabledFamilies: readonly AttentionFamily[] = [],
): Promise<void> {
  const platform = platformTag();
  for (const connection of registry.list()) {
    if (!connection.supervisor.attentionAdvertised()) continue;
    try {
      await connection.supervisor.invoke("device.registerPush", {
        pushToken: token,
        platform,
        disabledFamilies: [...disabledFamilies],
      });
    } catch {
      // Non-fatal: a daemon that is offline registers on its next reachable moment.
    }
  }
}

/** Clear this device's push token on every daemon (permission was turned off). */
export async function clearPushOnAllDaemons(registry: DaemonRegistry): Promise<void> {
  for (const connection of registry.list()) {
    try {
      await connection.supervisor.invoke("device.registerPush", {
        platform: platformTag(),
        remove: true,
      });
    } catch {
      // Non-fatal.
    }
  }
}

/** Resolve a tapped push's data payload into the in-app href to navigate to (or null). */
export function hrefForPush(data: AttentionPushData, registry: DaemonRegistry): string | null {
  return resolvePushHref(data, (deviceId) => registry.daemonIdForDevice(deviceId));
}

/** The ask push's answer chips, when present in its data payload (#382 M2). */
export function askActionsOf(data: AttentionPushData): AttentionAction[] {
  const actions = (data as { actions?: unknown }).actions;
  return Array.isArray(actions) ? (actions as AttentionAction[]) : [];
}

/**
 * Register an ask push's answer chips as an OS notification category so the lock-screen ask shows
 * its chips as actions (#382 M2, task 3.2). Best-effort; on a platform/permission that denies it,
 * the action falls back to opening the app pre-filled. Background=false ⇒ the action opens the app.
 */
export async function registerAskCategory(
  reviewId: string,
  actions: readonly AttentionAction[],
  background = true,
): Promise<void> {
  if (actions.length === 0) return;
  try {
    await Notifications.setNotificationCategoryAsync(
      askCategoryId(reviewId),
      shadeActionsFor(actions, background).map((a) => ({
        identifier: a.identifier,
        buttonTitle: a.buttonTitle,
        options: { opensAppToForeground: a.opensAppToForeground },
      })),
    );
  } catch {
    // Non-fatal: without the category the push still deep-links; the ask is answered in-app.
  }
}

/** The outcome of answering an ask from the shade — truthful, never a silent drop (#382 M2). */
export type ShadeAnswerOutcome =
  | { readonly status: "sent" }
  | { readonly status: "no-daemon" }
  | { readonly status: "no-chip" }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Answer an ask from a tapped notification action: resolve the chip, compose the SAME review.ask
 * reply the in-app card would, and send it to the delivering daemon. The daemon's superseded-turn
 * refusal is the dedup; a failure (unreachable / superseded) returns truthfully so the caller can
 * update the notification and deep-link — an answer is never silently dropped or duplicated.
 */
export async function answerAskFromShade(
  registry: DaemonRegistry,
  data: AttentionPushData,
  actionIdentifier: string,
): Promise<ShadeAnswerOutcome> {
  const deviceId = data.deviceId;
  const deepLink = data.deepLink ?? "";
  const reviewId = /review\/([^/]+)\/ask/.exec(deepLink)?.[1];
  if (!deviceId || !reviewId) return { status: "no-daemon" };
  const daemonId = registry.daemonIdForDevice(deviceId);
  const connection = daemonId ? registry.get(daemonId) : undefined;
  if (!connection) return { status: "no-daemon" };
  const chipLabel = chipLabelForAction(askActionsOf(data), actionIdentifier);
  if (!chipLabel) return { status: "no-chip" };
  const question = composeAskReply({ chipLabel });
  try {
    await connection.supervisor.invoke("review.ask", {
      commandId: newCommandId(),
      reviewId,
      question,
      mode: "orchestrator",
      threadId: reviewId,
      turnId: newCommandId(),
      anchor: { kind: "fragment", label: "steer", key: reviewId },
      turnBody: question,
    });
    return { status: "sent" };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "unreachable" };
  }
}
