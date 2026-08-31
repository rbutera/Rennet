import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  FileProjectStore,
  type ForgeDetectionDeps,
  type GitLabForgeCommandResult,
  type GitLabForgeCommandRunner,
  SessionStore,
} from "@rennet/adapters";
import type { ForgeReviewEvent } from "@rennet/core";
import {
  type ForgeRepoIdentity,
  PROTOCOL_VERSION,
  parseCommandOutput,
  type Review,
} from "@rennet/protocol";
import {
  createRennetServer,
  type RennetServer,
  removeDaemonFile,
  writeDaemonFile,
} from "@rennet/server";
import {
  BOARD_DESIGN_SCENARIO,
  BOARD_DESIGN_SPEC_PATH,
  BOARD_IMPLEMENTATION_PATH,
  BOARD_TEST_PATH,
} from "./board-fixture";
import { git, initRepo, makeTempDir, writeRepoFile } from "./harness";

export const LOCAL_FORGE_FIXTURE_MARKER = "rennet-c14-publish-proof-local-forge-v1";

export type PublishProofProvider = "github" | "gitlab";

export interface PublishProofRepository {
  readonly provider: PublishProofProvider;
  readonly repository: string;
  readonly projectId: string;
  readonly forgeRepository: ForgeRepoIdentity;
  readonly number: number;
  readonly forgeRef: string;
  readonly baseOid: string;
  readonly oldHeadOid: string;
  readonly newHeadOid: string;
  readonly headRef: string;
}

export interface CapturedPublishReview {
  readonly sessionId: string;
  readonly review: Review;
  readonly repository: PublishProofRepository;
}

export interface GitHubPublication {
  readonly number: number;
  readonly input: {
    readonly pullRequestId: string;
    readonly commitOID: string;
    readonly event: ForgeReviewEvent;
    readonly body: string;
    readonly threads: readonly {
      readonly path: string;
      readonly line: number;
      readonly startLine?: number;
      readonly side: "LEFT" | "RIGHT";
      readonly startSide?: "LEFT" | "RIGHT";
      readonly body: string;
    }[];
  };
}

export interface GitLabNotePublication {
  readonly number: number;
  readonly body: string;
}

export interface GitLabApprovalPublication {
  readonly number: number;
  readonly sha: string;
}

interface AcceptedPublication {
  readonly id: number;
  readonly body: string;
  readonly url: string;
}

interface TargetState extends PublishProofRepository {
  currentHeadOid: string;
  accepted: AcceptedPublication[];
  approved: boolean;
  failNextRead?: string;
  loseNextPublicationResponse: boolean;
  delayNextPublicationMs: number;
  githubMutationAttempts: number;
  gitLabNoteMutationAttempts: number;
  gitLabApprovalMutationAttempts: number;
}

function key(provider: PublishProofProvider, number: number): string {
  return `${provider}:${number}`;
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function commandResult(value: unknown): GitLabForgeCommandResult {
  return {
    exitCode: 0,
    stdout: typeof value === "string" ? value : JSON.stringify(value),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function gitOutput(root: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
}

function desktopVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve("apps/desktop/package.json"), "utf8")) as {
    version: string;
  };
  return manifest.version;
}

export class LocalForgeRecorder {
  readonly githubPublications: GitHubPublication[] = [];
  readonly gitLabNotes: GitLabNotePublication[] = [];
  readonly gitLabApprovals: GitLabApprovalPublication[] = [];
  readonly openerDrafts: {
    readonly reviewId: string;
    readonly provider: string;
    readonly verdict: ForgeReviewEvent;
    readonly lenses: readonly string[];
  }[] = [];

  private readonly targets = new Map<string, TargetState>();
  private readonly githubForgeRefs = new Map<string, TargetState>();
  private nextPublicationId = 700;

