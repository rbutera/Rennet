import { describe, expect, it } from "vitest";
import { createModels, createSpanner } from "./constellation-models";

describe("constellation morph geometry", () => {
  it("gives every scene the same deterministic, finite particle budget", () => {
    const models = createModels(257);
    expect(models).toHaveLength(6);
    for (const model of [...models, createSpanner(257)]) {
      expect(model).toHaveLength(257 * 3);
      expect([...model].every(Number.isFinite)).toBe(true);
      expect(Math.max(...model) - Math.min(...model)).toBeGreaterThan(1);
    }
    expect(createModels(257)).toEqual(models);
    expect(new Set(models.map((model) => model.join(","))).size).toBe(6);
  });
});
