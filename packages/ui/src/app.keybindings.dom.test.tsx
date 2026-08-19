// @vitest-environment happy-dom
//
// Persisted keybinding overrides (#44) applied AT DISPATCH. This mounts the whole
// `RennetApp` over a bridge whose `settings.get` returns a stored override map, lands
// on the review workspace, and proves the effective binding is what key dispatch
// matches: the remapped chord runs the command and the replaced default no longer
// does. Behavioural, never a label check.
import type { RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { fireEvent, mount, waitFor } from "./test/dom";

const review: Review = {
  id: "review",
  repositoryRoot: "/code/rennet",
  activePatchsetId: "patch-one",
  dispositions: [],
  status: "current",
  patchsets: [
    {
      id: "patch-one",
      createdAt: "2026-08-08T00:00:00.000Z",
      repository: {
        id: "repository",
        root: "/code/rennet",
        commonDir: "/code/rennet/.git",
        baseRef: "main",
        baseOid: "1111111111111111",
        headOid: "2222222222222222",
      },
      files: [
        {
          path: "src/x.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: "+const reviewed = true;",
        },
      ],
      rawDiff: "+const reviewed = true;",
      byteLength: 24,
      truncated: false,
    },
  ],
};

// A bridge that lands on the workspace and returns the given keybinding overrides from
// `settings.get`, so the app fetches them and overlays the catalogue defaults.
function bridge(keybindings: Record<string, string | null>): RennetBridge {
  const invoke = async (name: string): Promise<unknown> => {
    if (name === "app.bootstrap") return { review, repositoryPresent: true };
    if (name === "review.checkFreshness") return { review };
    if (name === "flagged.review") return { status: "ok", findings: [] };
    if (name === "noise.review") return { status: "ok", groups: [] };
    if (name === "openspec.change") return null;
    if (name === "settings.get")
      return {
        scheme: "system",
        schemeProvenance: { layer: "builtin", contributions: [] },
        appearanceMalformed: false,
        projects: [],
        keybindings,
      };
    throw new Error(`unhandled ${name}`);
  };
  return { invoke } as RennetBridge;
}

function interactiveBridge(initial: Record<string, string | null> = {}): {
  bridge: RennetBridge;
  writes: { id: string; keybinding?: string | null }[];
} {
  // Bind nav.settings to a chord so tests reach the Settings screen by real dispatch —
  // the workspace has no menu and no settings button (that button lives on the front door).
  const keybindings: Record<string, string | null> = { "nav.settings": "mod+g", ...initial };
  const writes: { id: string; keybinding?: string | null }[] = [];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    if (name === "app.bootstrap") return { review, repositoryPresent: true };
    if (name === "review.checkFreshness") return { review };
    if (name === "review.canvases")
      return { canvases: demoCanvases(), elementDiffs: {}, decisionsRun: { status: "ok" } };
    if (name === "flagged.review") return { status: "ok", findings: [] };
    if (name === "noise.review") return { status: "ok", groups: [] };
    if (name === "openspec.change") return null;
    if (name === "settings.get")
      return {
        scheme: "system",
        schemeProvenance: { layer: "builtin", contributions: [] },
        appearanceMalformed: false,
        projects: [],
        keybindings: { ...keybindings },
      };
    if (name === "settings.setKeybinding") {
      const payload = input as { id: string; keybinding?: string | null };
      writes.push(payload);
      if ("keybinding" in payload) keybindings[payload.id] = payload.keybinding ?? null;
      else delete keybindings[payload.id];
      return { keybindings: { ...keybindings } };
    }
    throw new Error(`unhandled ${name}`);
  };
  return { bridge: { invoke } as RennetBridge, writes };
}

/** Open Settings by dispatching its bound chord (interactiveBridge binds nav.settings). */
function openSettings(): void {
  fireEvent.keyDown(window, { key: "g", metaKey: true });
}

function keyRow(container: HTMLElement, label: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>(".settings-key-row")].find((entry) =>
    entry.querySelector(".settings-k")?.textContent?.includes(label),
  );
  if (!row) throw new Error(`missing key row: ${label}`);
  return row;
}

function clickRowButton(row: HTMLElement, label: string): void {
  const button = [...row.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!button) throw new Error(`missing ${label} button`);
  fireEvent.click(button);
}

