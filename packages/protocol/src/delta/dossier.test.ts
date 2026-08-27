import { describe, expect, it } from "vitest";
import { type DossierItem, dossierItemSchema, serializeDossier } from "./dossier";

const item: DossierItem = {
  id: "jira:REN-42",
  tracker: "jira",
  title: "Reviewer cannot cite acceptance criteria",
  state: "In Progress",
  body: "As a reviewer I want the round report to verify asks against the ticket's acceptance criteria.",
  acceptanceCriteria: "Round report cites AC by dossier id.",
  url: "https://example.atlassian.net/browse/REN-42",
  provenance: "branch-name",
  fetchedAt: "2026-08-27T10:00:00.000Z",
};

describe("dossierItemSchema (#461 §8)", () => {
  it("round-trips a full item", () => {
    expect(dossierItemSchema.parse(item)).toEqual(item);
  });

  it("accepts an item without acceptance criteria and rejects a missing freshness stamp", () => {
    const bare = { ...item };
    delete bare.acceptanceCriteria;
    expect(dossierItemSchema.parse(bare)).toEqual(bare);
    expect(dossierItemSchema.safeParse({ ...bare, fetchedAt: "yesterday" }).success).toBe(false);
  });
});

describe("serializeDossier", () => {
  it("is deterministic: item order and input key order do not change the bytes", () => {
    const other: DossierItem = {
      ...item,
      id: "github:461",
      tracker: "github",
      provenance: "pr-body",
    };
    // Same items, different array order AND different key insertion order.
    const shuffledKeys = JSON.parse(JSON.stringify(item, Object.keys(item).sort())) as DossierItem;
    expect(serializeDossier([other, shuffledKeys])).toBe(serializeDossier([item, other]));
  });
});
