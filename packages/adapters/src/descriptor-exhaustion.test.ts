import { describe, expect, it } from "vitest";
import { describeSpawnFailure } from "./descriptor-exhaustion";

// #850's third symptom: the message. All five lens lanes read "T3 sidecar unavailable:
// spawn EBADF", which is true and useless — the sidecar was fine, the daemon had no
// descriptors left, and the reader spent a week on #821 looking for a double-close in the
// spawn helpers. The assertion here is on what the SENTENCE says, because the sentence is
// the whole feature.
describe("describeSpawnFailure", () => {
  it("names the real cause for each errno the descriptor budget produces", () => {
    // The exact text that reached the lens lanes.
    const said = describeSpawnFailure("spawn EBADF");
    expect(said).toContain("spawn EBADF"); // the original is kept: it is what a log grep finds
    expect(said).toContain("file-descriptor budget is exhausted");
    expect(said).toContain("every process Rennet starts is failing, not just this one");
    expect(said).toContain("daemon.log");

    // This process at its own limit, and the machine at the system limit.
    expect(describeSpawnFailure("EMFILE: too many open files, watch")).toContain(
      "file-descriptor budget is exhausted",
    );
    expect(describeSpawnFailure("Command failed with ENFILE")).toContain(
      "file-descriptor budget is exhausted",
    );
  });

  it("leaves an ordinary failure exactly as it was", () => {
    // Not every spawn failure is this one, and a message that blamed descriptors for a
    // missing binary would be the same defect pointing the other way.
    expect(describeSpawnFailure("spawn ENOENT")).toBe("spawn ENOENT");
    expect(describeSpawnFailure("Command failed with EACCES: /usr/local/bin/codex")).toBe(
      "Command failed with EACCES: /usr/local/bin/codex",
    );
    // A word that merely contains an errno is not that errno.
    expect(describeSpawnFailure("could not read EMFILES.txt")).toBe("could not read EMFILES.txt");
  });
});
