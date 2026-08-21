// @vitest-environment happy-dom
//
// Direct cover for `ConnectionHost.connectSource` — the source switcher's daemon-attach glue
// (source-aware project selection, task 6). The other ConnectionHost specs drive the real
// RennetApp; here we mock it to a prop-capturing stub so we can call `connectSource` straight and
// watch its observable effects (resolve → remount → pending-browse stash → no re-trigger loop),
// black-box, without a resolvable front-door bridge.

import type { ProjectSource } from "@rennet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, mount, waitFor } from "../test/dom";
import type {
  Connection,
  ConnectionTarget,
  ConnectSource,
  DaemonResolution,
  PendingSourceBrowse,
} from "./connection-host";

// Captured off the mocked RennetApp on every render (hoisted so the vi.mock factory can close
// over it). The last render wins — after an `act`, it reflects the settled tree.
const captured = vi.hoisted(() => ({
  connectSource: undefined as ConnectSource | undefined,
  pendingSourceBrowse: undefined as PendingSourceBrowse | undefined,
  activeSource: undefined as ProjectSource | undefined,
  consume: undefined as (() => void) | undefined,
}));

vi.mock("../app", () => ({
  RennetApp: (props: {
    connectSource?: ConnectSource;
    pendingSourceBrowse?: PendingSourceBrowse;
    activeSource?: ProjectSource;
    onPendingSourceBrowseConsumed?: () => void;
  }) => {
    captured.connectSource = props.connectSource;
    captured.pendingSourceBrowse = props.pendingSourceBrowse;
    captured.activeSource = props.activeSource;
    captured.consume = props.onPendingSourceBrowseConsumed;
    return null;
  },
}));

// Imported after the mock is declared (vi.mock is hoisted above imports anyway).
const { ConnectionHost } = await import("./connection-host");

const LOCAL: ConnectionTarget = { id: "local", label: "This machine", host: "127.0.0.1" };
const REMOTE_STORE = JSON.stringify({
  daemons: [
    { id: "daemon:dev-9", label: "Laptop", host: "100.9.9.9", port: 7411, deviceToken: "tok" },
  ],
});

/** A connection whose invokes never settle (we only assert dial/close, never a resolved command). */
function stubConnection(): Connection {
  return {
    bridge: {
      invoke: vi.fn(() => new Promise<never>(() => undefined)),
    } as unknown as Connection["bridge"],
    subscribe: () => () => undefined,
    close: vi.fn(),
  };
}

function activeId(): string | undefined {
  return JSON.parse(globalThis.localStorage.getItem("rennet.daemons") ?? "{}").activeId;
}

