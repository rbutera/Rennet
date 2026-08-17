import type { HarnessEvent } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./codex-adapter";
import { type CodexTransportEffects, createCodexTurnTransport } from "./codex-turn-transport";

// Task 2.4 — a tripwire proving the adapter + its composition-root transport read
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
    mkdtemp: (prefix) => {
      accessed.push(prefix);
      return Promise.resolve(`${prefix}scratch`);
    },
    writeFile: (path) => {
      accessed.push(path);
      return Promise.resolve();
    },
    readFile: (path) => {
      accessed.push(path);
      return Promise.resolve('{"ok":true}');
    },
    rm: (path) => {
      accessed.push(path);
      return Promise.resolve();
    },
    // Fake spawn: no process, no credential — canned frames ending in a result.
    spawn: (_bin, _args, _cwd, outPath) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        accessed.push(`spawn:${outPath}`);
        yield { type: "thread.started", thread_id: "cred" };
        yield {
          type: "item.completed",
          item: { id: "item_1", type: "agent_message", text: '{"ok":true}' },
        };
        yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
        yield { rennet: "turn-result", exitCode: 0, lastMessage: '{"ok":true}' };
      },
    }),
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

    // Positive control: the transport actually touched the filesystem (the check
    // is live, not vacuous).
    expect(accessed.length).toBeGreaterThan(0);
    // The finding: none of those touches was a credential path.
    expect(accessed.filter(isCredentialPath)).toEqual([]);
    // Control that the predicate CAN fire on a real credential path.
    expect(isCredentialPath("/home/rai/.codex/auth.json")).toBe(true);
    expect(isCredentialPath("/home/rai/.codex/config.toml")).toBe(false);
    // Sanity: the turn actually completed.
    const ended = events.find((e) => e.kind === "session.ended");
    expect(ended?.kind).toBe("session.ended");
  });
});
