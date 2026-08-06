import type { HarnessEvent } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { createClaudeHarness } from "../src/claude-query";

/**
 * Gated, opt-in real-turn integration check. This is NOT part of the default
 * hermetic gate: `pnpm check` runs `vitest run packages/adapters/src`, which does
 * not reach this `integration/` directory, and the `skipIf` guard below keeps it
 * dormant even under a bare `vitest run`. It spends the subscription and needs a
 * live `claude`, so run it deliberately:
 *
 *     pnpm real-turn
 *
 * It proves the whole path end to end through the REAL @anthropic-ai/claude-agent-sdk:
 * discovery finds the user's own `claude`, the composition root wires the SDK
 * `query()` into the ClaudeAdapter, a tiny turn runs on the subscription/OAuth
 * path (apiKeySource oauth or the live "none", NEVER a metered key), and
 * schema-constrained structured output round-trips back as `structuredOutput`.
 */

const LIVE = process.env.RENNET_LIVE_CLAUDE === "1";

describe.skipIf(!LIVE)("live Claude real turn (opt-in; spends the subscription)", () => {
  it(
    "round-trips structured output through the real SDK on the subscription path",
    async () => {
      const { adapter, discovery } = await createClaudeHarness({ env: process.env });
      if (!adapter) {
        throw new Error(
          `No claude binary discovered; cannot run the real turn. Health: ${JSON.stringify(
            discovery.health,
          )}`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(`[real-turn] using claude at ${discovery.chosen?.path} (v${discovery.chosen?.version})`);

      const schema = {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      } as const;

      const session = await adapter.createSession({
        cwd: process.cwd(),
        readOnly: true,
        outputSchema: schema,
      });
      await session.send({
        prompt:
          "Respond only with the structured output {\"ok\": true}. Do not call any tools. Do not write any files.",
      });

      const events: HarnessEvent[] = [];
      for await (const event of session.events) events.push(event);

      const started = events.find((event) => event.kind === "session.started");
      const meteredWarning = events.find((event) => event.kind === "auth.metered-key-warning");
      const ended = events.find((event) => event.kind === "session.ended");

      const apiKeySource =
        started?.kind === "session.started" ? started.apiKeySource : "MISSING";
      // eslint-disable-next-line no-console
      console.log(`[real-turn] apiKeySource=${apiKeySource} meteredWarning=${meteredWarning ? "YES" : "no"}`);
      // eslint-disable-next-line no-console
      console.log(`[real-turn] outcome=${JSON.stringify(ended?.kind === "session.ended" ? ended.outcome : ended)}`);

      // The session started on the subscription path.
      expect(started).toBeDefined();
      expect(["oauth", "none"]).toContain(apiKeySource);
      // Money safety (R2): a subscription session must NEVER raise a metered warning.
      expect(meteredWarning).toBeUndefined();

      // Structured output round-tripped through the real SDK's outputFormat surface.
      expect(ended?.kind).toBe("session.ended");
      if (ended?.kind !== "session.ended" || ended.outcome.status !== "completed") {
        throw new Error(`Turn did not complete: ${JSON.stringify(ended)}`);
      }
      expect(ended.outcome.structuredOutput).toBeDefined();
      expect((ended.outcome.structuredOutput as { ok?: unknown }).ok).toBe(true);
    },
    120_000,
  );
});
