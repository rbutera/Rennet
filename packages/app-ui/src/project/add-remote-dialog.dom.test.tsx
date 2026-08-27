// @vitest-environment happy-dom
//
// The Add Environment pairing dialog (C12 §10.3) over a MemoryBridge: Connect
// gating, the connecting lock + spinner, the success actions, and the one `ui` hop
// behind "Browse Its Projects" (reopen Add Project preselected to the paired
// machine). Opened the way the sidebar opens it — `ui.openDialog("add-environment")`
// through the real store.
import type { PairedDevice } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, mount, screen, waitFor } from "../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { AddProjectDialog } from "./add-project-dialog";
import { AddRemoteDialog } from "./add-remote-dialog";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({
    ui: { ...s.ui, openDialogs: [], pendingAddProjectSource: undefined },
  }));
});

const device: PairedDevice = {
  deviceId: "d1",
  name: "build-server",
  createdAt: "2026-08-01T00:00:00.000Z",
  lastSeenAt: "2026-08-27T00:00:00.000Z",
  expiresAt: "2026-12-01T00:00:00.000Z",
};

function openRemote(): void {
  act(() => useRennetStore.getState().uiActions.openDialog("add-environment"));
}

function render(handlers: MemoryBridgeHandlers, withProject = false) {
  const history = memoryHistory("/new-chat");
  const bridge = new MemoryBridge(handlers);
  return mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <AddRemoteDialog />
        {withProject ? <AddProjectDialog /> : null}
      </Router>
    </BridgeProvider>,
  );
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
    openRemote();
    const { user } = render({});

    const connect = await screen.findByRole("button", { name: "Connect" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Address"), "build-server.tailnet.ts.net");
    // Address alone is not enough — the code is still empty.
    expect((connect as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Pairing code"), "abcd-1234");
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
  });

  it("locks the fields and shows the spinner while connecting", async () => {
    openRemote();
    const gate = deferred<{ deviceToken: string; deviceId: string }>();
    const { user } = render({ "pairing.exchange": () => gate.promise });

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

  it("derives the machine name from the address's first label and offers Done", async () => {
    openRemote();
    let sentName: string | undefined;
    const { user } = render({
      "pairing.exchange": ({ deviceName }) => {
        sentName = deviceName;
        return { deviceToken: "tok", deviceId: "d1" };
      },
    });

    await user.type(screen.getByLabelText("Address"), "build-server.tailnet.ts.net");
    await user.type(screen.getByLabelText("Pairing code"), "abcd-1234");
    await user.click(await screen.findByRole("button", { name: "Connect" }));

    // The name is the first dotted label, and it names the connected machine.
    await screen.findByText("build-server");
    expect(sentName).toBe("build-server");

    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(useRennetStore.getState().ui.openDialogs).not.toContain("add-environment"),
    );
  });

  it("Browse Its Projects reopens Add Project preselected to the paired machine", async () => {
    openRemote();
    const { user } = render(
      {
        "pairing.exchange": () => ({ deviceToken: "tok", deviceId: "d1" }),
        "pairing.listDevices": () => ({ devices: [device] }),
        // Add Project's browser fires once it mounts against the preselected source.
        "fs.listDir": () => ({
          result: { path: "/home", home: "/home", parent: null, entries: [] },
        }),
      },
      true,
    );

    await user.type(screen.getByLabelText("Address"), "build-server.tailnet.ts.net");
    await user.type(screen.getByLabelText("Pairing code"), "abcd-1234");
    await user.click(await screen.findByRole("button", { name: "Connect" }));

    await user.click(await screen.findByRole("button", { name: "Browse Its Projects" }));

    // The environment dialog closed; Add Project opened preselected to the new remote,
    // so its source picker names the paired machine (not "This machine").
    await waitFor(() => expect(useRennetStore.getState().ui.openDialogs).toContain("add-project"));
    expect(useRennetStore.getState().ui.openDialogs).not.toContain("add-environment");
    await screen.findByRole("button", { name: "Source: build-server" });
    // The one-shot hop is consumed, so a later manual reopen is clean.
    expect(useRennetStore.getState().ui.pendingAddProjectSource).toBeUndefined();
  });
});
