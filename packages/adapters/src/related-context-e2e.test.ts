import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDeltaPacket, type HarnessTurnResult } from "@rennet/core";
import {
  DOSSIER_BODY_MAX_CHARS,
  dossierItemSchema,
  type PatchFile,
  type Patchset,
  serializeDossier,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { DOSSIER_TOTAL_MAX_CHARS, type GhRunner, retrieveRelatedContext } from "./related-context";

/**
 * B07 packet E2E (reconciliation 4, ruled): a frozen real-Rennet-PR capture
 * (PR #514 + issue #464 and its body-hop issues — own-repo material only)
 * drives the full retrieval flow with a stub enrichment turn. No network, no
 * model, in any gate path: the gh runner replays the frozen bytes and throws
 * an unreachable-shaped error for anything outside the capture.
 */

interface FrozenFixture {
  pr: { number: number; title: string; body: string; comments: { body: string }[] };
  issues: Record<
    string,
    {
      issue: { title: string; state: string; body: string; html_url: string };
      comments: { body: string }[];
    }
  >;
}

const FIXTURE: FrozenFixture = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__/related-context/pr514-frozen.json"), "utf8"),
);

function frozenGh(fixture: FrozenFixture): GhRunner {
  return async (args: string[]) => {
    // The PR's own view — the production path fetches title/body/comments HERE,
    // through the injected runner, never from a caller-side cache.
    if (args[0] === "pr" && args[1] === "view" && args[2] === String(fixture.pr.number)) {
      return JSON.stringify(fixture.pr);
    }
    const issueApi = /^repos\/rbutera\/rennet\/issues\/(\d+)$/.exec(args[1] ?? "");
    if (args[0] === "api" && issueApi) {
      const frozen = fixture.issues[issueApi[1] ?? ""];
      if (frozen) return JSON.stringify(frozen.issue);
    }
    const commentsApi = /^repos\/rbutera\/rennet\/issues\/(\d+)\/comments$/.exec(args[1] ?? "");
    if (args[0] === "api" && commentsApi) {
      const frozen = fixture.issues[commentsApi[1] ?? ""];
      if (frozen) return JSON.stringify(frozen.comments);
    }
    // Outside the frozen capture: an unreachable-shaped failure (typed, never
    // a crash) — honest for refs the capture deliberately did not follow.
    throw new Error(`fixture: ${args.join(" ")} is outside the frozen capture`);
  };
}

function patchsetOf(files: PatchFile[]): Patchset {
  return {
    id: "ps_b07_e2e",
    createdAt: "2026-08-27T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "origin/main",
      baseOid: "0".repeat(40),
      headOid: "1".repeat(40),
    },
    files,
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  };
}

describe("B07 packet e2e — frozen PR #514 capture through the full retrieval flow", () => {
  const run = async () => {
    const keepAll = async (): Promise<HarnessTurnResult> => ({
      status: "emitted",
      body: { items: [] },
    });
    // The PR's title/body/comments are NOT passed in: the flow fetches them
    // itself through the frozen runner (`gh pr view`), the production path.
    return retrieveRelatedContext(
      { branchName: "b05-delta-packet" },
      {
        gh: frozenGh(FIXTURE),
        repo: { owner: "rbutera", name: "rennet" },
        prNumber: FIXTURE.pr.number,
        runTurn: keepAll,
        now: () => new Date("2026-08-27T12:00:00.000Z"),
      },
    );
  };

  it("produces a bounded dossier whose every item carries provenance and fetched-at", async () => {
    const result = await run();

    // The capture's anchor ref (#464) and its body-hop issues all resolved.
    const ids = result.items.map((item) => item.id).sort();
    expect(ids).toEqual([
      "github:rbutera/rennet#457",
      "github:rbutera/rennet#459",
      "github:rbutera/rennet#460",
      "github:rbutera/rennet#464",
    ]);

    for (const item of result.items) {
      const parsed = dossierItemSchema.parse(item); // schema = the bound + required provenance/fetchedAt
      expect(parsed.provenance.length).toBeGreaterThan(0);
      expect(parsed.fetchedAt).toBe("2026-08-27T12:00:00.000Z");
      expect(parsed.body.length).toBeLessThanOrEqual(DOSSIER_BODY_MAX_CHARS);
    }

    // Refs outside the frozen capture surfaced as typed failures, not crashes.
    expect(result.failures.length).toBeGreaterThan(0);
    for (const failure of result.failures) {
      expect(failure.error).toBe("unreachable");
    }

    // Serialized size respects the dossier-wide bound — a fixed cap, not one
    // that scales with however many items were fetched.
    const serialized = serializeDossier(result.items);
    expect(serialized.length).toBeLessThanOrEqual(DOSSIER_TOTAL_MAX_CHARS);
    expect(result.omitted).toEqual([]);
  });

  it("inlines into a B05 buildDeltaPacket call without truncation", async () => {
    const result = await run();
    const patch = ["@@ -1,1 +1,1 @@", "-const a = 1;", "+const a = 2;"].join("\n");
    const packet = buildDeltaPacket(
      patchsetOf([
        {
          path: "packages/core/src/example.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          binary: false,
          patch,
        },
      ]),
      result.items,
    );
    // Byte-identical pass-through — the packet carries the items untruncated.
    expect(packet.dossier).toEqual(result.items);
    expect(serializeDossier(packet.dossier)).toBe(serializeDossier(result.items));
  });
});
