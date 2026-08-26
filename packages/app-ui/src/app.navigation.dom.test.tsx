// @vitest-environment happy-dom
import type {
  Project,
  ProjectDetail as ProjectDetailData,
  RennetBridge,
  Review,
} from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { NAV_HISTORY_STORAGE_KEY, parse, serialize } from "./nav/history";
import { fireEvent, mount, waitFor, within } from "./test/dom";

const project: Project = {
  id: "project-1",
  name: "rennet",
  path: "/code/rennet",
  kind: "repo",
  repoCount: 1,
  branchCount: 1,
  primaryBranch: "main",
  openPath: "/code/rennet",
  addedAt: "2026-08-13T00:00:00.000Z",
  source: "local",
};

const review: Review = {
  id: "review-1",
  repositoryRoot: project.openPath,
  activePatchsetId: "patch-one",
  dispositions: [],
  status: "current",
  patchsets: [
    {
      id: "patch-one",
      createdAt: "2026-08-13T00:00:00.000Z",
      repository: {
        id: "repository",
        root: project.openPath,
        commonDir: `${project.openPath}/.git`,
        baseRef: "main",
        baseOid: "1111111111111111",
        headOid: "2222222222222222",
      },
      files: [],
      rawDiff: "",
      byteLength: 0,
      truncated: false,
    },
  ],
};

const directReview: Review = {
  ...review,
  id: "review-from-project-b",
  repositoryRoot: "/code/project-b",
  activePatchsetId: "patch-two",
  patchsets: review.patchsets.map((patchset) => ({
    ...patchset,
    id: "patch-two",
    repository: {
      ...patchset.repository,
      id: "repository-b",
      root: "/code/project-b",
      commonDir: "/code/project-b/.git",
    },
  })),
};

const projectDetail: ProjectDetailData = {
  viewer: { login: "rai" },
  truncated: false,
  locals: [
    {
      id: "local-1",
      branch: "feat/navigation",
      repository: "rennet",
      author: "rai",
      dirty: true,
      ahead: 1,
      behind: 0,
      stage: "captured",
      lastActivityAt: "2026-08-13T00:00:00.000Z",
    },
  ],
  prs: [],
};

function navigationBridge(
  restored: Review | null,
  calls: Array<{ name: string; input: unknown }> = [],
  opts: {
    repositoryPresent?: boolean;
    bootstrapRepositoryPresent?: boolean;
    loadPending?: boolean;
  } = {},
): RennetBridge {
  const invoke = async (name: string, input?: unknown): Promise<unknown> => {
    calls.push({ name, input });
    switch (name) {
      case "app.bootstrap":
        return {
          review: restored,
          repositoryPresent: restored ? (opts.bootstrapRepositoryPresent ?? true) : false,
        };
      case "review.load": {
        if (opts.loadPending) return new Promise<never>(() => undefined);
        const id = (input as { reviewId?: string }).reviewId;
        return {
          review: id === directReview.id ? directReview : review,
          repositoryPresent: opts.repositoryPresent ?? true,
        };
      }
      case "settings.get":
        return {
          scheme: "dark",
          schemeProvenance: { layer: "builtin", contributions: [] },
          appearanceMalformed: false,
          projects: [],
        };
      case "projects.list":
        return { projects: [project] };
      case "harness.detect":
        return { detected: [] };
      case "project.detail":
        return projectDetail;
      case "fs.listDir":
        // The in-app directory picker modal browses here (the native OS dialog is retired):
        // answer with the target root so the pick resolves to it and the capture proceeds.
        return {
          result: {
            path: directReview.repositoryRoot,
            home: directReview.repositoryRoot,
            parent: null,
            entries: [],
          },
        };
      case "repository.choose":
        return { path: directReview.repositoryRoot };
      case "review.capture":
        return {
          review:
            (input as { repoPath?: string }).repoPath === directReview.repositoryRoot
              ? directReview
              : review,
        };
      case "review.checkFreshness":
        return {
          review:
            (input as { reviewId?: string }).reviewId === directReview.id ? directReview : review,
        };
      case "review.canvases":
        return { canvases: demoCanvases(), elementDiffs: {} };
      case "flagged.review":
        return { status: "ok", findings: [] };
      case "noise.review":
        return { status: "ok", groups: [] };
      case "openspec.change":
        return null;
      default:
        return {};
    }
  };
  return { invoke: invoke as unknown as RennetBridge["invoke"] };
}

// These tests seed the persisted navigation blob (recents + the v3 back/forward
// stack). Clear it after each so a persisted stack never leaks into another test file
// running in the same worker and hijacks its boot restore.
afterEach(() => localStorage.clear());

