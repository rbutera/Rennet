import type { ForgePrSubmission, ForgePrSubmissionTarget, Locus } from "@rennet/core";
import { describe, expect, it, vi } from "vitest";
import type { ForgeDetectionDeps } from "./forge-discovery";
import {
  createGitLabPrSubmissionAdapter,
  type GitLabPrSubmissionCommand,
  type GitLabPrSubmissionCommandResult,
  type GitLabPrSubmissionCommandRunner,
} from "./gitlab-pr-submission";

const HOST_GLAB_PATH = "/opt/homebrew/bin/glab";
const HOST_REPOSITORY_ROOT = "/Users/rai/code/widget";
const TARGET: ForgePrSubmissionTarget = {
  repo: { forge: "gitlab", owner: "acme/platform/tools", name: "widget" },
};
const SUBMISSION: ForgePrSubmission = {
  title: "Reviewed change",
  body: "## Requested changes\n- fix it\n\nsecret-free body",
  base: "release/next",
  head: "feat/reviewed/change",
  draft: true,
};

interface MergeRequestFixture {
  readonly iid: number;
  readonly web_url: string;
  readonly state: string;
  readonly source_branch: string;
  readonly target_branch: string;
  readonly source_project_id: number;
  readonly target_project_id: number;
}

function mergeRequest(overrides: Partial<MergeRequestFixture> = {}): MergeRequestFixture {
  const iid = overrides.iid ?? 42;
  return {
    iid,
    web_url: `https://gitlab.com/acme/platform/tools/widget/-/merge_requests/${iid}`,
    state: "opened",
    source_branch: SUBMISSION.head,
    target_branch: SUBMISSION.base,
    source_project_id: 101,
    target_project_id: 101,
    ...overrides,
  };
}

function detectionDeps(
  initiallyPresent = true,
  glabPath = HOST_GLAB_PATH,
  platform: NodeJS.Platform = "darwin",
): {
  deps: ForgeDetectionDeps;
  listDir: ReturnType<typeof vi.fn<ForgeDetectionDeps["listDir"]>>;
  setGlabPresent(present: boolean): void;
} {
  let glabPresent = initiallyPresent;
  const directory = glabPath.slice(0, glabPath.lastIndexOf("/"));
  const listDir = vi.fn<ForgeDetectionDeps["listDir"]>(async (candidate) =>
    glabPresent && candidate === directory ? ["glab"] : [],
  );
  return {
    deps: {
      loginShellPath: async () => directory,
      envPath: "",
      home: "/Users/rai",
      listDir,
      isExecutable: async (candidate) => candidate === glabPath,
      probeVersion: async (candidate) => (candidate === glabPath ? "1.80.0" : null),
      probeAuth: async () => ({ kind: "authenticated" }),
      platform,
    },
    listDir,
    setGlabPresent(present) {
      glabPresent = present;
    },
  };
}

function scriptedAdapter(
  responses: readonly (GitLabPrSubmissionCommandResult | Error)[],
  options: {
    readonly detection?: ReturnType<typeof detectionDeps>;
    readonly locus?: Locus;
    readonly repositoryRoot?: string;
  } = {},
): {
  adapter: ReturnType<typeof createGitLabPrSubmissionAdapter>;
  calls: GitLabPrSubmissionCommand[];
  detection: ReturnType<typeof detectionDeps>;
} {
  const detection = options.detection ?? detectionDeps();
  const calls: GitLabPrSubmissionCommand[] = [];
  let index = 0;
  const run: GitLabPrSubmissionCommandRunner = async (command) => {
    calls.push(command);
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error(`no scripted response for command ${index}`);
    if (response instanceof Error) throw response;
    return response;
  };
  return {
    adapter: createGitLabPrSubmissionAdapter({
      detectionDeps: detection.deps,
      locus: options.locus ?? { kind: "host" },
      repositoryRoot: options.repositoryRoot ?? HOST_REPOSITORY_ROOT,
      run,
    }),
    calls,
    detection,
  };
}

function ok(stdout: unknown): GitLabPrSubmissionCommandResult {
  return { exitCode: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout) };
}

