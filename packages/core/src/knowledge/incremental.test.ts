import type { KnowledgeSet, KnowledgeStatement } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { dispositionCarrier, planReverify, routeDelta } from "./incremental";
import type { PartitionSlice } from "./partition";

const PARTITIONS: readonly PartitionSlice[] = [
  { id: "src", files: [{ path: "src/a.ts", blobOid: "blob-a" }] },
  { id: "lib", files: [{ path: "lib/b.ts", blobOid: "blob-b" }] },
  { id: "dir:docs", files: [{ path: "docs/c.md", blobOid: "blob-c" }] },
];

function statement(
  id: string,
  paths: readonly string[],
  status: KnowledgeStatement["status"] = "hypothesis",
): KnowledgeStatement {
  return {
    id,
    subject: id,
    aspect: "purpose",
    claim: `claim ${id}`,
    evidence: paths.map((path) => ({ path, blobOid: `blob-${path}` })),
    confidence: "high",
    status,
    provenance: { generator: "knowledge-swarm@1", model: null, apiKeySource: null },
    learnedAgainst: { baseOid: "a".repeat(40), snapshotFingerprint: "fp-1" },
  };
}

function set(statements: readonly KnowledgeStatement[]): KnowledgeSet {
  return {
    schemaVersion: 1,
    repoKey: "repo",
    baseOid: "a".repeat(40),
    snapshotFingerprint: "fp-1",
    generator: "knowledge-swarm@1",
    statements,
  };
}

describe("routeDelta", () => {
  it("one changed file re-runs exactly its owning partition", () => {
    const routed = routeDelta(PARTITIONS, ["lib/b.ts"]);
    expect(routed.map((slice) => slice.id)).toEqual(["lib"]);
  });

  it("no changed paths routes nothing; unknown paths route nothing", () => {
    expect(routeDelta(PARTITIONS, [])).toEqual([]);
    expect(routeDelta(PARTITIONS, ["deleted/gone.ts"])).toEqual([]);
  });
});

describe("planReverify", () => {
  it("splits evidence-touched from carried, carry byte-identical", () => {
    const touched = statement("s-touched", ["src/a.ts"]);
    const untouched = statement("s-untouched", ["lib/b.ts"]);
    const plan = planReverify(set([touched, untouched]), ["src/a.ts"]);
    expect(plan.reverify).toEqual([touched]);
    expect(plan.carried).toHaveLength(1);
    // Carried verbatim: the SAME object, not a rebuilt copy.
    expect(plan.carried[0]).toBe(untouched);
  });

  it("cross-cutting sensitivity: multi-slice evidence re-verifies on ANY cited path", () => {
    const crossCutting = statement("s-cross", ["src/a.ts", "docs/c.md"]);
    // docs/c.md changed — src's partition is not re-running, the statement still re-verifies.
    const plan = planReverify(set([crossCutting]), ["docs/c.md"]);
    expect(plan.reverify).toEqual([crossCutting]);
    expect(plan.carried).toEqual([]);
  });
});

describe("dispositionCarrier", () => {
  it("keeps a prior confirmed/rejected status for a re-minted same-id claim", () => {
    const prior = set([statement("s-1", ["src/a.ts"], "confirmed")]);
    const carry = dispositionCarrier(prior);
    const reminted = statement("s-1", ["src/a.ts"]);
    expect(carry(reminted).status).toBe("confirmed");
    // A new id is a genuinely new claim — stays a hypothesis.
    expect(carry(statement("s-2", ["src/a.ts"])).status).toBe("hypothesis");
  });
});
