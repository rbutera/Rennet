import type { ForgePrSubmissionPort } from "@rennet/core";
import { describe, expect, it, vi } from "vitest";
import {
  type ForgePrSubmissionResolver,
  type ResolvedForgePullRequestDestination,
  resolveForgePullRequestDestination,
  submitForgePullRequest,
} from "./forge-submission";
import { createForgeRegistry } from "./project-forge-registry";

const SUBMISSION = {
  title: "Route the forge",
  body: "Provider-qualified submission",
  base: "main",
  head: "feature/provider-route",
  draft: true,
};

const GITLAB_DESTINATION = {
  remoteName: "gitlab-submit",
  remotes: ["gitlab-submit"],
  target: {
    repo: { forge: "gitlab", owner: "acme", name: "widget" },
  },
} satisfies ResolvedForgePullRequestDestination;

describe("forge pull-request destination resolution", () => {
  it("returns null for an unsupported effective push URL without mutating the repository", async () => {
    const githubSubmit = vi.fn<ForgePrSubmissionPort["submitPullRequest"]>();
    const registry = createForgeRegistry<ForgePrSubmissionResolver>([
      {
        forge: "github",
        implementation: () => ({ submitPullRequest: githubSubmit }),
      },
    ]);
    const git = vi.fn(async (_root: string, args: string[]) => {
      if (args[0] === "remote") {
        // `remote -v` is the URL table discovery reads; a BARE `remote` is the name
        // list, which is what `git remote` actually prints and what the base-ref
        // normalisation needs. Conflating them would feed URLs in as remote names.
        return args[1] === "-v"
          ? [
              "gitlab-submit\thttps://github.com/acme/widget.git (fetch)",
              "gitlab-submit\tgit@gitlab.com:acme/widget.git (push)",
            ].join("\n")
          : "gitlab-submit\n";
      }
      throw new Error(`Unexpected mutation: ${args.join(" ")}`);
    });

    await expect(
      resolveForgePullRequestDestination({ registry, git, repoRoot: "/repo" }),
    ).resolves.toBeNull();
    expect(git.mock.calls).toEqual([["/repo", ["remote", "-v"]]]);
    expect(githubSubmit).not.toHaveBeenCalled();
  });

  it("returns null for an ambiguous effective push URL without mutating the repository", async () => {
    const githubSubmit = vi.fn<ForgePrSubmissionPort["submitPullRequest"]>();
    const registry = createForgeRegistry<ForgePrSubmissionResolver>([
      {
        forge: "github",
        implementation: () => ({ submitPullRequest: githubSubmit }),
      },
    ]);
    const git = vi.fn(async (_root: string, args: string[]) => {
      if (args[0] === "remote") {
        return args[1] === "-v"
          ? [
              "origin\thttps://github.com/acme/widget.git (fetch)",
              "origin\tgit@github.com:acme/widget.git (push)",
              "origin\tgit@github.com:backup/widget.git (push)",
            ].join("\n")
          : "origin\n";
      }
      throw new Error(`Unexpected mutation: ${args.join(" ")}`);
    });

    await expect(
      resolveForgePullRequestDestination({ registry, git, repoRoot: "/repo" }),
    ).resolves.toBeNull();
    expect(git.mock.calls).toEqual([["/repo", ["remote", "-v"]]]);
    expect(githubSubmit).not.toHaveBeenCalled();
  });

  it("uses a registered GitLab provider for the effective push URL", async () => {
    const gitlabSubmit = vi.fn<ForgePrSubmissionPort["submitPullRequest"]>();
    const registry = createForgeRegistry<ForgePrSubmissionResolver>([
      {
        forge: "gitlab",
        implementation: () => ({ submitPullRequest: gitlabSubmit }),
      },
    ]);
    const git = vi.fn(async (_root: string, args: string[]) => {
      if (args[0] === "remote") {
        // `remote -v` is the URL table discovery reads; a BARE `remote` is the name
        // list, which is what `git remote` actually prints and what the base-ref
        // normalisation needs. Conflating them would feed URLs in as remote names.
        return args[1] === "-v"
          ? [
              "gitlab-submit\thttps://github.com/acme/widget.git (fetch)",
              "gitlab-submit\tgit@gitlab.com:acme/widget.git (push)",
            ].join("\n")
          : "gitlab-submit\n";
      }
      throw new Error(`Unexpected mutation: ${args.join(" ")}`);
    });

    await expect(
      resolveForgePullRequestDestination({ registry, git, repoRoot: "/repo" }),
    ).resolves.toEqual(GITLAB_DESTINATION);
    expect(git.mock.calls).toEqual([
      ["/repo", ["remote", "-v"]],
      ["/repo", ["remote"], { reject: false }],
    ]);
    expect(gitlabSubmit).not.toHaveBeenCalled();
  });
});

