import type { DecisionRecordBody } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  decisionsRecordFixture,
  emptyDecisionsRecordFixture,
  failedDecisionsRunStatus,
  okDecisionsRunStatus,
} from "./decisions-fixture";

describe("decisionsRecordFixture (issue #137)", () => {
  const docs = decisionsRecordFixture();
  const [firstDoc] = docs;
  if (!firstDoc) throw new Error("decisionsRecordFixture must produce a decision.record document");
  const decisions = (firstDoc.body as DecisionRecordBody).decisions;

  it("emits decision.record documents the projector routes to the decisions lens", () => {
    expect(docs).toHaveLength(1);
    expect(docs[0]?.docType).toBe("decision.record");
    expect(decisions.length).toBeGreaterThan(1);
  });

  it("marks EVERY reconstructed why as reconstructed (never a stated fact)", () => {
    for (const decision of decisions) {
      if (decision.why) expect(decision.why.reconstructed).toBe(true);
    }
  });

  it("includes a decision with NO discernible rationale (renders on evidence alone)", () => {
    expect(decisions.some((decision) => decision.why === undefined)).toBe(true);
  });

  it("draws evidence only from spec / PR-body / hunk sources, never a verdict", () => {
    for (const decision of decisions) {
      for (const chip of decision.evidence ?? []) {
        expect(["spec", "pr-body", "hunk"]).toContain(chip.kind);
      }
    }
  });

  it("carries NO evidenced / mechanical / contestable triage bucket in the data", () => {
    const serialized = JSON.stringify(docs).toLowerCase();
    expect(serialized).not.toContain("evidenced");
    expect(serialized).not.toContain("contestable");
    expect(serialized).not.toContain("mechanical");
  });

  it("keeps empty vs failed honestly distinct", () => {
    expect(emptyDecisionsRecordFixture()).toEqual([]);
    expect(okDecisionsRunStatus()).toEqual({ status: "ok" });
    expect(failedDecisionsRunStatus().status).toBe("failed");
  });
});
