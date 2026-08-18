import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  exposed: null as unknown,
  listeners: new Map<string, Array<(event: unknown, payload: unknown) => void>>(),
  removed: [] as Array<{ channel: string; handler: unknown }>,
  sent: [] as Array<{ channel: string; payload?: unknown }>,
  invokeResults: new Map<string, unknown>(),
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
    invoke: (channel: string) => Promise.resolve(harness.invokeResults.get(channel) ?? null),
  },
}));

import type { RennetPreload } from "./index";

const UPDATE_READY_CHANNEL = "rennet:update-ready";
const UPDATE_APPLY_CHANNEL = "rennet:update-apply";

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
  vi.resetModules();
  await import("./index");
});

describe("preload update surface", () => {
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
});
