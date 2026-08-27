// @vitest-environment happy-dom
//
// The Add Project dialog (C12 §10.1) over a MemoryBridge: the source picker + the
// reused directory browser + the discover/add/navigate action, proven by DOM
// interaction. Opened the way the sidebar opens it — `ui.openDialog("add-project")`
// through the real store — so the mount, the seam reads/writes, and navigation all
// run against the real router + BridgeProvider.
import type { CommandInput, DiscoveryResult, FsListDirResult, Project } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { projectIndexingPath } from "../routes/url";
import { useRennetStore } from "../store";
import { act, cleanup, mount, screen, waitFor } from "../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { mountApp } from "../test/mount-app";
import { AddProjectDialog } from "./add-project-dialog";

afterEach(() => {
  cleanup();
  globalThis.localStorage.clear();
  useRennetStore.setState((s) => ({
    ui: { ...s.ui, openDialogs: [], pendingAddProjectSource: undefined },
  }));
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

/** The lancelot (remote daemon) filesystem — a DISTINCT listing from HOME, so browsing it
 *  proves the source switch changed which bridge the browser talks to. */
const LANCELOT: FsListDirResult = {
  path: "/home/lancelot",
  home: "/home/lancelot",
  parent: "/home",
  entries: [{ name: "services", path: "/home/lancelot/services", isRepo: true, unreadable: false }],
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

  it("switching source attaches that daemon and browses ITS filesystem (distinct bridge)", async () => {
    // A saved remote daemon, so the source picker offers "lancelot" alongside Local. The two
    // daemons are GENUINELY distinct bridges (mountApp gives each target its own MemoryBridge),
    // so browsing the remote must show its own filesystem — the single-bridge mock hid this.
    globalThis.localStorage.setItem(
      "rennet.daemons",
      JSON.stringify({
        daemons: [
          {
            id: "daemon:d1",
            label: "lancelot",
            host: "100.1.2.3",
            port: 7411,
            deviceToken: "tok",
          },
        ],
      }),
    );
    const { user } = mountApp((target) => ({
      "fs.listDir": () => ({ result: target.id === "daemon:d1" ? LANCELOT : HOME }),
    }));

    open();
    // Local first: the browser lists HOME.
    await screen.findByText("dev");
    const add = await screen.findByRole("button", { name: "Add" });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));

    // Switch to the remote daemon: connectSource remounts the app onto it, and the browser
    // now lists the REMOTE filesystem (a different bridge), not HOME.
    await user.click(screen.getByRole("button", { name: /^Source:/ }));
    await user.click(await screen.findByText("lancelot"));

    await screen.findByText("services"); // lancelot's listing, from its own bridge
    expect(screen.queryByText("dev")).toBeNull(); // HOME is gone — the bridge really changed
    const addAfter = await screen.findByRole("button", { name: "Add" });
    await waitFor(() => expect((addAfter as HTMLButtonElement).disabled).toBe(false));
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
