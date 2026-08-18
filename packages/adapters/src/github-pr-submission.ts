import type { Octokit } from "@octokit/core";
import type {
  ForgePrSubmission,
  ForgePrSubmissionOutcome,
  ForgePrSubmissionPort,
  ForgePrSubmissionTarget,
} from "@rennet/core";
import { requestErrorStatus } from "./github-octokit";

/**
 * The GitHub implementation of `ForgePrSubmissionPort` (issue #257 / #107) — opening
 * an own-branch pull request AS THE USER via the REST pulls API.
 *
 * Every GitHub-specific fact lives behind this class: the `POST /repos/{o}/{n}/pulls`
 * create, the `owner:head` filter on the existing-PR query, the `html_url`/`number`
 * fields. The caller works in `ForgePrSubmission`/`ForgePrSubmissionOutcome` nouns.
 *
 * Idempotent by head branch: `submitPullRequest` queries for an OPEN PR from the same
 * head BEFORE creating, and returns it (reused: true) if found — so a retry after a
 * dropped outcome, or a double sign, yields exactly one PR. GitHub itself also refuses
 * a duplicate (422 "A pull request already exists"), which is caught and resolved to
 * the existing PR rather than surfaced as a failure.
 *
 * The token is resolved LAZILY (`resolveOctokit`) and never leaves the client —
 * never persisted here, never part of a logged descriptor.
 */

export interface GitHubPrSubmissionConfig {
  /** The token-bound client resolver from the auth ladder. */
  resolveOctokit: () => Promise<Octokit>;
}

interface RestPr {
  html_url: string;
  number: number;
}

export class GitHubPrSubmissionAdapter implements ForgePrSubmissionPort {
  constructor(private readonly config: GitHubPrSubmissionConfig) {}

  /** The single OPEN PR from `head` against `base`, or null when none exists. */
  private async findOpenPr(
    target: ForgePrSubmissionTarget,
    submission: ForgePrSubmission,
  ): Promise<RestPr | null> {
    const octokit = await this.config.resolveOctokit();
    const { owner, name } = target.repo;
    // GitHub filters `head` as `owner:branch` (the head repo's owner). Same-repo
    // own-branch submission is always the target owner's branch.
    const res = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner,
      repo: name,
      state: "open",
      head: `${owner}:${submission.head}`,
      base: submission.base,
    });
    const prs = res.data as RestPr[];
    return prs.length > 0 ? (prs[0] ?? null) : null;
  }

  async submitPullRequest(input: {
    target: ForgePrSubmissionTarget;
    submission: ForgePrSubmission;
  }): Promise<ForgePrSubmissionOutcome> {
    const { target, submission } = input;
    const { owner, name } = target.repo;

    // (1) Query-before-create idempotency: reuse an already-open PR from this head.
    const existing = await this.findOpenPr(target, submission);
    if (existing) {
      return { url: existing.html_url, number: existing.number, reused: true };
    }

    // (2) Create the PR. `head` is a branch ref (#107), never a SHA.
    const octokit = await this.config.resolveOctokit();
    try {
      const res = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo: name,
        title: submission.title,
        body: submission.body,
        head: submission.head,
        base: submission.base,
        draft: submission.draft,
      });
      const pr = res.data as RestPr;
      return { url: pr.html_url, number: pr.number, reused: false };
    } catch (error) {
      // (3) A 422 means a PR already exists for this head (a race between the lookup
      // and the create) — resolve it to the existing PR rather than failing the sign.
      if (requestErrorStatus(error) === 422) {
        const raced = await this.findOpenPr(target, submission);
        if (raced) return { url: raced.html_url, number: raced.number, reused: true };
      }
      throw error;
    }
  }
}
