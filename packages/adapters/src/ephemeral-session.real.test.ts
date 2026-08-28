// ─────────────────────────────────────────────────────────────────────────────
// #585 — the LIVE positive control for ephemeral sessions.
//
// `ephemeral` on codex app-server's `thread/start` is UNDOCUMENTED (found via
// `codex app-server generate-json-schema`; present in codex-cli 0.147.0 as
// "Whether the thread is ephemeral and should not be materialized on disk"). An
// undocumented field can vanish, so this is the check that re-proves it — and its
// Claude peer, the SDK's `persistSession: false` — against the installed binaries
// by COUNTING FILES, not by trusting the flag.
//
// Each leg has a control that can fail: the same turn without the flag must add
// exactly one file. Both turns must complete.
//
//   RENNET_LIVE_SESSIONS=1 pnpm exec vitest run packages/adapters/src/ephemeral-session.real.test.ts
//
// Skipped in the normal gate: it spawns the user's real harnesses.
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeHarness } from "./claude-query";
import type { CodexTurnResultFrame } from "./codex-app-server";
import { defaultSpawnAppServer, runCodexTurn } from "./codex-app-server";
import { createCodexExecutor } from "./codex-exec";

const LIVE = process.env.RENNET_LIVE_SESSIONS === "1";
/** Today's rollout directory — `~/.codex/sessions/YYYY/MM/DD`. */
function todayDir(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return join(homedir(), ".codex", "sessions", String(now.getFullYear()), mm, dd);
}
const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

function countCodex(): number {
  try {
    return readdirSync(todayDir()).length;
  } catch {
    return 0;
  }
}
function countClaude(): number {
  let n = 0;
  for (const d of readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      n += readdirSync(join(CLAUDE_PROJECTS, d.name)).length;
    } catch {
      // An unreadable project dir contributes nothing to the count.
    }
  }
  return n;
}

async function codexTurn(ephemeral: boolean | undefined): Promise<string> {
  let terminal: CodexTurnResultFrame | null = null;
  const conn = defaultSpawnAppServer({ bin: "codex", args: ["app-server"], cwd: "/tmp" });
  for await (const frame of runCodexTurn(conn, {
    cwd: "/tmp",
    prompt: "Reply with exactly the word: ok",
    model: "gpt-5.6-luna",
    effort: "low",
    ...(ephemeral === undefined ? {} : { ephemeral }),
  })) {
    if ((frame as { rennet?: unknown }).rennet === "turn-result") {
      terminal = frame as CodexTurnResultFrame;
    }
  }
  return `${terminal?.status}:${(terminal?.finalMessage ?? "").slice(0, 40)}`;
}

describe("#585 live positive control", () => {
  it.skipIf(!LIVE)(
    "codex: ephemeral:true adds no rollout, omitting it adds one",
    async () => {
      const b1 = countCodex();
      const t1 = await codexTurn(true);
      const a1 = countCodex();
      const b2 = countCodex();
      const t2 = await codexTurn(undefined);
      const a2 = countCodex();
      console.log(
        `CODEX ephemeral=true  ${b1} -> ${a1} delta=${a1 - b1} turn=${t1}\n` +
          `CODEX ephemeral=off   ${b2} -> ${a2} delta=${a2 - b2} turn=${t2}`,
      );
      expect(t1.startsWith("completed")).toBe(true);
      expect(t2.startsWith("completed")).toBe(true);
      expect(a1 - b1).toBe(0);
      expect(a2 - b2).toBe(1);
    },
    600_000,
  );

  it.skipIf(!LIVE)(
    "codex: the shipped utility executor writes no rollout",
    async () => {
      const before = countCodex();
      const executor = createCodexExecutor();
      const out = await executor({
        prompt: 'Emit {"ok": true}.',
        model: "gpt-5.6-luna",
        effort: "low",
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      });
      const after = countCodex();
      console.log(
        `CODEX shipped executor ${before} -> ${after} delta=${after - before} out=${JSON.stringify(out.output)}`,
      );
      expect(out.output).toBeDefined();
      expect(after - before).toBe(0);
    },
    600_000,
  );

  it.skipIf(!LIVE)(
    "claude: ephemeral:true adds no session file, omitting it adds one",
    async () => {
      const { adapter } = await createClaudeHarness();
      expect(adapter).not.toBeNull();
      if (!adapter) return;
      const run = async (ephemeral: boolean | undefined): Promise<string> => {
        const session = await adapter.createSession({
          cwd: "/tmp",
          model: "haiku",
          ...(ephemeral === undefined ? {} : { ephemeral }),
        });
        let status = "none";
        try {
          await session.send({ prompt: "Reply with exactly the word: ok" });
          for await (const event of session.events) {
            if (event.kind === "session.ended") {
              status = event.outcome.status;
              break;
            }
            if (event.kind === "error") {
              status = `error:${event.error.message}`;
              break;
            }
          }
        } finally {
          await session.close();
        }
        return status;
      };
      const b1 = countClaude();
      const t1 = await run(true);
      const a1 = countClaude();
      const b2 = countClaude();
      const t2 = await run(undefined);
      const a2 = countClaude();
      console.log(
        `CLAUDE ephemeral=true  ${b1} -> ${a1} delta=${a1 - b1} turn=${t1}\n` +
          `CLAUDE ephemeral=off   ${b2} -> ${a2} delta=${a2 - b2} turn=${t2}`,
      );
      expect(t1).toBe("completed");
      expect(t2).toBe("completed");
      expect(a1 - b1).toBe(0);
      expect(a2 - b2).toBe(1);
    },
    600_000,
  );
});
