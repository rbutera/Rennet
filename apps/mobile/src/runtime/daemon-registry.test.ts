import type { AttentionEventFrame } from "@rennet/protocol";
import type { ConnectionStatus, Presence } from "@rennet/client";
import { describe, expect, it, vi } from "vitest";
import { DaemonRegistry, type DaemonSupervisor, type PairedDaemon } from "./daemon-registry";

type FakeSupervisor = DaemonSupervisor & {
  presence: Partial<Presence>[];
  closed: boolean;
  emitAttention(frame: AttentionEventFrame): void;
};

function fakeSupervisor(): FakeSupervisor {
  const attentionListeners = new Set<(f: AttentionEventFrame) => void>();
  const state = { presence: [] as Partial<Presence>[], closed: false };
  return {
    ...state,
    replica: undefined,
    invoke: (async () => ({})) as DaemonSupervisor["invoke"],
    subscribe: (listener: (s: ConnectionStatus) => void) => {
      listener({ state: "online", since: 0 });
      return () => undefined;
    },
    setPresence(p: Partial<Presence>) {
      this.presence.push(p);
    },
    onAttention(listener: (f: AttentionEventFrame) => void) {
      attentionListeners.add(listener);
      return () => void attentionListeners.delete(listener);
    },
    saveReplica() {},
    attentionAdvertised: () => true,
    emitAttention(frame: AttentionEventFrame) {
      for (const l of attentionListeners) l(frame);
    },
    close() {
      this.closed = true;
    },
  };
}

const daemon = (over: Partial<PairedDaemon> & Pick<PairedDaemon, "id">): PairedDaemon => ({
  name: "home-mac",
  url: "ws://100.84.12.9:9999",
  deviceId: `dev-${over.id}`,
  ...over,
});

describe("DaemonRegistry (issue #383 M1)", () => {
  it("maps a daemon-minted device id back to its local daemon (push router lookup)", () => {
    const registry = new DaemonRegistry(() => fakeSupervisor());
    registry.add(daemon({ id: "d1", deviceId: "dev-9" }));
    expect(registry.daemonIdForDevice("dev-9")).toBe("d1");
    expect(registry.daemonIdForDevice("nope")).toBeUndefined();
  });

  it("closes the supervisor and drops the indexes on remove (revoke)", () => {
    const supervisors: ReturnType<typeof fakeSupervisor>[] = [];
    const registry = new DaemonRegistry(() => {
      const s = fakeSupervisor();
      supervisors.push(s);
      return s;
    });
    registry.add(daemon({ id: "d1", deviceId: "dev-9" }));
    registry.remove("d1");
    expect(supervisors[0]?.closed).toBe(true);
    expect(registry.get("d1")).toBeUndefined();
    expect(registry.daemonIdForDevice("dev-9")).toBeUndefined();
  });

  it("does not re-add an already-paired daemon", () => {
    let built = 0;
    const registry = new DaemonRegistry(() => {
      built += 1;
      return fakeSupervisor();
    });
    registry.add(daemon({ id: "d1" }));
    registry.add(daemon({ id: "d1" }));
    expect(built).toBe(1);
    expect(registry.list()).toHaveLength(1);
  });

  it("scopes the focused review to one daemon and clears it for the rest", () => {
    const supervisors: ReturnType<typeof fakeSupervisor>[] = [];
    const registry = new DaemonRegistry(() => {
      const s = fakeSupervisor();
      supervisors.push(s);
      return s;
    });
    registry.add(daemon({ id: "d1", deviceId: "a" }));
    registry.add(daemon({ id: "d2", deviceId: "b" }));
    registry.reportPresence({ focused: true, visible: true, focusedReviewId: "rev-1" }, "d1");
    expect(supervisors[0]?.presence.at(-1)).toMatchObject({ focusedReviewId: "rev-1" });
    expect(supervisors[1]?.presence.at(-1)).toMatchObject({ focusedReviewId: undefined });
  });

  it("notifies subscribers when a daemon is added", () => {
    const registry = new DaemonRegistry(() => fakeSupervisor());
    const changed = vi.fn();
    registry.subscribe(changed);
    registry.add(daemon({ id: "d1" }));
    expect(changed).toHaveBeenCalled();
  });

  it("tracks the live needs-you set from attention broadcasts (#383 batch)", () => {
    let sup: FakeSupervisor | undefined;
    const registry = new DaemonRegistry(() => {
      sup = fakeSupervisor();
      return sup;
    });
    registry.add(daemon({ id: "d1" }));
    expect(registry.needsYouReviewIds().has("rev-1")).toBe(false);

    // A high-priority attention (ask-pending) on rev-1 makes it needs-you.
    sup?.emitAttention({
      type: "attentionEvent",
      event: "raised",
      item: {
        id: "ask-pending:rev-1",
        family: "ask-pending",
        reviewId: "rev-1",
        deepLink: "rennet://review/rev-1/ask",
        title: "Ask pending",
        body: "",
      },
    });
    expect(registry.needsYouReviewIds().has("rev-1")).toBe(true);

    // A silent family (processing-finished) does NOT add needs-you.
    sup?.emitAttention({
      type: "attentionEvent",
      event: "raised",
      item: {
        id: "processing-finished:proj-1",
        family: "processing-finished",
        projectId: "proj-1",
        deepLink: "rennet://project/proj-1",
        title: "Processing finished",
        body: "",
      },
    });
    expect(registry.needsYouReviewIds().size).toBe(1);

    // Clearing the ask drops it from the set.
    sup?.emitAttention({
      type: "attentionEvent",
      event: "cleared",
      clearedIds: ["ask-pending:rev-1"],
    });
    expect(registry.needsYouReviewIds().has("rev-1")).toBe(false);
  });
});