  register(repository: PublishProofRepository): void {
    const state: TargetState = {
      ...repository,
      currentHeadOid: repository.oldHeadOid,
      accepted: [],
      approved: false,
      loseNextPublicationResponse: false,
      delayNextPublicationMs: 0,
      githubMutationAttempts: 0,
      gitLabNoteMutationAttempts: 0,
      gitLabApprovalMutationAttempts: 0,
    };
    this.targets.set(key(repository.provider, repository.number), state);
    this.githubForgeRefs.set(repository.forgeRef, state);
  }

  private target(provider: PublishProofProvider, number: number): TargetState {
    const target = this.targets.get(key(provider, number));
    if (target === undefined) throw new Error(`missing local ${provider} target ${number}`);
    return target;
  }

  advanceHead(provider: PublishProofProvider, number: number): void {
    const target = this.target(provider, number);
    target.currentHeadOid = target.newHeadOid;
  }

  failNextRead(provider: PublishProofProvider, number: number, message: string): void {
    this.target(provider, number).failNextRead = message;
  }

  loseNextPublicationResponse(provider: PublishProofProvider, number: number): void {
    this.target(provider, number).loseNextPublicationResponse = true;
  }

  delayNextPublication(provider: PublishProofProvider, number: number, delayMs: number): void {
    this.target(provider, number).delayNextPublicationMs = delayMs;
  }

  acceptedCount(provider: PublishProofProvider, number: number): number {
    return this.target(provider, number).accepted.length;
  }

  publicationMutationCount(provider: PublishProofProvider, number: number): number {
    const target = this.target(provider, number);
    return provider === "github"
      ? target.githubMutationAttempts
      : target.gitLabNoteMutationAttempts;
  }

  approvalMutationCount(number: number): number {
    return this.target("gitlab", number).gitLabApprovalMutationAttempts;
  }

