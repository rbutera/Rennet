import { DECOMPOSITION_PROPOSAL_CONTRACT } from "@rennet/instructions";
import {
  buildOfferedManifest,
  createInvocationBudget,
  decompose,
  type DecompositionTurnResult,
  type HarnessEvent,
  runDecompositionAngle,
} from "@rennet/core";
import { bodyJsonSchema } from "@rennet/protocol";
import type { PatchFile, Patchset } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createClaudeHarness } from "../src/claude-query";

/**
 * Gated, opt-in real decomposition-angle turn. NOT part of the default gate:
 * `pnpm check` runs `vitest run packages/adapters/src`, which does not reach this
 * `integration/` directory, and the `skipIf` keeps it dormant even under a bare
 * `vitest run`. It spends the subscription and needs a live `claude`:
 *
 *     pnpm real-turn
 *
 * It drives the whole diff-to-angles transformation end to end on the
 * subscription/OAuth path (NEVER a metered key): the floor decomposes a tiny
 * changeset, the contract prompt is assembled, the real SDK runs one turn
 * constrained to the proposal body schema, and the orchestration stamps and
 * validates the result. Either the agent's body is admitted or the deterministic
 * floor stands — both prove the wiring; the assertion is that a document is
 * produced on the subscription path with no metered warning.
 */

const LIVE = process.env.RENNET_LIVE_CLAUDE === "1";

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: null, deletions: null, binary: false, patch };
}

function patch(path: string, lines: string[]): string {
  const oldCount = lines.filter((l) => l[0] === "-" || l[0] === " ").length;
  const newCount = lines.filter((l) => l[0] === "+" || l[0] === " ").length;
  return (
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
    `@@ -1,${oldCount} +1,${newCount} @@\n${lines.join("\n")}\n`
  );
}

const PATCHSET: Patchset = {
  id: "ps_live_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "origin/main",
    baseOid: "0".repeat(40),
    headOid: "1".repeat(40),
  },
  files: [
    file("src/a.ts", patch("src/a.ts", ["+export const a = 1;"])),
    file("src/b.ts", patch("src/b.ts", ['+import { a } from "./a";', "+export const b = a + 1;"])),
  ],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

describe.skipIf(!LIVE)("live decomposition angle (opt-in; spends the subscription)", () => {
  it(
    "runs the diff-to-angles transformation on the subscription path",
    async () => {
      const { adapter, discovery } = await createClaudeHarness({ env: process.env });
      if (!adapter) {
        throw new Error(
          `No claude binary discovered; cannot run the live decomposition. Health: ${JSON.stringify(
            discovery.health,
          )}`,
        );
      }

      const decomposition = decompose(PATCHSET);
      const manifest = buildOfferedManifest(decomposition);
      const outputSchema = bodyJsonSchema("decomposition.proposal");

      let sawMeteredWarning = false;
      let apiKeySource: string | null = "MISSING";

      const runTurn = async (prompt: string): Promise<DecompositionTurnResult> => {
        const session = await adapter.createSession({ cwd: process.cwd(), readOnly: true, outputSchema });
        await session.send({ prompt });
        const events: HarnessEvent[] = [];
        for await (const event of session.events) events.push(event);
        const started = events.find((event) => event.kind === "session.started");
        if (started?.kind === "session.started") apiKeySource = started.apiKeySource;
        if (events.some((event) => event.kind === "auth.metered-key-warning")) sawMeteredWarning = true;
        const ended = events.find((event) => event.kind === "session.ended");
        if (ended?.kind === "session.ended" && ended.outcome.status === "completed") {
          const body = ended.outcome.structuredOutput;
          if (body !== undefined) return { status: "emitted", body };
          return { status: "failed", message: "no structured output" };
        }
        return { status: "failed", message: `turn did not complete: ${JSON.stringify(ended)}` };
      };

      const result = await runDecompositionAngle({
        decomposition,
        contract: DECOMPOSITION_PROPOSAL_CONTRACT,
        manifest,
        provenance: {
          harness: "claude-code",
          harnessVersion: discovery.chosen?.version ?? "unknown",
          adapterVersion: "0.1.0",
          model: "unknown",
          modelReportedBy: "unknown",
          capability: {
            structuredOutput: {
              implementedByAdapter: true,
              advertisedByHarness: true,
              availableInSession: true,
            },
            perCallModelSelection: {
              implementedByAdapter: false,
              advertisedByHarness: false,
              availableInSession: false,
            },
          },
        },
        runTurn,
        maxRetries: 0,
        budget: createInvocationBudget(10), // explicit budget: absent now fails closed (#95)
      });

      // eslint-disable-next-line no-console
      console.log(
        `[real-decomp] apiKeySource=${apiKeySource} usedFallback=${result.usedFallback} admitted=${result.admitted}`,
      );

      // Money safety (R2): the subscription path only, never a metered key.
      expect(["oauth", "none"]).toContain(apiKeySource);
      expect(sawMeteredWarning).toBe(false);
      // The transformation produced an admitted decomposition — agent's or floor's.
      expect(result.admitted).toBe(true);
      expect(result.document.docType).toBe("decomposition.proposal");
    },
    180_000,
  );
});
