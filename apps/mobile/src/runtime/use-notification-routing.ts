// Notification-tap routing + shade answering (issue #383 M1 finding 11; #382 M2 task 3.2). When
// the user taps a push, navigate to the surface its deep-link names — both COLD start
// (getLastNotificationResponseAsync) and WARM (addNotificationResponseReceivedListener). When the
// user picks an ANSWER CHIP on an ask push instead of tapping the body, the answer round-trips to
// the daemon as the same review.ask reply WITHOUT the app opening (background where the platform
// allows); on failure it is truthful — the app deep-links into the ask rather than dropping the
// answer. Ask categories are registered as their pushes arrive so the chips render as actions.
//
// The pure pieces (deep-link resolution, chip→reply composition, the shade outcome) are tested in
// lib/deep-links, lib/notification-actions, and answerAskFromShade; this hook is the RN/expo glue.

import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { type AttentionPushData, askReviewIdOf, parseAttentionPushData } from "../lib/deep-links";
import { useRuntime } from "./context";
import {
  answerAskFromShade,
  askActionsOf,
  hrefForPush,
  notifyShadeAnswerFailed,
  registerAskCategory,
} from "./push";

/** PARSE a notification response's untrusted `data` payload into the attention push shape (never a
 *  blind cast — #382 M2 findings 3 + 11). */
function dataOf(notification: Notifications.Notification | null): AttentionPushData | null {
  return parseAttentionPushData(notification?.request.content.data ?? null);
}

// Responses already handled this app lifetime (#382 M2 finding 4): `getLastNotificationResponseAsync`
// returns the SAME cold-start response on every remount, so without deduping, a remount would
// re-send a shade answer already sent. Keyed by the notification's request id + the action, at
// module scope so it survives a component remount within the process.
const handledResponses = new Set<string>();
function responseKey(response: Notifications.NotificationResponse): string {
  return `${response.notification.request.identifier}:${response.actionIdentifier}`;
}

/**
 * Navigate on a tapped push (cold + warm), answer an ask from a shade action, and register ask
 * categories as their pushes arrive. Mount once near the root.
 */
export function useNotificationRouting(): void {
  const router = useRouter();
  const { registry } = useRuntime();

  useEffect(() => {
    let cancelled = false;

    const handleResponse = (response: Notifications.NotificationResponse | null): void => {
      if (!response || cancelled) return;
      // Dedup a replayed cold-start response (#382 M2 finding 4): remounting re-reads the same last
      // response, which would re-send an answer already sent. Handle each response exactly once.
      const key = responseKey(response);
      if (handledResponses.has(key)) return;
      handledResponses.add(key);
      const data = dataOf(response.notification);
      if (!data) return;
      const action = response.actionIdentifier;
      // A chip action (not the default body tap) answers the ask from the shade.
      if (action && action !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
        void answerAskFromShade(registry, data, action).then((outcome) => {
          // Truthful failure: could not send / superseded / unknown chip ⇒ UPDATE the notification
          // to say the answer did not land, THEN deep-link into the ask so the user finishes it
          // in-app, never a silent drop. A sent answer needs no navigation.
          if (outcome.status !== "sent") {
            void notifyShadeAnswerFailed(data);
            const href = hrefForPush(data, registry);
            if (href && !cancelled) router.push(href);
          }
        });
        return;
      }
      // A body tap deep-links to the linked surface.
      const href = hrefForPush(data, registry);
      if (href && !cancelled) router.push(href);
    };

    // Cold start: the app was launched by tapping a push (or one of its actions).
    void Notifications.getLastNotificationResponseAsync().then(handleResponse);
    // Warm: a tap while the app is already running.
    const responseSub = Notifications.addNotificationResponseReceivedListener(handleResponse);
    // Register an ask push's chips as a notification category as it arrives, so the shade shows them.
    const receiveSub = Notifications.addNotificationReceivedListener((notification) => {
      const data = dataOf(notification);
      if (!data) return;
      const reviewId = askReviewIdOf(data.deepLink);
      const actions = askActionsOf(data);
      // On Android the chip action is honoured in the background/terminated by the module-scope
      // TaskManager task (#382 M2 finding 4), so register it background-capable (the app stays
      // closed). On iOS — no background action-tap task — the action opens the app pre-filled and
      // the deduped cold/warm handler sends the answer (still one tap). Either way, never dropped.
      if (reviewId && actions.length > 0)
        void registerAskCategory(reviewId, actions, Platform.OS === "android");
    });

    return () => {
      cancelled = true;
      responseSub.remove();
      receiveSub.remove();
    };
  }, [router, registry]);
}