describe("RennetApp — keybinding overrides at dispatch (#44)", () => {
  it("a remapped palette.toggle opens on the new chord; the old ⌘K no longer does", async () => {
    const { container, getByText } = mount(
      <RennetApp bridge={bridge({ "palette.toggle": "mod+j" })} />,
    );
    await waitFor(() => expect(getByText("Canvases")).toBeTruthy());
    // The override has been fetched (settings.get resolved) before we press.
    await waitFor(() => expect(getByText("Canvases")).toBeTruthy());

    // The DEFAULT ⌘K is now dead — pressing it does not open the palette.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(container.querySelector(".command-palette")).toBeNull();

    // The remapped ⌘J opens it.
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    await waitFor(() => expect(container.querySelector(".command-palette")).toBeTruthy());
  });

  it("a remapped nav.back runs on its new chord and the default stops navigating", async () => {
    const { getByText, queryByText } = mount(
      <RennetApp bridge={bridge({ "nav.back": "mod+e" })} />,
    );
    await waitFor(() => expect(getByText("Canvases")).toBeTruthy());

    // The default ⌘[ is now dead — pressing it leaves us on the workspace.
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    expect(getByText("Canvases")).toBeTruthy();

    // The remapped ⌘E runs nav.back — the workspace is left (no more Canvases toggle).
    fireEvent.keyDown(window, { key: "e", metaKey: true });
    await waitFor(() => expect(queryByText("Canvases")).toBeNull());
  });

  it("dispatches a bare first binding app-wide but never while typing in an input", async () => {
    const { container, getByLabelText, getByText } = mount(
      <RennetApp bridge={bridge({ "nav.settings": "s" })} />,
    );
    await waitFor(() => expect(getByText("Canvases")).toBeTruthy());

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const search = getByLabelText("Search commands");
    fireEvent.keyDown(search, { key: "s" });
    expect(container.querySelector(".settings")).toBeNull();
    fireEvent.keyDown(search, { key: "Escape" });

    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(container.querySelector(".settings")).not.toBeNull());
  });

  it("settings set, unbind, and reset update live dispatch", async () => {
    const harness = interactiveBridge();
    const { container, getByRole, getByLabelText } = mount(<RennetApp bridge={harness.bridge} />);
    await waitFor(() => expect(container.querySelector(".navigation-shell")).not.toBeNull());

    openSettings();
    await waitFor(() => expect(container.querySelector(".settings")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(container.querySelector(".settings-keys")).not.toBeNull());
    clickRowButton(keyRow(container, "Toggle command palette"), "Set");
    fireEvent.keyDown(getByLabelText("Press the new chord for Toggle command palette"), {
      key: "j",
      metaKey: true,
    });
    await waitFor(() => expect(harness.writes).toHaveLength(1));

    fireEvent.click(container.querySelector(".settings-back") as HTMLButtonElement);
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    await waitFor(() => expect(container.querySelector(".command-palette")).not.toBeNull());
    fireEvent.keyDown(getByLabelText("Search commands"), { key: "Escape" });

    openSettings();
    fireEvent.click(getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(container.querySelector(".settings-keys")).not.toBeNull());
    clickRowButton(keyRow(container, "Toggle command palette"), "Unbind");
    await waitFor(() => expect(harness.writes).toHaveLength(2));
    fireEvent.click(container.querySelector(".settings-back") as HTMLButtonElement);
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(container.querySelector(".command-palette")).toBeNull();

    openSettings();
    fireEvent.click(getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(container.querySelector(".settings-keys")).not.toBeNull());
    clickRowButton(keyRow(container, "Toggle command palette"), "Reset");
    await waitFor(() => expect(harness.writes).toHaveLength(3));
    fireEvent.click(container.querySelector(".settings-back") as HTMLButtonElement);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(container.querySelector(".command-palette")).not.toBeNull());
  });

  it("recording mod+k writes once without opening the palette", async () => {
    const harness = interactiveBridge();
    const { container, getByRole, getByLabelText } = mount(<RennetApp bridge={harness.bridge} />);
    await waitFor(() => expect(container.querySelector(".navigation-shell")).not.toBeNull());
    openSettings();
    fireEvent.click(getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(container.querySelector(".settings-keys")).not.toBeNull());
    clickRowButton(keyRow(container, "Back"), "Set");
    fireEvent.keyDown(getByLabelText("Press the new chord for Back"), {
      key: "k",
      metaKey: true,
    });
    await waitFor(() => expect(harness.writes).toHaveLength(1));
    expect(container.querySelector(".command-palette")).toBeNull();
  });

  it("falls back from mod+ end to end and reports the raw invalid override", async () => {
    const harness = interactiveBridge({ "palette.toggle": "mod+" });
    const { container, getByRole } = mount(<RennetApp bridge={harness.bridge} />);
    await waitFor(() => expect(container.querySelector(".navigation-shell")).not.toBeNull());

    // The invalid stored chord falls back to the default ⌘K at dispatch.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(container.querySelector(".command-palette")).not.toBeNull());
    fireEvent.keyDown(container.querySelector(".command-palette-input") as HTMLInputElement, {
      key: "Escape",
    });
    openSettings();
    fireEvent.click(getByRole("tab", { name: "Keyboard" }));
    await waitFor(() =>
      expect(container.querySelector(".settings-key-invalid")?.textContent).toContain("mod+"),
    );
  });

  it("a modified zoom chord handled by Workspace advances exactly one altitude", async () => {
    const harness = interactiveBridge({ "zoom.in": "mod+j" });
    const { container, getByRole } = mount(<RennetApp bridge={harness.bridge} />);
    await waitFor(() =>
      expect(container.querySelector(".zoom-level")?.textContent).toBe("Roll-up"),
    );
    const tab = getByRole("tab", { name: "Decisions" });
    fireEvent.keyDown(tab, { key: "j", metaKey: true });
    expect(container.querySelector(".zoom-level")?.textContent).toBe("Cohort");
  });
});
