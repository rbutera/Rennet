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
});
