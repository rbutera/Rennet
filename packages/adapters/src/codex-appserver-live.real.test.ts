import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent, SessionOutcome } from "@rennet/core";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { createCodexHarness } from "./codex-turn-transport";
import { defaultCodexDiscoveryDeps, discoverCodex } from "./harness-discovery";

// ─────────────────────────────────────────────────────────────────────────────
// Gated MANUAL real app-server round-trip through the ChatGPT-desktop-bundled
// codex (adopt-codex-app-server, task 5.1).
//
// On a macOS host with ChatGPT desktop installed, this proves the zero-install
// claim end to end: discovery lists the bundled binary as a
// `chatgpt-desktop-bundle` candidate (ranked below a user CLI when one exists),
// and the bundled binary itself — sharing `~/.codex` auth with every other codex
// surface — completes a REAL app-server turn with first-class structured output
// and in-protocol token usage. Spends subscription quota, so SKIPPED unless
// RENNET_LIVE_APPSERVER_CODEX=1; never in the gate. Non-mac / no ChatGPT.app:
// skipped cleanly.
//
//   RENNET_LIVE_APPSERVER_CODEX=1 pnpm exec vitest run packages/adapters/src/codex-appserver-live.real.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.RENNET_LIVE_APPSERVER_CODEX === "1";
const BUNDLE = "/Applications/ChatGPT.app/Contents/Resources/codex";

async function mintHostRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rennet-appserver-live-"));
  const git = (...args: string[]) => execa("git", args, { cwd: dir, stdin: "ignore" });
  await git("init", "-q");
  await git("config", "user.email", "rennet-test@example.com");
  await git("config", "user.name", "rennet-test");
  await execa("sh", ["-c", "printf hi > f.txt"], { cwd: dir });
  await git("add", "f.txt");
  await git("-c", "commit.gpgsign=false", "commit", "-qm", "init");
  return dir;
}

describe("codex app-server — real ChatGPT-desktop-bundled binary round-trip (gated)", () => {
  it.skipIf(!LIVE)(
    "discovery lists the bundle and the bundled binary completes a structured turn",
    async () => {
      // (1) Real discovery on this host: the bundle is a candidate with its
      // provenance recorded, and a user CLI (when present) outranks it.
      const discovery = await discoverCodex(defaultCodexDiscoveryDeps());
      const bundle = discovery.candidates.find(
        (candidate) => candidate.provenance === "chatgpt-desktop-bundle",
      );
      expect(
        bundle,
        `no chatgpt-desktop-bundle candidate: ${JSON.stringify(discovery.candidates)}`,
      ).toBeDefined();
      expect(bundle?.path).toBe(BUNDLE);
      const cliCandidates = discovery.candidates.filter(
        (candidate) => candidate.provenance !== "chatgpt-desktop-bundle",
      );
      if (cliCandidates.length > 0) {
        expect(discovery.chosen?.path).not.toBe(BUNDLE);
      }

      // (2) A REAL turn through the bundled binary itself (explicit override runs
      // the same executability + app-server handshake probes): structured output
      // round-trips and usage arrives in-protocol.
      const { adapter, discovery: bundled } = await createCodexHarness({ explicitBin: BUNDLE });
      expect(adapter, `bundled codex unusable: ${JSON.stringify(bundled.health)}`).not.toBeNull();
      if (!adapter) return;

      const repo = await mintHostRepo();
      const session = await adapter.createSession({
        cwd: repo,
        outputSchema: {
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["ok"] },
                answer: { type: "string" },
              },
              required: ["kind", "answer"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["error"] },
                message: { type: "string" },
              },
              required: ["kind", "message"],
              additionalProperties: false,
            },
          ],
        },
      });
      await session.send({
        prompt: 'Reply with exactly the JSON {"kind":"ok","answer":"ok"}. Do not edit any files.',
      });
      const events: HarnessEvent[] = [];
      let outcome: SessionOutcome | null = null;
      for await (const event of session.events) {
        events.push(event);
        if (event.kind === "session.ended") outcome = event.outcome;
      }

      expect(outcome?.status, `outcome: ${JSON.stringify(outcome)}`).toBe("completed");
      if (outcome?.status !== "completed") return;
      expect(outcome.structuredOutput).toEqual({ kind: "ok", answer: "ok" });
      // In-protocol usage (thread/tokenUsage/updated), not a session-log read.
      expect(outcome.usage?.total ?? 0).toBeGreaterThan(0);
    },
    180_000,
  );
});
