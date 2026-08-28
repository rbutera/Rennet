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

// Real UUIDs: `MemoryBridge.invoke` parses every input against the wire schema, and
// `commandId` is `z.uuid()`. A stub driven with a made-up id is a stub driven with a value
// the daemon would refuse — the exact gap that let a dead chat dock ship green.
const PROCESS_ID = "0d5a0a2b-6b0f-4c8e-9a2b-1f7c3d5e9a10";
const REMOVE_ID = "3b9c1e44-2a7d-4f61-8c0b-5e2a9d4f7b31";

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
      const { data } = useCommand("project.process", { commandId: PROCESS_ID, projectId: "p1" });
      useCommandStream({
        channel: "progress",
        subscriptionKey: PROCESS_ID,
        command: { name: "project.process", input: { commandId: PROCESS_ID, projectId: "p1" } },
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
    act(() => bridge.emitProgress(PROCESS_ID, event));
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
        <button type="button" onClick={() => void mutate({ commandId: REMOVE_ID, projectId: "a" })}>
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

  it("a bridge swap gets a fresh cache — the new bridge answers, not the old cache", async () => {
    const bridgeA = new MemoryBridge({ "projects.list": () => ({ projects: [project("a")] }) });
    const bridgeB = new MemoryBridge({
      "projects.list": () => ({ projects: [project("a"), project("b")] }),
    });
    const { getByText, rerender } = mount(
      <BridgeProvider bridge={bridgeA}>
        <ProjectsCount />
      </BridgeProvider>,
    );
    await waitFor(() => expect(getByText("count:1")).toBeTruthy());
    // Swap the bridge prop: cache identity is bound to bridge identity, so bridge B is
    // invoked against a fresh cache rather than serving bridge A's cached count.
    rerender(
      <BridgeProvider bridge={bridgeB}>
        <ProjectsCount />
      </BridgeProvider>,
    );
    await waitFor(() => expect(getByText("count:2")).toBeTruthy());
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
