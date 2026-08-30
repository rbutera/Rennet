import type { ForgeCheckRun, ForgeCiStatus, ForgePort, ForgePullRequestRef } from "@rennet/core";
import { execa } from "execa";
import { z } from "zod";
import { type ForgeDetectionDeps, gitlabForge, resolveForgeBinary } from "./forge-discovery";

const gitLabCommitStatusSchema = z.object({
  id: z.union([z.number().int().nonnegative(), z.string().min(1)]),
  name: z.string().min(1),
  status: z.string().min(1),
  description: z.string().nullable().optional(),
  target_url: z.url().nullable().optional(),
  allow_failure: z.boolean().optional(),
});

const gitLabCommitStatusesSchema = z.array(gitLabCommitStatusSchema);
type GitLabCommitStatus = z.infer<typeof gitLabCommitStatusSchema>;

export interface GitLabCiCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly signal?: AbortSignal;
}

export interface GitLabCiCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type GitLabCiCommandRunner = (command: GitLabCiCommand) => Promise<GitLabCiCommandResult>;

export interface GitLabCiAdapterConfig {
  readonly detectionDeps: ForgeDetectionDeps;
  readonly run?: GitLabCiCommandRunner;
}

async function runGitLabCiCommand(command: GitLabCiCommand): Promise<GitLabCiCommandResult> {
  const result = await execa(command.executable, [...command.args], {
    reject: false,
    shell: false,
    stdin: "ignore",
    stderr: "ignore",
    timeout: 15_000,
    ...(command.signal === undefined ? {} : { cancelSignal: command.signal }),
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout };
}

function outcomeOf(status: GitLabCommitStatus): ForgeCheckRun["outcome"] {
  switch (status.status) {
    case "success":
      return "passing";
    case "created":
    case "pending":
    case "running":
    case "preparing":
    case "waiting_for_resource":
    case "waiting_for_callback":
    case "scheduled":
    case "canceling":
      return "pending";
    case "failed":
      return status.allow_failure === true ? "neutral" : "failing";
    case "canceled":
      return "failing";
    case "manual":
      return status.allow_failure === true ? "neutral" : "pending";
    case "skipped":
      return "neutral";
    default:
      return "pending";
  }
}

function checkOf(status: GitLabCommitStatus): ForgeCheckRun {
  return {
    id: `gitlab-status:${status.id}`,
    name: status.name,
    outcome: outcomeOf(status),
    summary: status.description ?? "",
    ...(status.target_url === undefined || status.target_url === null
      ? {}
      : { detailsUrl: status.target_url }),
  };
}

function commandArgs(ref: ForgePullRequestRef, headOid: string): readonly string[] {
  const projectPath = encodeURIComponent(`${ref.repo.owner}/${ref.repo.name}`);
  const commit = encodeURIComponent(headOid);
  return [
    "api",
    `projects/${projectPath}/repository/commits/${commit}/statuses?per_page=100`,
    "--hostname",
    "gitlab.com",
    "--paginate",
    "--output",
    "json",
  ];
}

function canceledError(): Error {
  const error = new Error("GitLab CI status request was canceled.");
  error.name = "AbortError";
  return error;
}

/** GitLab.com's CLI-backed implementation of the forge CI read. */
export function createGitLabCiAdapter(
  config: GitLabCiAdapterConfig,
): Pick<ForgePort, "fetchCiStatus"> {
  const run = config.run ?? runGitLabCiCommand;
  return {
    async fetchCiStatus(
      ref: ForgePullRequestRef,
      headOid: string,
      signal?: AbortSignal,
    ): Promise<ForgeCiStatus> {
      if (ref.repo.forge !== "gitlab") {
        throw new Error(`GitLab CI adapter cannot read forge "${ref.repo.forge}".`);
      }

      if (signal?.aborted) throw canceledError();

      let glab: Awaited<ReturnType<typeof resolveForgeBinary>>;
      try {
        glab = await resolveForgeBinary(gitlabForge, config.detectionDeps);
      } catch {
        if (signal?.aborted) throw canceledError();
        throw new Error("GitLab CI status request failed.");
      }
      if (signal?.aborted) throw canceledError();
      if (glab === null) throw new Error("GitLab CI status request failed.");

      let result: GitLabCiCommandResult;
      try {
        result = await run({
          executable: glab.path,
          args: commandArgs(ref, headOid),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        if (signal?.aborted) throw canceledError();
        throw new Error("GitLab CI status request failed.");
      }
      if (result.exitCode !== 0) throw new Error("GitLab CI status request failed.");

      let decoded: unknown;
      try {
        decoded = JSON.parse(result.stdout);
      } catch {
        throw new Error("GitLab CI status response was invalid.");
      }
      const parsed = gitLabCommitStatusesSchema.safeParse(decoded);
      if (!parsed.success) throw new Error("GitLab CI status response was invalid.");

      return {
        checks: parsed.data.map(checkOf),
        sso: { kind: "none" },
        incomplete: false,
      };
    },
  };
}
