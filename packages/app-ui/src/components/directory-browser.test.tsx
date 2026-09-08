// @vitest-environment happy-dom
//
// The in-app directory browser (source-aware project selection, task 5): mounts
// the real component over a fake `RennetBridge` recording `fs.listDir` calls,
// asserting the rendered listing/breadcrumb/up-affordance and the `onPathChange`
// seam behaviourally — matching the house pattern in front-door.dom.test.tsx.
import type { CommandInput, FsListDirResult, RennetBridge } from "@rennet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, mount, screen, waitFor } from "../test/dom";
import { DirectoryBrowser } from "./directory-browser";

beforeEach(() => {
  globalThis.localStorage.clear();
});

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
    // A trailing slash: the bar names a DIRECTORY, and the caret is ready for the next segment.
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("/home/rai/");
  });

  it("keeps the root as a single slash in the bar", async () => {
    const { bridge } = fakeBridge({
      "": { path: "/", home: "/home/rai", parent: null, entries: [] },
    });
    const { container } = mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);
    await screen.findByText("No folders here");
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("/");
  });

  it("strips the trailing slash from a typed path before asking the daemon", async () => {
    // The bar shows `/home/rai/`, so appending a segment and pressing Enter sends
    // `/home/rai/dev/` when the user keeps typing the convention; the daemon is asked for the
    // canonical path, and the selection the flow submits carries none.
    const onPathChange = vi.fn();
    const { bridge, calls } = fakeBridge({
      "": home,
      "/home/rai/dev": {
        path: "/home/rai/dev",
        home: "/home/rai",
        parent: "/home/rai",
        entries: [],
      },
    });
    mount(<DirectoryBrowser bridge={bridge} onPathChange={onPathChange} />);
    await screen.findByText("dev");

    const input = screen.getByRole("textbox", { name: "Directory path" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/home/rai/dev/" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onPathChange).toHaveBeenCalledWith("/home/rai/dev"));
    expect(calls).toEqual([undefined, "/home/rai/dev"]);
    expect(input.value).toBe("/home/rai/dev/");
  });

  it("passes a row's own path through untouched, whitespace and all", async () => {
    // Only TYPED input is normalised. A folder named "repo " is a real folder; trimming
    // its row path would list the sibling "repo" instead (or fail if there is none).
    const onPathChange = vi.fn();
    const { bridge, calls } = fakeBridge({
      "": {
        path: "/home/rai",
        home: "/home/rai",
        parent: "/home",
        entries: [{ name: "repo ", path: "/home/rai/repo ", isRepo: false, unreadable: false }],
      },
      "/home/rai/repo ": {
        path: "/home/rai/repo ",
        home: "/home/rai",
        parent: "/home/rai",
        entries: [],
      },
    });
    mount(<DirectoryBrowser bridge={bridge} onPathChange={onPathChange} />);
    fireEvent.click(await screen.findByText("repo"));

    await waitFor(() => expect(onPathChange).toHaveBeenCalledWith("/home/rai/repo "));
    expect(calls).toEqual([undefined, "/home/rai/repo "]);
  });

  it("keeps a typed Windows drive root whole instead of sending the bare drive letter", async () => {
    // `C:` alone names the drive's CURRENT directory, so stripping the slash would list
    // somewhere other than the root the user asked for.
    const { bridge, calls } = fakeBridge({
      "": home,
      "C:/": { path: "C:/", home: "C:/Users/rai", parent: null, entries: [] },
    });
    mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);
    await screen.findByText("dev");

    const input = screen.getByRole("textbox", { name: "Directory path" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  C:/  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(calls.at(-1)).toBe("C:/"));
  });

  it("uses the path's own separator for a Windows daemon and never treats a POSIX backslash as one", async () => {
    // Browse… on a Windows host drops `C:\Users\rai` into the bar: it must read
    // `C:\Users\rai\`, and a typed `C:\Users\rai\dev\` must be asked for as `C:\Users\rai\dev`.
    const win = {
      path: "C:\\Users\\rai",
      home: "C:\\Users\\rai",
      parent: "C:\\Users",
      entries: [],
    };
    const { bridge, calls } = fakeBridge({
      "": win,
      "C:\\Users\\rai\\dev": { ...win, path: "C:\\Users\\rai\\dev", parent: "C:\\Users\\rai" },
      "C:\\": { ...win, path: "C:\\", parent: null },
      // POSIX: `repo\` is a folder NAME, so the backslash survives the strip.
      "/home/rai/repo\\": {
        path: "/home/rai/repo\\",
        home: "/home/rai",
        parent: "/home/rai",
        entries: [],
      },
    });
    mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);
    const input = (await screen.findByRole("textbox", {
      name: "Directory path",
    })) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("C:\\Users\\rai\\"));

    fireEvent.change(input, { target: { value: "C:\\Users\\rai\\dev\\" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.at(-1)).toBe("C:\\Users\\rai\\dev"));

    fireEvent.change(input, { target: { value: "C:\\" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.at(-1)).toBe("C:\\"));
    await waitFor(() => expect(input.value).toBe("C:\\"));

    fireEvent.change(input, { target: { value: "/home/rai/repo\\" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.at(-1)).toBe("/home/rai/repo\\"));
    await waitFor(() => expect(input.value).toBe("/home/rai/repo\\/"));
  });

  it("keeps keyboard focus in the list when hiding the focused dot-folder", async () => {
    globalThis.localStorage.setItem("rennet.directory-browser.show-hidden", "1");
    const { bridge } = fakeBridge({
      "": {
        path: "/home/rai",
        home: "/home/rai",
        parent: "/home",
        entries: [
          { name: ".config", path: "/home/rai/.config", isRepo: false, unreadable: false },
          { name: "dev", path: "/home/rai/dev", isRepo: false, unreadable: false },
        ],
      },
    });
    mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);
    const hiddenRow = (await screen.findByText(".config")).closest(
      "[role='option']",
    ) as HTMLElement;
    hiddenRow.focus();
    expect(document.activeElement).toBe(hiddenRow);

    fireEvent.click(screen.getByRole("button", { name: "Hide hidden folders" }));

    await waitFor(() => expect(screen.queryByText(".config")).toBeNull());
    const devRow = screen.getByText("dev").closest("[role='option']");
    expect(document.activeElement).toBe(devRow);
  });

  it("a folder dialog that rejects reports the failure inline", async () => {
    const { bridge } = fakeBridge({ "": home });
    const { container } = mount(
      <DirectoryBrowser
        bridge={bridge}
        onPathChange={vi.fn()}
        pickDirectory={async () => {
          throw new Error("dialog unavailable");
        }}
      />,
    );
    await screen.findByText("dev");
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));

    await waitFor(() =>
      expect(container.querySelector(".directory-browser-error")?.textContent).toBe(
        "dialog unavailable",
      ),
    );
  });

  it("drops a folder dialog's answer when the source switched while it was open", async () => {
    // The dialog is open across an await. A source switch (reloadKey) reloads the browser
    // onto another daemon; the HOST path the dialog then returns must not be listed there.
    const onPathChange = vi.fn();
    const picked = createDeferred<string | null>();
    const { bridge, calls } = fakeBridge({
      "": home,
      "/home/rai/dev": {
        path: "/home/rai/dev",
        home: "/home/rai",
        parent: "/home/rai",
        entries: [],
      },
    });
    const { rerender } = mount(
      <DirectoryBrowser
        bridge={bridge}
        reloadKey="a"
        onPathChange={onPathChange}
        pickDirectory={() => picked.promise}
      />,
    );
    await screen.findByText("dev");
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));

    rerender(
      <DirectoryBrowser
        bridge={bridge}
        reloadKey="b"
        onPathChange={onPathChange}
        pickDirectory={() => picked.promise}
      />,
    );
    await waitFor(() => expect(calls).toEqual([undefined, undefined]));

    await act(async () => {
      picked.resolve("/home/rai/dev");
      await picked.promise;
    });
    expect(calls).toEqual([undefined, undefined]);
    expect(onPathChange).not.toHaveBeenCalledWith("/home/rai/dev");
  });

  it("renders the breadcrumb without a separator after the root slash", async () => {
    // "/ / Users / rai" read as a typo; the root crumb IS the slash, so the first segment
    // follows it directly and separators only sit BETWEEN named segments.
    const { bridge } = fakeBridge({ "": home });
    mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);
    await screen.findByText("dev");

    const trail = screen.getByRole("navigation", { name: "Current path" });
    expect(trail.textContent?.replace(/\s+/g, "")).toBe("/home/rai");
  });

  it("hides dot-folders by default and reveals them with the toggle, remembering the choice", async () => {
    const { bridge } = fakeBridge({
      "": {
        path: "/home/rai",
        home: "/home/rai",
        parent: "/home",
        entries: [
          { name: ".config", path: "/home/rai/.config", isRepo: false, unreadable: false },
          { name: ".ssh", path: "/home/rai/.ssh", isRepo: false, unreadable: false },
          { name: "dev", path: "/home/rai/dev", isRepo: true, unreadable: false },
        ],
      },
    });
    const first = mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);
    await screen.findByText("dev");
    expect(screen.queryByText(".config")).toBeNull();
    expect(screen.queryByText(".ssh")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Show hidden folders" });
    expect(toggle.getAttribute("title")).toBe("Show hidden folders (2)");
    fireEvent.click(toggle);

    await screen.findByText(".config");
    expect(screen.getByText(".ssh")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide hidden folders" })).toBeTruthy();
    // Hidden rows sort first (the daemon name-sorts), and stay keyboard-reachable like any row.
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual([
      ".config",
      ".ssh",
      "devrepo",
    ]);

    // The browser remounts on every dialog open; the preference must not reset with it.
    first.unmount();
    mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);
    await screen.findByText(".config");
  });

  it("names the hidden count in the empty state so an all-dot directory is not 'empty'", async () => {
    const { bridge } = fakeBridge({
      "": {
        path: "/home/rai",
        home: "/home/rai",
        parent: "/home",
        entries: [{ name: ".git", path: "/home/rai/.git", isRepo: false, unreadable: false }],
      },
    });
    mount(<DirectoryBrowser bridge={bridge} onPathChange={vi.fn()} />);
    await screen.findByText("No folders here (1 hidden)");
  });

  it("offers Browse… only when the host lends a folder dialog, and jumps to its answer", async () => {
    const onPathChange = vi.fn();
    const { bridge, calls } = fakeBridge({
      "": home,
      "/home/rai/dev": {
        path: "/home/rai/dev",
        home: "/home/rai",
        parent: "/home/rai",
        entries: [],
      },
    });
    const bare = mount(<DirectoryBrowser bridge={bridge} onPathChange={onPathChange} />);
    await screen.findByText("dev");
    expect(screen.queryByRole("button", { name: "Browse…" })).toBeNull();
    bare.unmount();

    const pickDirectory = vi.fn(async () => "/home/rai/dev");
    mount(
      <DirectoryBrowser
        bridge={bridge}
        onPathChange={onPathChange}
        pickDirectory={pickDirectory}
      />,
    );
    await screen.findByText("dev");
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));

    await waitFor(() => expect(onPathChange).toHaveBeenCalledWith("/home/rai/dev"));
    // The dialog opened where the user was browsing, and its answer was listed (a real load).
    expect(pickDirectory).toHaveBeenCalledWith({ defaultPath: "/home/rai" });
    expect(calls.at(-1)).toBe("/home/rai/dev");
  });

  it("a cancelled folder dialog changes nothing", async () => {
    const onPathChange = vi.fn();
    const { bridge, calls } = fakeBridge({ "": home });
    mount(
      <DirectoryBrowser
        bridge={bridge}
        onPathChange={onPathChange}
        pickDirectory={async () => null}
      />,
    );
    await screen.findByText("dev");
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));

    // Let the picker's promise settle; a null answer must issue no load.
    await act(() => Promise.resolve());
    expect(calls).toEqual([undefined]);
    expect(onPathChange).toHaveBeenCalledTimes(1);
    expect(screen.getByText("dev")).toBeTruthy();
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
