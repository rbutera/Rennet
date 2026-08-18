import { describe, expect, it, vi } from "vitest";
import { type ExpoPushMessage, sendExpoPushes } from "./expo-push";

const msg = (to: string): ExpoPushMessage => ({
  to,
  title: "Review finished",
  body: "acme is ready to read",
  data: { deepLink: "rennet://review/r1/digest" },
});

const okResponse = (tickets: unknown[]) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ data: tickets }),
});

describe("sendExpoPushes (attention-notifications: outbound, non-fatal, dead-token cleanup)", () => {
  it("posts the batch to the Expo endpoint and counts accepted tickets", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse([{ status: "ok" }, { status: "ok" }]));
    const accepted = await sendExpoPushes([msg("tok-1"), msg("tok-2")], { fetch });
    expect(accepted).toBe(2);
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string, { method: string; body: string }];
    expect(url).toContain("exp.host");
    expect(init.method).toBe("POST");
    // The body carries one message per token.
    expect(JSON.parse(init.body)).toHaveLength(2);
  });

  it("drops a token the service reports dead (DeviceNotRegistered)", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        okResponse([
          { status: "ok" },
          { status: "error", details: { error: "DeviceNotRegistered" } },
        ]),
      );
    const dead: string[] = [];
    const accepted = await sendExpoPushes([msg("live"), msg("dead")], {
      fetch,
      onDeadToken: (t) => dead.push(t),
    });
    expect(accepted).toBe(1);
    expect(dead).toEqual(["dead"]);
  });

  it("is non-fatal on a network error — reports via onError, returns 0", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const errors: unknown[] = [];
    const accepted = await sendExpoPushes([msg("tok-1")], {
      fetch,
      onError: (e) => errors.push(e),
    });
    expect(accepted).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it("is non-fatal on a non-2xx response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) });
    const errors: unknown[] = [];
    const accepted = await sendExpoPushes([msg("tok-1")], {
      fetch,
      onError: (e) => errors.push(e),
    });
    expect(accepted).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it("sends nothing for an empty batch", async () => {
    const fetch = vi.fn();
    expect(await sendExpoPushes([], { fetch })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
