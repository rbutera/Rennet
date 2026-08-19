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
import type { AttentionPushData } from "../lib/deep-links";
import { useRuntime } from "./context";
import { answerAskFromShade, askActionsOf, hrefForPush, registerAskCategory } from "./push";

/** Read a notification response's `data` payload as the attention push shape. */
function dataOf(notification: Notifications.Notification | null): AttentionPushData | null {
  const data = notification?.request.content.data;
  return data && typeof data === "object" ? (data as AttentionPushData) : null;
}

/** The reviewId an ask deep-link names, for registering its category. */
function askReviewId(data: AttentionPushData): string | null {
  return /review\/([^/]+)\/ask/.exec(data.deepLink ?? "")?.[1] ?? null;
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
      const data = dataOf(response?.notification ?? null);
      if (!data || cancelled) return;
      const action = response?.actionIdentifier;
      // A chip action (not the default body tap) answers the ask from the shade.
      if (action && action !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
        void answerAskFromShade(registry, data, action).then((outcome) => {
          // Truthful failure: could not send / superseded / unknown chip ⇒ deep-link into the ask
          // so the user finishes it in-app, never a silent drop. A sent answer needs no navigation.
          if (outcome.status !== "sent") {
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
      const reviewId = askReviewId(data);
      const actions = askActionsOf(data);
      if (reviewId && actions.length > 0) void registerAskCategory(reviewId, actions);
    });

    return () => {
      cancelled = true;
      responseSub.remove();
      receiveSub.remove();
    };
  }, [router, registry]);
}
