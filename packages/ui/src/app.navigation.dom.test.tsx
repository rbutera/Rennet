// @vitest-environment happy-dom
import type { Project, ProjectDetail as ProjectDetailData, RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { NAV_HISTORY_STORAGE_KEY, serialize } from "./nav/history";
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
): RennetBridge {
  const invoke = async (name: string, input?: unknown): Promise<unknown> => {
    calls.push({ name, input });
    switch (name) {
      case "app.bootstrap":
        return { review: restored };
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
    fireEvent.click(await waitFor(() => getByRole("button", { name: /project-1/ })));

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
    fireEvent.click(await waitFor(() => getByRole("button", { name: /project-1/ })));

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
    fireEvent.click(await waitFor(() => getByRole("button", { name: /Open review/ })));
    fireEvent.click(getByRole("button", { name: "Choose a repository" }));

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
    fireEvent.click(await waitFor(() => getByRole("button", { name: /Open review/ })));
    await waitFor(() => expect(getByRole("heading", { name: "Start a review." })).not.toBeNull());
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    expect(getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe(crumbBefore);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(await waitFor(() => getByRole("button", { name: /Open Settings/ })));
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
    await waitFor(() => expect(container.querySelector(".command-palette")).not.toBeNull());
    const palette = container.querySelector(".command-palette") as HTMLElement;
    const paletteQueries = within(palette);
    expect(paletteQueries.queryByRole("button", { name: /\/code\/rennet/ })).toBeNull();
    const recentProject = paletteQueries.getByRole("button", { name: /rennet/ });
    expect(recentProject.textContent).toContain("Recent");

    fireEvent.click(recentProject);
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    expect(getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain(project.name);
  });

  it("records only project locations, never an unresolvable review visit", async () => {
    const { container } = mount(<RennetApp bridge={navigationBridge(null)} />);

    await waitFor(() => expect(container.querySelector(".project-row")).not.toBeNull());
    fireEvent.click(container.querySelector(".project-row") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".smart-row-action")).not.toBeNull());
    fireEvent.click(container.querySelector(".smart-row-action") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());
    fireEvent.click(
      within(container.querySelector(".nav-rail") as HTMLElement).getByRole("button", {
        name: "Projects",
      }),
    );
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await waitFor(() => container.querySelector(".command-palette") as HTMLElement);
    expect(within(palette).getByRole("button", { name: /rennet/ })).not.toBeNull();
    expect(within(palette).queryByRole("button", { name: /\/code\/rennet/ })).toBeNull();
  });

  it("a recent Projects jump ascends to the existing root without duplicating it", async () => {
    const { container, getByRole } = mount(<RennetApp bridge={navigationBridge(null)} />);

    await waitFor(() => expect(container.querySelector(".project-row")).not.toBeNull());
    fireEvent.click(container.querySelector(".project-row") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await waitFor(() => container.querySelector(".command-palette") as HTMLElement);
    fireEvent.click(within(palette).getByRole("button", { name: "Recent Projects" }));

    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    const breadcrumb = getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getAllByRole("button")).toHaveLength(1);
    expect((getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
