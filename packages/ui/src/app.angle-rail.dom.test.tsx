// @vitest-environment happy-dom
//
// The Files view's Angles rail (critique P2: "vestigial dual review surface").
// The rail was DEAD — six fictional angle names, every row hard-coded "Not run",
// "Manual coverage only" — while the real review ran one tab away. It now derives
// from the SAME state the Canvases view renders: the five real canvas angles, each
// row's state read from the loaded canvas set and the flagged/noise fetches, and a
// row click jumps to that angle's canvas lens over the plumbing that already exists
// (the lifted view store's `setAngle` + the view toggle). These mount the whole
// `RennetApp` over a fake bridge and assert the rail tells the truth in each
// reachable state — loaded, not-yet-landed, failed, and the mechanical outline.
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
      createdAt: "2026-08-18T00:00:00.000Z",
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

const engine = { aiReview: true, claudeAvailable: true, codexAvailable: true };

/** A bridge with per-command overrides atop the honest defaults. */
function bridgeWith(overrides: Record<string, () => unknown>): RennetBridge {
  const invoke = async (name: string): Promise<unknown> => {
    const override = overrides[name];
    if (override) return override();
    if (name === "app.bootstrap") return { review, repositoryPresent: true };
    if (name === "openspec.change" || name === "openspec.coverage") return null;
    return { review };
  };
  return { invoke: invoke as unknown as RennetBridge["invoke"] };
}

/** A fetch that never lands — the honest in-flight state, held open. */
const pendingForever = () => new Promise(() => undefined);

describe("RennetApp — the Files view's Angles rail reflects the real review (critique P2)", () => {
  it("shows the five real angles with honest counts from the loaded state — no placeholders", async () => {
    const canvases = demoCanvases();
    const bridge = bridgeWith({
      "review.canvases": () => ({ canvases, elementDiffs: {}, engine }),
      "flagged.review": () => ({ status: "ok", findings: [], patchsetId: "patch-one" }),
      "noise.review": () => ({ status: "ok", groups: [{}, {}] }),
    });
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Files" }));

    // RED-proof: the pre-fix rail rendered six fictional rows, all "Not run".
    await waitFor(() => {
      expect(container.querySelectorAll(".angle-row")).toHaveLength(5);
    });
    const rail = container.querySelector(".angle-panel");
    const text = rail?.textContent ?? "";
    // The canvas-fed rows carry the REAL element counts of the loaded set…
    expect(text).toContain("Spec");
    expect(text).toContain(`${canvases.spec.layers.analysis.elements.length} elements`);
    expect(text).toContain(`${canvases.decisions.layers.analysis.elements.length} elements`);
    // …and the flagged/noise rows read their own fetch results (their lenses'
    // actual inputs): the noise run grouped 2, the flagged run raised nothing.
    expect(text).toContain("2 groups");
    expect(text).toContain("0 findings");
    // The lies are gone: no dead placeholder copy, no fictional angle names.
    expect(text).not.toContain("Not run");
    expect(text).not.toContain("Manual coverage only");
    expect(text).not.toContain("Security");
  });

  it("is honest before anything lands: pending/running, no counts, no 'Not run'", async () => {
    const bridge = bridgeWith({
      "review.canvases": pendingForever,
      "flagged.review": pendingForever,
      "noise.review": pendingForever,
    });
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(getByRole("tab", { name: "Files" })).toBeDefined());
    fireEvent.click(getByRole("tab", { name: "Files" }));

    const rail = container.querySelector(".angle-panel");
    const text = rail?.textContent ?? "";
    // Canvas-fed rows claim nothing about a run that hasn't landed…
    expect(text).toContain("Pending");
    // …while flagged/noise say Running — their fetches genuinely fired on open.
    expect(text).toContain("Running");
    // No fabricated verdicts either way.
    expect(text).not.toContain("Not run");
    expect(text).not.toContain("element");
  });

  it("shows Failed on every row when the engine and the fetches all fail", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const bridge = bridgeWith({
      "review.canvases": boom,
      "flagged.review": boom,
      "noise.review": boom,
    });
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    // The canvases landing surfaces the honest failure first…
    await waitFor(() => expect(container.querySelector(".canvas-primer")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Files" }));
    // …and the rail carries the same truth per row, never a placebo "Not run".
    await waitFor(() => {
      const states = [...container.querySelectorAll(".angle-state")].map((s) => s.textContent);
      expect(states).toEqual(["Failed", "Failed", "Failed", "Failed", "Failed"]);
    });
  });

  it("names the structural outline when no model ran (real-AI-default)", async () => {
    const bridge = bridgeWith({
      "review.canvases": () => ({
        canvases: demoCanvases(),
        elementDiffs: {},
        engine: { aiReview: false, claudeAvailable: false, codexAvailable: false },
      }),
    });
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".engine-fallback")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Files" }));
    // The rail's counts are diff STRUCTURE under the fallback, and it says so.
    await waitFor(() => {
      expect(container.querySelector(".angle-panel")?.textContent).toContain(
        "Structural outline — not AI findings.",
      );
    });
  });

  it("an angle row navigates to that canvas lens (the existing plumbing, wired)", async () => {
    const bridge = bridgeWith({
      "review.canvases": () => ({ canvases: demoCanvases(), elementDiffs: {}, engine }),
      "flagged.review": () => ({ status: "ok", findings: [], patchsetId: "patch-one" }),
      "noise.review": () => ({ status: "ok", groups: [] }),
    });
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Files" }));
    await waitFor(() => expect(container.querySelectorAll(".angle-row")).toHaveLength(5));

    const specRow = [...container.querySelectorAll(".angle-row")].find((row) =>
      row.textContent?.includes("Spec"),
    );
    expect(specRow).toBeDefined();
    if (specRow) fireEvent.click(specRow);
    // Back on the Canvases view, with the Spec lens active — not the default.
    await waitFor(() => {
      expect(getByRole("tab", { name: "Spec" }).getAttribute("aria-selected")).toBe("true");
    });
    expect(container.querySelector(".canvas-app")).not.toBeNull();
  });
});
