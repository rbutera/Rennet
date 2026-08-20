// @vitest-environment happy-dom
//
// Project detail: the unified smart list (issue #37). This mounts the real
// `ProjectDetail` over a recording fake `RennetBridge` and drives the surface —
// the deduped list renders, the dedupe annotation replaces the second row, the HOT
// default floats a needs-you row up, filters narrow the list, the truncation banner
// shows on a truncated fixture, and Clean up invokes the command. Assertions are
// behavioural (rendered rows, recorded command inputs), not presence-only.
import type {
  Project,
  ProjectDetail as ProjectDetailData,
  ProjectDetailProgressEvent,
  RennetBridge,
} from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, mount, waitFor } from "../test/dom";
import { ProjectDetail } from "./project-detail";

const project: Project = {
  id: "project-1",
  name: "rennet",
  path: "/code/rennet",
  kind: "repo",
  repoCount: 1,
  branchCount: 4,
  primaryBranch: "main",
  openPath: "/code/rennet",
  addedAt: "2026-08-09T00:00:00.000Z",
};

function detail(over: Partial<ProjectDetailData> = {}): ProjectDetailData {
  return {
    viewer: { login: "rai" },
    truncated: false,
    locals: [
      {
        id: "local-unpublished",
        branch: "feat/unpublished",
        repository: "rennet",
        author: "rai",
        dirty: true,
        ahead: 2,
        behind: 0,
        stage: "reviewed",
        lastActivityAt: "2026-08-09T09:00:00.000Z",
      },
      {
        id: "local-front-door",
        branch: "feat/front-door", // dedupes into pr #130
        repository: "rennet",
        author: "rai",
        dirty: false,
        ahead: 0,
        behind: 1,
        stage: "prd",
        lastActivityAt: "2026-08-09T20:00:00.000Z",
      },
      {
        id: "local-merged",
        branch: "feat/merged", // dedupes into merged pr #124
        repository: "rennet",
        author: "rai",
        dirty: false,
        ahead: 0,
        behind: 3,
        stage: "prd",
        lastActivityAt: "2026-08-08T18:00:00.000Z",
      },
    ],
    prs: [
      {
        id: "pr-131",
        number: 131,
        title: "Span disposition re-anchor",
        branch: "fix/span",
        repository: "rennet",
        author: "emma",
        state: "open",
        reviewRequestedFromViewer: true,
        ci: "passing",
        additions: 10,
        deletions: 2,
        changedFiles: 3,
        lastActivityAt: "2026-08-09T08:00:00.000Z",
      },
      {
        id: "pr-130",
        number: 130,
        title: "The front-door shell",
        branch: "feat/front-door",
        repository: "rennet",
        author: "rai",
        state: "open",
        reviewRequestedFromViewer: false,
        ci: "passing",
        additions: 100,
        deletions: 20,
        changedFiles: 12,
        lastActivityAt: "2026-08-09T20:05:00.000Z",
      },
      {
        id: "pr-124",
        number: 124,
        title: "Publish egress",
        branch: "feat/merged",
        repository: "rennet",
        author: "rai",
        state: "merged",
        reviewRequestedFromViewer: false,
        ci: "passing",
        additions: 60,
        deletions: 7,
        changedFiles: 5,
        lastActivityAt: "2026-08-08T18:05:00.000Z",
      },
    ],
    ...over,
  };
}

type CleanupOutcome = "ok" | "not-ok" | "reject";

function fakeBridge(
  data: ProjectDetailData,
  cleanup: CleanupOutcome = "ok",
): {
  bridge: RennetBridge;
  calls: { name: string; input: unknown }[];
} {
  const calls: { name: string; input: unknown }[] = [];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    switch (name) {
      case "project.detail":
        return data;
      case "project.cleanupWorktree":
        if (cleanup === "reject") throw new Error("worktree is dirty");
        return { ok: cleanup === "ok" };
      default:
        return {};
    }
  };
  return { bridge: { invoke: invoke as unknown as RennetBridge["invoke"] }, calls };
}

