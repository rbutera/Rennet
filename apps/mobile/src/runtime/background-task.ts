// Background shade answering (issue #382 M2 finding 4). A module-scope TaskManager task that
// answers an ask from a tapped notification action WHILE THE APP IS BACKGROUNDED OR TERMINATED —
// on Android only, the one platform where expo-notifications runs a task in response to an action
// tap (its `registerTaskAsync` doc: "Only on Android, the task also runs in response to a
// notification action tap when the app is backgrounded or terminated"). On iOS the app opens
// pre-filled and the foreground handler sends (the honest fallback, unchanged).
//
// The task runs headless: no React runtime, no live DaemonRegistry with open sockets. So it
// reconstructs the send from persisted state — the paired-daemon list (async storage) and the
// device token (keychain) — and opens ONE short-lived WsRennetBridge to invoke `review.ask`, the
// SAME reply bytes the in-app card sends (via `askReplyInvoke`), then closes it. Exactly-once is
// the daemon's: the reply binds the ask's attention id, so a duplicate is refused "already
// answered"; a failure schedules the truthful "answer didn't land" notification, never a silent drop.
//
// Defined + registered at module scope, imported from `index.ts` so expo-task-manager can load the
// JS bundle and find the task when the OS wakes the app in the background (the documented pattern).

import { WsRennetBridge } from "@rennet/client";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { type AttentionPushData, askReviewIdOf, parseAttentionPushData } from "../lib/deep-links";
import { newCommandId } from "../lib/ids";
import { askReplyInvoke, chipLabelForAction } from "../lib/notification-actions";
import { createDaemonListStore, createTokenStore } from "../stores/native";
import { notifyShadeAnswerFailed } from "./push";

/** The task name expo-notifications drives via `registerTaskAsync` (module-scope constant). */
export const BACKGROUND_NOTIFICATION_TASK = "rennet-background-notification-response";

/**
 * Send an ask answer from the headless task: resolve the delivering daemon from the persisted
 * pairing (by the push's device id), load its token, and invoke `review.ask` over one short-lived
 * bridge. Returns whether the answer was sent — false ⇒ the caller schedules the failed-answer
 * notification. Best-effort and self-contained: it opens and closes its own transport.
 */
async function sendAskAnswerHeadless(
  data: AttentionPushData,
  actionIdentifier: string,
): Promise<boolean> {
  const reviewId = askReviewIdOf(data.deepLink);
  if (!data.deviceId || !reviewId) return false;
  const chipLabel = chipLabelForAction(data.actions, actionIdentifier);
  if (!chipLabel) return false;

  const daemons = await createDaemonListStore().load();
  const daemon = daemons.find((d) => d.deviceId === data.deviceId);
  if (!daemon) return false;
  const deviceToken = await createTokenStore().get(daemon.id);
  if (!deviceToken) return false;

  const bridge = new WsRennetBridge({ url: daemon.url, deviceToken, autoReconnect: false });
  try {
    await bridge.invoke(
      "review.ask",
      askReplyInvoke({ reviewId, chipLabel, attentionId: data.attentionId, newId: newCommandId }),
    );
    return true;
  } catch {
    return false;
  } finally {
    bridge.close();
  }
}

// Define the task at module scope (required by expo-task-manager). The payload is a
// NotificationResponse when the user tapped an action (`actionIdentifier` present) — the only case
// we act on; a plain received-notification payload is left to the app's own receive handling.
TaskManager.defineTask<Notifications.NotificationTaskPayload>(
  BACKGROUND_NOTIFICATION_TASK,
  async ({ data, error }) => {
    if (error || !data || !("actionIdentifier" in data)) return;
    const response = data as Notifications.NotificationResponse;
    const action = response.actionIdentifier;
    // A body tap (default action) opens the app and routes there — nothing to send in the task.
    if (!action || action === Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const push = parseAttentionPushData(response.notification.request.content.data);
    if (!push) return;
    const sent = await sendAskAnswerHeadless(push, action);
    // Truthful failure (unreachable / superseded / unknown chip): tell the user it did not land so
    // they finish it in-app — never a silently dropped answer. A sent answer clears everywhere via
    // the daemon's attention broadcast.
    if (!sent) await notifyShadeAnswerFailed(push);
  },
);

/**
 * Register the background notification-response task. Android only: it is the sole platform where
 * the task runs on an action tap while the app is backgrounded/terminated; registering elsewhere
 * buys nothing and iOS keeps the open-app fallback. Best-effort — a failure leaves the fallback
 * intact. Call once, early (from `index.ts`).
 */
export async function registerBackgroundNotificationTask(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
  } catch {
    // Non-fatal: without the background task, the action opens the app and the foreground handler
    // sends the answer (still one tap) — the honest fallback, never a dropped answer.
  }
}
