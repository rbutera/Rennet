// Push registration + tap routing (issue #383 M1, task 6.1/6.2). Asks for notification
// permission at the right moment (after pairing, not on cold launch), gets this install's
// Expo push token, and registers it with every paired daemon via `device.registerPush`. On a
// tapped push it resolves the daemon-relative deep-link back to a daemon and an href. All the
// Expo/RN calls live here (typecheck-only from tests); the routing itself is the pure table in
// lib/deep-links, unit-tested there.

import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { type AttentionPushData, resolvePushHref } from "../lib/deep-links";
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

/** Register (or re-register) this device's push token with every paired daemon. */
export async function registerPushWithAllDaemons(
  registry: DaemonRegistry,
  token: string,
): Promise<void> {
  const platform = platformTag();
  for (const connection of registry.list()) {
    try {
      await connection.supervisor.invoke("device.registerPush", { pushToken: token, platform });
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
