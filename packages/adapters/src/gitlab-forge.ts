import type {
  ForgeCapabilities,
  ForgeCiStatus,
  ForgeDiff,
  ForgePort,
  ForgePublishOutcome,
  ForgePublishPort,
  ForgePullRequest,
  ForgePullRequestList,
  ForgePullRequestRef,
  ForgeRequestDescriptor,
  ForgeReviewPost,
  ForgeReviewTarget,
  Locus,
} from "@rennet/core";
import { extractMarker, locusCommand } from "@rennet/core";
import type {
  ForgeRepoIdentity,
  PullRequest,
  PullRequestState,
  SmartListCi,
} from "@rennet/protocol";
import { execa } from "execa";
import { z } from "zod";
import { type ForgeDetectionDeps, gitlabForge, resolveForgeBinary } from "./forge-discovery";
import { type ProjectPrSource, ProjectPrSourceUnavailable } from "./project-pr-source";

const userSchema = z.object({ username: z.string().min(1) });
const pipelineSchema = z
  .object({ status: z.string().min(1) })
  .nullable()
  .optional();
const diffRefsSchema = z.object({ base_sha: z.string().min(1), head_sha: z.string().min(1) });
const mergeRequestSchema = z.object({
  id: z.number().int().positive(),
  iid: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  state: z.string().min(1),
  sha: z.string().min(1),
  diff_refs: diffRefsSchema.optional(),
  target_branch: z.string().min(1),
  source_branch: z.string().min(1),
  changes_count: z.string().nullable().optional(),
  updated_at: z.iso.datetime(),
  author: userSchema,
  reviewers: z.array(userSchema).optional(),
  head_pipeline: pipelineSchema,
  web_url: z.url(),
});
const statusSchema = z.object({
  id: z.union([z.number().int().nonnegative(), z.string().min(1)]),
  name: z.string().min(1),
  status: z.string().min(1),
  description: z.string().nullable().optional(),
  target_url: z.url().nullable().optional(),
  allow_failure: z.boolean().optional(),
});
const noteSchema = z.object({
  id: z.number().int().positive(),
  body: z.string(),
  web_url: z.url().nullable().optional(),
});

type MergeRequest = z.infer<typeof mergeRequestSchema>;
type CommitStatus = z.infer<typeof statusSchema>;
type Note = z.infer<typeof noteSchema>;

export interface GitLabForgeCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
}

export interface GitLabForgeCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type GitLabForgeCommandRunner = (
  command: GitLabForgeCommand,
) => Promise<GitLabForgeCommandResult>;

export interface GitLabForgeConfig {
  readonly detectionDeps: ForgeDetectionDeps | Promise<ForgeDetectionDeps>;
  readonly locus: Locus;
  readonly repositoryRoot: string;
  readonly run?: GitLabForgeCommandRunner;
}

