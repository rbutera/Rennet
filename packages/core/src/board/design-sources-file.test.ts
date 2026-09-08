import { describe, expect, it } from "vitest";
import { DESIGN_SOURCES_FILE, designSourcesContextFile } from "./design-sources-file";

const OPENSPEC = [
  { format: "openspec" as const, role: "proposal", path: "openspec/changes/ws/proposal.md" },
  { format: "openspec" as const, role: "tasks", path: "openspec/changes/ws/tasks.md" },
  {
    format: "openspec" as const,
    role: "spec-delta",
    path: "openspec/changes/ws/specs/settings-resolution/spec.md",
  },
];

describe("designSourcesContextFile", () => {
  it("names the format and every artifact path, and never the artifact text", () => {
    const file = designSourcesContextFile(OPENSPEC);
    expect(file?.name).toBe(DESIGN_SOURCES_FILE);
    expect(file?.body).toContain("Format: OpenSpec");
    for (const source of OPENSPEC) {
      expect(file?.body).toContain(`- \`${source.path}\` — ${source.role}`);
    }
    // The seat is told these ARE the specification, so it does not go looking for one.
    expect(file?.body).toContain("do not search for another");
    expect(file?.readWhen).toContain("first");
  });

  it("is undefined when nothing was located — a prompt must not name an unwritten file", () => {
    expect(designSourcesContextFile([])).toBeUndefined();
  });

  it("declares a byte bound: past the cap it says how many paths it dropped", () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      format: "kiro" as const,
      role: "requirements",
      path: `.kiro/specs/feature-${index}/requirements.md`,
    }));
    const file = designSourcesContextFile(many, 40);
    const listed = file?.body.split("\n").filter((line) => line.startsWith("- `")) ?? [];
    expect(listed).toHaveLength(40);
    expect(file?.body).toContain("… and 5 more artifacts not listed");
    // The control: under the cap, no marker.
    expect(designSourcesContextFile(many.slice(0, 3), 40)?.body).not.toContain("not listed");
  });
});