  readonly githubFetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url).pathname;
    if (path === "/rate_limit") {
      return json({ resources: {} }, { "X-OAuth-Scopes": "repo", "X-RateLimit-Limit": "5000" });
    }
    if (path === "/user") return json({ login: "proof-reviewer" });
    if (path !== "/graphql") return new Response("not found", { status: 404 });

    const body =
      init?.body === undefined && input instanceof Request
        ? await input.clone().text()
        : String(init?.body ?? "{}");
    const request = JSON.parse(body) as {
      query: string;
      variables: {
        owner?: string;
        name?: string;
        number?: number;
        input?: GitHubPublication["input"];
      };
    };

    if (request.query.includes("addPullRequestReview")) {
      const publication = request.variables.input;
      if (publication === undefined) throw new Error("GitHub publication input is missing");
      const target = this.githubForgeRefs.get(publication.pullRequestId);
      if (target === undefined) {
        throw new Error(`unknown GitHub pull-request id ${publication.pullRequestId}`);
      }
      target.githubMutationAttempts += 1;
      const delayMs = target.delayNextPublicationMs;
      target.delayNextPublicationMs = 0;
      if (delayMs > 0) await sleep(delayMs);
      this.githubPublications.push({ number: target.number, input: publication });
      const id = this.nextPublicationId++;
      const url = `https://github.com/${target.forgeRepository.owner}/${target.forgeRepository.name}/pull/${target.number}#pullrequestreview-${id}`;
      target.accepted.push({ id, body: publication.body, url });
      if (target.loseNextPublicationResponse) {
        target.loseNextPublicationResponse = false;
        throw new Error("controlled GitHub response loss after acceptance");
      }
      return json({
        data: {
          addPullRequestReview: {
            pullRequestReview: { id: `PRR_${id}`, url, state: publication.event },
          },
        },
      });
    }

    const number = request.variables.number;
    if (number === undefined) throw new Error("GitHub query target is missing");
    const target = this.target("github", number);
    if (request.query.includes("title body isDraft")) {
      return json({
        data: {
          repository: {
            pullRequest: {
              number,
              title: `Controlled teammate change ${number}`,
              body: `Source-backed change ${number}.`,
              isDraft: false,
              headRefOid: target.currentHeadOid,
              baseRefOid: target.baseOid,
              baseRefName: "main",
              headRefName: target.headRef,
              changedFiles: 3,
              id: target.forgeRef,
              viewerDidAuthor: false,
            },
          },
        },
      });
    }
    if (request.query.includes("reviews(first")) {
      if (target.failNextRead !== undefined) {
        const message = target.failNextRead;
        delete target.failNextRead;
        throw new Error(message);
      }
      return json({
        data: {
          repository: {
            pullRequest: {
              headRefOid: target.currentHeadOid,
              reviews: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: target.accepted.map((publication) => ({
                  id: `PRR_${publication.id}`,
                  url: publication.url,
                  body: publication.body,
                })),
              },
            },
          },
        },
      });
    }
    throw new Error(`unexpected GitHub GraphQL operation: ${request.query.slice(0, 80)}`);
  };

  readonly gitLabRun: GitLabForgeCommandRunner = async (command) => {
    const endpoint = command.args[1] ?? "";
    if (endpoint === "user") return commandResult({ username: "proof-reviewer" });
    const number = Number(/\/merge_requests\/(\d+)/.exec(endpoint)?.[1]);
    if (!Number.isFinite(number)) {
      throw new Error(`unexpected GitLab command: ${command.args.join(" ")}`);
    }
    const target = this.target("gitlab", number);

    if (endpoint.includes("/notes?")) {
      if (target.failNextRead !== undefined) {
        const message = target.failNextRead;
        delete target.failNextRead;
        return { exitCode: 1, stdout: "", stderr: message };
      }
      return commandResult(
        target.accepted
          .map((publication) =>
            JSON.stringify({ id: publication.id, body: publication.body, web_url: null }),
          )
          .join("\n"),
      );
    }
    if (endpoint.endsWith("/approvals")) {
      return commandResult({
        approved_by: target.approved ? [{ user: { username: "proof-reviewer" } }] : [],
      });
    }
    if (endpoint.endsWith("/approve")) {
      target.gitLabApprovalMutationAttempts += 1;
      const parsed = JSON.parse(command.stdin ?? "{}") as { sha?: unknown };
      if (typeof parsed.sha !== "string") throw new Error("GitLab approval SHA is missing");
      this.gitLabApprovals.push({ number, sha: parsed.sha });
      target.approved = true;
      return commandResult({ approved: true });
    }
    if (endpoint.endsWith("/notes")) {
      target.gitLabNoteMutationAttempts += 1;
      const delayMs = target.delayNextPublicationMs;
      target.delayNextPublicationMs = 0;
      if (delayMs > 0) await sleep(delayMs);
      const parsed = JSON.parse(command.stdin ?? "{}") as { body?: unknown };
      if (typeof parsed.body !== "string") throw new Error("GitLab note body is missing");
      this.gitLabNotes.push({ number, body: parsed.body });
      const id = this.nextPublicationId++;
      const url = `https://gitlab.com/${target.forgeRepository.owner}/${target.forgeRepository.name}/-/merge_requests/${number}#note_${id}`;
      target.accepted.push({ id, body: parsed.body, url });
      if (target.loseNextPublicationResponse) {
        target.loseNextPublicationResponse = false;
        throw new Error("controlled GitLab response loss after acceptance");
      }
      return commandResult({ id, body: parsed.body, web_url: null });
    }
    if (endpoint.endsWith(`/merge_requests/${number}`)) {
      return commandResult(this.gitLabMergeRequest(target));
    }
    throw new Error(`unexpected GitLab command: ${command.args.join(" ")}`);
  };

  readonly gitLabDetection = async (): Promise<ForgeDetectionDeps> => ({
    loginShellPath: async () => "/proof/bin",
    envPath: "",
    home: "/proof/home",
    listDir: async (directory) => (directory === "/proof/bin" ? ["glab"] : []),
    isExecutable: async (path) => path === "/proof/bin/glab",
    probeVersion: async (path) => (path === "/proof/bin/glab" ? "1.80.0" : null),
    probeAuth: async () => ({ kind: "authenticated" }),
    platform: "darwin",
  });

  reviewOpener = async ({
    review,
    draft,
  }: {
    readonly review: Review;
    readonly draft: {
      readonly verdict: ForgeReviewEvent;
      readonly boards: readonly { readonly lens: string }[];
    };
  }) => {
    const provider = review.postTarget?.repo.forge ?? "unknown";
    this.openerDrafts.push({
      reviewId: review.id,
      provider,
      verdict: draft.verdict,
      lenses: draft.boards.map((board) => board.lens),
    });
    return {
      status: "drafted" as const,
      opener: `Exact ${provider} opener for immutable review ${review.id}.`,
      model: "controlled-local-forge",
    };
  };

  private gitLabMergeRequest(target: TargetState): Record<string, unknown> {
    return {
      id: Number(target.forgeRef),
      iid: target.number,
      title: `Controlled teammate change ${target.number}`,
      description: `Source-backed change ${target.number}.`,
      draft: false,
      state: "opened",
      sha: target.currentHeadOid,
      diff_refs: { base_sha: target.baseOid, head_sha: target.currentHeadOid },
      target_branch: "main",
      source_branch: target.headRef,
      changes_count: "3",
      updated_at: "2026-08-31T00:00:00Z",
      author: { username: "teammate" },
      reviewers: [{ username: "proof-reviewer" }],
      head_pipeline: { status: "success" },
      web_url: `https://gitlab.com/${target.forgeRepository.owner}/${target.forgeRepository.name}/-/merge_requests/${target.number}`,
    };
  }
}

