// @vitest-environment happy-dom
//
// The in-app directory browser (source-aware project selection, task 5): mounts
// the real component over a fake `RennetBridge` recording `fs.listDir` calls,
// asserting the rendered listing/breadcrumb/up-affordance and the `onPathChange`
// seam behaviourally — matching the house pattern in front-door.dom.test.tsx.
import type { CommandInput, FsListDirResult, RennetBridge } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, mount, screen, waitFor } from "../test/dom";
import { DirectoryBrowser } from "./directory-browser";

const home: FsListDirResult = {
  path: "/home/rai",
  home: "/home/rai",
  parent: "/home",
  entries: [{ name: "dev", path: "/home/rai/dev", isRepo: true, unreadable: false }],
};

/** A fake bridge answering `fs.listDir` by requested path (`""` for the empty/home call). */
function fakeBridge(responses: Record<string, FsListDirResult>): {
  bridge: RennetBridge;
  calls: (string | undefined)[];
} {
  const calls: (string | undefined)[] = [];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    if (name !== "fs.listDir") return {};
    const { path } = input as CommandInput<"fs.listDir">;
    calls.push(path);
    const result = responses[path ?? ""];
    if (!result) throw new Error("No such directory");
    return { result };
  };
  return { bridge: { invoke } as unknown as RennetBridge, calls };
}