async function defaultRunner(command: GitLabForgeCommand): Promise<GitLabForgeCommandResult> {
  const result = await execa(command.file, [...command.args], {
    reject: false,
    shell: false,
    stderr: "ignore",
    timeout: 30_000,
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    ...(command.stdin === undefined ? { stdin: "ignore" as const } : { input: command.stdin }),
    ...(command.signal === undefined ? {} : { cancelSignal: command.signal }),
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout };
}

function projectPath(repository: ForgeRepoIdentity): string {
  return encodeURIComponent(`${repository.owner}/${repository.name}`);
}

function decodeJson<T>(stdout: string, schema: z.ZodType<T>, context: string): T {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(`${context} response was invalid.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${context} response was invalid.`);
  return parsed.data;
}

function decodeNdjson<T>(stdout: string, schema: z.ZodType<T>, context: string): T[] {
  const values: T[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    values.push(decodeJson(line, schema, context));
  }
  return values;
}

function pullRequestState(state: string): PullRequest["state"] {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return "open";
}

function requestedStates(states: readonly PullRequestState[]): string {
  const mapped = states.map((state) => (state === "open" ? "opened" : state));
  return mapped.length === 1 ? `&state=${mapped[0]}` : "";
}

function ciSummary(pipeline: MergeRequest["head_pipeline"]): SmartListCi {
  const status = pipeline?.status;
  if (status === "success") return "passing";
  if (status === "failed" || status === "canceled") return "failing";
  if (status === undefined || status === "skipped") return "none";
  return "pending";
}

function exactChangeCount(value: string | null | undefined): number | undefined {
  return value !== undefined && value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

function statusOutcome(status: CommitStatus): "passing" | "failing" | "pending" | "neutral" {
  if (status.status === "success") return "passing";
  if (status.status === "failed") return status.allow_failure ? "neutral" : "failing";
  if (status.status === "canceled") return "failing";
  if (status.status === "skipped") return "neutral";
  return "pending";
}

function reviewBody(post: ForgeReviewPost): string {
  const verdict =
    post.event === "APPROVE"
      ? "Approved"
      : post.event === "REQUEST_CHANGES"
        ? "Changes requested"
        : "Commented";
  return `**Rennet review verdict: ${verdict}**\n\n${post.body}`;
}

export class GitLabForgeAdapter implements ForgePort, ProjectPrSource, ForgePublishPort {
  readonly capabilities: ForgeCapabilities = {
    supportsThreadResolution: false,
    supportsBatchedReview: false,
    supportsMultiLineAnchors: false,
    supportsFileLevelThreads: false,
  };

  private readonly run: GitLabForgeCommandRunner;
  private viewer: string | null | undefined;

  constructor(private readonly config: GitLabForgeConfig) {
    this.run = config.run ?? defaultRunner;
  }

  private async execute(
    args: readonly string[],
    options: { stdin?: string; signal?: AbortSignal } = {},
  ): Promise<string> {
    const binary = await resolveForgeBinary(gitlabForge, await this.config.detectionDeps);
    if (binary === null) {
      throw new ProjectPrSourceUnavailable(
        "gitlab",
        "tooling",
        "GitLab CLI is unavailable. Install `glab` and run `glab auth login`.",
      );
    }
    const command = locusCommand(this.config.locus, binary.path, args, this.config.repositoryRoot);
    let result: GitLabForgeCommandResult;
    try {
      result = await this.run({
        file: command.file,
        args: command.args,
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      throw new ProjectPrSourceUnavailable(
        "gitlab",
        "network",
        "GitLab is unreachable right now. Check the selected host and try again.",
      );
    }
    if (result.exitCode !== 0) {
      throw new ProjectPrSourceUnavailable(
        "gitlab",
        "authentication",
        "GitLab authentication failed. Run `glab auth status --hostname gitlab.com`.",
      );
    }
    return result.stdout;
  }

  async resolveViewer(): Promise<string | null> {
    if (this.viewer !== undefined) return this.viewer;
    const stdout = await this.execute([
      "api",
      "user",
      "--hostname",
      "gitlab.com",
      "--output",
      "json",
    ]);
    this.viewer = decodeJson(stdout, userSchema, "GitLab user").username;
    return this.viewer;
  }

  async listPullRequests(
    repository: ForgeRepoIdentity,
    states: readonly PullRequestState[] = ["open"],
  ): Promise<{ prs: PullRequest[]; truncated: boolean }> {
    this.assertRepository(repository);
    const viewer = await this.resolveViewer();
    const endpoint = `projects/${projectPath(repository)}/merge_requests?scope=all&per_page=100&order_by=updated_at&sort=desc${requestedStates(states)}`;
    const stdout = await this.execute([
      "api",
      endpoint,
      "--hostname",
      "gitlab.com",
      "--paginate",
      "--output",
      "ndjson",
    ]);
    const mergeRequests = decodeNdjson(stdout, mergeRequestSchema, "GitLab merge request");
    const allowed = new Set(states);
    return {
      prs: mergeRequests
        .filter((mergeRequest) => allowed.has(pullRequestState(mergeRequest.state)))
        .map((mergeRequest) => ({
          id: String(mergeRequest.id),
          number: mergeRequest.iid,
          title: mergeRequest.title,
          repository: `${repository.owner}/${repository.name}`,
          forgeRepository: repository,
          branch: mergeRequest.source_branch,
          author: mergeRequest.author.username,
          viewerDidAuthor: viewer === mergeRequest.author.username,
          state: pullRequestState(mergeRequest.state),
          reviewRequestedFromViewer:
            viewer !== null &&
            (mergeRequest.reviewers ?? []).some((reviewer) => reviewer.username === viewer),
          ci: ciSummary(mergeRequest.head_pipeline),
          ...(exactChangeCount(mergeRequest.changes_count) === undefined
            ? {}
            : { changedFiles: exactChangeCount(mergeRequest.changes_count) }),
          lastActivityAt: mergeRequest.updated_at,
        })),
      truncated: false,
    };
  }

  async listOpenPullRequests(): Promise<ForgePullRequestList> {
    const stdout = await this.execute([
      "api",
      "merge_requests?scope=all&state=opened&per_page=100&order_by=updated_at&sort=desc",
      "--hostname",
      "gitlab.com",
      "--paginate",
      "--output",
      "ndjson",
    ]);
    const mergeRequests = decodeNdjson(stdout, mergeRequestSchema, "GitLab merge request");
    const items = mergeRequests.flatMap((mergeRequest) => {
      const parsed = new URL(mergeRequest.web_url);
      const path = parsed.pathname.replace(/^\//, "").replace(/\/-\/merge_requests\/\d+$/, "");
      const parts = path.split("/");
      const name = parts.pop();
      if (!name || parts.length === 0) return [];
      return [
        {
          ref: {
            repo: { forge: "gitlab", owner: parts.join("/"), name },
            number: mergeRequest.iid,
          },
          title: mergeRequest.title,
          isDraft: mergeRequest.draft ?? false,
          updatedAt: mergeRequest.updated_at,
          headOid: mergeRequest.sha,
          forgeRef: String(mergeRequest.id),
        },
      ];
    });
    return {
      items,
      sso: { kind: "none" },
      complete: true,
      truncatedOver1000: false,
    };
  }

  async fetchPullRequest(ref: ForgePullRequestRef): Promise<ForgePullRequest> {
    this.assertRepository(ref.repo);
    const stdout = await this.execute([
      "api",
      `projects/${projectPath(ref.repo)}/merge_requests/${ref.number}`,
      "--hostname",
      "gitlab.com",
      "--output",
      "json",
    ]);
    const mergeRequest = decodeJson(stdout, mergeRequestSchema, "GitLab merge request");
    if (mergeRequest.diff_refs === undefined) {
      throw new Error("GitLab merge request response did not include pinned diff OIDs.");
    }
    const viewer = await this.resolveViewer();
    return {
      ref,
      title: mergeRequest.title,
      body: mergeRequest.description ?? "",
      isDraft: mergeRequest.draft ?? false,
      headOid: mergeRequest.diff_refs.head_sha,
      baseOid: mergeRequest.diff_refs.base_sha,
      baseRef: mergeRequest.target_branch,
      headRef: mergeRequest.source_branch,
      cloneUrls: [
        `https://gitlab.com/${ref.repo.owner}/${ref.repo.name}.git`,
        `git@gitlab.com:${ref.repo.owner}/${ref.repo.name}.git`,
      ],
      forgeRef: String(mergeRequest.id),
      changedFiles: Number.parseInt(mergeRequest.changes_count ?? "0", 10) || 0,
      viewerDidAuthor: viewer === mergeRequest.author.username,
      sso: { kind: "none" },
    };
  }

  async fetchDiff(ref: ForgePullRequestRef): Promise<ForgeDiff> {
    this.assertRepository(ref.repo);
    const diff = await this.execute([
      "api",
      `projects/${projectPath(ref.repo)}/merge_requests/${ref.number}/raw_diffs`,
      "--hostname",
      "gitlab.com",
    ]);
    return { diff, sso: { kind: "none" } };
  }

  async fetchCiStatus(
    ref: ForgePullRequestRef,
    headOid: string,
    signal?: AbortSignal,
  ): Promise<ForgeCiStatus> {
    this.assertRepository(ref.repo);
    const stdout = await this.execute(
      [
        "api",
        `projects/${projectPath(ref.repo)}/repository/commits/${encodeURIComponent(headOid)}/statuses?per_page=100`,
        "--hostname",
        "gitlab.com",
        "--paginate",
        "--output",
        "json",
      ],
      { signal },
    );
    const statuses = decodeJson(stdout, z.array(statusSchema), "GitLab CI status");
    return {
      checks: statuses.map((status) => ({
        id: `gitlab-status:${status.id}`,
        name: status.name,
        outcome: statusOutcome(status),
        summary: status.description ?? "",
        ...(status.target_url === undefined || status.target_url === null
          ? {}
          : { detailsUrl: status.target_url }),
      })),
      sso: { kind: "none" },
      incomplete: false,
    };
  }

  buildReviewRequest(post: ForgeReviewPost): ForgeRequestDescriptor {
    this.assertRepository(post.target.ref.repo);
    const note = {
      endpoint: `projects/${projectPath(post.target.ref.repo)}/merge_requests/${post.target.ref.number}/notes`,
      method: "POST",
      body: { body: reviewBody(post) },
    };
    return {
      requests:
        post.event === "APPROVE"
          ? [
              note,
              {
                endpoint: `projects/${projectPath(post.target.ref.repo)}/merge_requests/${post.target.ref.number}/approve`,
                method: "POST",
                body: { sha: post.target.headOid },
              },
            ]
          : [note],
    };
  }

  async findExistingReview(
    target: ForgeReviewTarget,
    marker: string,
  ): Promise<ForgePublishOutcome | null> {
    this.assertRepository(target.ref.repo);
    const stdout = await this.execute([
      "api",
      `projects/${projectPath(target.ref.repo)}/merge_requests/${target.ref.number}/notes?per_page=100&sort=desc&order_by=updated_at`,
      "--hostname",
      "gitlab.com",
      "--paginate",
      "--output",
      "ndjson",
    ]);
    const note = decodeNdjson(stdout, noteSchema, "GitLab review note").find(
      (candidate) => extractMarker(candidate.body) === marker,
    );
    return note === undefined
      ? null
      : { reviewRef: String(note.id), url: note.web_url ?? null, reused: true };
  }

  async publishReview(post: ForgeReviewPost): Promise<ForgePublishOutcome> {
    const existing = await this.findExistingReview(post.target, post.marker);
    const requests = this.buildReviewRequest(post).requests;
    const noteRequest = requests[0];
    if (noteRequest === undefined) throw new Error("GitLab review note request is missing.");

    let outcome = existing;
    if (outcome === null) {
      const stdout = await this.execute(
        [
          "api",
          noteRequest.endpoint,
          "--hostname",
          "gitlab.com",
          "--method",
          noteRequest.method,
          "--input",
          "-",
          "--output",
          "json",
        ],
        { stdin: JSON.stringify(noteRequest.body) },
      );
      const note: Note = decodeJson(stdout, noteSchema, "GitLab review note");
      outcome = { reviewRef: String(note.id), url: note.web_url ?? null, reused: false };
    }

    const approvalRequest = requests[1];
    if (approvalRequest !== undefined) {
      await this.execute(
        [
          "api",
          approvalRequest.endpoint,
          "--hostname",
          "gitlab.com",
          "--method",
          approvalRequest.method,
          "--input",
          "-",
          "--output",
          "json",
        ],
        { stdin: JSON.stringify(approvalRequest.body) },
      );
    }
    return outcome;
  }

  private assertRepository(repository: ForgeRepoIdentity): void {
    if (repository.forge !== "gitlab") {
      throw new Error(`GitLab adapter cannot read forge "${repository.forge}".`);
    }
  }
}