describe("forge pull-request submission", () => {
  it("resolves the repository-scoped submitter before pushing", async () => {
    const resolveGitLab = vi.fn<ForgePrSubmissionResolver>(async () => {
      throw new Error("GitLab execution locus is unavailable");
    });
    const registry = createForgeRegistry<ForgePrSubmissionResolver>([
      { forge: "gitlab", implementation: resolveGitLab },
    ]);
    const git = vi.fn(async () => "");

    await expect(
      submitForgePullRequest({
        registry,
        git,
        repoRoot: "/workspace/gitlab",
        headRef: SUBMISSION.head,
        submission: SUBMISSION,
        destination: GITLAB_DESTINATION,
      }),
    ).rejects.toThrow("GitLab execution locus is unavailable");
    expect(resolveGitLab).toHaveBeenCalledWith("/workspace/gitlab");
    expect(git).not.toHaveBeenCalled();
  });

  it("uses one resolved destination for both push and provider submission", async () => {
    const outcome = {
      number: 17,
      url: "https://gitlab.com/acme/widget/-/merge_requests/17",
      reused: false,
    };
    const gitlabSubmit = vi.fn<ForgePrSubmissionPort["submitPullRequest"]>(async () => outcome);
    const resolveGitLab = vi.fn<ForgePrSubmissionResolver>(async () => ({
      submitPullRequest: gitlabSubmit,
    }));
    const registry = createForgeRegistry<ForgePrSubmissionResolver>([
      {
        forge: "gitlab",
        implementation: resolveGitLab,
      },
    ]);
    const git = vi.fn(async (_root: string, args: string[]) => {
      if (args[0] === "remote") {
        // `remote -v` is the URL table discovery reads; a BARE `remote` is the name
        // list, which is what `git remote` actually prints and what the base-ref
        // normalisation needs. Conflating them would feed URLs in as remote names.
        return args[1] === "-v"
          ? [
              "gitlab-submit\thttps://github.com/acme/widget.git (fetch)",
              "gitlab-submit\tgit@gitlab.com:acme/widget.git (push)",
            ].join("\n")
          : "gitlab-submit\n";
      }
      if (args[0] === "push") return "";
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });
    const destination = await resolveForgePullRequestDestination({
      registry,
      git,
      repoRoot: "/repo",
    });
    if (destination === null) throw new Error("Expected a registered GitLab destination");

    await expect(
      submitForgePullRequest({
        registry,
        git,
        repoRoot: "/repo",
        headRef: SUBMISSION.head,
        submission: SUBMISSION,
        destination,
      }),
    ).resolves.toEqual(outcome);
    expect(git.mock.calls).toEqual([
      ["/repo", ["remote", "-v"]],
      ["/repo", ["remote"], { reject: false }],
      [
        "/repo",
        [
          "push",
          "gitlab-submit",
          "refs/heads/feature/provider-route:refs/heads/feature/provider-route",
        ],
      ],
    ]);
    expect(gitlabSubmit).toHaveBeenCalledTimes(1);
    expect(resolveGitLab).toHaveBeenCalledOnce();
    expect(resolveGitLab).toHaveBeenCalledWith("/repo");
    expect(gitlabSubmit.mock.calls[0]?.[0].target).toBe(destination.target);
    expect(gitlabSubmit).toHaveBeenCalledWith({
      target: destination.target,
      submission: SUBMISSION,
    });
  });

  it("refuses an unregistered destination before push", async () => {
    const githubSubmit = vi.fn<ForgePrSubmissionPort["submitPullRequest"]>();
    const registry = createForgeRegistry<ForgePrSubmissionResolver>([
      {
        forge: "github",
        implementation: () => ({ submitPullRequest: githubSubmit }),
      },
    ]);
    const git = vi.fn(async (_root: string, args: string[]) => {
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    await expect(
      submitForgePullRequest({
        registry,
        git,
        repoRoot: "/repo",
        headRef: SUBMISSION.head,
        submission: SUBMISSION,
        destination: GITLAB_DESTINATION,
      }),
    ).rejects.toThrow(/No pull-request submitter is registered for forge "gitlab"/);
    expect(git).not.toHaveBeenCalled();
    expect(githubSubmit).not.toHaveBeenCalled();
  });
});
