import type { CanvasOpsBackend, HarnessEvent } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { startCanvasOpsExternalServer } from "./canvas-ops-external";
import { makeCanvasOpsTestBackend } from "./canvas-ops-test-backend";
import { createCodexHarness } from "./codex-turn-transport";

// ─────────────────────────────────────────────────────────────────────────────
// Gated MANUAL real orchestrator round-trip (#25, task 4.2).
//
// Proves the codex slot reaches canvasOps@2 through the EXTERNAL loopback
// streamable-HTTP transport against the LIVE backend: a real `codex exec` session
// configured with `-c mcp_servers.canvasops.url=<loopback>` calls canvas.describe
// then canvas.read, and the in-process backend records those calls. Spends
// subscription quota, so SKIPPED unless RENNET_LIVE_CODEX=1; never in the gate.
//
//   RENNET_LIVE_CODEX=1 pnpm exec vitest run packages/adapters/src/orchestrator-codex-live.real.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.RENNET_LIVE_CODEX === "1";

/** Wrap a backend to record which retrieval ops the codex session actually calls. */
function recording(backend: CanvasOpsBackend): { backend: CanvasOpsBackend; calls: string[] } {
  const calls: string[] = [];
  const wrapped: CanvasOpsBackend = {
    ...backend,
    canvas: (id) => {
      calls.push("canvas");
      return backend.canvas(id);
    },
    element: (ref) => {
      calls.push("element");
      return backend.element(ref);
    },
  };
  return { backend: wrapped, calls };
}

describe("codex orchestrator slot — real canvasOps@2 external round-trip (gated)", () => {
  it.skipIf(!LIVE)(
    "a real codex session round-trips canvas.describe → canvas.read over the loopback transport",
    async () => {
      const { backend: base } = makeCanvasOpsTestBackend();
      const { backend, calls } = recording(base);
      const server = await startCanvasOpsExternalServer(backend);
      try {
        const { adapter, discovery } = await createCodexHarness({
          mcpServers: { canvasops: { url: server.url } },
        });
        expect(adapter, `no codex: ${JSON.stringify(discovery.health)}`).not.toBeNull();
        if (!adapter) return;

        const session = await adapter.createSession({ cwd: process.cwd() });
        await session.send({
          prompt: [
            "You have an MCP server named `canvasops`. Using ONLY its tools:",
            "1. Call `canvas.describe` with { depth: 'counts' }.",
            "2. Call `canvas.describe` with { depth: 'elements' } and take the first elementKey.",
            "3. Call `canvas.read` with { ref: <that elementKey> }.",
            "Then reply with the single word DONE. Do not edit any files.",
          ].join("\n"),
        });
        const events: HarnessEvent[] = [];
        for await (const event of session.events) events.push(event);

        const ended = events.find((e) => e.kind === "session.ended");
        expect(ended?.kind).toBe("session.ended");
        // The live backend saw the describe and read calls come through the loopback transport.
        expect(calls).toContain("canvas");
        expect(calls).toContain("element");
      } finally {
        await server.close();
      }
    },
    180_000,
  );
});