export function createPublishProofRepository(
  dataDir: string,
  recorder: LocalForgeRecorder,
  provider: PublishProofProvider,
  number: number,
): PublishProofRepository {
  const repository = makeTempDir(`rennet-e2e-publish-${provider}-${number}-`);
  initRepo(repository);
  writeRepoFile(repository, BOARD_IMPLEMENTATION_PATH, "export const widget = 1;\n");
  git(repository, "add", BOARD_IMPLEMENTATION_PATH);
  git(repository, "commit", "-qm", "base widget");
  const baseOid = gitOutput(repository, "rev-parse", "HEAD");
  const headRef = `feature/publish-${provider}-${number}`;
  git(repository, "checkout", "-qb", headRef);
  writeRepoFile(repository, BOARD_IMPLEMENTATION_PATH, "export const widget = 2;\n");
  writeRepoFile(repository, BOARD_TEST_PATH, "import { widget } from './widget';\nvoid widget;\n");
  writeRepoFile(
    repository,
    BOARD_DESIGN_SPEC_PATH,
    [
      "# Widget value specification",
      "",
      "## Why",
      "Reviewers need the specification and implementation evidence in one reading path.",
      "",
      "## MODIFIED Requirements",
      "",
      "### Requirement: Expose the reviewed widget value",
      "The widget SHALL expose the reviewed value.",
      "",
      "#### Scenario: Reading the widget",
      BOARD_DESIGN_SCENARIO,
      "",
    ].join("\n"),
  );
  git(repository, "add", BOARD_IMPLEMENTATION_PATH, BOARD_TEST_PATH, BOARD_DESIGN_SPEC_PATH);
  git(repository, "commit", "-qm", "teammate change one");
  const oldHeadOid = gitOutput(repository, "rev-parse", "HEAD");
  writeRepoFile(
    repository,
    BOARD_IMPLEMENTATION_PATH,
    "export const widget = 2;\nexport const reviewed = true;\n",
  );
  git(repository, "add", BOARD_IMPLEMENTATION_PATH);
  git(repository, "commit", "-qm", "teammate change two");
  const newHeadOid = gitOutput(repository, "rev-parse", "HEAD");

  const owner = provider === "github" ? "proof-gh" : "proof-gl";
  const name = `review-${number}`;
  const forgeRepository = { forge: provider, owner, name } as const;
  const remote =
    provider === "github"
      ? `https://github.com/${owner}/${name}.git`
      : `https://gitlab.com/${owner}/${name}.git`;
  git(repository, "remote", "add", "origin", remote);

  const project = new FileProjectStore(join(dataDir, "projects.json")).add({
    name: `${owner}/${name}`,
    path: repository,
    kind: "repo",
    repoCount: 1,
    branchCount: 2,
    primaryBranch: "main",
    openPath: repository,
    includedRepoPaths: [repository],
    source: "local",
  });
  const fixture: PublishProofRepository = {
    provider,
    repository,
    projectId: project.id,
    forgeRepository,
    number,
    forgeRef: provider === "github" ? `PR_PROOF_${number}` : String(9_000 + number),
    baseOid,
    oldHeadOid,
    newHeadOid,
    headRef,
  };
  recorder.register(fixture);
  return fixture;
}

