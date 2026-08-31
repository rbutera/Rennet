import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  exposed: null as unknown,
  listeners: new Map<string, Array<(event: unknown, payload: unknown) => void>>(),
  removed: [] as Array<{ channel: string; handler: unknown }>,
  sent: [] as Array<{ channel: string; payload?: unknown }>,
  invokeResults: new Map<string, unknown>(),
  invokeErrors: new Map<string, Error>(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, value: unknown) => {
      harness.exposed = value;
    },
  },
  ipcRenderer: {
    on: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
      const existing = harness.listeners.get(channel) ?? [];
      existing.push(handler);
      harness.listeners.set(channel, existing);
    },
    removeListener: (channel: string, handler: unknown) => {
      harness.removed.push({ channel, handler });
      const existing = harness.listeners.get(channel) ?? [];
      harness.listeners.set(
        channel,
        existing.filter((entry) => entry !== handler),
      );
    },
    send: (channel: string, payload?: unknown) => harness.sent.push({ channel, payload }),
    invoke: (channel: string) => {
      const error = harness.invokeErrors.get(channel);
      return error
        ? Promise.reject(error)
        : Promise.resolve(harness.invokeResults.get(channel) ?? null);
    },
  },
}));

import { RENNET_PRELOAD_KEYS } from "./contract";
import type { RennetPreload } from "./index";

const UPDATE_READY_CHANNEL = "rennet:update-ready";
const UPDATE_APPLY_CHANNEL = "rennet:update-apply";
const OPEN_FULL_DISK_ACCESS_CHANNEL = "rennet:open-full-disk-access";
const WS_PORT_CHANNEL = "rennet:ws-port";

function preload(): RennetPreload {
  return harness.exposed as RennetPreload;
}

function pushReady(payload: unknown): void {
  for (const handler of harness.listeners.get(UPDATE_READY_CHANNEL) ?? []) {
    handler({}, payload);
  }
}

beforeEach(async () => {
  harness.listeners.clear();
  harness.removed.length = 0;
  harness.sent.length = 0;
  harness.invokeResults.clear();
  harness.invokeErrors.clear();
  vi.resetModules();
  await import("./index");
});

describe("preload update surface", () => {
  it("exposes exactly the declared contract keys (#386 — no silent drift)", () => {
    expect(Object.keys(preload()).sort()).toEqual([...RENNET_PRELOAD_KEYS].sort());
  });

  it("delivers pushed readiness with a valid payload", () => {
    const seen: unknown[] = [];
    preload().onUpdateReady((info) => seen.push(info));
    pushReady({ version: "1.2.3" });
    expect(seen).toEqual([{ version: "1.2.3" }]);
  });

  it("rejects malformed payloads at the boundary", () => {
    const seen: unknown[] = [];
    preload().onUpdateReady((info) => seen.push(info));
    pushReady("not-an-object");
    pushReady({ version: 42 });
    pushReady(null);
    expect(seen).toEqual([]);
    pushReady({});
    expect(seen).toEqual([{}]);
  });

  it("replays cached MAIN-side readiness to a late subscriber", async () => {
    harness.invokeResults.set(UPDATE_READY_CHANNEL, { version: "2.0.0" });
    const seen: unknown[] = [];
    preload().onUpdateReady((info) => seen.push(info));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([{ version: "2.0.0" }]);
  });

  it("stays silent when MAIN has nothing cached", async () => {
    const seen: unknown[] = [];
    preload().onUpdateReady((info) => seen.push(info));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]);
  });

  it("swallows a replay invoke that MAIN has no handler for yet", async () => {
    // Packaged + signed macOS: MAIN registers the replay handler only once the codesign probe
    // resolves (seconds), so a renderer subscribing first RELIABLY gets "No handler registered".
    // Uncaught, that was an Unhandled Rejection in the renderer on every signed boot.
    harness.invokeErrors.set(UPDATE_READY_CHANNEL, new Error("No handler registered"));
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const seen: unknown[] = [];
      preload().onUpdateReady((info) => seen.push(info));
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
      // …and the subscription survives the failed replay: a later push still lands.
      pushReady({ version: "4.0.0" });
      expect(seen).toEqual([{ version: "4.0.0" }]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("unsubscribe removes the push listener", () => {
    const seen: unknown[] = [];
    const unsubscribe = preload().onUpdateReady((info) => seen.push(info));
    unsubscribe();
    pushReady({ version: "3.0.0" });
    expect(seen).toEqual([]);
    expect(harness.removed.some((entry) => entry.channel === UPDATE_READY_CHANNEL)).toBe(true);
  });

  it("applyUpdate sends the one-way apply channel", () => {
    preload().applyUpdate();
    expect(harness.sent).toEqual([{ channel: UPDATE_APPLY_CHANNEL, payload: undefined }]);
  });

  it("forwards the Full Disk Access settings action through its narrow channel", async () => {
    harness.invokeResults.set(OPEN_FULL_DISK_ACCESS_CHANNEL, true);
    await expect(preload().openFullDiskAccessSettings()).resolves.toBe(true);
  });
});

describe("preload daemon port (perf audit §2/§6 H1 — delivered late, not via argv)", () => {
  it("asks MAIN for the ensured port", async () => {
    harness.invokeResults.set(WS_PORT_CHANNEL, 51_234);
    await expect(preload().wsPort()).resolves.toBe(51_234);
  });

  it("propagates a daemon that never came up, rather than reporting a port", async () => {
    // MAIN owns the failure surface (dialog naming daemon.log, then quit). The renderer's job
    // is only to not paint a connected app over a daemon that is not there.
    harness.invokeErrors.set(WS_PORT_CHANNEL, new Error("daemon failed to start"));
    await expect(preload().wsPort()).rejects.toThrow("daemon failed to start");
  });

  it("ignores a `--rennet-ws-port=` argv flag — the port does not exist at window creation", async () => {
    // The OLD contract: MAIN injected the port as a boot-time argv constant, which is only
    // possible while boot waits for daemon health. A flag left on the argv must not win.
    process.argv.push("--rennet-ws-port=40000");
    try {
      vi.resetModules();
      await import("./index");
      harness.invokeResults.set(WS_PORT_CHANNEL, 51_234);
      await expect(preload().wsPort()).resolves.toBe(51_234);
    } finally {
      process.argv.pop();
    }
  });
});
