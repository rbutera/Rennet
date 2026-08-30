// @vitest-environment happy-dom
//
// The router-side Context Map view (C12 cluster 5) over a MemoryBridge. It mounts the
// reused incumbent surface WITHOUT the ask rail and lands on New Chat when left. The
// incumbent's own suite proves the structure/knowledge internals exhaustively; here we
// prove the C12 wiring: scopes render from `project.contextMap`, an SVG node click
// re-centers the neighborhood, a knowledge disposition fires the mutation and retires
// the verbs, the ask rail is absent, and Back navigates to that project's New Chat.
import type { KnowledgeSetPayload, ProjectMapPayload, RennetBridge } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { discussPrompt } from "../components/context-map-view";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { newChatPath, projectMapPath } from "../routes/url";
import { cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { ProjectContextMapView } from "./context-map-view";

afterEach(cleanup);

const map: ProjectMapPayload = {
  baseRef: "main",
  baseRefResolution: "symbolic-head",
  baseOid: "abcdef0123456789",
  fingerprint: "fp-1",
  files: [
    { path: "packages/core/src/index.ts", blobOid: "b1", size: 10, mode: "100644" },
    { path: "packages/core/src/project-context.ts", blobOid: "b2", size: 20, mode: "100644" },
    { path: "packages/ui/src/app.tsx", blobOid: "b3", size: 30, mode: "100644" },
  ],
  scopes: [
    { name: "@rennet/core", root: "packages/core", private: false, tags: [] },
    { name: "@rennet/ui", root: "packages/ui", private: false, tags: [] },
  ],
  edges: [{ from: "@rennet/ui", to: "@rennet/core", kind: "manifest" }],
  entryPoints: [{ scope: "@rennet/core", main: "src/index.ts", bin: [] }],
  tests: [],
  ownership: [],
  conventions: [],
};

const k1: KnowledgeSetPayload["statements"][number] = {
  id: "k1",
  subject: "@rennet/core",
  aspect: "purpose",
  claim: "Owns the pure review domain.",
  evidence: [{ path: "packages/core/src/index.ts", blobOid: "b1" }],
  confidence: "high",
  status: "hypothesis",
  provenance: { generator: "knowledge-pass@1", model: "claude", apiKeySource: null },
  learnedAgainst: { baseOid: "abcdef0123456789", snapshotFingerprint: "fp-1" },
};

const knowledge: KnowledgeSetPayload = {
  schemaVersion: 1,
  repoKey: "rennet",
  baseOid: "abcdef0123456789",
  snapshotFingerprint: "fp-1",
  generator: "knowledge-pass@1",
  statements: [k1],
};

function renderMap() {
  const history = memoryHistory(projectMapPath("p1"));
  const calls: { name: string; input: unknown }[] = [];
  const bridge = new MemoryBridge({
    "project.contextMap": () => ({ status: "ok", map, knowledge }),
    "project.knowledgeDisposition": (input) => {
      calls.push({ name: "project.knowledgeDisposition", input });
      return {
        status: "ok",
        statement: { ...k1, status: input.disposition },
      };
    },
  }) as unknown as RennetBridge;
  const view = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <ProjectContextMapView projectId="p1" />
      </Router>
    </BridgeProvider>,
  );
  return { ...view, history, calls };
}

describe("ProjectContextMapView — router-side map (C12 cluster 5)", () => {
  it("lists workspace members and opens the selected repository map", async () => {
    const history = memoryHistory(projectMapPath("p1"));
    const reads: unknown[] = [];
    const gitlab = { forge: "gitlab", owner: "acme", name: "repo-b" };
    const bridge = new MemoryBridge({
      "project.contextMap": (input) => {
        reads.push(input);
        return input.repository === "acme/repo-b"
          ? { status: "ok" as const, map, knowledge }
          : {
              status: "members" as const,
              members: [
                {
                  repository: "acme/repo-a",
                  forgeRepository: { forge: "github", owner: "acme", name: "repo-a" },
                },
                { repository: "acme/repo-b", forgeRepository: gitlab },
              ],
            };
      },
    });
    const { container } = mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <ProjectContextMapView projectId="p1" />
        </Router>
      </BridgeProvider>,
    );

    await waitFor(() => expect(container.querySelectorAll(".context-map-member")).toHaveLength(2));
    const repoB = [...container.querySelectorAll(".context-map-member")].find((button) =>
      button.textContent?.includes("acme/repo-b"),
    );
    fireEvent.click(repoB as Element);

    await waitFor(() =>
      expect(container.querySelector(".context-map-tree")?.textContent).toContain("@rennet/core"),
    );
    expect(reads).toEqual([
      { projectId: "p1" },
      { projectId: "p1", repository: "acme/repo-b", forgeRepository: gitlab },
    ]);
  });

  it("renders scopes from project.contextMap with no ask rail", async () => {
    const { container } = renderMap();
    await waitFor(() =>
      expect(container.querySelector(".context-map-tree")?.textContent).toContain("@rennet/core"),
    );
    expect(container.querySelector(".context-map-tree")?.textContent).toContain("@rennet/ui");
    // The ask rail is absent — the session chat column plays that role here.
    expect(container.querySelector(".context-map-input")).toBeNull();
    expect(container.querySelector(".context-map-field")).toBeNull();
  });

  it("re-centers the neighborhood when a graph node is clicked", async () => {
    const { container } = renderMap();
    // @rennet/core is selected on load; its importer @rennet/ui is a clickable SVG node.
    await waitFor(() =>
      expect(container.querySelector(".context-map-svg")?.getAttribute("aria-label")).toBe(
        "Dependency neighborhood of @rennet/core",
      ),
    );
    const uiNode = [...container.querySelectorAll(".context-map-node")].find(
      (node) => node.textContent?.trim() === "ui",
    );
    fireEvent.click(uiNode as Element);
    await waitFor(() =>
      expect(container.querySelector(".context-map-svg")?.getAttribute("aria-label")).toBe(
        "Dependency neighborhood of @rennet/ui",
      ),
    );
  });

  it("fires project.knowledgeDisposition and retires the verbs on confirm", async () => {
    const { container, calls } = renderMap();
    await waitFor(() => expect(container.querySelector(".context-map-confirm")).not.toBeNull());
    fireEvent.click(container.querySelector(".context-map-confirm") as Element);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.input).toEqual({
      projectId: "p1",
      statementId: "k1",
      disposition: "confirmed",
    });
    // The store's confirmed status wins — a disposed claim is not re-disposed.
    await waitFor(() => expect(container.querySelector(".context-map-confirm")).toBeNull());
  });

  it("discuss hands the statement to the project's New Chat, prefilled (not an inert button)", async () => {
    const { container, history } = renderMap();
    // The ask rail is absent here, so discuss is a real handoff to New Chat, not a no-op.
    await waitFor(() => expect(container.querySelector(".context-map-discuss")).not.toBeNull());
    fireEvent.click(container.querySelector(".context-map-discuss") as Element);
    expect(history.history.at(-1)).toBe(newChatPath("p1", discussPrompt(k1)));
  });

  it("lands on that project's New Chat when the map is left", async () => {
    const { container, history } = renderMap();
    await waitFor(() => expect(container.querySelector(".context-map-back")).not.toBeNull());
    fireEvent.click(container.querySelector(".context-map-back") as Element);
    expect(history.history.at(-1)).toBe(newChatPath("p1"));
  });
});
