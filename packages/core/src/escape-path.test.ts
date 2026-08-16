import { describe, expect, it } from "vitest";
import { escapePath } from "./escape-path";

// The exact cross-platform fixtures Rai LOCKED (brief 2026-08-10 + design §1.2 +
// the repo-map-storage spec scenarios). These are the contract: the leading-dash
// form (Claude Code's real `~/.claude/projects/-Users-rai-navi` shape) is chosen.
describe("escapePath", () => {
  const cases: readonly (readonly [label: string, input: string, expected: string])[] = [
    ["POSIX path", "/Users/rai/dev/lumiere", "-Users-rai-dev-lumiere"],
    ["POSIX path (Claude Code's verifiable form)", "/Users/rai/navi", "-Users-rai-navi"],
    [
      "Windows drive path (drive-colon + backslash collapse)",
      "C:\\Users\\rai\\navi",
      "C-Users-rai-navi",
    ],
    [
      "Windows UNC path (leading double-backslash collapses)",
      "\\\\srv\\share\\proj",
      "-srv-share-proj",
    ],
  ];

  for (const [label, input, expected] of cases) {
    it(`${label}: ${input} → ${expected}`, () => {
      expect(escapePath(input)).toBe(expected);
    });
  }

  it("is deterministic and stable across repeated calls", () => {
    const input = "/Users/rai/dev/rennet";
    expect(escapePath(input)).toBe(escapePath(input));
    expect(escapePath(input)).toBe("-Users-rai-dev-rennet");
  });

  it("collapses a run of mixed separators (drive-colon-backslash) to one dash", () => {
    // `:` then `\` is two escapable chars in a row — they must collapse to ONE `-`.
    expect(escapePath("D:\\repo")).toBe("D-repo");
  });

  it("leaves a segment with no separators untouched", () => {
    expect(escapePath("noseparators")).toBe("noseparators");
  });

  it("keys a drive-letter absolute path (Windows host)", () => {
    // A `C:\dev\repo` project key must be a single flat segment, `:` and `\` folded.
    expect(escapePath("C:\\dev\\repo")).toBe("C-dev-repo");
  });

  it("keys a WSL UNC path (add-windows-support)", () => {
    // The leading `\\` collapses with the following `wsl.localhost` separator to one
    // dash, so a distro-resident project has a stable, flat key.
    expect(escapePath("\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo")).toBe(
      "-wsl.localhost-Ubuntu-home-rai-repo",
    );
  });
});