function ndjson(...values: readonly unknown[]): GitLabPrSubmissionCommandResult {
  return ok(
    values.length === 0 ? "" : `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
}

function isCreateCall(call: GitLabPrSubmissionCommand): boolean {
  return call.args.includes("--method") && call.args.includes("POST");
}

describe("createGitLabPrSubmissionAdapter", () => {
  it("queries nested projects and exact refs before creating with body only on stdin", async () => {
    const { adapter, calls } = scriptedAdapter([ndjson(), ok("created"), ndjson(mergeRequest())]);

    await expect(
      adapter.submitPullRequest({ target: TARGET, submission: SUBMISSION }),
    ).resolves.toEqual({
      url: "https://gitlab.com/acme/platform/tools/widget/-/merge_requests/42",
      number: 42,
      reused: false,
    });

    const queryArgs = [
      "api",
      "projects/acme%2Fplatform%2Ftools%2Fwidget/merge_requests?state=opened&source_branch=feat%2Freviewed%2Fchange&target_branch=release%2Fnext&per_page=100",
      "--hostname",
      "gitlab.com",
      "--paginate",
      "--output",
      "ndjson",
    ];
    expect(calls).toEqual([
      { file: HOST_GLAB_PATH, args: queryArgs, cwd: HOST_REPOSITORY_ROOT },
      {
        file: HOST_GLAB_PATH,
        args: [
          "api",
          "projects/acme%2Fplatform%2Ftools%2Fwidget/merge_requests",
          "--hostname",
          "gitlab.com",
          "--method",
          "POST",
          "--input",
          "-",
          "--output",
          "json",
        ],
        cwd: HOST_REPOSITORY_ROOT,
        stdin: JSON.stringify({
          source_branch: "feat/reviewed/change",
          target_branch: "release/next",
          title: "Draft: Reviewed change",
          description: SUBMISSION.body,
        }),
      },
      { file: HOST_GLAB_PATH, args: queryArgs, cwd: HOST_REPOSITORY_ROOT },
    ]);
    expect(calls[1]?.args).not.toContain(SUBMISSION.body);
    expect(calls[1]?.args).not.toContain(SUBMISSION.title);
  });

  it("routes every query and create through the exact WSL locus command", async () => {
    const wslDetection = detectionDeps(true, "/usr/bin/glab", "linux");
    const repositoryRoot = "\\\\wsl.localhost\\Ubuntu\\home\\rai\\widget";
    const { adapter, calls } = scriptedAdapter([ndjson(), ok("created"), ndjson(mergeRequest())], {
      detection: wslDetection,
      locus: { kind: "wsl", distro: "Ubuntu" },
      repositoryRoot,
    });

    await adapter.submitPullRequest({ target: TARGET, submission: SUBMISSION });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.file).toBe("wsl.exe");
      expect(call.cwd).toBeUndefined();
      expect(call.args.slice(0, 7)).toEqual([
        "-d",
        "Ubuntu",
        "--cd",
        "/home/rai/widget",
        "-e",
        "/usr/bin/glab",
        expect.any(String),
      ]);
    }
    expect(calls[0]?.args.slice(6)).toEqual([
      "api",
      "projects/acme%2Fplatform%2Ftools%2Fwidget/merge_requests?state=opened&source_branch=feat%2Freviewed%2Fchange&target_branch=release%2Fnext&per_page=100",
      "--hostname",
      "gitlab.com",
      "--paginate",
      "--output",
      "ndjson",
    ]);
    expect(calls[1]?.args.slice(6)).toEqual([
      "api",
      "projects/acme%2Fplatform%2Ftools%2Fwidget/merge_requests",
      "--hostname",
      "gitlab.com",
      "--method",
      "POST",
      "--input",
      "-",
      "--output",
      "json",
    ]);
    expect(JSON.parse(calls[1]?.stdin ?? "")).toEqual({
      source_branch: SUBMISSION.head,
      target_branch: SUBMISSION.base,
      title: "Draft: Reviewed change",
      description: SUBMISSION.body,
    });
  });

  it("reads paginated NDJSON and reuses the exact already-open merge request", async () => {
    const { adapter, calls } = scriptedAdapter([
      ndjson(mergeRequest({ iid: 11, source_branch: "feat/other" }), mergeRequest({ iid: 12 })),
    ]);

    await expect(
      adapter.submitPullRequest({ target: TARGET, submission: SUBMISSION }),
    ).resolves.toEqual({
      url: "https://gitlab.com/acme/platform/tools/widget/-/merge_requests/12",
      number: 12,
      reused: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("does not reuse a fork merge request with the same branch names", async () => {
    const { adapter, calls } = scriptedAdapter([
      ndjson(
        mergeRequest({ iid: 21, source_project_id: 202, target_project_id: 101 }),
        mergeRequest({ iid: 22 }),
      ),
    ]);

    await expect(
      adapter.submitPullRequest({ target: TARGET, submission: SUBMISSION }),
    ).resolves.toEqual({
      url: "https://gitlab.com/acme/platform/tools/widget/-/merge_requests/22",
      number: 22,
      reused: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("reconciles one failed create when the exact merge request appeared concurrently", async () => {
    const secret = "glpat-do-not-print";
    const { adapter, calls } = scriptedAdapter([
      ndjson(),
      { exitCode: 1, stdout: `request failed with ${secret}` },
      ndjson(mergeRequest({ iid: 51 })),
    ]);

    await expect(
      adapter.submitPullRequest({ target: TARGET, submission: SUBMISSION }),
    ).resolves.toEqual({
      url: "https://gitlab.com/acme/platform/tools/widget/-/merge_requests/51",
      number: 51,
      reused: true,
    });
    expect(calls.filter(isCreateCall)).toHaveLength(1);
  });

  it("reconciles a thrown create outcome without exposing or resending it", async () => {
    const secret = "glpat-do-not-print";
    const { adapter, calls } = scriptedAdapter([
      ndjson(),
      new Error(`connection dropped after create with ${secret}`),
      ndjson(mergeRequest({ iid: 52 })),
    ]);

    await expect(
      adapter.submitPullRequest({ target: TARGET, submission: SUBMISSION }),
    ).resolves.toEqual({
      url: "https://gitlab.com/acme/platform/tools/widget/-/merge_requests/52",
      number: 52,
      reused: true,
    });
    expect(calls.filter(isCreateCall)).toHaveLength(1);
  });

  it("does not prefix the title when the signed submission is not a draft", async () => {
    const submission = { ...SUBMISSION, draft: false };
    const { adapter, calls } = scriptedAdapter([
      ndjson(),
      ok("created"),
      ndjson(mergeRequest({ source_branch: submission.head, target_branch: submission.base })),
    ]);

    await adapter.submitPullRequest({ target: TARGET, submission });

    expect(JSON.parse(calls[1]?.stdin ?? "")).toEqual({
      source_branch: submission.head,
      target_branch: submission.base,
      title: "Reviewed change",
      description: submission.body,
    });
  });

  it("fails without resending when create and reconciliation both find no merge request", async () => {
    const secret = "glpat-do-not-print";
    const { adapter, calls } = scriptedAdapter([
      ndjson(),
      { exitCode: 1, stdout: `request failed with ${secret}` },
      ndjson(),
    ]);

    const error = await adapter
      .submitPullRequest({ target: TARGET, submission: SUBMISSION })
      .catch((caught: unknown) => caught);

    expect(String(error)).toBe("Error: GitLab merge request submission failed.");
    expect(String(error)).not.toContain(secret);
    expect(calls.filter(isCreateCall)).toHaveLength(1);
  });

  it("fails honestly when a successful create cannot be observed afterward", async () => {
    const { adapter, calls } = scriptedAdapter([ndjson(), ok("created"), ndjson()]);

    await expect(
      adapter.submitPullRequest({ target: TARGET, submission: SUBMISSION }),
    ).rejects.toThrow("GitLab merge request submission failed.");
    expect(calls.filter(isCreateCall)).toHaveLength(1);
  });

  it("does not expose nonzero, malformed, or invalid API output", async () => {
    const secret = "glpat-do-not-print";
    const nonzero = scriptedAdapter([{ exitCode: 1, stdout: `failed with ${secret}` }]);
    const malformed = scriptedAdapter([ok(`not-json-${secret}`)]);
    const invalid = scriptedAdapter([ndjson({ token: secret })]);

    const errors = await Promise.all(
      [nonzero.adapter, malformed.adapter, invalid.adapter].map((adapter) =>
        adapter
          .submitPullRequest({ target: TARGET, submission: SUBMISSION })
          .catch((caught: unknown) => caught),
      ),
    );

    expect(String(errors[0])).toBe("Error: GitLab merge request submission failed.");
    expect(String(errors[1])).toBe("Error: GitLab merge request response was invalid.");
    expect(String(errors[2])).toBe("Error: GitLab merge request response was invalid.");
    for (const error of errors) expect(String(error)).not.toContain(secret);
  });

  it("fails before execution when no proven glab binary exists", async () => {
    const detection = detectionDeps(false);
    const run = vi.fn<GitLabPrSubmissionCommandRunner>();
    const adapter = createGitLabPrSubmissionAdapter({
      detectionDeps: detection.deps,
      locus: { kind: "host" },
      repositoryRoot: HOST_REPOSITORY_ROOT,
      run,
    });

    await expect(
      adapter.submitPullRequest({ target: TARGET, submission: SUBMISSION }),
    ).rejects.toThrow("GitLab merge request submission failed.");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a non-GitLab target before discovery or execution", async () => {
    const detection = detectionDeps();
    const run = vi.fn<GitLabPrSubmissionCommandRunner>();
    const adapter = createGitLabPrSubmissionAdapter({
      detectionDeps: detection.deps,
      locus: { kind: "host" },
      repositoryRoot: HOST_REPOSITORY_ROOT,
      run,
    });
    const githubTarget: ForgePrSubmissionTarget = {
      repo: { forge: "github", owner: "acme", name: "widget" },
    };

    await expect(
      adapter.submitPullRequest({ target: githubTarget, submission: SUBMISSION }),
    ).rejects.toThrow('GitLab merge request adapter cannot submit forge "github".');
    expect(detection.listDir).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("detects glab installed after adapter creation on the next submission", async () => {
    const detection = detectionDeps(false);
    const run = vi
      .fn<GitLabPrSubmissionCommandRunner>()
      .mockResolvedValueOnce(ndjson(mergeRequest()));
    const adapter = createGitLabPrSubmissionAdapter({
      detectionDeps: detection.deps,
      locus: { kind: "host" },
      repositoryRoot: HOST_REPOSITORY_ROOT,
      run,
    });

    await expect(
      adapter.submitPullRequest({ target: TARGET, submission: SUBMISSION }),
    ).rejects.toThrow("GitLab merge request submission failed.");
    detection.setGlabPresent(true);
    await expect(
      adapter.submitPullRequest({ target: TARGET, submission: SUBMISSION }),
    ).resolves.toMatchObject({
      reused: true,
      number: 42,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ file: HOST_GLAB_PATH }));
  });
});