describe("ConnectionHost.connectSource — source dispatch", () => {
  beforeEach(() => {
    captured.connectSource = undefined;
    captured.pendingSourceBrowse = undefined;
    captured.activeSource = undefined;
    captured.consume = undefined;
  });

  it("wsl:<distro> resolves via the synthetic UNC, stashes the browse, and remounts once", async () => {
    const createConnection = vi.fn(() => stubConnection());
    const resolveDaemonTarget = vi.fn(
      async (): Promise<DaemonResolution> => ({
        switched: true,
        target: { id: "wsl:Ubuntu", label: "WSL · Ubuntu", host: "127.0.0.1", port: 5001 },
        repoPath: "/",
      }),
    );
    mount(
      <ConnectionHost
        createConnection={createConnection}
        defaultTarget={LOCAL}
        resolveDaemonTarget={resolveDaemonTarget}
        listWslDistros={async () => ["Ubuntu"]}
      />,
    );
    await waitFor(() => expect(captured.connectSource).toBeDefined());
    const dialsBefore = createConnection.mock.calls.length;

    let result: { switched: boolean; error?: string } | undefined;
    await act(async () => {
      result = await captured.connectSource?.("wsl:Ubuntu", "repo");
    });

    expect(result).toEqual({ switched: true });
    // The distro name comes straight from the id, fed to the resolver as a synthetic UNC.
    expect(resolveDaemonTarget).toHaveBeenCalledWith("\\\\wsl.localhost\\Ubuntu");
    // Exactly one remount, against the resolved distro target.
    expect(createConnection).toHaveBeenCalledTimes(dialsBefore + 1);
    expect(createConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "wsl:Ubuntu" }),
    );
    expect(activeId()).toBe("wsl:Ubuntu");
    // The browse is stashed so the post-remount FrontDoor restore fires there.
    expect(captured.pendingSourceBrowse).toEqual({ source: "wsl:Ubuntu", kind: "repo" });

    // Consuming the pending browse clears it and does NOT re-dial (no restore→attach loop).
    const dialsAfter = createConnection.mock.calls.length;
    act(() => captured.consume?.());
    await waitFor(() => expect(captured.pendingSourceBrowse).toBeUndefined());
    expect(createConnection).toHaveBeenCalledTimes(dialsAfter);
  });

  it("remote:<id> maps to the saved paired daemon (daemon:<id>) and remounts onto it", async () => {
    globalThis.localStorage.setItem("rennet.daemons", REMOTE_STORE);
    const createConnection = vi.fn(() => stubConnection());
    mount(<ConnectionHost createConnection={createConnection} defaultTarget={LOCAL} />);
    await waitFor(() => expect(captured.connectSource).toBeDefined());

    let result: { switched: boolean; error?: string } | undefined;
    await act(async () => {
      result = await captured.connectSource?.("remote:dev-9", "workspace");
    });

    expect(result).toEqual({ switched: true });
    expect(createConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "daemon:dev-9" }),
    );
    expect(activeId()).toBe("daemon:dev-9");
    expect(captured.pendingSourceBrowse).toEqual({ source: "remote:dev-9", kind: "workspace" });
  });

  it("local switches back to the owned default target from a non-local daemon", async () => {
    globalThis.localStorage.setItem(
      "rennet.daemons",
      JSON.stringify({ ...JSON.parse(REMOTE_STORE), activeId: "daemon:dev-9" }),
    );
    const createConnection = vi.fn(() => stubConnection());
    mount(<ConnectionHost createConnection={createConnection} defaultTarget={LOCAL} />);
    await waitFor(() => expect(captured.connectSource).toBeDefined());
    // Starts attached to the saved remote (its stored activeId).
    await waitFor(() =>
      expect(createConnection).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "daemon:dev-9" }),
      ),
    );

    let result: { switched: boolean; error?: string } | undefined;
    await act(async () => {
      result = await captured.connectSource?.("local", "repo");
    });

    expect(result).toEqual({ switched: true });
    expect(createConnection).toHaveBeenLastCalledWith(expect.objectContaining({ id: "local" }));
    expect(activeId()).toBe("local");
  });

  it("local is a no-op when already attached to the owned default target", async () => {
    const createConnection = vi.fn(() => stubConnection());
    mount(<ConnectionHost createConnection={createConnection} defaultTarget={LOCAL} />);
    await waitFor(() => expect(captured.connectSource).toBeDefined());
    const dialsBefore = createConnection.mock.calls.length;

    let result: { switched: boolean; error?: string } | undefined;
    await act(async () => {
      result = await captured.connectSource?.("local", "repo");
    });

    expect(result).toEqual({ switched: false });
    expect(createConnection).toHaveBeenCalledTimes(dialsBefore); // no remount
    expect(captured.pendingSourceBrowse).toBeUndefined();
  });

  it("reports the attached daemon's ProjectSource so a fresh add defaults to it (F1)", async () => {
    // Attached to a saved remote: `activeSource` must read `remote:<id>`, NOT "local" — the
    // fresh add flow keys its default (and the SourceSwitcher's selection) off this.
    globalThis.localStorage.setItem(
      "rennet.daemons",
      JSON.stringify({ ...JSON.parse(REMOTE_STORE), activeId: "daemon:dev-9" }),
    );
    const createConnection = vi.fn(() => stubConnection());
    mount(<ConnectionHost createConnection={createConnection} defaultTarget={LOCAL} />);
    await waitFor(() => expect(captured.connectSource).toBeDefined());
    await waitFor(() => expect(captured.activeSource).toBe("remote:dev-9"));
  });

  it("defaults activeSource to local when attached to the owned default target (F1)", async () => {
    const createConnection = vi.fn(() => stubConnection());
    mount(<ConnectionHost createConnection={createConnection} defaultTarget={LOCAL} />);
    await waitFor(() => expect(captured.connectSource).toBeDefined());
    expect(captured.activeSource).toBe("local");
  });

  it("returns switched:false when the requested remote is ALREADY the active daemon (F3)", async () => {
    // Selecting the already-attached target changes no activeId, so no remount fires. It must
    // report `switched:false` (not the old buggy `true`) so the caller proceeds inline instead
    // of hanging `busy` waiting for a browse restore that never arrives.
    globalThis.localStorage.setItem(
      "rennet.daemons",
      JSON.stringify({ ...JSON.parse(REMOTE_STORE), activeId: "daemon:dev-9" }),
    );
    const createConnection = vi.fn(() => stubConnection());
    mount(<ConnectionHost createConnection={createConnection} defaultTarget={LOCAL} />);
    await waitFor(() => expect(captured.connectSource).toBeDefined());
    await waitFor(() =>
      expect(createConnection).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "daemon:dev-9" }),
      ),
    );
    const dialsBefore = createConnection.mock.calls.length;

    let result: { switched: boolean; error?: string } | undefined;
    await act(async () => {
      result = await captured.connectSource?.("remote:dev-9", "repo");
    });

    expect(result).toEqual({ switched: false });
    expect(createConnection).toHaveBeenCalledTimes(dialsBefore); // no remount
    expect(captured.pendingSourceBrowse).toBeUndefined(); // no dangling browse restore
  });
});
