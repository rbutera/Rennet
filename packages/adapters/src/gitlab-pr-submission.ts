import {
  type ForgePrSubmission,
  type ForgePrSubmissionOutcome,
  type ForgePrSubmissionPort,
  type ForgePrSubmissionTarget,
  type Locus,
  locusCommand,
} from "@rennet/core";
import { execa } from "execa";
import { z } from "zod";
import { type ForgeDetectionDeps, gitlabForge, resolveForgeBinary } from "./forge-discovery";

const gitLabMergeRequestSchema = z.object({
  iid: z.number().int().positive(),
  web_url: z.url(),
  state: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  source_project_id: z.number().int().positive(),
  target_project_id: z.number().int().positive(),
});

type GitLabMergeRequest = z.infer<typeof gitLabMergeRequestSchema>;

export interface GitLabPrSubmissionCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly stdin?: string;
}

export interface GitLabPrSubmissionCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type GitLabPrSubmissionCommandRunner = (
  command: GitLabPrSubmissionCommand,
) => Promise<GitLabPrSubmissionCommandResult>;

export interface GitLabPrSubmissionConfig {
  readonly detectionDeps: ForgeDetectionDeps;
  readonly locus: Locus;
  readonly repositoryRoot: string;
  readonly run?: GitLabPrSubmissionCommandRunner;
}

async function runGitLabPrSubmissionCommand(
  command: GitLabPrSubmissionCommand,
): Promise<GitLabPrSubmissionCommandResult> {
  const result = await execa(command.file, [...command.args], {
    reject: false,
    shell: false,
    stderr: "ignore",
    timeout: 30_000,
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    ...(command.stdin === undefined ? { stdin: "ignore" as const } : { input: command.stdin }),
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout };
}

function projectPath(target: ForgePrSubmissionTarget): string {
  return `${target.repo.owner}/${target.repo.name}`;
}

function mergeRequestQueryArgs(
  target: ForgePrSubmissionTarget,
  submission: ForgePrSubmission,
): readonly string[] {
  const project = encodeURIComponent(projectPath(target));
  const sourceBranch = encodeURIComponent(submission.head);
  const targetBranch = encodeURIComponent(submission.base);
  return [
    "api",
    `projects/${project}/merge_requests?state=opened&source_branch=${sourceBranch}&target_branch=${targetBranch}&per_page=100`,
    "--hostname",
    "gitlab.com",
    "--paginate",
    "--output",
    "ndjson",
  ];
}

function createMergeRequestArgs(target: ForgePrSubmissionTarget): readonly string[] {
  const project = encodeURIComponent(projectPath(target));
  return [
    "api",
    `projects/${project}/merge_requests`,
    "--hostname",
    "gitlab.com",
    "--method",
    "POST",
    "--input",
    "-",
    "--output",
    "json",
  ];
}

function createMergeRequestInput(submission: ForgePrSubmission): string {
  return JSON.stringify({
    source_branch: submission.head,
    target_branch: submission.base,
    title: submission.draft ? `Draft: ${submission.title}` : submission.title,
    description: submission.body,
  });
}

function exactOpenMergeRequest(
  mergeRequests: readonly GitLabMergeRequest[],
  submission: ForgePrSubmission,
): GitLabMergeRequest | null {
  return (
    mergeRequests.find(
      (mergeRequest) =>
        mergeRequest.state === "opened" &&
        mergeRequest.source_branch === submission.head &&
        mergeRequest.target_branch === submission.base &&
        mergeRequest.source_project_id === mergeRequest.target_project_id,
    ) ?? null
  );
}

function decodeMergeRequests(stdout: string): GitLabMergeRequest[] {
  const mergeRequests: GitLabMergeRequest[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;

    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      throw new Error("GitLab merge request response was invalid.");
    }
    const parsed = gitLabMergeRequestSchema.safeParse(decoded);
    if (!parsed.success) throw new Error("GitLab merge request response was invalid.");
    mergeRequests.push(parsed.data);
  }
  return mergeRequests;
}

function outcomeOf(mergeRequest: GitLabMergeRequest, reused: boolean): ForgePrSubmissionOutcome {
  return { url: mergeRequest.web_url, number: mergeRequest.iid, reused };
}

/** GitLab.com's `glab`-backed own-branch merge-request submission adapter. */
export function createGitLabPrSubmissionAdapter(
  config: GitLabPrSubmissionConfig,
): ForgePrSubmissionPort {
  const run = config.run ?? runGitLabPrSubmissionCommand;

  return {
    async submitPullRequest(input): Promise<ForgePrSubmissionOutcome> {
      const { target, submission } = input;
      if (target.repo.forge !== "gitlab") {
        throw new Error(`GitLab merge request adapter cannot submit forge "${target.repo.forge}".`);
      }

      let glab: Awaited<ReturnType<typeof resolveForgeBinary>>;
      try {
        glab = await resolveForgeBinary(gitlabForge, config.detectionDeps);
      } catch {
        throw new Error("GitLab merge request submission failed.");
      }
      if (glab === null) throw new Error("GitLab merge request submission failed.");

      const execute = async (
        args: readonly string[],
        stdin?: string,
      ): Promise<GitLabPrSubmissionCommandResult> => {
        const command = locusCommand(config.locus, glab.path, args, config.repositoryRoot);
        try {
          return await run({
            file: command.file,
            args: command.args,
            ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
            ...(stdin === undefined ? {} : { stdin }),
          });
        } catch {
          throw new Error("GitLab merge request submission failed.");
        }
      };

      const findExisting = async (): Promise<GitLabMergeRequest | null> => {
        const result = await execute(mergeRequestQueryArgs(target, submission));
        if (result.exitCode !== 0) throw new Error("GitLab merge request submission failed.");

        return exactOpenMergeRequest(decodeMergeRequests(result.stdout), submission);
      };

      const existing = await findExisting();
      if (existing !== null) return outcomeOf(existing, true);

      let createFailed: boolean;
      try {
        const created = await execute(
          createMergeRequestArgs(target),
          createMergeRequestInput(submission),
        );
        createFailed = created.exitCode !== 0;
      } catch {
        createFailed = true;
      }
      const reconciled = await findExisting();
      if (reconciled !== null) return outcomeOf(reconciled, createFailed);

      throw new Error("GitLab merge request submission failed.");
    },
  };
}
