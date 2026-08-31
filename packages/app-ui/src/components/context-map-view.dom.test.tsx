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
  KNOWLEDGE_SWARM_GENERATOR_ID,
  type KnowledgeSetPayload,
  type ProjectContextMapResult,
  type ProjectMapPayload,
  type ProjectRepositoryAddress,
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
  repositoryAddress,
  onBack,
}: {
  bridge: RennetBridge;
  projectId: string;
  repositoryAddress?: ProjectRepositoryAddress;
  onBack(): void;
}) {
  return (
    <BridgeProvider bridge={bridge}>
      <ProductContextMapView
        projectId={projectId}
        repositoryAddress={repositoryAddress}
        onBack={onBack}
      />
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

const coverageScopes = Array.from({ length: 65 }, (_, index) => {
  const suffix = index.toString().padStart(2, "0");
  return {
    name: `@wide/p${suffix}`,
    root: `packages/p${suffix}`,
    path: `packages/p${suffix}/src/index.ts`,
    blobOid: `coverage-blob-${suffix}`,
  };
});

const mapWithCoverage: ProjectMapPayload = {
  ...map,
  fingerprint: "fp-coverage",
  files: [
    ...coverageScopes.map((scope) => ({
      path: scope.path,
      blobOid: scope.blobOid,
      size: 10,
      mode: "100644" as const,
    })),
    { path: "pnpm-lock.yaml", blobOid: "coverage-lock", size: 10, mode: "100644" },
  ],
  scopes: coverageScopes.map((scope) => ({
    name: scope.name,
    root: scope.root,
    private: false,
    tags: [],
  })),
  edges: [],
  entryPoints: [],
};

const knowledgeWithCoverage: KnowledgeSetPayload = {
  schemaVersion: 1,
  repoKey: "rennet-wide",
  baseOid: mapWithCoverage.baseOid,
  snapshotFingerprint: mapWithCoverage.fingerprint,
  generator: "knowledge-pass@1",
  statements: [
    {
      id: "coverage-k1",
      subject: coverageScopes[0]?.name ?? "@wide/p00",
      aspect: "purpose",
      claim: "Owns the first mapped slice.",
      evidence: [
        {
          path: coverageScopes[0]?.path ?? "packages/p00/src/index.ts",
          blobOid: coverageScopes[0]?.blobOid ?? "coverage-blob-00",
        },
      ],
      confidence: "high",
      status: "hypothesis",
      provenance: { generator: "knowledge-pass@1", model: "claude", apiKeySource: null },
      learnedAgainst: {
        baseOid: mapWithCoverage.baseOid,
        snapshotFingerprint: mapWithCoverage.fingerprint,
      },
    },
  ],
  coverage: {
    schemaVersion: 1,
    catalogueDigest: "catalogue-fixture",
    selector: {
      kind: "council",
      cap: 64,
      generator: "map-scope@1",
      harness: "codex",
      assignedModel: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      effort: "medium",
      apiKeySource: null,
    },
    groups: [
      ...coverageScopes.slice(0, 64).map((scope) => ({
        kind: "mapped" as const,
        sliceId: scope.name,
        files: [{ path: scope.path, blobOid: scope.blobOid }],
      })),
      {
        kind: "excluded" as const,
        source: "scope",
        sliceId: coverageScopes[64]?.name ?? "@wide/p64",
        reason: "Lower-priority application shell",
        files: [
          {
            path: coverageScopes[64]?.path ?? "packages/p64/src/index.ts",
            blobOid: coverageScopes[64]?.blobOid ?? "coverage-blob-64",
          },
        ],
      },
      {
        kind: "excluded" as const,
        source: "mechanical",
        reason: "lockfile",
        files: [{ path: "pnpm-lock.yaml", blobOid: "coverage-lock" }],
      },
    ],
  },
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
      // The takeover header names the project it belongs to, so the surface asks for it.
      case "projects.list":
        return { projects: [{ id: "project-1", name: "atlas" }] };
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
            consulted: [
              "context.knowledge (1 statements)",
              "context.knowledge coverage (1 mapped; 1 scope-excluded; 1 mechanically excluded)",
              "context.map (3 files)",
            ],
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
    // The map is read for the project under review. (Not `calls[0]`: the header's own
    // `projects.list` is a child, and a child's effect runs before its parent's, so the
    // ORDER of these two is React's, not this surface's — only their presence is ours.)
    expect(calls).toContainEqual({
      name: "project.contextMap",
      input: { projectId: "project-1" },
    });
    // The 40px takeover header: an icon Back, the `project › Context Map` trail, `esc`.
    const bar = container.querySelector(".context-map-bar");
    expect(bar?.className).toContain("h-10");
    expect(bar?.textContent).toContain("atlas");
    expect(bar?.textContent).toContain("Context Map");
    expect(bar?.textContent).toContain("esc");
    expect(bar?.querySelector('[aria-label="Back"]')).not.toBeNull();
    // The base the map was built from is its OWN strip under the header, not folded in.
    expect(bar?.textContent).not.toContain("abcdef012345");
    expect(container.querySelector(".context-map-base-strip")?.textContent).toContain(
      "abcdef012345",
    );
    const tree = container.querySelector(".context-map-tree");
    // Scope rows carry the SHORT name (the graph nodes and the prototype both do), so
    // this is an exact-equality check on the row's own name span, not a `toContain`
    // that "core" would satisfy just as happily against an unstripped "@rennet/core".
    expect(
      [...(tree?.querySelectorAll(".context-map-name") ?? [])].map((n) => n.textContent),
    ).toEqual(["core", "ui"]);
    // Two files under core roll up to a "2f" count on its row.
    expect(tree?.textContent).toContain("2f");
  });

  it("keeps the selected repository on reads, asks, and knowledge writes", async () => {
    const { bridge, calls } = fakeBridge();
    const repositoryAddress = {
      repository: "acme/repo-b",
      forgeRepository: { forge: "gitlab", owner: "acme", name: "repo-b" },
    };
    const { container } = mount(
      <ContextMapView
        bridge={bridge}
        projectId="project-1"
        repositoryAddress={repositoryAddress}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.querySelector(".context-map-confirm")).not.toBeNull());
    fireEvent.click(container.querySelector(".context-map-confirm") as Element);
    const field = container.querySelector(".context-map-field") as HTMLInputElement;
    field.value = "what owns this?";
    fireEvent.input(field, { target: { value: "what owns this?" } });
    fireEvent.submit(container.querySelector(".context-map-input") as Element);
    await waitFor(() =>
      expect(calls.some((call) => call.name === "project.contextAsk")).toBe(true),
    );

    expect(calls.find((call) => call.name === "project.contextMap")?.input).toEqual({
      projectId: "project-1",
      ...repositoryAddress,
    });
    expect(calls.find((call) => call.name === "project.knowledgeDisposition")?.input).toEqual({
      projectId: "project-1",
      ...repositoryAddress,
      statementId: "k1",
      disposition: "confirmed",
    });
    expect(calls.find((call) => call.name === "project.contextAsk")?.input).toEqual({
      projectId: "project-1",
      ...repositoryAddress,
      question: "what owns this?",
    });
  });

  it("asks against the repository selected from a multi-repo workspace", async () => {
    const asks: unknown[] = [];
    const repositoryAddress = {
      repository: "acme/repo-b",
      forgeRepository: { forge: "gitlab" as const, owner: "acme", name: "repo-b" },
    };
    const bridge = new MemoryBridge({
      "project.contextMap": (input) =>
        input.repository === repositoryAddress.repository
          ? { status: "ok" as const, map, knowledge }
          : {
              status: "members" as const,
              members: [
                {
                  repository: "acme/repo-a",
                  forgeRepository: { forge: "github" as const, owner: "acme", name: "repo-a" },
                },
                repositoryAddress,
              ],
            },
      "project.contextAsk": (input) => {
        asks.push(input);
        return {
          status: "answered",
          answer: {
            answer: "Repository B owns it.",
            evidence: [],
            confidence: "high",
            consulted: [],
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
      },
    });
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );

    await waitFor(() => expect(container.querySelectorAll(".context-map-member")).toHaveLength(2));
    const repoB = [...container.querySelectorAll(".context-map-member")].find((button) =>
      button.textContent?.includes(repositoryAddress.repository),
    );
    fireEvent.click(repoB as Element);
    await waitFor(() => expect(container.querySelector(".context-map-field")).not.toBeNull());
    const field = container.querySelector(".context-map-field") as HTMLInputElement;
    field.value = "what owns this?";
    fireEvent.input(field, { target: { value: "what owns this?" } });
    fireEvent.submit(container.querySelector(".context-map-input") as Element);

    await waitFor(() => expect(asks).toHaveLength(1));
    expect(asks[0]).toEqual({
      projectId: "project-1",
      ...repositoryAddress,
      question: "what owns this?",
    });
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
      (row) => row.querySelector(".context-map-name")?.textContent === "ui",
    );
    fireEvent.click(uiRow as Element);
    await waitFor(() =>
      expect(container.querySelector(".context-map-knowledge")?.textContent).toContain(
        "Renders over the protocol only.",
      ),
    );
  });

  it("shows exact mapped and excluded file counts instead of calling partial knowledge complete", async () => {
    const { bridge } = fakeBridge({
      status: "ok",
      map: mapWithCoverage,
      knowledge: knowledgeWithCoverage,
    });
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector(".context-map-fresh")).not.toBeNull());

    const freshness = container.querySelector(".context-map-fresh")?.textContent;
    expect(freshness).toContain("64 mapped");
    expect(freshness).toContain("1 scope-excluded");
    expect(freshness).toContain("1 mechanically excluded");
    expect(freshness).not.toBe("● current");
  });

  it("refuses to call matching-identity coverage current when its inventory is partial", async () => {
    const exact = knowledgeWithCoverage.coverage;
    if (exact === undefined) throw new Error("fixture");
    const { bridge } = fakeBridge({
      status: "ok",
      map: mapWithCoverage,
      knowledge: {
        ...knowledgeWithCoverage,
        coverage: { ...exact, groups: exact.groups.slice(0, 2) },
      },
    });
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector(".context-map-fresh")).not.toBeNull());
    expect(container.querySelector(".context-map-fresh")?.textContent).toContain(
      "coverage invalid",
    );
    expect(container.querySelector(".context-map-fresh")?.textContent).not.toContain("64 mapped");
  });

  it("calls current-swarm knowledge without its mandatory coverage invalid", async () => {
    const { bridge } = fakeBridge({
      status: "ok",
      map,
      knowledge: { ...knowledge, generator: KNOWLEDGE_SWARM_GENERATOR_ID },
    });
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector(".context-map-fresh")).not.toBeNull());
    expect(container.querySelector(".context-map-fresh")?.textContent).toContain(
      "coverage invalid",
    );
    expect(container.querySelector(".context-map-fresh")?.textContent).not.toContain(
      "coverage unrecorded",
    );
  });

  it("explains an empty selection that was deliberately scope-excluded", async () => {
    const { bridge } = fakeBridge({
      status: "ok",
      map: mapWithCoverage,
      knowledge: knowledgeWithCoverage,
    });
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector(".context-map-tree")).not.toBeNull());
    const uiRow = [...container.querySelectorAll(".context-map-tree .context-map-row")].find(
      (row) => row.querySelector(".context-map-name")?.textContent === "@wide/p64",
    );
    fireEvent.click(uiRow as Element);

    await waitFor(() =>
      expect(container.querySelector(".context-map-knowledge")?.textContent).toContain(
        "deliberately excluded from model mapping",
      ),
    );
    expect(container.querySelector(".context-map-knowledge")?.textContent).toContain(
      "Lower-priority application shell",
    );
    expect(container.querySelector(".context-map-knowledge")?.textContent).not.toContain(
      "Nothing learned about this selection yet",
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
    expect(container.querySelector(".context-map-consulted")?.textContent).toContain(
      "1 scope-excluded",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The takeover/embedded split. `/projects/:id/map` OWNS the window: the 40px header
// (Back, trail, `esc`) and the window Escape that keycap advertises. The session's
// `?view=map` renders the same surface INSIDE the session's chrome, where that header
// is a second Back and a second trail and that Escape fires from the chat composer.
// Nothing exercised Escape at all before this pair, while the keycap claimed it worked.
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextMapView — takeover chrome vs an in-session mount", () => {
  it("leaves the map on a window Escape when it is the takeover, making the `esc` keycap true", async () => {
    const { bridge } = fakeBridge();
    const onBack = vi.fn();
    const { container } = mount(
      <ContextMapView bridge={bridge} projectId="project-1" onBack={onBack} />,
    );
    await waitFor(() => expect(container.querySelector(".context-map-tree")).not.toBeNull());
    expect(container.querySelector(".context-map-bar")?.textContent).toContain("esc");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders no takeover chrome and installs no window Escape when embedded in a session", async () => {
    const { bridge } = fakeBridge();
    const onBack = vi.fn();
    const { container } = mount(
      <BridgeProvider bridge={bridge}>
        <ProductContextMapView projectId="project-1" onBack={onBack} takeover={false} />
      </BridgeProvider>,
    );
    await waitFor(() => expect(container.querySelector(".context-map-tree")).not.toBeNull());
    // No second header: no second Back, no second trail, no keycap promising an Escape.
    expect(container.querySelector(".context-map-bar")).toBeNull();
    expect(container.querySelector('[aria-label="Back"]')).toBeNull();
    // Escape anywhere in the window (the session's chat composer) does NOT navigate the
    // reviewer off the map. This assertion passes vacuously if the listener is simply
    // never reached for some other reason — the takeover case above is what proves the
    // same key press DOES fire the same handler when the listener is installed.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onBack).not.toHaveBeenCalled();
    // The gate is on the CHROME, not the surface: the map itself still renders.
    const baseStrip = container.querySelector(".context-map-base-strip");
    expect(baseStrip).not.toBeNull();
    expect(baseStrip?.querySelector('[role="heading"][aria-level="1"]')?.textContent).toBe(
      "Context Map",
    );
  });
});