export interface RunningPublishProofDaemon {
  readonly server: RennetServer;
  readonly stop: () => void;
}

export async function startPublishProofDaemon(
  dataDir: string,
  home: string,
  recorder: LocalForgeRecorder,
): Promise<RunningPublishProofDaemon> {
  const version = desktopVersion();
  const server = await createRennetServer({
    dataDir,
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: process.env.PATH ?? "",
      RENNET_DISABLE_HARNESS: "1",
      RENNET_TEST_BOARD_PREPARATION_DELAY_MS: "30000",
    },
    serverVersion: version,
    httpFetch: recorder.githubFetch,
    githubCliToken: async () => ({ kind: "token", token: "gho_local_publish_proof" }),
    gitLabForgeEffects: {
      detectionDepsForLocus: recorder.gitLabDetection,
      run: recorder.gitLabRun,
    },
    draftReviewOpener: recorder.reviewOpener,
  });
  writeDaemonFile(dataDir, {
    pid: process.pid,
    wsPort: server.wsPort,
    host: server.wsHost,
    protocolVersion: PROTOCOL_VERSION,
    version,
    startedAt: new Date().toISOString(),
  });
  let stopped = false;
  return {
    server,
    stop: () => {
      if (stopped) return;
      stopped = true;
      removeDaemonFile(dataDir, process.pid);
      server.shutdown();
    },
  };
}

export async function captureTeammateReview(
  daemon: RunningPublishProofDaemon,
  dataDir: string,
  repository: PublishProofRepository,
): Promise<CapturedPublishReview> {
  const minted = parseCommandOutput(
    "session.mint",
    await daemon.server.dispatch("session.mint", {
      projectId: repository.projectId,
      commandId: randomUUID(),
      branch: repository.headRef,
      prNumber: repository.number,
      repository: `${repository.forgeRepository.owner}/${repository.forgeRepository.name}`,
      forgeRepository: repository.forgeRepository,
    }),
  );
  if (minted.session === null) throw new Error("publish proof session was not minted");
  return waitForCapturedReview(daemon, dataDir, repository, minted.session.id);
}

export async function waitForCapturedReview(
  daemon: RunningPublishProofDaemon,
  dataDir: string,
  repository: PublishProofRepository,
  sessionId: string,
): Promise<CapturedPublishReview> {
  const sessions = new SessionStore(join(dataDir, "sessions"));
  const deadline = Date.now() + 30_000;
  let reviewId: string | undefined;
  while (reviewId === undefined && Date.now() < deadline) {
    const session = sessions.load(sessionId);
    if (session?.preparation?.status === "failed") {
      throw new Error(`teammate capture failed: ${session.preparation.reason}`);
    }
    reviewId = session?.reviewId;
    if (reviewId === undefined) await sleep(20);
  }
  if (reviewId === undefined) throw new Error("teammate capture did not attach a review");

  await daemon.server.dispatch("session.cancelPreparation", { sessionId });
  sessions.setPreparation(sessionId, undefined);
  const loaded = parseCommandOutput(
    "review.load",
    await daemon.server.dispatch("review.load", { commandId: randomUUID(), reviewId }),
  ).review;
  return { sessionId, review: loaded, repository };
}
