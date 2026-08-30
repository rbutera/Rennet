import type { ForgePullRequestRef } from "@rennet/core";
import { describe, expect, it, vi } from "vitest";
import type { ForgeDetectionDeps } from "./forge-discovery";
import { createGitLabCiAdapter, type GitLabCiCommandRunner } from "./gitlab-ci";

const GLAB_PATH = "/opt/homebrew/bin/glab";
const REF: ForgePullRequestRef = {
  repo: { forge: "gitlab", owner: "acme/platform/tools", name: "widget" },
  number: 42,
};

function detectionDeps(initiallyPresent = true): {
  deps: ForgeDetectionDeps;
  listDir: ReturnType<typeof vi.fn<ForgeDetectionDeps["listDir"]>>;
  setGlabPresent(present: boolean): void;
} {
  let glabPresent = initiallyPresent;
  const listDir = vi.fn<ForgeDetectionDeps["listDir"]>(async (directory) =>
    glabPresent && directory === "/opt/homebrew/bin" ? ["glab"] : [],
  );
  const probeVersion = vi.fn<ForgeDetectionDeps["probeVersion"]>(async (path) =>
    path === GLAB_PATH ? "1.72.0" : null,
  );
  return {
    deps: {
      loginShellPath: async () => "/opt/homebrew/bin",
      envPath: "",
      home: "/Users/rai",
      listDir,
      isExecutable: async (path) => path === GLAB_PATH,
      probeVersion,
      probeAuth: async () => ({ kind: "authenticated" }),
      platform: "darwin",
    },
    listDir,
    setGlabPresent(present) {
      glabPresent = present;
    },
  };
}

function adapterWith(stdout: unknown) {
  const detection = detectionDeps();
  const run = vi.fn<GitLabCiCommandRunner>().mockResolvedValue({
    exitCode: 0,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
  });
  return {
    adapter: createGitLabCiAdapter({ detectionDeps: detection.deps, run }),
    run,
    ...detection,
  };
}

