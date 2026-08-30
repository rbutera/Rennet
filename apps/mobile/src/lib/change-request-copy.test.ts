import { describe, expect, it } from "vitest";
import { changeRequestCopy } from "./change-request-copy";

describe("changeRequestCopy", () => {
  it("names GitLab merge requests and their ! receipt", () => {
    expect(changeRequestCopy("gitlab")).toEqual({
      noun: "merge request",
      opening: "Opening merge request…",
      opened: "Merge request opened",
      sigil: "!",
    });
  });

  it("keeps GitHub and legacy targets on pull-request vocabulary", () => {
    for (const forge of ["github", undefined]) {
      expect(changeRequestCopy(forge)).toEqual({
        noun: "pull request",
        opening: "Opening pull request…",
        opened: "Pull request opened",
        sigil: "#",
      });
    }
  });
});
