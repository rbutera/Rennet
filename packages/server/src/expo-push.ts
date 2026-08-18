// Expo push egress (issue #383 M1, attention-notifications spec). An OUTBOUND daemon
// call to the Expo push service — consistent with Rennet's no-inbound-relay posture: the
// daemon reaches out to post a notification, nothing reaches in. Failure is NON-FATAL (the
// in-app event still flows; a push is best-effort), and a token the service reports dead
// (`DeviceNotRegistered`) is dropped so it is never posted to again.
//
// `fetch` is injected so the egress is testable to the API boundary without a network
// (spec: "test to the API boundary with a stub"); it defaults to the global `fetch`.

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/** One push to post: the target token plus the notification's substance and deep-link data. */
export interface ExpoPushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  /** The deep-link payload the app reads on tap (`{ deviceId, deepLink, family }`). */
  readonly data: Record<string, unknown>;
  readonly priority?: "default" | "normal" | "high";
}

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface ExpoPushSenderOptions {
  /** Injected transport (default: global `fetch`). */
  readonly fetch?: FetchLike;
  /** Called with each token the service reports dead, so the caller drops it from the store. */
  readonly onDeadToken?: (token: string) => void;
  /** Called (never thrown) when a post fails wholesale — logging only, delivery is best-effort. */
  readonly onError?: (error: unknown) => void;
}

interface ExpoTicket {
  status?: string;
  details?: { error?: string };
}

/**
 * Post a batch of pushes to the Expo service. Resolves to the number the service accepted.
 * Never throws: a network error or a non-2xx response is reported via `onError` and swallowed
 * (the in-app path is authoritative). Tickets that come back `DeviceNotRegistered` fire
 * `onDeadToken(token)` so the caller prunes the store.
 */
export async function sendExpoPushes(
  messages: readonly ExpoPushMessage[],
  options: ExpoPushSenderOptions = {},
): Promise<number> {
  if (messages.length === 0) return 0;
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await doFetch(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(
        messages.map((m) => ({
          to: m.to,
          title: m.title,
          body: m.body,
          data: m.data,
          priority: m.priority ?? "high",
        })),
      ),
    });
  } catch (error) {
    options.onError?.(error);
    return 0;
  }
  if (!response.ok) {
    options.onError?.(new Error(`Expo push service returned ${response.status}`));
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    options.onError?.(error);
    return 0;
  }
  const tickets = extractTickets(parsed);
  let accepted = 0;
  tickets.forEach((ticket, index) => {
    if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
      const dead = messages[index];
      if (dead) options.onDeadToken?.(dead.to);
      return;
    }
    if (ticket.status === "ok") accepted += 1;
  });
  return accepted;
}

/** The Expo response is `{ data: Ticket[] }`; tolerate a missing/odd body without throwing. */
function extractTickets(parsed: unknown): ExpoTicket[] {
  if (parsed && typeof parsed === "object" && "data" in parsed) {
    const data = (parsed as { data: unknown }).data;
    if (Array.isArray(data)) return data as ExpoTicket[];
  }
  return [];
}
