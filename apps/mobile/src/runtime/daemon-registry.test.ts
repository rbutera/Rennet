import type { ConnectionStatus, Presence } from "@rennet/client";
import { describe, expect, it, vi } from "vitest";
import { DaemonRegistry, type DaemonSupervisor, type PairedDaemon } from "./daemon-registry";

function fakeSupervisor(): DaemonSupervisor & { presence: Partial<Presence>[]; closed: boolean } {
  const state = { presence: [] as Partial<Presence>[], closed: false };
  return {
    ...state,
    invoke: (async () => ({})) as DaemonSupervisor["invoke"],
    subscribe: (listener: (s: ConnectionStatus) => void) => {
      listener({ state: "online", since: 0 });
      return () => undefined;
    },
    setPresence(p: Partial<Presence>) {
      this.presence.push(p);
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
});
