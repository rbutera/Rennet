import type { HarnessEvent } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./codex-adapter";
import type { AppServerConnection } from "./codex-app-server";
import { type CodexTransportEffects, createCodexTurnTransport } from "./codex-turn-transport";

// A tripwire proving the adapter + its composition-root app-server transport read
// NO credential path (Codex `auth.json` included) across construction and a full
// fake turn. `codex` authenticates itself on the user's own subscription.

function isCredentialPath(path: string): boolean {
  return (
    path.endsWith("/auth.json") ||
    path.endsWith("/.credentials.json") ||
    path.includes("/.codex/auth")
  );
}

function recordingEffects(): { effects: CodexTransportEffects; accessed: string[] } {
  const accessed: string[] = [];
  const effects: CodexTransportEffects = {
    // Fake spawn: no process, no file, no credential — a scripted app-server turn.
    spawn: ({ bin, args }) => {
      accessed.push(bin, ...args);
      const buffer: Record<string, unknown>[] = [];
      let done = false;
      let wake: (() => void) | null = null;
      const push = (v: Record<string, unknown>): void => {
        buffer.push(v);
        wake?.();
        wake = null;
      };
      const conn: AppServerConnection = {
        send: (message) => {
          const { method, id } = message;
          if (method === "initialize") push({ id, result: {} });
          else if (method === "thread/start") push({ id, result: { thread: { id: "cred" } } });
          else if (method === "turn/start") {
            push({
              method: "item/completed",
              params: { item: { id: "i", type: "agentMessage", text: '{"ok":true}' } },
            });
            push({
              method: "turn/completed",
              params: { threadId: "cred", turn: { id: "tn", status: "completed", items: [] } },
            });
          }
        },
        messages: {
          async *[Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
            while (true) {
              if (buffer.length > 0) {
                yield buffer.shift() as Record<string, unknown>;
                continue;
              }
              if (done) return;
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          },
        },
        kill: () => {
          done = true;
          wake?.();
          wake = null;
        },
        exit: Promise.resolve({ exitCode: 0, stderr: "", aborted: false }),
      };
      return conn;
    },
  };
  return { effects, accessed };
}

describe("Codex adapter credential tripwire", () => {
  it("reads no credential path across construction and a full turn", async () => {
    const { effects, accessed } = recordingEffects();
    const adapter = new CodexAdapter({
      binaryPath: "/x/codex",
      transport: createCodexTurnTransport("/x/codex", effects),
      version: "0.146.0",
    });
    const session = await adapter.createSession({
      cwd: "/repo",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    });
    await session.send({ prompt: "review" });
    const events: HarnessEvent[] = [];
    for await (const event of session.events) events.push(event);

    // Positive control: the transport was actually driven (it composed a spawn).
    expect(accessed.length).toBeGreaterThan(0);
    // The finding: nothing the transport touched was a credential path.
    expect(accessed.filter(isCredentialPath)).toEqual([]);
    // Control that the predicate CAN fire on a real credential path.
    expect(isCredentialPath("/home/rai/.codex/auth.json")).toBe(true);
    expect(isCredentialPath("/home/rai/.codex/config.toml")).toBe(false);
    // Sanity: the turn actually completed.
    const ended = events.find((e) => e.kind === "session.ended");
    expect(ended?.kind).toBe("session.ended");
  });
});
