import type { ForgePrSubmissionPort } from "@rennet/core";
import { describe, expect, it, vi } from "vitest";
import { submitForgePullRequest } from "./forge-submission";
import { createForgeRegistry, type ForgeProvider } from "./project-forge-registry";

const SUBMISSION = {
  title: "Route the forge",
  body: "Provider-qualified submission",
  base: "main",
  head: "feature/provider-route",
  draft: true,
};

describe("forge pull-request submission", () => {
  it("refuses a GitLab push URL before push or GitHub egress", async () => {
    const githubSubmit = vi.fn<ForgePrSubmissionPort["submitPullRequest"]>();
    const registry = createForgeRegistry<Pick<ForgeProvider, "pullRequest">>([
      {
        forge: "github",
        implementation: { pullRequest: { submitPullRequest: githubSubmit } },
      },
    ]);
    const git = vi.fn(async (_root: string, args: string[]) => {
      if (args[0] === "remote") {
        return [
          "origin\thttps://github.com/acme/widget.git (fetch)",
          "origin\tgit@gitlab.com:acme/widget.git (push)",
        ].join("\n");
      }
      throw new Error(`Unexpected mutation: ${args.join(" ")}`);
    });

    await expect(
      submitForgePullRequest({
        registry,
        git,
        repoRoot: "/repo",
        headRef: SUBMISSION.head,
        submission: SUBMISSION,
      }),
    ).rejects.toThrow(/No supported forge remote/);
    expect(git.mock.calls).toEqual([["/repo", ["remote", "-v"]]]);
    expect(githubSubmit).not.toHaveBeenCalled();
  });

  it("uses one registered remote for both push and submission target", async () => {
    const outcome = {
      number: 17,
      url: "https://gitlab.com/acme/widget/-/merge_requests/17",
      reused: false,
    };
    const gitlabSubmit = vi.fn<ForgePrSubmissionPort["submitPullRequest"]>(async () => outcome);
    const registry = createForgeRegistry<Pick<ForgeProvider, "pullRequest">>([
      {
        forge: "gitlab",
        implementation: { pullRequest: { submitPullRequest: gitlabSubmit } },
      },
    ]);
    const git = vi.fn(async (_root: string, args: string[]) => {
      if (args[0] === "remote") {
        return [
          "origin\thttps://github.com/acme/widget.git (fetch)",
          "origin\tgit@gitlab.com:acme/widget.git (push)",
        ].join("\n");
      }
      if (args[0] === "push") return "";
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    await expect(
      submitForgePullRequest({
        registry,
        git,
        repoRoot: "/repo",
        headRef: SUBMISSION.head,
        submission: SUBMISSION,
      }),
    ).resolves.toEqual(outcome);
    expect(git.mock.calls).toEqual([
      ["/repo", ["remote", "-v"]],
      [
        "/repo",
        ["push", "origin", "refs/heads/feature/provider-route:refs/heads/feature/provider-route"],
      ],
    ]);
    expect(gitlabSubmit).toHaveBeenCalledWith({
      target: {
        repo: { forge: "gitlab", owner: "acme", name: "widget" },
      },
      submission: SUBMISSION,
    });
  });
});
