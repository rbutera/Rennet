import type { OfferedManifest, PatchsetRef } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createCodexUtilityAdapter } from "./codex-exec";

// ─────────────────────────────────────────────────────────────────────────────
// Gated MANUAL real-turn proof (issue #66).
//
// This composes the REAL Codex utility executor and drives one `complete` call
// end to end, proving the live wiring (core's CodexUtilityPort ↔ the real
// `codex exec` spawn ↔ the user's installed `codex`). It runs on the user's
// ChatGPT subscription, so it spends NO metered tokens — but it does spend
// subscription quota and needs a discoverable `codex` binary, so it is SKIPPED
// unless `RENNET_LIVE_CODEX` is set and never runs in the normal gate.
//
//   RENNET_LIVE_CODEX=1 pnpm exec vitest run packages/adapters/src/codex-utility-port.real.test.ts
//
// It reproduces the go/no-go spike: a gpt-5.6-luna structured-output call emits
// an RSP `ordering` body that PASSES the real validateDocument on a two-chunk
// manifest, at $0 metered.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.RENNET_LIVE_CODEX === "1";

const PATCHSET: PatchsetRef = { id: "ps-real-1" };
const MANIFEST: OfferedManifest = {
  occurrences: [
    { id: "c1", kind: "chunk" },
    { id: "c2", kind: "chunk" },
  ],
};

const PROMPT = [
  "You are ordering code-review chunks for comprehension.",
  "There are exactly two chunks with ids: c1, c2.",
  "Emit an ordering body whose readingOrder is exactly those two chunk ids (each",
  "once, any order) and a short non-empty rationale explaining the order.",
].join(" ");

describe("CodexUtilityPort — real codex exec (gated)", () => {
  it.skipIf(!LIVE)(
    "drives a real gpt-5.6-luna call to a validator-admitted ordering document on the subscription",
    async () => {
      const port = createCodexUtilityAdapter();
      const result = await port.complete({
        docType: "ordering",
        prompt: PROMPT,
        model: "gpt-5.6-luna",
        effort: "low",
        patchset: PATCHSET,
        manifest: MANIFEST,
      });

      expect(
        result.status,
        `expected admitted, got ${result.status}: ${JSON.stringify(result)}`,
      ).toBe("admitted");
      if (result.status !== "admitted") return;

      expect(result.document.provenance.harness).toBe("codex");
      expect(result.document.provenance.tier).toBe("light");
      expect(result.document.provenance.route).toBe("utility");
      expect(result.document.provenance.model).toBe("gpt-5.6-luna");
      // $0 metered: Codex reports no per-call USD on subscription.
      expect(result.document.provenance.reportedUsd).toBeNull();
      expect(result.report.admitted).toBe(true);
    },
    120_000,
  );
});
