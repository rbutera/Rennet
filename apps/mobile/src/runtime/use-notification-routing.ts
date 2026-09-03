// Notification-tap routing (issue #383 M1 finding 11). When the user taps a push, navigate to
// the surface its deep-link names — both COLD start (getLastNotificationResponseAsync) and WARM
// (addNotificationResponseReceivedListener).
//
// Shade ANSWERING is gone with the orchestrator chat (t3-lens-threads 4.2): there is no
// `review.ask` to answer into, so a push carries no answer chips and no notification category.
// The pure deep-link resolution is tested in lib/deep-links; this hook is the RN/expo glue.

import type * as Notifications from "expo-notifications";
import * as NotificationsRuntime from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { type AttentionPushData, parseAttentionPushData } from "../lib/deep-links";
import { useRuntime } from "./context";
import { hrefForPush } from "./push";

/** PARSE a notification response's untrusted `data` payload into the attention push shape (never a
 *  blind cast — #382 M2 findings 3 + 11). */
function dataOf(notification: Notifications.Notification | null): AttentionPushData | null {
  return parseAttentionPushData(notification?.request.content.data ?? null);
}

// Responses already handled this app lifetime: `getLastNotificationResponseAsync` returns the
// SAME cold-start response on every remount, so without deduping a remount would re-navigate.
// Keyed by the notification's request id, at module scope so it survives a component remount.
const handledResponses = new Set<string>();

/** Navigate on a tapped push (cold + warm). Mount once near the root. */
export function useNotificationRouting(): void {
  const router = useRouter();
  const { registry } = useRuntime();

  useEffect(() => {
    let cancelled = false;

    const handleResponse = (response: Notifications.NotificationResponse | null): void => {
      if (!response || cancelled) return;
      const key = response.notification.request.identifier;
      if (handledResponses.has(key)) return;
      handledResponses.add(key);
      const data = dataOf(response.notification);
      if (!data) return;
      const href = hrefForPush(data, registry);
      if (href && !cancelled) router.push(href);
    };

    // Cold start: the app was launched by tapping a push.
    void NotificationsRuntime.getLastNotificationResponseAsync().then(handleResponse);
    // Warm: a tap while the app is already running.
    const responseSub =
      NotificationsRuntime.addNotificationResponseReceivedListener(handleResponse);

    return () => {
      cancelled = true;
      responseSub.remove();
    };
  }, [router, registry]);
}
