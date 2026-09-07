import { describe, expect, it } from "vitest";
import {
  PROJECT_SCOUT_LOGO_CANDIDATE_CAP,
  PROJECT_SCOUT_PATH_CAP,
  renderProjectScoutPrompt,
} from "./prompt-contracts";

const base = { gaps: ["gateCommand"], guidanceDocs: [] } as const;

describe("renderProjectScoutPrompt (#900)", () => {
  it("names the guidance documents and the detected-facts file, and carries neither's content", () => {
    const prompt = renderProjectScoutPrompt({
      gaps: ["trackerKind", "gateCommand"],
      detectedRef: ".rennet/context/project-scout-1/scout-detected.json",
      guidanceDocs: ["CONTRIBUTING.md", "AGENTS.md"],
    });
    expect(prompt).toContain("trackerKind, gateCommand");
    expect(prompt).toContain(".rennet/context/project-scout-1/scout-detected.json");
    expect(prompt).toContain("CONTRIBUTING.md, AGENTS.md");
    // No logo section when the caller found no candidate: the seat is not asked to
    // invent one, and the prompt does not pay for a section with nothing in it.
    expect(prompt).not.toContain("logoPath");
  });

  it("caps the candidate list and says how many it did not list", () => {
    const candidates = Array.from({ length: 40 }, (_, i) => `assets/logo-${i}.svg`);
    const prompt = renderProjectScoutPrompt({
      ...base,
      logo: { candidates, total: 57 },
    });
    const listed = candidates.filter((path) => prompt.includes(`- ${path}\n`));
    expect(listed).toHaveLength(PROJECT_SCOUT_LOGO_CANDIDATE_CAP);
    // 57 found, 20 listed: the marker states the 37 the reader cannot see.
    expect(prompt).toContain("…and 37 more not listed");
    // The control: a list that fits carries no marker at all, so the marker is a
    // statement about THIS render and not boilerplate every prompt wears.
    const short = renderProjectScoutPrompt({
      ...base,
      logo: { candidates: candidates.slice(0, 3), total: 3 },
    });
    expect(short).toContain("- assets/logo-2.svg");
    expect(short).not.toContain("more not listed");
  });

  it("truncates one pathological path instead of carrying it whole", () => {
    const long = `assets/${"deep/".repeat(200)}logo.svg`;
    const prompt = renderProjectScoutPrompt({ ...base, logo: { candidates: [long], total: 1 } });
    expect(prompt).not.toContain(long);
    expect(prompt).toContain("…");
    // The bound is the declared one, not "shorter than the input".
    const line = prompt.split("\n").find((entry) => entry.startsWith("- assets/deep/"));
    // The cap covers the path INCLUDING its truncation marker; the 2 is the "- " bullet.
    expect(Buffer.byteLength(line ?? "", "utf8")).toBe(PROJECT_SCOUT_PATH_CAP + 2);
  });

  it("states what a suitable mark is, and never restates the output schema", () => {
    const prompt = renderProjectScoutPrompt({
      ...base,
      logo: { candidates: ["public/logo.svg"], total: 1 },
    });
    expect(prompt).toContain("standalone square mark over a wordmark");
    expect(prompt).toContain("svg over raster");
    expect(prompt).toContain("64px");
    expect(prompt).toContain("sponsor, partner,");
    expect(prompt).toContain("screenshots and diagrams");
    // It may look outside the list — the inventory is a starting point, not a fence.
    expect(prompt).toContain("not a fence");
    // The schema travels as the SDK `outputFormat`; the prompt names it and no more.
    expect(prompt).toContain("Return JSON per the schema.");
    expect(prompt).not.toContain("additionalProperties");
    expect(prompt).not.toContain('"type":');
  });

  it("stays small: the whole logo section is a bound, not a vibe", () => {
    const prompt = renderProjectScoutPrompt({
      gaps: ["trackerKind", "gateCommand"],
      detectedRef: ".rennet/context/project-scout-1/scout-detected.json",
      guidanceDocs: ["CONTRIBUTING.md", "CLAUDE.md", "AGENTS.md"],
      logo: {
        candidates: Array.from({ length: 20 }, (_, i) => `public/images/brand/mark-${i}.svg`),
        total: 31,
      },
    });
    // A full 20-path inventory on a repo with every guidance document present.
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(2_400);
  });
});