describe("ProjectDetail — the unified smart list", () => {
  it("renders the unreachable-GitHub hint and still shows local work", async () => {
    const { bridge } = fakeBridge(detail({ prs: [], authUnavailable: "network" }));
    const { container } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={vi.fn()}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector(".project-detail-auth-hint")?.textContent).toContain(
        "GitHub is unreachable right now — showing local work only.",
      ),
    );
    // The local half still renders — degraded, never empty-or-hung.
    expect(container.querySelectorAll(".smart-row").length).toBeGreaterThan(0);
  });

  it("streams per-repo PR progress into an honest determinate banner", async () => {
    let emit: ((event: ProjectDetailProgressEvent) => void) | undefined;
    const localData = detail({ prs: [] });
    const bridge = {
      invoke: (async (name: string, input: { localOnly?: boolean }) => {
        if (name === "project.detail") {
          if (input.localOnly) return localData;
          return new Promise(() => undefined); // full fetch stays pending → banner up
        }
        return {};
      }) as unknown as RennetBridge["invoke"],
      onProjectDetailProgress: (
        _id: string,
        listener: (event: ProjectDetailProgressEvent) => void,
      ) => {
        emit = listener;
        return () => undefined;
      },
    } as RennetBridge;
    const { container } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={vi.fn()}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector(".project-detail-prs-pending")).not.toBeNull(),
    );
    act(() => emit?.({ kind: "prs-start", total: 2 }));
    act(() => emit?.({ kind: "repo-prs", repo: "acme/widget", index: 1, total: 2, count: 3 }));
    await waitFor(() => {
      const banner = container.querySelector(".project-detail-prs-pending");
      expect(banner?.textContent).toContain("acme/widget");
      expect(banner?.textContent).toContain("(1 of 2)");
      // Honest determinate fill: 1 of 2 repos done → 50%.
      const bar = container.querySelector(".project-detail-prs-bar > span") as HTMLElement | null;
      expect(bar?.style.width).toBe("50%");
    });
  });

  it("dedupes a local branch that has a PR into a single PR row with an annotation", async () => {
    const { bridge } = fakeBridge(detail());
    const { container } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={vi.fn()}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => expect(container.querySelectorAll(".smart-row").length).toBeGreaterThan(0));
    // One row per branch: 3 PRs + 1 undeduped local = 4 rows, not 6.
    expect(container.querySelectorAll(".smart-row")).toHaveLength(4);
    // The "feat/front-door" branch appears once, as the PR row, with the checkout note.
    const prRow = container.querySelector('.smart-row[data-kind="pr"] .smart-row-checkout');
    expect(prRow?.textContent).toContain("checked out locally");
  });

  it("floats a needs-you row to the top under the HOT default", async () => {
    const { bridge } = fakeBridge(detail());
    const { container } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={vi.fn()}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.querySelector(".smart-row")).not.toBeNull());
    // pr-131 requested my review → it leads despite being the oldest.
    const first = container.querySelector(".smart-row .smart-row-title");
    expect(first?.textContent).toBe("Span disposition re-anchor");
    expect(container.querySelector('.smart-row[data-needs-you="true"]')).not.toBeNull();
  });

  it("marks the merged PR read-only and offers Clean up, which invokes the command", async () => {
    const { bridge, calls } = fakeBridge(detail());
    const { container, getByRole } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={vi.fn()}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.querySelector(".smart-row")).not.toBeNull());
    const merged = container.querySelector('.smart-row[data-read-only="true"]');
    expect(merged?.querySelector(".smart-row-badge.is-read-only")?.textContent).toContain(
      "read-only",
    );

    fireEvent.click(getByRole("button", { name: "Clean up" }));
    await waitFor(() =>
      expect(calls.some((call) => call.name === "project.cleanupWorktree")).toBe(true),
    );
    const cleanup = calls.find((call) => call.name === "project.cleanupWorktree");
    // Targets the stable worktree id (not a bare branch), so a reused branch name
    // never sweeps the wrong worktree.
    expect(cleanup?.input).toMatchObject({ projectId: "project-1", worktreeId: "local-merged" });
    // The annotation is removed after a successful clean-up.
    await waitFor(() =>
      expect(
        container.querySelector('.smart-row[data-read-only="true"] .smart-row-checkout'),
      ).toBeNull(),
    );
  });

  it("restores the annotation when clean-up REJECTS (never silently hidden)", async () => {
    const { bridge } = fakeBridge(detail(), "reject");
    const { container, getByRole } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={vi.fn()}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.querySelector(".smart-row")).not.toBeNull());
    const annotation = () =>
      container.querySelector('.smart-row[data-read-only="true"] .smart-row-checkout');
    expect(annotation()).not.toBeNull();

    fireEvent.click(getByRole("button", { name: "Clean up" }));
    // The failure surfaces AND the annotation is restored (the worktree is still on disk).
    await waitFor(() =>
      expect(container.querySelector(".project-detail-error")?.textContent).toContain(
        "worktree is dirty",
      ),
    );
    expect(annotation()).not.toBeNull();
  });

  it("restores the annotation when clean-up returns { ok: false }", async () => {
    const { bridge } = fakeBridge(detail(), "not-ok");
    const { container, getByRole } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={vi.fn()}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.querySelector(".smart-row")).not.toBeNull());
    const annotation = () =>
      container.querySelector('.smart-row[data-read-only="true"] .smart-row-checkout');
    expect(annotation()).not.toBeNull();

    fireEvent.click(getByRole("button", { name: "Clean up" }));
    await waitFor(() =>
      expect(container.querySelector(".project-detail-error")?.textContent).toContain(
        "Could not clean up",
      ),
    );
    // An { ok: false } is a real failure — the annotation must NOT stay hidden.
    expect(annotation()).not.toBeNull();
  });

  it("filters to just the local work via the Local chip", async () => {
    const { bridge } = fakeBridge(detail());
    const { container, getByRole } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={vi.fn()}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.querySelector(".smart-row")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Local/ }));
    await waitFor(() => {
      const rows = container.querySelectorAll(".smart-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.getAttribute("data-kind")).toBe("local");
    });
  });

  it("renders the partial-results banner on a truncated substrate", async () => {
    const { bridge } = fakeBridge(detail({ truncated: true }));
    const { container } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={vi.fn()}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector(".project-detail-truncated")).not.toBeNull(),
    );
    expect(container.querySelector(".project-detail-truncated")?.textContent).toContain(
      "not complete",
    );
  });

  it("re-associates the Sort label with its Select — a label click opens the listbox", async () => {
    const { bridge } = fakeBridge(detail());
    const { container, user } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={vi.fn()}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.querySelector(".smart-sort-select")).not.toBeNull());
    // Nothing open yet.
    expect(document.querySelector('[role="option"]')).toBeNull();
    // Click the visible "Sort" text label (not the trigger) — the htmlFor→id wiring
    // must forward the activation to the Select, the behaviour the inert <span> lost.
    await user.click(container.querySelector(".smart-sort-label") as HTMLElement);
    await waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull());
  });

  it("PR-scope select refetches the substrate for the chosen state (callback fires)", async () => {
    const { bridge, calls } = fakeBridge(detail());
    const { container, findByRole, user } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={vi.fn()}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.querySelector(".smart-pr-scope-select")).not.toBeNull());
    // Open the PR-scope select and choose "Merged".
    await user.click(container.querySelector(".smart-pr-scope-select") as HTMLElement);
    await user.click(await findByRole("option", { name: "Merged" }));
    // The change flows to prScope → the effect refetches project.detail with the
    // merged state filter (history is paged on demand, never synced locally).
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.name === "project.detail" &&
            Array.isArray((call.input as { prStates?: unknown }).prStates) &&
            (call.input as { prStates: string[] }).prStates.includes("merged"),
        ),
      ).toBe(true),
    );
  });

  it("Sort select reorders the list via the callback (keyboard selection)", async () => {
    const { bridge } = fakeBridge(detail());
    const { container, findByRole, user } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={vi.fn()}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.querySelector(".smart-row-title")).not.toBeNull());
    // HOT default floats the needs-you PR to the top.
    expect(container.querySelector(".smart-row-title")?.textContent).toBe(
      "Span disposition re-anchor",
    );
    // Open with the keyboard (focus the trigger, press Enter) and pick "Recent" — the
    // most recently active row then leads, proving the onSort callback reordered.
    const trigger = container.querySelector<HTMLElement>(".smart-sort-select");
    trigger?.focus();
    await user.keyboard("{Enter}");
    await user.click(await findByRole("option", { name: "Recent" }));
    await waitFor(() =>
      expect(container.querySelector(".smart-row-title")?.textContent).toBe("The front-door shell"),
    );
  });

  it("opens a row into review via onOpenRow", async () => {
    const onOpenRow = vi.fn();
    const { bridge } = fakeBridge(detail());
    const { container } = mount(
      <ProjectDetail
        bridge={bridge}
        project={project}
        onOpenRow={onOpenRow}
        onOpenContextMap={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.querySelector(".smart-row-open")).not.toBeNull());
    fireEvent.click(container.querySelector(".smart-row-open") as HTMLElement);
    expect(onOpenRow).toHaveBeenCalledTimes(1);
  });
});