/** A promise plus its own `resolve`, for controlling settle order across two in-flight loads. */
function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("DirectoryBrowser", () => {
  it("keeps what the user typed while the opening listing was still in flight", async () => {
    // The opening load is asynchronous. Someone who opens the browser and starts typing
    // immediately used to have their text replaced by the home directory when it landed —
    // input accepted and then silently discarded. Found by an e2e drive that filled the
    // path bar faster than the first listing resolved.
    const opening = createDeferred<{ result: FsListDirResult }>();
    const bridge = {
      invoke: async (name: string) => (name === "fs.listDir" ? opening.promise : {}),
    } as unknown as RennetBridge;
    const { container } = mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);

    const bar = container.querySelector("input") as HTMLInputElement;
    fireEvent.change(bar, { target: { value: "/home/rai/dev/rennet" } });
    await act(async () => {
      opening.resolve({ result: home });
    });

    expect(bar.value).toBe("/home/rai/dev/rennet");
  });

  it("still normalises the bar to the resolved path when the user has NOT typed", async () => {
    // The other direction: without an edit, the load must still fill the bar, or the
    // browser opens showing nothing and the fix above would have broken the common case.
    const { bridge } = fakeBridge({ "": home });
    const { container } = mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);

    await screen.findByText("dev");
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("/home/rai");
  });

  it("lists the home dir on mount and descends on click", async () => {
    const onPathChange = vi.fn();
    const { bridge } = fakeBridge({
      "": home,
      "/home/rai/dev": {
        path: "/home/rai/dev",
        home: "/home/rai",
        parent: "/home/rai",
        entries: [],
      },
    });
    const { container } = mount(<DirectoryBrowser bridge={bridge} onPathChange={onPathChange} />);

    await screen.findByText("dev");
    expect(onPathChange).toHaveBeenCalledWith("/home/rai");
    // repo badge on the descendable row
    expect(container.querySelector(".directory-browser-repo-badge")).not.toBeNull();

    fireEvent.click(screen.getByText("dev"));

    await waitFor(() => expect(onPathChange).toHaveBeenCalledWith("/home/rai/dev"));
    await screen.findByText("No folders here");
  });

  it("disables Up at the filesystem root, after being enabled below it", async () => {
    const onPathChange = vi.fn();
    const { bridge } = fakeBridge({
      "": home,
      "/home": { path: "/home", home: "/home/rai", parent: null, entries: [] },
    });
    mount(<DirectoryBrowser bridge={bridge} onPathChange={onPathChange} />);

    const up = (await screen.findByRole("button", { name: "Up one level" })) as HTMLButtonElement;
    await waitFor(() => expect(up.disabled).toBe(false));

    fireEvent.click(up);

    await waitFor(() => expect(onPathChange).toHaveBeenCalledWith("/home"));
    expect(up.disabled).toBe(true);
  });

  it("shows an inline error on a bad typed path and leaves the bar populated", async () => {
    const { bridge } = fakeBridge({ "": home });
    const { container } = mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);
    await screen.findByText("dev");

    const input = screen.getByRole("textbox", { name: "Directory path" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/nope" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(container.querySelector(".directory-browser-error")?.textContent).toBe(
        "No such directory",
      ),
    );
    expect(input.value).toBe("/nope");
    // the last-good listing stays put under the error, not silently blown away
    expect(container.querySelector(".directory-browser-list")?.textContent).not.toContain("dev");
  });

  it("calls onPathInvalid when a load fails, so the flow can drop the selection", async () => {
    const onPathInvalid = vi.fn();
    const { bridge } = fakeBridge({ "": home });
    mount(
      <DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} onPathInvalid={onPathInvalid} />,
    );
    await screen.findByText("dev");

    const input = screen.getByRole("textbox", { name: "Directory path" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/nope" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The bad path errored → the browser tells the flow the selection is now invalid.
    await waitFor(() => expect(onPathInvalid).toHaveBeenCalledTimes(1));
  });

  it("renders an empty state when a directory has no child folders", async () => {
    const { bridge } = fakeBridge({
      "": { path: "/empty", home: "/empty", parent: "/", entries: [] },
    });
    mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);

    await screen.findByText("No folders here");
  });

  it("renders unreadable rows dim and non-descendable", async () => {
    const onPathChange = vi.fn();
    const { bridge, calls } = fakeBridge({
      "": {
        path: "/home/rai",
        home: "/home/rai",
        parent: "/home",
        entries: [{ name: "locked", path: "/home/rai/locked", isRepo: false, unreadable: true }],
      },
    });
    mount(<DirectoryBrowser bridge={bridge} onPathChange={onPathChange} />);

    const row = await screen.findByText("locked");
    expect(row.closest("[role='option']")?.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(row);
    // no second fs.listDir call fired for the unreadable row
    expect(calls).toEqual([undefined]);
  });

  it("ignores a stale load response once a newer reload has been issued", async () => {
    const onPathChange = vi.fn();
    const deferredDev = createDeferred<{ result: FsListDirResult }>();
    const invoke = vi.fn(async (name: string, input: unknown): Promise<unknown> => {
      if (name !== "fs.listDir") return {};
      const { path } = input as CommandInput<"fs.listDir">;
      // The descend to /dev is held pending; every other call (mount + the
      // reload triggered below) resolves immediately with `home`.
      if (path === "/home/rai/dev") return deferredDev.promise;
      return { result: home };
    });
    const bridge = { invoke } as unknown as RennetBridge;

    const { rerender } = mount(
      <DirectoryBrowser bridge={bridge} reloadKey="a" onPathChange={onPathChange} />,
    );
    await screen.findByText("dev");

    // Issue the stale load (held pending)...
    fireEvent.click(screen.getByText("dev"));
    // ...then issue a NEWER load (source switch bumping reloadKey) before it settles.
    rerender(<DirectoryBrowser bridge={bridge} reloadKey="b" onPathChange={onPathChange} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));

    // Now let the stale descend resolve, AFTER the newer reload was issued — it
    // must be dropped, not painted over the newer (home) state.
    await act(async () => {
      deferredDev.resolve({
        result: { path: "/home/rai/dev", home: "/home/rai", parent: "/home/rai", entries: [] },
      });
      await deferredDev.promise;
    });

    expect(onPathChange).not.toHaveBeenCalledWith("/home/rai/dev");
    expect(screen.queryByText("No folders here")).toBeNull();
    expect(screen.getByText("dev")).toBeTruthy();
  });

  it("moves focus between rows with ArrowDown/ArrowUp (roving tabindex)", async () => {
    const { bridge } = fakeBridge({
      "": {
        path: "/home/rai",
        home: "/home/rai",
        parent: "/home",
        entries: [
          { name: "alpha", path: "/home/rai/alpha", isRepo: false, unreadable: false },
          { name: "beta", path: "/home/rai/beta", isRepo: false, unreadable: false },
        ],
      },
    });
    mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);
    await screen.findByText("alpha");

    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("tabindex")).toBe("0");
    expect(rows[1]?.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(rows[0] as Element, { key: "ArrowDown" });
    expect(rows[0]?.getAttribute("tabindex")).toBe("-1");
    expect(rows[1]?.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(rows[1] as Element, { key: "ArrowUp" });
    expect(rows[0]?.getAttribute("tabindex")).toBe("0");
    expect(rows[1]?.getAttribute("tabindex")).toBe("-1");
  });

  it("ascends to the parent on Backspace from a focused row", async () => {
    const onPathChange = vi.fn();
    const { bridge } = fakeBridge({
      "": home,
      "/home": { path: "/home", home: "/home/rai", parent: null, entries: [] },
    });
    mount(<DirectoryBrowser bridge={bridge} onPathChange={onPathChange} />);

    const row = await screen.findByText("dev");
    fireEvent.keyDown(row.closest("[role='option']") as Element, { key: "Backspace" });

    await waitFor(() => expect(onPathChange).toHaveBeenCalledWith("/home"));
  });
});
