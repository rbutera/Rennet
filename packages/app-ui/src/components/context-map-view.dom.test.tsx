// @vitest-environment happy-dom
//
// The Context Map surface (change add-context-map-view). Mounts the real
// `ContextMapView` over a recording fake `RennetBridge` and drives it: the surface
// loads `project.contextMap`, the tree renders scopes with rolled-up counts, selecting
// a scope re-centers the neighbourhood graph and filters the knowledge panel to that
// subject, confirming a statement invokes `project.knowledgeDisposition`, and asking a
// question invokes `project.contextAsk` and renders the answer. Assertions are
// behavioural — rendered nodes and recorded command inputs.
import {
  commandIdFor,
  type KnowledgeSetPayload,
  type ProjectContextMapResult,
  type ProjectMapPayload,
  type RennetBridge,
} from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../data";
import { act, fireEvent, mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { ContextMapView as ProductContextMapView } from "./context-map-view";

function ContextMapView({
  bridge,
  projectId,
  onBack,
}: {
  bridge: RennetBridge;
  projectId: string;
  onBack(): void;
}) {
  return (
    <BridgeProvider bridge={bridge}>
      <ProductContextMapView projectId={projectId} onBack={onBack} />
    </BridgeProvider>
  );
}

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

function fakeBridge(
  mapResult: ProjectContextMapResult = { status: "ok", map, knowledge },
  dispositionOutcome: "ok" | "not-found" | "throw" = "ok",
): {
  bridge: RennetBridge;
  calls: { name: string; input: unknown }[];
} {
  const calls: { name: string; input: unknown }[] = [];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    switch (name) {
      case "project.contextMap":
        return mapResult;
      case "project.knowledgeDisposition": {
        // The store is authoritative: echo the persisted statement with the flipped
        // status (not the pre-disposition hypothesis) — the reconciliation the UI relies on.
        const { statementId, disposition } = input as {
          statementId: string;
          disposition: "confirmed" | "rejected";
        };
        if (dispositionOutcome === "throw") throw new Error("the store is offline");
        if (dispositionOutcome === "not-found") return { status: "not-found", statementId };
        const found = knowledge.statements.find((s) => s.id === statementId);
        return { status: "ok", statement: { ...found, status: disposition } };
      }
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

  it("starts the durable project run, renders its live progress, then opens the generated map", async () => {
    let reads = 0;
    const processing = deferred<{ repos: [] }>();
    const bridge = new MemoryBridge({
      "project.contextMap": () => {
        reads += 1;
        return reads === 1
          ? { status: "absent" as const, reason: "no repo map is persisted yet" }
          : { status: "ok" as const, map, knowledge };
      },
      "project.process": () => processing.promise,
    });
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    const commandId = commandIdFor("project.process:project-1");
    await waitFor(() =>
      expect(container.querySelector(".context-map-status")?.textContent).toContain(
        "Starting the Context Map",
      ),
    );
    act(() =>
      bridge.emitProgress(commandId, {
        kind: "stage",
        repo: "rennet",
        stage: "tree",
        note: "Reading the file tree",
        detail: "412 files",
      }),
    );
    await waitFor(() =>
      expect(container.querySelector(".context-map-status")?.textContent).toContain(
        "Reading the file tree",
      ),
    );
    expect(container.querySelector(".context-map-status")?.textContent).toContain("412 files");

    act(() => processing.resolve({ repos: [] }));
    await waitFor(() => expect(container.querySelector(".context-map-tree")).not.toBeNull());
    expect(reads).toBe(2);
  });

  it("surfaces processing failure and retries the same durable project run", async () => {
    let attempts = 0;
    const commandIds: string[] = [];
    const bridge = new MemoryBridge({
      "project.contextMap": () => ({
        status: "absent",
        reason: "no repo map is persisted yet",
      }),
      "project.process": (input) => {
        attempts += 1;
        commandIds.push(input.commandId);
        throw new Error("worker exited during map generation");
      },
    });
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "worker exited during map generation",
      ),
    );
    fireEvent.click(container.querySelector(".context-map-status button") as Element);
    await waitFor(() => expect(attempts).toBe(2));
    expect(commandIds).toEqual([
      commandIdFor("project.process:project-1"),
      commandIdFor("project.process:project-1"),
    ]);
  });

  it("uses a fresh run identity when a completed journal produced no readable map", async () => {
    const commandIds: string[] = [];
    const rebuilding = deferred<{ repos: [] }>();
    // A remount after an earlier repair sees that completed rebuild in the durable
    // result. The next repair must derive from it, never repeat local `rebuild:1`.
    const completedId = commandIdFor("project.process:project-1:rebuild:1");
    const bridge = new MemoryBridge({
      "project.contextMap": () => ({
        status: "absent",
        reason: "stored map failed its integrity check",
        run: {
          id: completedId,
          projectId: "project-1",
          status: "done",
          phase: "complete",
          repos: [],
          scout: null,
          totals: { repos: 0, files: 0, scopes: 0, confirmed: 0, rejected: 0 },
        },
      }),
      "project.process": (input) => {
        commandIds.push(input.commandId);
        return rebuilding.promise;
      },
    });
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "stored map failed its integrity check",
      ),
    );
    fireEvent.click(container.querySelector(".context-map-status button") as Element);
    await waitFor(() => expect(commandIds).toHaveLength(1));
    expect(commandIds[0]).not.toBe(completedId);
  });

  it("retries a failed rebuild under its persisted rebuild identity", async () => {
    const completedId = commandIdFor("project.process:project-1");
    let persistedRun: Extract<ProjectContextMapResult, { status: "absent" }> = {
      status: "absent",
      reason: "stored map failed its integrity check",
      run: {
        id: completedId,
        projectId: "project-1",
        status: "done",
        phase: "complete",
        repos: [],
        scout: null,
        totals: { repos: 0, files: 0, scopes: 0, confirmed: 0, rejected: 0 },
      },
    };
    const commandIds: string[] = [];
    const retrying = deferred<{ repos: [] }>();
    const bridge = new MemoryBridge({
      "project.contextMap": () => persistedRun,
      "project.process": (input) => {
        commandIds.push(input.commandId);
        if (commandIds.length > 1) return retrying.promise;
        persistedRun = {
          status: "absent",
          reason: "rebuild worker exited",
          run: {
            id: input.commandId,
            projectId: input.projectId,
            status: "failed",
            phase: "map",
            repos: [],
            scout: null,
            reason: "rebuild worker exited",
          },
        };
        return { repos: [], run: persistedRun.run };
      },
    });
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());

    fireEvent.click(container.querySelector(".context-map-status button") as Element);
    await waitFor(() => expect(commandIds).toHaveLength(1));
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Context Map map failed: rebuild worker exited",
      ),
    );
    fireEvent.click(container.querySelector(".context-map-status button") as Element);
    await waitFor(() => expect(commandIds).toHaveLength(2));
    expect(commandIds[1]).toBe(commandIds[0]);
  });

  it("reattaches to a persisted rebuild after the Map remounts", async () => {
    const completedId = commandIdFor("project.process:project-1");
    let persistedRun: Extract<ProjectContextMapResult, { status: "absent" }> = {
      status: "absent",
      reason: "stored map failed its integrity check",
      run: {
        id: completedId,
        projectId: "project-1",
        status: "done",
        phase: "complete",
        repos: [],
        scout: null,
        totals: { repos: 0, files: 0, scopes: 0, confirmed: 0, rejected: 0 },
      },
    };
    const rebuilding = deferred<{ repos: [] }>();
    const commandIds: string[] = [];
    const bridge = new MemoryBridge({
      "project.contextMap": () => persistedRun,
      "project.process": (input) => {
        commandIds.push(input.commandId);
        persistedRun = {
          status: "absent",
          reason: "Context Map rebuild is still running",
          run: {
            id: input.commandId,
            projectId: input.projectId,
            status: "running",
            phase: "map",
            repos: [],
            scout: null,
          },
        };
        return rebuilding.promise;
      },
    });
    const render = (show: boolean) => (
      <BridgeProvider bridge={bridge}>
        {show ? <ProductContextMapView projectId="project-1" onBack={vi.fn()} /> : null}
      </BridgeProvider>
    );
    const view = mount(render(true));
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
    fireEvent.click(view.container.querySelector(".context-map-status button") as Element);
    await waitFor(() => expect(commandIds).toHaveLength(1));

    view.rerender(render(false));
    view.rerender(render(true));

    await waitFor(() => expect(commandIds).toHaveLength(2));
    expect(commandIds[1]).toBe(commandIds[0]);
  });

  it("does not render a cached map as current when its authoritative refetch fails", async () => {
    let reads = 0;
    const bridge = new MemoryBridge({
      "project.contextMap": () => {
        reads += 1;
        if (reads === 1) return { status: "ok", map, knowledge };
        throw new Error("the saved map can no longer be read");
      },
    });
    const render = (show: boolean) => (
      <BridgeProvider bridge={bridge}>
        {show ? <ProductContextMapView projectId="project-1" onBack={vi.fn()} /> : null}
      </BridgeProvider>
    );
    const view = mount(render(true));
    await waitFor(() => expect(view.container.querySelector(".context-map-tree")).not.toBeNull());

    view.rerender(render(false));
    view.rerender(render(true));

    await waitFor(() =>
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
        "the saved map can no longer be read",
      ),
    );
    expect(view.container.querySelector(".context-map-tree")).toBeNull();
    expect(reads).toBe(2);
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

  it("rolls back the optimistic flip and surfaces the error when disposition fails", async () => {
    const { bridge } = fakeBridge(undefined, "throw");
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector(".context-map-confirm")).not.toBeNull());
    fireEvent.click(container.querySelector(".context-map-confirm") as Element);
    // The failure surfaces AND the verbs come back — no guessed "confirmed" left standing.
    await waitFor(() =>
      expect(container.querySelector(".context-map-disposition-error")?.textContent).toContain(
        "the store is offline",
      ),
    );
    expect(container.querySelector(".context-map-confirm")).not.toBeNull();
  });

  it("rolls back on a typed not-found and tells the user the view is stale", async () => {
    const { bridge } = fakeBridge(undefined, "not-found");
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector(".context-map-reject")).not.toBeNull());
    fireEvent.click(container.querySelector(".context-map-reject") as Element);
    await waitFor(() =>
      expect(container.querySelector(".context-map-disposition-error")?.textContent).toContain(
        "no longer in the map",
      ),
    );
    // Not left as a phantom "rejected" — the verbs remain actionable.
    expect(container.querySelector(".context-map-reject")).not.toBeNull();
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
