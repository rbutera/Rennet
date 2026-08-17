import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./claude-adapter";
import {
  readTestedRange,
  TESTED_RANGE_ARTIFACT_PATH,
  type TestedRange,
} from "./harness-tested-range";

/** Read the artifact straight from disk — an INDEPENDENT source from the reader's
 *  static import, so a hand-edited constant that drifts from the file is caught. */
function artifactFromDisk(): Record<string, TestedRange> {
  return JSON.parse(readFileSync(TESTED_RANGE_ARTIFACT_PATH, "utf8"));
}

describe("harness tested-range artifact", () => {
  it("reads a harness's range from the committed artifact", () => {
    const disk = artifactFromDisk();
    expect(readTestedRange("claude-code")).toEqual(disk["claude-code"]);
    expect(readTestedRange("codex")).toEqual(disk.codex);
  });

  it("returns null for a harness with no recorded run", () => {
    expect(readTestedRange("omp")).toBeNull();
  });

  it("the Claude descriptor's testedRange equals the artifact — no other source", () => {
    const adapter = new ClaudeAdapter({
      binaryPath: "/x/claude",
      queryFn: () => ({
        async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
          for (const frame of [] as unknown[]) yield frame;
        },
      }),
    });
    expect(adapter.descriptor.testedRange).toEqual(artifactFromDisk()["claude-code"]);
  });
});