describe("createGitLabCiAdapter", () => {
  it("uses the proven glab binary and exact paginated GitLab.com statuses request", async () => {
    const { adapter, run } = adapterWith([]);

    await adapter.fetchCiStatus(REF, "abc123");

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({
      executable: GLAB_PATH,
      args: [
        "api",
        "projects/acme%2Fplatform%2Ftools%2Fwidget/repository/commits/abc123/statuses?per_page=100",
        "--hostname",
        "gitlab.com",
        "--paginate",
        "--output",
        "json",
      ],
    });
  });

  it("detects glab installed after adapter creation on the next operation", async () => {
    const detection = detectionDeps(false);
    const run = vi.fn<GitLabCiCommandRunner>().mockResolvedValue({ exitCode: 0, stdout: "[]" });
    const adapter = createGitLabCiAdapter({ detectionDeps: detection.deps, run });

    await expect(adapter.fetchCiStatus(REF, "before-install")).rejects.toThrow(
      "GitLab CI status request failed.",
    );
    detection.setGlabPresent(true);
    await expect(adapter.fetchCiStatus(REF, "after-install")).resolves.toMatchObject({
      checks: [],
    });

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ executable: GLAB_PATH }));
  });

  it("keeps blocking and unknown GitLab states from passing", async () => {
    const statuses = [
      ["success", false],
      ["created", false],
      ["pending", false],
      ["running", false],
      ["preparing", false],
      ["waiting_for_resource", false],
      ["waiting_for_callback", false],
      ["scheduled", false],
      ["canceling", false],
      ["failed", false],
      ["canceled", false],
      ["failed", true],
      ["canceled", true],
      ["manual", false],
      ["manual", true],
      ["skipped", false],
      ["new-gitlab-state", false],
    ] as const;
    const { adapter } = adapterWith(
      statuses.map(([status, allow_failure], index) => ({
        id: index + 1,
        name: `job-${index + 1}`,
        status,
        allow_failure,
        description: index === 0 ? "Tests passed" : null,
        target_url: index === 0 ? "https://gitlab.com/acme/widget/-/jobs/1" : null,
      })),
    );

    const result = await adapter.fetchCiStatus(REF, "abc123");

    expect(result).toEqual({
      checks: [
        {
          id: "gitlab-status:1",
          name: "job-1",
          outcome: "passing",
          summary: "Tests passed",
          detailsUrl: "https://gitlab.com/acme/widget/-/jobs/1",
        },
        ...[
          "pending",
          "pending",
          "pending",
          "pending",
          "pending",
          "pending",
          "pending",
          "pending",
          "failing",
          "failing",
          "neutral",
          "failing",
          "pending",
          "neutral",
          "neutral",
          "pending",
        ].map((outcome, index) => ({
          id: `gitlab-status:${index + 2}`,
          name: `job-${index + 2}`,
          outcome,
          summary: "",
        })),
      ],
      sso: { kind: "none" },
      incomplete: false,
    });
  });

  it("does not expose nonzero or malformed CLI output in errors", async () => {
    const secret = "glpat-do-not-print-this";
    const firstDetection = detectionDeps();
    const secondDetection = detectionDeps();
    const nonzero = vi.fn<GitLabCiCommandRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: `request failed with token ${secret}`,
    });
    const malformed = vi.fn<GitLabCiCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ token: secret }),
    });

    const nonzeroError = await createGitLabCiAdapter({
      detectionDeps: firstDetection.deps,
      run: nonzero,
    })
      .fetchCiStatus(REF, "abc123")
      .catch((error: unknown) => error);
    const malformedError = await createGitLabCiAdapter({
      detectionDeps: secondDetection.deps,
      run: malformed,
    })
      .fetchCiStatus(REF, "abc123")
      .catch((error: unknown) => error);

    expect(nonzeroError).toBeInstanceOf(Error);
    expect(String(nonzeroError)).toBe("Error: GitLab CI status request failed.");
    expect(String(nonzeroError)).not.toContain(secret);
    expect(malformedError).toBeInstanceOf(Error);
    expect(String(malformedError)).toBe("Error: GitLab CI status response was invalid.");
    expect(String(malformedError)).not.toContain(secret);
  });

  it("fails safely when no proven glab binary exists", async () => {
    const detection = detectionDeps(false);
    const run = vi.fn<GitLabCiCommandRunner>();
    const adapter = createGitLabCiAdapter({ detectionDeps: detection.deps, run });

    await expect(adapter.fetchCiStatus(REF, "abc123")).rejects.toThrow(
      "GitLab CI status request failed.",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("forwards caller cancellation to the command runner", async () => {
    const { adapter, run } = adapterWith([]);
    const controller = new AbortController();

    await adapter.fetchCiStatus(REF, "abc123", controller.signal);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });

  it("rejects an already canceled call before discovery or execution", async () => {
    const detection = detectionDeps();
    const run = vi.fn<GitLabCiCommandRunner>();
    const adapter = createGitLabCiAdapter({ detectionDeps: detection.deps, run });
    const controller = new AbortController();
    controller.abort();

    const error = await adapter
      .fetchCiStatus(REF, "abc123", controller.signal)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(detection.listDir).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a non-GitLab ref before discovery or execution", async () => {
    const detection = detectionDeps();
    const run = vi.fn<GitLabCiCommandRunner>();
    const adapter = createGitLabCiAdapter({ detectionDeps: detection.deps, run });
    const githubRef: ForgePullRequestRef = {
      repo: { forge: "github", owner: "acme", name: "widget" },
      number: 42,
    };

    await expect(adapter.fetchCiStatus(githubRef, "abc123")).rejects.toThrow(
      'GitLab CI adapter cannot read forge "github".',
    );
    expect(detection.listDir).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
