// @vitest-environment happy-dom
import type { Project } from "@rennet/protocol";
import { afterEach, expect, it } from "vitest";
import { useReviewActivityState } from "../shell/review-activity-state";
import { cleanup, screen, waitFor } from "../test/dom";
import { sessionHandlers } from "../test/fixtures/sessions";
import { mountApp } from "../test/mount-app";

afterEach(() => {
  cleanup();
  localStorage.clear();
  useReviewActivityState.setState({ bySession: {} });
});

it("restores local, tokenless WSL and paired remote history together and opens on the owning host", async () => {
  localStorage.setItem(
    "rennet.daemons",
    JSON.stringify({
      daemons: [
        { id: "wsl:Ubuntu", label: "Ubuntu", host: "127.0.0.1", port: 12345 },
        { id: "daemon:nimbus", label: "Nimbus", host: "nimbus", deviceToken: "test-token" },
      ],
    }),
  );
  const { user, bridges, history, unmount } = mountApp((target) => {
    const project: Project = {
      id: "same-project",
      name: `${target.label} project`,
      path: "/repos/rennet",
      openPath: "/repos/rennet",
      kind: "repo",
      repoCount: 1,
      branchCount: 1,
      primaryBranch: "main",
      addedAt: "2026-09-17T00:00:00.000Z",
      source:
        target.id === "wsl:Ubuntu"
          ? "wsl:Ubuntu"
          : target.id === "daemon:nimbus"
            ? "remote:nimbus"
            : "local",
    };
    return {
      "projects.list": () => ({ projects: [project] }),
      ...sessionHandlers([
        {
          id: "same-session",
          projectId: project.id,
          title: `${target.label} session`,
          preparation:
            target.id === "local"
              ? { status: "capturing", step: "capturing-change" }
              : { status: "failed", stage: "capture", reason: `${target.label} unavailable` },
        },
      ]),
    };
  });
  await user.click(await screen.findByText("This machine project"));
  await user.click(await screen.findByText("Ubuntu project"));
  await user.click(await screen.findByText("Nimbus project"));
  await screen.findByText("This machine session");
  await screen.findByText("Ubuntu session");
  await screen.findByText("Nimbus session");
  expect(useReviewActivityState.getState().bySession["same-session"]?.kind).toBe("running");
  await user.click(screen.getByText("Ubuntu session"));
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem("rennet.daemons") ?? "{}").activeId).toBe("wsl:Ubuntu"),
  );
  expect(history.history.at(-1)).toBe("/s/same-session");
  expect(bridges.has("wsl:Ubuntu")).toBe(true);
  await screen.findByText("This machine session");
  await screen.findByText("Nimbus session");
  await waitFor(() => expect(localStorage.getItem("rennet.history.wsl:Ubuntu")).not.toBeNull());
  unmount();
  const restored = mountApp(() => ({
    "projects.list": () => new Promise(() => undefined),
    "session.list": () => new Promise(() => undefined),
  }));
  await restored.findByText("Ubuntu session");
  expect(restored.getAllByText("Saved history · reconnecting").length).toBe(3);
});
