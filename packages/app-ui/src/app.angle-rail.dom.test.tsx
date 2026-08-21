// @vitest-environment happy-dom
//
// The Files view's Angles rail (critique P2: "vestigial dual review surface").
// The rail was DEAD — six fictional angle names, every row hard-coded "Not run",
// "Manual coverage only" — while the real review ran one tab away. It now derives
// from the SAME state the Canvases view renders: the five real canvas angles, each
// row's state read from the loaded canvas set and the flagged/noise fetches, and a
// row click jumps to that angle's canvas lens over the plumbing that already exists
// (the lifted view store's `setAngle` + the view toggle). These mount the whole
// `RennetApp` over a fake bridge and assert — PER ROW, each against a DISTINCT
// source value so no single hard-coded row can pass — that the rail tells the
// truth in every reachable state: loaded, not-yet-landed, failed, the mechanical
// outline, a failed Decisions runner beside a landed set, a gone repository, and
// the staleness edges (regenerate / review switch while on Files).
import type { Project, ProjectDetail as ProjectDetailData, RennetBridge } from "@rennet/protocol";
import type { Canvas, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { fireEvent, mount, waitFor } from "./test/dom";

/** The one-project world the review-switch test walks through. */
const project: Project = {
  id: "project-1",
  name: "rennet",
  path: "/code/rennet",
  kind: "repo",
  repoCount: 1,
  branchCount: 1,
  primaryBranch: "main",
  openPath: "/code/rennet",
  addedAt: "2026-08-18T00:00:00.000Z",
  source: "local",
};

const projectDetail: ProjectDetailData = {
  viewer: { login: "rai" },
  truncated: false,
  locals: [
    {
      id: "local-1",
      branch: "feat/rail",
      repository: "rennet",
      author: "rai",
      dirty: true,
      ahead: 1,
      behind: 0,
      stage: "captured",
      lastActivityAt: "2026-08-18T00:00:00.000Z",
    },
  ],
  prs: [],
};

function makeReview(id: string, patchsetIds: readonly string[], active: string): Review {
  return {
    id,
    repositoryRoot: "/code/rennet",
    activePatchsetId: active,
    dispositions: [],
    status: "current",
    patchsets: patchsetIds.map((patchsetId) => ({
      id: patchsetId,
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
    })),
  };
}

const review = makeReview("review", ["patch-one"], "patch-one");

const engine = { aiReview: true, claudeAvailable: true, codexAvailable: true };

/** Cap a canvas's analysis elements so every rail row gets a DISTINCT count. */
function withElements(canvas: Canvas, n: number): Canvas {
  return {
    ...canvas,
    layers: {
      ...canvas.layers,
      analysis: {
        ...canvas.layers.analysis,
        elements: canvas.layers.analysis.elements.slice(0, n),
      },
    },
  };
}

/** The distinct-per-row canvas fixture: spec 1, sequence 2, decisions untouched. */
function distinctCanvases() {
  const canvases = demoCanvases();
  return {
    ...canvases,
    spec: withElements(canvases.spec, 1),
    sequence: withElements(canvases.sequence, 2),
  };
}

/** 4 findings whose agreement never triggers the adjudication poll. */
const fourFindings = Array.from({ length: 4 }, () => ({ agreement: { kind: "agree" } }));

/** A bridge with per-command overrides atop the honest defaults. */
function bridgeWith(
  overrides: Record<string, (input: unknown) => unknown>,
  calls: string[] = [],
): RennetBridge {
  const invoke = async (name: string, input?: unknown): Promise<unknown> => {
    calls.push(name);
    const override = overrides[name];
    if (override) return override(input);
    if (name === "app.bootstrap") return { review, repositoryPresent: true };
    if (name === "openspec.change" || name === "openspec.coverage") return null;
    return { review };
  };
  return { invoke: invoke as unknown as RennetBridge["invoke"] };
}

/** A fetch that never lands — the honest in-flight state, held open. */
const pendingForever = () => new Promise(() => undefined);

/** The state text of ONE rail row, addressed by its angle label. */
function rowState(container: Element, label: string): string | null | undefined {
  const row = [...container.querySelectorAll(".angle-row")].find(
    (candidate) => candidate.querySelector("span")?.textContent === label,
  );
  expect(row, `rail row "${label}" exists`).toBeDefined();
  return row?.querySelector(".angle-state")?.textContent;
}

describe("RennetApp — the Files view's Angles rail reflects the real review (critique P2)", () => {
  it("shows the five real angles, each row's DISTINCT honest count from its own source", async () => {
    const canvases = distinctCanvases();
    const bridge = bridgeWith({
      "review.canvases": () => ({ canvases, elementDiffs: {}, engine }),
      "flagged.review": () => ({ status: "ok", findings: fourFindings, patchsetId: "patch-one" }),
      "noise.review": () => ({ status: "ok", groups: [{}, {}, {}] }),
    });
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Files" }));

    // RED-proof: the pre-fix rail rendered six fictional rows, all "Not run".
    await waitFor(() => {
      expect(container.querySelectorAll(".angle-row")).toHaveLength(5);
    });
    // Per-row, each against a distinct source value — hard-coding ANY one row's
    // state (the Codex mutation: Sequence pinned to "Failed") reds its assertion.
    await waitFor(() => {
      expect(rowState(container, "Spec")).toBe("1 element");
      expect(rowState(container, "Sequence")).toBe("2 elements");
      expect(rowState(container, "Decisions")).toBe(
        `${canvases.decisions.layers.analysis.elements.length} elements`,
      );
      expect(rowState(container, "Noise")).toBe("3 groups");
      expect(rowState(container, "Flagged")).toBe("4 findings");
    });
    // The lies are gone: no dead placeholder copy, no fictional angle names.
    const text = container.querySelector(".angle-panel")?.textContent ?? "";
    expect(text).not.toContain("Not run");
    expect(text).not.toContain("Manual coverage only");
    expect(text).not.toContain("Security");
  });

  it("a failed Decisions runner shows Failed on that row while siblings keep their counts", async () => {
    const canvases = distinctCanvases();
    const bridge = bridgeWith({
      "review.canvases": () => ({
        canvases,
        elementDiffs: {},
        engine,
        decisionsRun: { status: "failed", reason: "the runner crashed" },
      }),
      "flagged.review": () => ({ status: "ok", findings: fourFindings, patchsetId: "patch-one" }),
      "noise.review": () => ({ status: "ok", groups: [{}, {}, {}] }),
    });
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Files" }));

    await waitFor(() => {
      // The crashed pass is named — never an element count dressing it as a run…
      expect(rowState(container, "Decisions")).toBe("Failed");
      // …while the siblings of the SAME landed set keep their honest counts.
      expect(rowState(container, "Spec")).toBe("1 element");
      expect(rowState(container, "Sequence")).toBe("2 elements");
      expect(rowState(container, "Noise")).toBe("3 groups");
      expect(rowState(container, "Flagged")).toBe("4 findings");
    });
  });

  it("is honest before anything lands: pending/running per row, no counts, no 'Not run'", async () => {
    const bridge = bridgeWith({
      "review.canvases": pendingForever,
      "flagged.review": pendingForever,
      "noise.review": pendingForever,
    });
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(getByRole("tab", { name: "Files" })).toBeDefined());
    fireEvent.click(getByRole("tab", { name: "Files" }));

    // Canvas-fed rows claim nothing about a run that hasn't landed…
    expect(rowState(container, "Spec")).toBe("Pending");
    expect(rowState(container, "Sequence")).toBe("Pending");
    expect(rowState(container, "Decisions")).toBe("Pending");
    // …while flagged/noise say Running — their fetches genuinely fired on open.
    expect(rowState(container, "Noise")).toBe("Running");
    expect(rowState(container, "Flagged")).toBe("Running");
    // No fabricated verdicts either way.
    const text = container.querySelector(".angle-panel")?.textContent ?? "";
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

  it("shows Unavailable on ALL five rows when the repository is gone, and fires no fetch", async () => {
    const calls: string[] = [];
    const bridge = bridgeWith(
      { "app.bootstrap": () => ({ review, repositoryPresent: false }) },
      calls,
    );
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(getByRole("tab", { name: "Files" })).toBeDefined());
    fireEvent.click(getByRole("tab", { name: "Files" }));

    // Every row — including flagged/noise, whose fetches never fired: "Running"
    // (or a doomed model invocation) would be a lie against a path that isn't there.
    await waitFor(() => {
      const states = [...container.querySelectorAll(".angle-state")].map((s) => s.textContent);
      expect(states).toEqual([
        "Unavailable",
        "Unavailable",
        "Unavailable",
        "Unavailable",
        "Unavailable",
      ]);
    });
    expect(calls).not.toContain("flagged.review");
    expect(calls).not.toContain("noise.review");
    expect(calls).not.toContain("review.canvases");
  });

  it("a regenerate while on Files drops the canvas rows to Pending and re-runs flagged/noise", async () => {
    const invalid: Review = {
      ...makeReview("review", ["patch-one", "patch-two"], "patch-one"),
      status: "invalid",
      pendingPatchsetId: "patch-two",
    };
    const regenerated = makeReview("review", ["patch-one", "patch-two"], "patch-two");
    const calls: string[] = [];
    let flaggedCalls = 0;
    let noiseCalls = 0;
    const bridge = bridgeWith(
      {
        "app.bootstrap": () => ({ review: invalid, repositoryPresent: true }),
        "review.canvases": () => ({ canvases: distinctCanvases(), elementDiffs: {}, engine }),
        // First fetch lands (patch-one's result); the post-regenerate re-runs pend,
        // so the rail's honest in-flight state is observable.
        "flagged.review": () =>
          ++flaggedCalls === 1
            ? { status: "ok", findings: fourFindings, patchsetId: "patch-one" }
            : pendingForever(),
        "noise.review": () =>
          ++noiseCalls === 1 ? { status: "ok", groups: [{}, {}, {}] } : pendingForever(),
        "review.regenerate": () => ({ review: regenerated }),
        "review.checkFreshness": () => ({ review: regenerated }),
      },
      calls,
    );
    const { container, getByRole, getByText } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Files" }));
    await waitFor(() => {
      expect(rowState(container, "Spec")).toBe("1 element");
      expect(rowState(container, "Flagged")).toBe("4 findings");
    });

    // Regenerate activates patch-two under the SAME reviewId. The view-gated
    // canvas load does NOT re-fire on Files — the old set is simply no longer
    // about the active patchset, and the rail must say so.
    fireEvent.click(getByText("Regenerate affected review"));
    await waitFor(() => {
      // Canvas-fed rows drop to the honest Pending — the stale "ran, N elements"
      // (the pre-fix bug) never lingers over a diff that was never enriched…
      expect(rowState(container, "Spec")).toBe("Pending");
      expect(rowState(container, "Sequence")).toBe("Pending");
      expect(rowState(container, "Decisions")).toBe("Pending");
      // …and the patchset-keyed flagged/noise fetches cleared and re-ran.
      expect(rowState(container, "Flagged")).toBe("Running");
      expect(rowState(container, "Noise")).toBe("Running");
    });
    expect(flaggedCalls).toBe(2);
    expect(noiseCalls).toBe(2);
    expect(container.querySelector(".angle-panel")?.textContent).not.toContain("element");
  });

  it("a review switch while on Files never paints the previous review's bundle", async () => {
    // The real switch path (the nav topology allows one review per route): review A
    // → Back to Projects → project detail → open the project's local work, which
    // captures review B. The view stays "review" (Files) the whole way, so B's
    // canvases NEVER fetch — the rail must show B's honest Pending, not A's counts.
    const reviewA = makeReview("review-a", ["patch-a"], "patch-a");
    const reviewB = makeReview("review-b", ["patch-b"], "patch-b");
    const bridge = bridgeWith({
      "app.bootstrap": () => ({ review: reviewA, repositoryPresent: true }),
      "review.canvases": () => ({ canvases: distinctCanvases(), elementDiffs: {}, engine }),
      "flagged.review": pendingForever,
      "noise.review": pendingForever,
      "review.checkFreshness": (input) => ({
        review: (input as { reviewId: string }).reviewId === "review-b" ? reviewB : reviewA,
      }),
      "projects.list": () => ({ projects: [project] }),
      "harness.detect": () => ({ detected: [] }),
      "project.detail": () => projectDetail,
      "review.capture": () => ({ review: reviewB }),
    });
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Files" }));
    await waitFor(() => expect(rowState(container, "Spec")).toBe("1 element"));

    fireEvent.click(getByRole("button", { name: "Back" }));
    await waitFor(() => expect(container.querySelector(".project-row")).not.toBeNull());
    fireEvent.click(container.querySelector(".project-row") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".smart-row-action")).not.toBeNull());
    fireEvent.click(container.querySelector(".smart-row-action") as HTMLButtonElement);

    // Review B is open on the Files view: A's enriched set is not B's — honest
    // Pending under B's identity, never A's counts.
    await waitFor(() => {
      expect(rowState(container, "Spec")).toBe("Pending");
      expect(rowState(container, "Sequence")).toBe("Pending");
      expect(rowState(container, "Decisions")).toBe("Pending");
    });
    expect(container.querySelector(".angle-panel")?.textContent).not.toContain("element");
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