describe("RennetApp navigation spine", () => {
  it("shows only the Projects root crumb while bootstrap is still loading", () => {
    const pending = new Promise<never>(() => undefined);
    const invoke = (name: string): Promise<unknown> => {
      if (name === "app.bootstrap") return pending;
      if (name === "settings.get") {
        return Promise.resolve({
          scheme: "dark",
          schemeProvenance: { layer: "builtin", contributions: [] },
          appearanceMalformed: false,
          projects: [],
        });
      }
      return Promise.resolve({});
    };
    const { getByRole, getByText } = mount(
      <RennetApp bridge={{ invoke: invoke as unknown as RennetBridge["invoke"] }} />,
    );

    expect(getByText("Restoring local review…")).not.toBeNull();
    const breadcrumb = getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getAllByRole("button")).toHaveLength(1);
    expect(breadcrumb.textContent).toContain("Projects");
  });

  it("reloads a persisted recent project before navigating to its renderable surface", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    localStorage.setItem(
      NAV_HISTORY_STORAGE_KEY,
      serialize([{ kind: "project", projectId: project.id }]),
    );
    const { container, getByRole } = mount(<RennetApp bridge={navigationBridge(null, calls)} />);

    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(await waitFor(() => getByRole("option", { name: /project-1/ })));

    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    expect(calls).toContainEqual({
      name: "project.detail",
      input: { projectId: project.id },
    });
    expect(container.querySelector(".project-detail-name")?.textContent).toBe(project.name);
    expect(container.querySelector(".canvas-app")).toBeNull();
  });

  it("keeps the current surface and reports an error when a recent project cannot reload", async () => {
    localStorage.setItem(
      NAV_HISTORY_STORAGE_KEY,
      serialize([{ kind: "project", projectId: project.id }]),
    );
    const fallback = navigationBridge(null);
    const invoke = async (name: string, input?: unknown): Promise<unknown> => {
      if (name === "project.detail") throw new Error("Project detail unavailable.");
      return (fallback.invoke as (command: string, value?: unknown) => Promise<unknown>)(
        name,
        input,
      );
    };
    const { container, getByRole, getByText } = mount(
      <RennetApp bridge={{ invoke: invoke as unknown as RennetBridge["invoke"] }} />,
    );

    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(await waitFor(() => getByRole("option", { name: /project-1/ })));

    await waitFor(() => expect(getByText("Project detail unavailable.")).not.toBeNull());
    expect(container.querySelector(".front-door")).not.toBeNull();
    expect(container.querySelector(".project-detail")).toBeNull();
  });

  it("opens project → review, then Back lands on project detail rather than the front door", async () => {
    const { container, getByRole } = mount(<RennetApp bridge={navigationBridge(null)} />);

    await waitFor(() => expect(container.querySelector(".project-row")).not.toBeNull());
    fireEvent.click(container.querySelector(".project-row") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    await waitFor(() => expect(container.querySelector(".smart-row-action")).not.toBeNull());

    fireEvent.click(container.querySelector(".smart-row-action") as HTMLButtonElement);
    await waitFor(() => {
      const breadcrumb = getByRole("navigation", { name: "Breadcrumb" });
      expect(breadcrumb.textContent).toContain("rennet");
      expect(breadcrumb.textContent).toContain(project.openPath);
      expect(breadcrumb.textContent).not.toContain("project-1");
      expect(breadcrumb.textContent).not.toContain("review-1");
    });

    fireEvent.click(getByRole("button", { name: "Back" }));
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    expect(container.querySelector(".front-door")).toBeNull();
  });

  it("switching a lens leaves the breadcrumb unchanged and records no history", async () => {
    const { container, getByRole } = mount(<RennetApp bridge={navigationBridge(review)} />);

    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());
    const breadcrumb = getByRole("navigation", { name: "Breadcrumb" });
    const before = breadcrumb.textContent;
    const beforeLength = within(breadcrumb).getAllByRole("button").length;

    fireEvent.click(getByRole("tab", { name: "Spec" }));
    await waitFor(() =>
      expect(container.querySelector(".lens-tab.is-active")?.textContent).toBe("Spec"),
    );
    expect(breadcrumb.textContent).toBe(before);
    expect(within(breadcrumb).getAllByRole("button")).toHaveLength(beforeLength);

    fireEvent.click(getByRole("button", { name: "Back" }));
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
  });

  it("⌘[ and ⌘] use the same Back/Forward history paths", async () => {
    const { container, getByRole } = mount(<RennetApp bridge={navigationBridge(null)} />);

    await waitFor(() => expect(container.querySelector(".project-row")).not.toBeNull());
    fireEvent.click(container.querySelector(".project-row") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".smart-row-action")).not.toBeNull());
    fireEvent.click(container.querySelector(".smart-row-action") as HTMLButtonElement);
    await waitFor(() =>
      expect(getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain(
        review.repositoryRoot,
      ),
    );

    fireEvent.keyDown(window, { key: "[", metaKey: true });
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    expect(container.querySelector(".front-door")).toBeNull();

    fireEvent.keyDown(window, { key: "]", metaKey: true });
    await waitFor(() =>
      expect(getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain(
        review.repositoryRoot,
      ),
    );
    expect(container.querySelector(".project-detail")).toBeNull();
  });

  it("roots an arbitrary direct-entry capture at Projects instead of the open project", async () => {
    const { container, getByRole } = mount(<RennetApp bridge={navigationBridge(null)} />);

    await waitFor(() => expect(container.querySelector(".project-row")).not.toBeNull());
    fireEvent.click(container.querySelector(".project-row") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(await waitFor(() => getByRole("option", { name: /Open review/ })));
    fireEvent.click(getByRole("button", { name: "Choose a repository" }));
    // The in-app picker modal opens; pick the browsed path, then Continue captures it.
    await waitFor(() =>
      expect((getByRole("button", { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(getByRole("button", { name: /Continue/ }));

    await waitFor(() => {
      const breadcrumb = getByRole("navigation", { name: "Breadcrumb" });
      expect(breadcrumb.textContent).toContain(directReview.repositoryRoot);
      expect(breadcrumb.textContent).not.toContain(project.id);
    });
    fireEvent.click(getByRole("button", { name: "Back" }));
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    expect(container.querySelector(".project-detail")).toBeNull();
  });

  it("⌘[ closes direct-entry and Settings overlays without changing the underlying surface", async () => {
    const { container, getByRole, queryByRole } = mount(
      <RennetApp bridge={navigationBridge(null)} />,
    );

    await waitFor(() => expect(container.querySelector(".project-row")).not.toBeNull());
    fireEvent.click(container.querySelector(".project-row") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    const crumbBefore = getByRole("navigation", { name: "Breadcrumb" }).textContent;

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(await waitFor(() => getByRole("option", { name: /Open review/ })));
    await waitFor(() => expect(getByRole("heading", { name: "Start a review." })).not.toBeNull());
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    expect(getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe(crumbBefore);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(await waitFor(() => getByRole("option", { name: /Open Settings/ })));
    await waitFor(() => expect(getByRole("heading", { name: "Settings" })).not.toBeNull());
    fireEvent.keyDown(window, { key: "[", metaKey: true });

    await waitFor(() => expect(queryByRole("heading", { name: "Settings" })).toBeNull());
    expect(container.querySelector(".project-detail")).not.toBeNull();
    expect(getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe(crumbBefore);
  });

  it("lists resolved recent locations, excludes the current surface, and navigates to one", async () => {
    const { container, getByRole } = mount(<RennetApp bridge={navigationBridge(null)} />);

    await waitFor(() => expect(container.querySelector(".project-row")).not.toBeNull());
    fireEvent.click(container.querySelector(".project-row") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".smart-row-action")).not.toBeNull());
    fireEvent.click(container.querySelector(".smart-row-action") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(document.querySelector(".command-palette")).not.toBeNull());
    const palette = document.querySelector(".command-palette") as HTMLElement;
    const paletteQueries = within(palette);
    expect(paletteQueries.queryByRole("option", { name: /\/code\/rennet/ })).toBeNull();
    const recentProject = paletteQueries.getByRole("option", { name: /rennet/ });
    expect(recentProject.textContent).toContain("Recent");

    fireEvent.click(recentProject);
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    const breadcrumb = getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb.textContent).toContain(project.name);
    expect(breadcrumb.textContent).not.toContain(review.repositoryRoot);
    expect(within(breadcrumb).getAllByRole("button")).toHaveLength(2);
  });

  it("records only project locations, never an unresolvable review visit", async () => {
    const { container } = mount(<RennetApp bridge={navigationBridge(null)} />);

    await waitFor(() => expect(container.querySelector(".project-row")).not.toBeNull());
    fireEvent.click(container.querySelector(".project-row") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".smart-row-action")).not.toBeNull());
    fireEvent.click(container.querySelector(".smart-row-action") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());
    fireEvent.click(
      within(container.querySelector(".nav-breadcrumb") as HTMLElement).getByRole("button", {
        name: /Projects/,
      }),
    );
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await waitFor(() => document.querySelector(".command-palette") as HTMLElement);
    expect(within(palette).getByRole("option", { name: /rennet/ })).not.toBeNull();
    expect(within(palette).queryByRole("option", { name: /\/code\/rennet/ })).toBeNull();
  });

  it("a recent Projects jump ascends to the existing root without duplicating it", async () => {
    const { container, getByRole } = mount(<RennetApp bridge={navigationBridge(null)} />);

    await waitFor(() => expect(container.querySelector(".project-row")).not.toBeNull());
    fireEvent.click(container.querySelector(".project-row") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await waitFor(() => document.querySelector(".command-palette") as HTMLElement);
    fireEvent.click(within(palette).getByRole("option", { name: "Recent Projects" }));

    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    const breadcrumb = getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getAllByRole("button")).toHaveLength(1);
    expect((getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("RennetApp navigation-stack restore across restarts (#324/#297)", () => {
  function seedStack(
    stack: Array<Record<string, unknown>>,
    future: Array<Record<string, unknown>> = [],
  ) {
    localStorage.clear();
    localStorage.setItem(
      NAV_HISTORY_STORAGE_KEY,
      serialize([{ kind: "project", projectId: project.id }], stack as never, future as never),
    );
  }

  it("persists navigation performed by the mounted app and restores it after a real remount", async () => {
    localStorage.clear();
    const first = mount(<RennetApp bridge={navigationBridge(null)} />);
    await waitFor(() => expect(first.container.querySelector(".project-row")).not.toBeNull());
    fireEvent.click(first.container.querySelector(".project-row") as HTMLButtonElement);
    await waitFor(() => expect(first.container.querySelector(".project-detail")).not.toBeNull());
    await waitFor(() =>
      expect(parse(localStorage.getItem(NAV_HISTORY_STORAGE_KEY)).stack).toEqual([
        { kind: "projects" },
        { kind: "project", projectId: project.id },
      ]),
    );

    first.unmount();
    const calls: Array<{ name: string; input: unknown }> = [];
    const second = mount(<RennetApp bridge={navigationBridge(null, calls)} />);

    await waitFor(() => expect(second.container.querySelector(".project-detail")).not.toBeNull());
    expect(calls).toContainEqual({ name: "project.detail", input: { projectId: project.id } });
    expect(second.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain(
      project.name,
    );
  });

  it("restores a persisted projects › project › review stack on boot and Back rehydrates the project", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    seedStack([
      { kind: "projects" },
      { kind: "project", projectId: project.id },
      { kind: "review", reviewId: review.id },
    ]);
    // No bootstrap review: the persisted stack alone drives the restore, landing on
    // the review via review.load.
    const { container, getByRole } = mount(<RennetApp bridge={navigationBridge(null, calls)} />);

    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());
    expect(calls).toContainEqual(
      expect.objectContaining({
        name: "review.load",
        input: expect.objectContaining({ reviewId: review.id }),
      }),
    );
    const breadcrumb = getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb.textContent).toContain(project.name);
    expect(breadcrumb.textContent).toContain(review.repositoryRoot);

    fireEvent.click(getByRole("button", { name: "Back" }));
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    expect(calls).toContainEqual({ name: "project.detail", input: { projectId: project.id } });
    expect(container.querySelector(".canvas-app")).toBeNull();
  });

  it("shows the loading treatment under the review crumb while the tip rehydrates — never another surface's content (#305)", async () => {
    seedStack([
      { kind: "projects" },
      { kind: "project", projectId: project.id },
      { kind: "review", reviewId: review.id },
    ]);
    // review.load never resolves: we must see the review crumb + a loading state, and
    // NEVER the front door / project detail / a stale review rendered under the crumb.
    const { container, getByRole } = mount(
      <RennetApp bridge={navigationBridge(null, [], { loadPending: true })} />,
    );

    // The tip crumb shows the review (by id until its label resolves) — proof we are
    // under the review's OWN crumb, not another surface's.
    await waitFor(() => {
      const breadcrumb = getByRole("navigation", { name: "Breadcrumb" });
      expect(breadcrumb.textContent).toContain(review.id);
    });
    expect(container.querySelector(".canvas-app")).toBeNull();
    expect(container.querySelector(".project-detail")).toBeNull();
    expect(container.querySelector(".front-door")).toBeNull();
    expect(container.textContent).toContain("Reopening");
  });

  it("floors to the nearest restorable ancestor when a restored tip cannot reopen", async () => {
    seedStack(
      [
        { kind: "projects" },
        { kind: "project", projectId: project.id },
        { kind: "review", reviewId: review.id },
      ],
      [{ kind: "draft", reviewId: review.id }],
    );
    // Both the review AND the project fail to reopen → the app floors all the way to
    // the Projects root, naming what could not be reopened.
    const calls: Array<{ name: string; input: unknown }> = [];
    const invoke = async (name: string, input?: unknown): Promise<unknown> => {
      calls.push({ name, input });
      if (name === "review.load") throw new Error("This review could not be reopened.");
      if (name === "project.detail") throw new Error("This project could not be reopened.");
      return (
        navigationBridge(null).invoke as (command: string, value?: unknown) => Promise<unknown>
      )(name, input);
    };
    const { container, getByText } = mount(
      <RennetApp bridge={{ invoke: invoke as unknown as RennetBridge["invoke"] }} />,
    );

    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    expect(getByText("This project could not be reopened.")).not.toBeNull();
    await waitFor(() => {
      const persisted = parse(localStorage.getItem(NAV_HISTORY_STORAGE_KEY));
      expect(persisted.stack).toEqual([{ kind: "projects" }]);
      expect(persisted.future).toEqual([]);
    });
  });

  it("a deleted latest worktree restored from bootstrap shows missing status and starts no live work", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    seedStack([{ kind: "projects" }, { kind: "review", reviewId: review.id }]);
    const { container, getByText } = mount(
      <RennetApp bridge={navigationBridge(review, calls, { bootstrapRepositoryPresent: false })} />,
    );

    await waitFor(() => expect(getByText(/original worktree is gone/i)).not.toBeNull());
    expect(container.querySelector(".canvas-app")).toBeNull();
    expect(calls.some((call) => call.name === "review.load")).toBe(false);
    expect(calls.some((call) => call.name === "review.canvases")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(calls.some((call) => call.name === "review.checkFreshness")).toBe(false);
  });

  it("a reopened review whose worktree is gone shows the plain status, runs no freshness poll, and offers no live canvases", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    seedStack([
      { kind: "projects" },
      { kind: "project", projectId: project.id },
      { kind: "review", reviewId: review.id },
    ]);
    const { container, getByText } = mount(
      <RennetApp bridge={navigationBridge(null, calls, { repositoryPresent: false })} />,
    );

    await waitFor(() => expect(getByText(/original worktree is gone/i)).not.toBeNull());
    // The live review surfaces are honestly unavailable — no doomed canvas load fired.
    expect(container.querySelector(".canvas-app")).toBeNull();
    expect(calls.some((call) => call.name === "review.canvases")).toBe(false);
    // No working-tree freshness poll runs against the missing root.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(calls.some((call) => call.name === "review.checkFreshness")).toBe(false);
  });
});

describe("RennetApp chrome layout", () => {
  it("offsets the scrolling content below the fixed titlebar so no view is obscured", async () => {
    const { container } = mount(<RennetApp bridge={navigationBridge(null)} />);
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());

    const titlebar = container.querySelector(".navigation-titlebar") as HTMLElement;
    const content = container.querySelector(".navigation-surface-content") as HTMLElement;
    expect(titlebar).not.toBeNull();
    expect(content).not.toBeNull();

    // The titlebar is position:fixed (the macOS drag surface reserving the traffic-
    // light inset), so it is out of flow: the content needs a top offset at least as
    // tall as the bar, or its first rows render hidden underneath it. Compare the two
    // ramp steps directly so shrinking the pad (or growing the bar) past overlap reds.
    expect(titlebar.className).toContain("fixed");
    const barHeight = Number(/\bh-(\d+)\b/.exec(titlebar.className)?.[1]);
    const topPad = Number(/\bpt-(\d+)\b/.exec(content.className)?.[1]);
    expect(barHeight).toBeGreaterThan(0);
    expect(topPad).toBeGreaterThanOrEqual(barHeight);
  });

  it("renders Back/Forward history controls as lucide icons, not text arrows", async () => {
    const { container, getByRole } = mount(<RennetApp bridge={navigationBridge(null)} />);
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());

    for (const name of ["Back", "Forward"]) {
      const button = getByRole("button", { name });
      const svg = button.querySelector("svg");
      expect(svg, `${name} should render a lucide svg`).not.toBeNull();
      // The Icon wrapper stamps the 1.6px product stroke on every lucide glyph.
      expect(svg?.getAttribute("stroke-width")).toBe("1.6");
      // No bespoke text arrow (← / →) left behind by the pre-lucide chrome.
      expect(button.textContent ?? "").not.toMatch(/[←→]/);
    }
  });
});
