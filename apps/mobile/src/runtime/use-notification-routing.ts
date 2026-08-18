// Notification-tap routing (issue #383 batch, finding 11). When the user taps a push, navigate to
// the surface its deep-link names — both COLD start (the app was launched by the tap:
// getLastNotificationResponseAsync) and WARM (already running: addNotificationResponseReceived-
// Listener). The daemon-relative link is resolved to a local href under the delivering daemon via
// the device→daemon index; an unresolvable link (unpaired/revoked daemon, or a future surface) is
// ignored rather than routed somewhere wrong. The pure resolution is `hrefForPush`, tested in
// lib/deep-links; this hook is the thin RN/expo-router glue.

import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import type { AttentionPushData } from "../lib/deep-links";
import { useRuntime } from "./context";
import { hrefForPush } from "./push";

/** Read a notification response's `data` payload as the attention push shape. */
function dataOf(response: Notifications.NotificationResponse | null): AttentionPushData | null {
  const data = response?.notification.request.content.data;
  return data && typeof data === "object" ? (data as AttentionPushData) : null;
}

/**
 * Navigate on a tapped push (cold + warm). Mount once near the root. Only a fully resolved href is
 * navigated — a link the app cannot place is left alone (the user stays where they are).
 */
export function useNotificationRouting(): void {
  const router = useRouter();
  const { registry } = useRuntime();

  useEffect(() => {
    let cancelled = false;
    const go = (response: Notifications.NotificationResponse | null): void => {
      const data = dataOf(response);
      if (!data) return;
      const href = hrefForPush(data, registry);
      if (href && !cancelled) router.push(href);
    };
    // Cold start: the app was launched by tapping a push.
    void Notifications.getLastNotificationResponseAsync().then(go);
    // Warm: a tap while the app is already running.
    const sub = Notifications.addNotificationResponseReceivedListener(go);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [router, registry]);
}
