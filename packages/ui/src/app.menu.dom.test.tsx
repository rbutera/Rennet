// @vitest-environment happy-dom
//
// The application menu wired to the registry (#44). This mounts the whole `RennetApp`
// over a bridge that captures the projected menu template and the menu-run listener,
// then proves the renderer half: a `menu:run` runs the SAME handler the palette would,
// a run for an unoffered command is dropped without a throw, and the template reposts
// when the live context changes (and only when it changed).
import type { RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { act, mount, waitFor } from "./test/dom";

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

function menuBridge(): {
  bridge: RennetBridge;
  posted: string[];
  fireMenuRun(id: string): void;
} {
  let listener: ((id: string) => void) | undefined;
  const posted: string[] = [];
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
      };
    throw new Error(`unhandled ${name}`);
  };
  const bridge = {
    invoke,
    updateMenu: (sections: unknown) => posted.push(JSON.stringify(sections)),
    onMenuRun: (fn: (id: string) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as RennetBridge;
  return { bridge, posted, fireMenuRun: (id) => act(() => listener?.(id)) };
}

describe("RennetApp — application menu from the registry (#44)", () => {
  it("posts a template, runs a command on menu:run, drops an unoffered id, and reposts on change", async () => {
    const { bridge, posted, fireMenuRun } = menuBridge();
    const { getByText, queryByText } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(getByText("Canvases")).toBeTruthy());

    // A template was projected to MAIN, carrying registry commands.
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    expect(posted.at(-1)).toContain("nav.settings");
    expect(posted.at(-1)).toContain("palette.toggle");
    const postsBefore = posted.length;

    // A menu:run for an unoffered command is dropped without a throw.
    expect(() => fireMenuRun("nav.canvases-nonexistent")).not.toThrow();
    expect(queryByText("Changes")).toBeNull();

    // A menu:run for a live command runs the SAME handler the palette would: Files view.
    fireMenuRun("nav.files");
    await waitFor(() => expect(getByText("Changes")).toBeTruthy());

    // The context changed (now on Files), so the template reposts — and differs.
    await waitFor(() => expect(posted.length).toBeGreaterThan(postsBefore));
    expect(posted.at(-1)).not.toBe(posted[postsBefore - 1]);
  });
});
