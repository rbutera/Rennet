// @vitest-environment happy-dom
import type { Project, ProjectDetail as ProjectDetailData, RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
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

function navigationBridge(restored: Review | null): RennetBridge {
  const invoke = async (name: string): Promise<unknown> => {
    switch (name) {
      case "app.bootstrap":
        return { review: restored };
      case "settings.get":
        return { scheme: "dark" };
      case "projects.list":
        return { projects: [project] };
      case "harness.detect":
        return { detected: [] };
      case "project.detail":
        return projectDetail;
      case "review.capture":
      case "review.checkFreshness":
        return { review };
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
  it("opens project → review, then Back lands on project detail rather than the front door", async () => {
    const { container, getByRole } = mount(<RennetApp bridge={navigationBridge(null)} />);

    await waitFor(() => expect(container.querySelector(".project-row")).not.toBeNull());
    fireEvent.click(container.querySelector(".project-row") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    await waitFor(() => expect(container.querySelector(".smart-row-action")).not.toBeNull());

    fireEvent.click(container.querySelector(".smart-row-action") as HTMLButtonElement);
    await waitFor(() => {
      const breadcrumb = getByRole("navigation", { name: "Breadcrumb" });
      expect(breadcrumb.textContent).toContain("project-1");
      expect(breadcrumb.textContent).toContain("review-1");
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
      expect(getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("review-1"),
    );

    fireEvent.keyDown(window, { key: "[", metaKey: true });
    await waitFor(() => expect(container.querySelector(".project-detail")).not.toBeNull());
    expect(container.querySelector(".front-door")).toBeNull();

    fireEvent.keyDown(window, { key: "]", metaKey: true });
    await waitFor(() =>
      expect(getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("review-1"),
    );
    expect(container.querySelector(".project-detail")).toBeNull();
  });
});
