// @vitest-environment happy-dom
//
// The Add Project dialog (C12 §10.1) over a MemoryBridge: the source picker + the
// reused directory browser + the discover/add/navigate action, proven by DOM
// interaction. Opened the way the sidebar opens it — `ui.openDialog("add-project")`
// through the real store — so the mount, the seam reads/writes, and navigation all
// run against the real router + BridgeProvider.
import type {
  CommandInput,
  DiscoveryResult,
  FsListDirResult,
  PairedDevice,
  Project,
} from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { projectIndexingPath } from "../routes/url";
import { useRennetStore } from "../store";
import { act, cleanup, mount, screen, waitFor } from "../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { AddProjectDialog } from "./add-project-dialog";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({ ui: { ...s.ui, openDialogs: [] } }));
});

const HOME: FsListDirResult = {
  path: "/home/rai",
  home: "/home/rai",
  parent: "/home",
  entries: [
    { name: "dev", path: "/home/rai/dev", isRepo: false, unreadable: false },
    { name: "rennet", path: "/home/rai/rennet", isRepo: true, unreadable: false },
  ],
};

const DEV: FsListDirResult = {
  path: "/home/rai/dev",
  home: "/home/rai",
  parent: "/home/rai",
  entries: [{ name: "acme", path: "/home/rai/dev/acme", isRepo: true, unreadable: false }],
};

const device: PairedDevice = {
  deviceId: "d1",
  name: "lancelot",
  createdAt: "2026-08-01T00:00:00.000Z",
  lastSeenAt: "2026-08-27T00:00:00.000Z",
  expiresAt: "2026-12-01T00:00:00.000Z",
};

function project(id: string): Project {
  return {
    id,
    name: id,
    path: "/home/rai/rennet",
    kind: "repo",
    repoCount: 1,
    branchCount: 3,
    primaryBranch: "main",
    openPath: "/home/rai/rennet",
    addedAt: "2026-08-27T00:00:00.000Z",
    source: "local",
  };
}

const discovery: DiscoveryResult = {
  path: "/home/rai/rennet",
  kind: "repo",
  repos: [{ name: "rennet", path: "/home/rai/rennet", branches: 3 }],
  primaryBranch: "main",
  source: "local",
};

function open(): void {
  act(() => useRennetStore.getState().uiActions.openDialog("add-project"));
}

function renderDialog(handlers: MemoryBridgeHandlers, initialPath = "/new-chat") {
  const history = memoryHistory(initialPath);
  const bridge = new MemoryBridge(handlers);
  const view = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <AddProjectDialog />
      </Router>
    </BridgeProvider>,
  );
  return { ...view, history };
}

/** A promise with an exposed resolver, to hold a listing in flight. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("AddProjectDialog", () => {
  it("Add is inert until a directory loads, then enabled once one is selected", async () => {
    open();
    const first = deferred<{ result: FsListDirResult }>();
    renderDialog({ "fs.listDir": () => first.promise });

    // With the listing still in flight, nothing is selected → Add is inert.
    const add = await screen.findByRole("button", { name: "Add" });
    expect((add as HTMLButtonElement).disabled).toBe(true);

    // The browser lists home and reports it as the current selection → Add enables.
    act(() => first.resolve({ result: HOME }));
    await screen.findByText("dev");
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  });

  it("Add runs discover + add and navigates straight to the indexing view", async () => {
    open();
    const added: CommandInput<"projects.add">[] = [];
    const { history } = renderDialog({
      "fs.listDir": () => ({ result: HOME }),
      "repository.choose": ({ path }) => ({ path: path ?? null }),
      "project.discover": () => ({ discovery }),
      "projects.add": (input) => {
        added.push(input);
        return { project: project("proj-1"), projects: [project("proj-1")] };
      },
    });

    const add = await screen.findByRole("button", { name: "Add" });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    act(() => add.click());

    await waitFor(() => expect(history.history.at(-1)).toBe(projectIndexingPath("proj-1")));
    // No orchestrator turn: only the discover/add commands ran, and the dialog closed.
    expect(added).toHaveLength(1);
    expect(useRennetStore.getState().ui.openDialogs).not.toContain("add-project");
  });

  it("falls back to workspace discovery when the path is not itself a repo", async () => {
    open();
    const kinds: string[] = [];
    const { history } = renderDialog({
      "fs.listDir": () => ({ result: HOME }),
      "repository.choose": ({ path }) => ({ path: path ?? null }),
      "project.discover": ({ kind }) => {
        kinds.push(kind);
        return kind === "repo"
          ? { discovery: { ...discovery, kind: "repo", repos: [] } }
          : {
              discovery: {
                ...discovery,
                kind: "workspace",
                repos: [{ name: "acme", path: "/home/rai/dev/acme", branches: 2 }],
              },
            };
      },
      "projects.add": () => ({ project: project("proj-2"), projects: [project("proj-2")] }),
    });

    const add = await screen.findByRole("button", { name: "Add" });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    act(() => add.click());

    await waitFor(() => expect(history.history.at(-1)).toBe(projectIndexingPath("proj-2")));
    // Tried repo first, then workspace when that found nothing.
    expect(kinds).toEqual(["repo", "workspace"]);
  });

  it("switching source clears the selected path and reloads the browser against that host", async () => {
    open();
    const second = deferred<{ result: FsListDirResult }>();
    let calls = 0;
    const { user } = renderDialog({
      "pairing.listDevices": () => ({ devices: [device] }),
      "fs.listDir": () => {
        calls += 1;
        return calls === 1 ? { result: HOME } : second.promise;
      },
    });

    const add = await screen.findByRole("button", { name: "Add" });
    await screen.findByText("dev");
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));

    // Open the source picker and switch to the paired remote.
    await user.click(screen.getByRole("button", { name: /^Source:/ }));
    await user.click(await screen.findByText("lancelot"));

    // Selection cleared and the new listing is in flight → Add is inert again.
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(true));
    expect(calls).toBe(2); // the source switch reloaded the browser

    // Once the host's listing resolves, a directory is current again → Add re-enables.
    act(() =>
      second.resolve({ result: { ...HOME, path: "/home/lancelot", home: "/home/lancelot" } }),
    );
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  });

  it("reopens clean — a descent in one session is gone the next", async () => {
    open();
    const { user } = renderDialog({
      "fs.listDir": ({ path }: CommandInput<"fs.listDir">) => ({
        result: path === "/home/rai/dev" ? DEV : HOME,
      }),
    });

    // Descend into a subfolder, so the path bar leaves home.
    await user.click(await screen.findByText("dev"));
    await waitFor(() =>
      expect((screen.getByLabelText("Directory path") as HTMLInputElement).value).toBe(
        "/home/rai/dev",
      ),
    );

    // Close, then reopen: the body remounts, so the browser is back at home.
    act(() => useRennetStore.getState().uiActions.closeDialog("add-project"));
    open();
    await waitFor(() =>
      expect((screen.getByLabelText("Directory path") as HTMLInputElement).value).toBe("/home/rai"),
    );
  });
});
