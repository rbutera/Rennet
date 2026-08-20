// @vitest-environment happy-dom
//
// The Context Map surface (change add-context-map-view). Mounts the real
// `ContextMapView` over a recording fake `RennetBridge` and drives it: the surface
// loads `project.contextMap`, the tree renders scopes with rolled-up counts, selecting
// a scope re-centers the neighbourhood graph and filters the knowledge panel to that
// subject, confirming a statement invokes `project.knowledgeDisposition`, and asking a
// question invokes `project.contextAsk` and renders the answer. Assertions are
// behavioural — rendered nodes and recorded command inputs.
import type {
  KnowledgeSetPayload,
  ProjectContextMapResult,
  ProjectMapPayload,
  RennetBridge,
} from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount, waitFor } from "../test/dom";
import { ContextMapView } from "./context-map-view";

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

const knowledge: KnowledgeSetPayload = {
  schemaVersion: 1,
  repoKey: "rennet",
  baseOid: "abcdef0123456789",
  snapshotFingerprint: "fp-1",
  generator: "knowledge-pass@1",
  statements: [
    {
      id: "k1",
      subject: "@rennet/core",
      aspect: "purpose",
      claim: "Owns the pure review domain.",
      evidence: [{ path: "packages/core/src/index.ts", blobOid: "b1" }],
      confidence: "high",
      status: "hypothesis",
      provenance: { generator: "knowledge-pass@1", model: "claude", apiKeySource: null },
      learnedAgainst: { baseOid: "abcdef0123456789", snapshotFingerprint: "fp-1" },
    },
    {
      id: "k2",
      subject: "@rennet/ui",
      aspect: "purpose",
      claim: "Renders over the protocol only.",
      evidence: [{ path: "packages/ui/package.json", blobOid: "b9" }],
      confidence: "medium",
      status: "hypothesis",
      provenance: { generator: "knowledge-pass@1", model: "claude", apiKeySource: null },
      learnedAgainst: { baseOid: "abcdef0123456789", snapshotFingerprint: "fp-1" },
    },
  ],
};

function fakeBridge(mapResult: ProjectContextMapResult = { status: "ok", map, knowledge }): {
  bridge: RennetBridge;
  calls: { name: string; input: unknown }[];
} {
  const calls: { name: string; input: unknown }[] = [];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    switch (name) {
      case "project.contextMap":
        return mapResult;
      case "project.knowledgeDisposition":
        return { status: "ok", statement: knowledge.statements[0] };
      case "project.contextAsk":
        return {
          status: "answered",
          answer: {
            answer: "Because the boundary contract forbids it.",
            evidence: [{ path: "packages/ui/package.json", blobOid: "b9" }],
            confidence: "high",
            consulted: ["packages/ui/package.json"],
            cost: {
              turns: 1,
              model: "claude",
              effort: null,
              budgetGranted: true,
              overage: false,
              resolution: null,
            },
          },
        };
      default:
        return {};
    }
  };
  return { bridge: { invoke: invoke as unknown as RennetBridge["invoke"] }, calls };
}

describe("ContextMapView — the Context Map surface", () => {
  it("loads project.contextMap and renders the scope tree with rolled-up counts", async () => {
    const { bridge, calls } = fakeBridge();
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() =>
      expect(
        container.querySelectorAll(".context-map-row.scope, .context-map-tree .context-map-row")
          .length,
      ).toBeGreaterThan(0),
    );
    expect(calls[0]).toEqual({ name: "project.contextMap", input: { projectId: "project-1" } });
    const tree = container.querySelector(".context-map-tree");
    expect(tree?.textContent).toContain("@rennet/core");
    expect(tree?.textContent).toContain("@rennet/ui");
    // Two files under core roll up to a "2f" count on its row.
    expect(tree?.textContent).toContain("2f");
  });

  it("states the absent snapshot plainly instead of a fabricated map", async () => {
    const { bridge } = fakeBridge({ status: "absent", reason: "no repo map is persisted yet" });
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() =>
      expect(container.querySelector(".context-map-status")?.textContent).toContain(
        "no repo map is persisted yet",
      ),
    );
    expect(container.querySelector(".context-map-tree")).toBeNull();
  });

  it("filters the knowledge panel to the selected scope", async () => {
    const { bridge } = fakeBridge();
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    // First scope (@rennet/core) is selected on load: its claim shows, ui's does not.
    await waitFor(() =>
      expect(container.querySelector(".context-map-knowledge")?.textContent).toContain(
        "Owns the pure review domain.",
      ),
    );
    expect(container.querySelector(".context-map-knowledge")?.textContent).not.toContain(
      "Renders over the protocol only.",
    );
    // Select @rennet/ui in the tree → its claim replaces core's.
    const uiRow = [...container.querySelectorAll(".context-map-tree .context-map-row")].find(
      (row) => row.textContent?.includes("@rennet/ui"),
    );
    fireEvent.click(uiRow as Element);
    await waitFor(() =>
      expect(container.querySelector(".context-map-knowledge")?.textContent).toContain(
        "Renders over the protocol only.",
      ),
    );
  });

  it("confirms a statement through project.knowledgeDisposition", async () => {
    const { bridge, calls } = fakeBridge();
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector(".context-map-confirm")).not.toBeNull());
    fireEvent.click(container.querySelector(".context-map-confirm") as Element);
    await waitFor(() =>
      expect(calls.some((call) => call.name === "project.knowledgeDisposition")).toBe(true),
    );
    expect(calls.find((call) => call.name === "project.knowledgeDisposition")?.input).toEqual({
      projectId: "project-1",
      statementId: "k1",
      disposition: "confirmed",
    });
  });

  it("rejects a statement through project.knowledgeDisposition and retires its verbs", async () => {
    const { bridge, calls } = fakeBridge();
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector(".context-map-reject")).not.toBeNull());
    fireEvent.click(container.querySelector(".context-map-reject") as Element);
    await waitFor(() =>
      expect(calls.some((call) => call.name === "project.knowledgeDisposition")).toBe(true),
    );
    expect(calls.find((call) => call.name === "project.knowledgeDisposition")?.input).toEqual({
      projectId: "project-1",
      statementId: "k1",
      disposition: "rejected",
    });
    // Once rejected, the verbs retire — a disposed claim is not re-disposed.
    await waitFor(() => expect(container.querySelector(".context-map-confirm")).toBeNull());
  });

  it("asks the orchestrator through project.contextAsk and renders the answer", async () => {
    const { bridge, calls } = fakeBridge();
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector(".context-map-field")).not.toBeNull());
    const input = container.querySelector(".context-map-field") as HTMLInputElement;
    input.value = "why doesn't ui import core?";
    fireEvent.input(input, { target: { value: "why doesn't ui import core?" } });
    fireEvent.submit(container.querySelector(".context-map-input") as Element);
    await waitFor(() =>
      expect(container.querySelector(".context-map-log")?.textContent).toContain(
        "Because the boundary contract forbids it.",
      ),
    );
    expect(calls.find((call) => call.name === "project.contextAsk")?.input).toEqual({
      projectId: "project-1",
      question: "why doesn't ui import core?",
    });
  });
});
