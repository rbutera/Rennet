import type { AttentionEventFrame, ProjectProcessEvent } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { frontDoorBridge } from "./fixtures/front-door";
import { MemoryBridge } from "./memory-bridge";

describe("MemoryBridge", () => {
  it("round-trips a handled command through its typed handler", async () => {
    const bridge = new MemoryBridge({
      "projects.list": () => ({ projects: [] }),
    });
    await expect(bridge.invoke("projects.list", {})).resolves.toEqual({ projects: [] });
  });

  it("rejects an un-handled command loudly, naming the command", async () => {
    const bridge = new MemoryBridge();
    await expect(bridge.invoke("projects.list", {})).rejects.toThrow(/projects\.list/);
  });

  it("surfaces a synchronous handler throw as a rejection, not an escaped exception", async () => {
    const bridge = new MemoryBridge({
      "projects.list": () => {
        throw new Error("boom");
      },
    });
    await expect(bridge.invoke("projects.list", {})).rejects.toThrow("boom");
  });

  it("exposes settable platform/version per instance", () => {
    const bridge = new MemoryBridge({}, { platform: "darwin", version: "9.9.9" });
    expect(bridge.platform).toBe("darwin");
    expect(bridge.version).toBe("9.9.9");
  });

  describe("push channels", () => {
    const progressEvent: ProjectProcessEvent = {
      kind: "repo-start",
      repo: "atlas",
      index: 1,
      total: 1,
    };

    it("emits a keyed event to that key's subscriber only", () => {
      const bridge = new MemoryBridge();
      const heard = vi.fn();
      const other = vi.fn();
      bridge.onProgress("cmd-1", heard);
      bridge.onProgress("cmd-2", other);
      bridge.emitProgress("cmd-1", progressEvent);
      expect(heard).toHaveBeenCalledWith(progressEvent);
      expect(other).not.toHaveBeenCalled();
    });

    it("stops delivering after unsubscribe", () => {
      const bridge = new MemoryBridge();
      const heard = vi.fn();
      const unsubscribe = bridge.onProgress("cmd-1", heard);
      unsubscribe();
      bridge.emitProgress("cmd-1", progressEvent);
      expect(heard).not.toHaveBeenCalled();
    });

    it("fans an attention frame out to every subscriber (daemon-wide)", () => {
      const bridge = new MemoryBridge();
      const a = vi.fn();
      const b = vi.fn();
      bridge.onAttention(a);
      const off = bridge.onAttention(b);
      const frame: AttentionEventFrame = {
        type: "attentionEvent",
        event: "cleared",
        clearedIds: ["x"],
      };
      bridge.emitAttention(frame);
      expect(a).toHaveBeenCalledWith(frame);
      expect(b).toHaveBeenCalledWith(frame);
      off();
      bridge.emitAttention(frame);
      expect(a).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("delivers update-ready info to subscribers", () => {
      const bridge = new MemoryBridge();
      const heard = vi.fn();
      bridge.onUpdateReady(heard);
      bridge.emitUpdateReady({ version: "9.9.9" });
      expect(heard).toHaveBeenCalledWith({ version: "9.9.9" });
    });
  });

  it("front-door fixture answers the boot reads", async () => {
    const bridge = frontDoorBridge();
    await expect(bridge.invoke("app.bootstrap", {})).resolves.toEqual({
      review: null,
      repositoryPresent: false,
    });
    await expect(bridge.invoke("projects.list", {})).resolves.toEqual({ projects: [] });
    await expect(bridge.invoke("harness.detect", {})).resolves.toEqual({ detected: [] });
  });
});
