// @vitest-environment happy-dom
//
// The in-app directory browser (source-aware project selection, task 5): mounts
// the real component over a fake `RennetBridge` recording `fs.listDir` calls,
// asserting the rendered listing/breadcrumb/up-affordance and the `onPathChange`
// seam behaviourally — matching the house pattern in front-door.dom.test.tsx.
import type { CommandInput, FsListDirResult, RennetBridge } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount, screen, waitFor } from "../test/dom";
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

describe("DirectoryBrowser", () => {
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
});
