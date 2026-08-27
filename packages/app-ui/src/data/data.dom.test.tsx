// @vitest-environment happy-dom
import type { Project, ProjectProcessEvent } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { act, mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { BridgeProvider, useCommand, useCommandStream, useMutation } from "./index";

function project(id: string): Project {
  return {
    id,
    name: id,
    path: `/repos/${id}`,
    kind: "repo",
    repoCount: 1,
    branchCount: 1,
    primaryBranch: "main",
    openPath: `/repos/${id}`,
    addedAt: "2026-01-01T00:00:00.000Z",
    source: "local",
  };
}

function ProjectsCount() {
  const { data, pending, error } = useCommand("projects.list", {});
  if (error) return <span>error:{(error as Error).message}</span>;
  if (pending) return <span>loading</span>;
  return <span>count:{data?.projects.length}</span>;
}

describe("data seam", () => {
  it("dedupes: two readers on one key produce a single invoke", async () => {
    let invokes = 0;
    const bridge = new MemoryBridge({
      "projects.list": () => {
        invokes += 1;
        return { projects: [project("a")] };
      },
    });
    const { getAllByText } = mount(
      <BridgeProvider bridge={bridge}>
        <ProjectsCount />
        <ProjectsCount />
      </BridgeProvider>,
    );
    await waitFor(() => expect(getAllByText("count:1")).toHaveLength(2));
    expect(invokes).toBe(1);
  });

  it("folds a streamed event into the read's data (one cache entry)", async () => {
    const bridge = new MemoryBridge({
      // Never resolves: the data a component reads arrives from the STREAM alone.
      "project.process": () => new Promise<never>(() => undefined),
    });
    function Processing() {
      const { data } = useCommand("project.process", { commandId: "c1", projectId: "p1" });
      useCommandStream({
        channel: "progress",
        subscriptionKey: "c1",
        command: { name: "project.process", input: { commandId: "c1", projectId: "p1" } },
        fold: (prev, event) => ({
          repos:
            event.kind === "repo-done"
              ? [...(prev?.repos ?? []), event.summary]
              : (prev?.repos ?? []),
        }),
      });
      return <span>repos:{data?.repos.length ?? "none"}</span>;
    }
    const { getByText } = mount(
      <BridgeProvider bridge={bridge}>
        <Processing />
      </BridgeProvider>,
    );
    expect(getByText("repos:none")).toBeTruthy();
    const event: ProjectProcessEvent = {
      kind: "repo-done",
      repo: "atlas",
      summary: { repo: "atlas", path: "/repos/atlas", ok: true },
    };
    act(() => bridge.emitProgress("c1", event));
    await waitFor(() => expect(getByText("repos:1")).toBeTruthy());
  });

  it("a mutation invalidates its declared prefix and the read refetches", async () => {
    let projects = [project("a"), project("b")];
    const bridge = new MemoryBridge({
      "projects.list": () => ({ projects: [...projects] }),
      "projects.remove": () => {
        projects = projects.slice(1);
        return { projects: [...projects] };
      },
    });
    function Remover() {
      const { mutate } = useMutation("projects.remove", { invalidates: ["projects.list"] });
      return (
        <button type="button" onClick={() => void mutate({ commandId: "c", projectId: "a" })}>
          remove
        </button>
      );
    }
    const { getByText, user } = mount(
      <BridgeProvider bridge={bridge}>
        <ProjectsCount />
        <Remover />
      </BridgeProvider>,
    );
    await waitFor(() => expect(getByText("count:2")).toBeTruthy());
    await user.click(getByText("remove"));
    await waitFor(() => expect(getByText("count:1")).toBeTruthy());
  });

  it("an invoke rejection surfaces as error, not an unhandled throw", async () => {
    const bridge = new MemoryBridge({
      "projects.list": () => {
        throw new Error("router not ready");
      },
    });
    const { getByText } = mount(
      <BridgeProvider bridge={bridge}>
        <ProjectsCount />
      </BridgeProvider>,
    );
    await waitFor(() => expect(getByText("error:router not ready")).toBeTruthy());
  });
});
