// @vitest-environment happy-dom
//
// The Add Environment pairing dialog (C12 §10.3) over the REAL shell (ConnectionHost →
// router), so the cross-daemon connect is genuine: `pairAtAddress` dials a TEMPORARY bridge
// AT the entered address, exchanges the one-time code on THAT connection, and persists the
// tokened daemon as a selectable source. Dialling the currently-attached daemon and
// discarding the token — the blocker-1 bug — paired nothing; a single-bridge mock hid it.
// Opened the way the sidebar opens it: `ui.openDialog("add-environment")` through the store.
//
// The two failure cases at the bottom moved here from `connection-host.dom.test.tsx` when
// the corner switcher's own pairing form was removed. They pin `pairAtAddress`'s error
// paths — a malformed address that must never dial, and a temporary bridge that never
// comes up — through the only surface that still reaches them.
import type { CommandInput, FsListDirResult } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { act, cleanup, screen, waitFor } from "../test/dom";
import { mountApp } from "../test/mount-app";

afterEach(() => {
  cleanup();
  globalThis.localStorage.clear();
  useRennetStore.setState((s) => ({
    ui: { ...s.ui, openDialogs: [], pendingAddProjectSource: undefined },
  }));
});

const REMOTE_FS: FsListDirResult = {
  path: "/home",
  home: "/home",
  parent: null,
  entries: [],
};

function openRemote(): void {
  act(() => useRennetStore.getState().uiActions.openDialog("add-environment"));
}

/** A promise with an exposed resolver, to hold the exchange in flight. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("AddRemoteDialog", () => {
  it("Connect is inert until BOTH address and code carry a value", async () => {
    const { user } = mountApp(() => ({}));
    openRemote();

    const connect = await screen.findByRole("button", { name: "Connect" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Address"), "build-server.tailnet.ts.net");
    // Address alone is not enough — the code is still empty.
    expect((connect as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Pairing code"), "abcd-1234");
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
  });

  it("locks the fields and shows the spinner while connecting", async () => {
    const gate = deferred<{ deviceToken: string; deviceId: string }>();
    const { user } = mountApp(() => ({ "pairing.exchange": () => gate.promise }));
    openRemote();

    await user.type(screen.getByLabelText("Address"), "build-server.tailnet.ts.net");
    await user.type(screen.getByLabelText("Pairing code"), "abcd-1234");
    await user.click(await screen.findByRole("button", { name: "Connect" }));

    // In flight: the button reads Connecting…, and both fields are locked.
    await screen.findByRole("button", { name: /Connecting/ });
    expect((screen.getByLabelText("Address") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Pairing code") as HTMLInputElement).disabled).toBe(true);

    act(() => gate.resolve({ deviceToken: "tok", deviceId: "d1" }));
    await screen.findByText(/Connected to/);
  });

  it("dials the entered address, derives the machine name from it, and offers Done", async () => {
    let sentName: string | undefined;
    let dialledHost: string | undefined;
    const { user, bridges } = mountApp((target) => ({
      "pairing.exchange": (input: CommandInput<"pairing.exchange">) => {
        sentName = input.deviceName;
        // The pairing bridge is a TEMPORARY connection at the entered address, not the
        // local daemon — so its target id is a `pairing:*`, never "local".
        dialledHost = target.host;
        return { deviceToken: "tok", deviceId: "d1" };
      },
    }));
    openRemote();

    await user.type(screen.getByLabelText("Address"), "build-server.tailnet.ts.net");
    await user.type(screen.getByLabelText("Pairing code"), "abcd-1234");
    await user.click(await screen.findByRole("button", { name: "Connect" }));

    // The name is the first dotted label, and it names the connected machine.
    await screen.findByText("build-server");
    expect(sentName).toBe("build-server");
    // The exchange ran on a bridge dialled AT the address — never the local daemon.
    expect(dialledHost).toBe("build-server.tailnet.ts.net");
    expect(bridges.get("local")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(useRennetStore.getState().ui.openDialogs).not.toContain("add-environment"),
    );
  });

  it("Browse Its Projects attaches the paired machine and opens Add Project on it", async () => {
    const { user } = mountApp(() => ({
      "pairing.exchange": () => ({ deviceToken: "tok", deviceId: "d1" }),
      // Add Project's browser fires once it mounts against the newly-attached remote.
      "fs.listDir": () => ({ result: REMOTE_FS }),
    }));
    openRemote();

    await user.type(screen.getByLabelText("Address"), "build-server.tailnet.ts.net");
    await user.type(screen.getByLabelText("Pairing code"), "abcd-1234");
    await user.click(await screen.findByRole("button", { name: "Connect" }));

    await user.click(await screen.findByRole("button", { name: "Browse Its Projects" }));

    // The environment dialog closed; Add Project opened on the newly-paired remote, so its
    // source picker names the paired machine (not "This machine").
    await waitFor(() => expect(useRennetStore.getState().ui.openDialogs).toContain("add-project"));
    expect(useRennetStore.getState().ui.openDialogs).not.toContain("add-environment");
    await screen.findByRole("button", { name: "Source: build-server" });
    // The one-shot hop is consumed, so a later manual reopen is clean.
    expect(useRennetStore.getState().ui.pendingAddProjectSource).toBeUndefined();
  });

  it("refuses a malformed address without dialling it, and leaves Connect usable", async () => {
    const { user, bridges } = mountApp(() => ({}));
    openRemote();

    await user.type(screen.getByLabelText("Address"), "host:70000");
    await user.type(screen.getByLabelText("Pairing code"), "abcd-1234");
    await user.click(await screen.findByRole("button", { name: "Connect" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Enter a host");
    // The port is out of range, so nothing was dialled: the local daemon is the only
    // bridge that ever got built — no stray `pairing:*` connection was opened.
    expect([...bridges.keys()]).toEqual(["local"]);
    // Back to idle, not stuck on "Connecting…" — the button is still Connect and live.
    const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
  });

  it("surfaces a temporary bridge that never came up, and leaves Connect usable", async () => {
    const { user } = mountApp(() => ({}), {
      failBridgeFor: (target) =>
        target.id.startsWith("pairing:") ? new Error("bridge construction failed") : undefined,
    });
    openRemote();

    await user.type(screen.getByLabelText("Address"), "build-server.tailnet.ts.net");
    await user.type(screen.getByLabelText("Pairing code"), "abcd-1234");
    await user.click(await screen.findByRole("button", { name: "Connect" }));

    // The dial threw before there was anything to close; the cause reaches the reader
    // rather than leaving the dialog spinning forever.
    expect((await screen.findByRole("alert")).textContent).toContain("bridge construction failed");
    const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
  });
});
