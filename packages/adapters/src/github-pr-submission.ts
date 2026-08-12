import type {
  ForgePrSubmission,
  ForgePrSubmissionOutcome,
  ForgePrSubmissionPort,
  ForgePrSubmissionTarget,
} from "@rennet/core";
import type { HttpFetch } from "./github-auth";

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
 * The token is resolved LAZILY (`resolveToken`) and only ever an Authorization HEADER
 * on a real send — never persisted here, never part of a logged descriptor.
 */

export interface GitHubPrSubmissionConfig {
  http: HttpFetch;
  /** The bearer token resolver from the auth ladder. Held in memory only. */
  resolveToken: () => Promise<string>;
  apiBaseUrl?: string;
}

const API_BASE = "https://api.github.com";

interface RestPr {
  html_url: string;
  number: number;
}

export class GitHubPrSubmissionAdapter implements ForgePrSubmissionPort {
  constructor(private readonly config: GitHubPrSubmissionConfig) {}

  private base(): string {
    return this.config.apiBaseUrl ?? API_BASE;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.config.resolveToken();
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };
  }

  /** The single OPEN PR from `head` against `base`, or null when none exists. */
  private async findOpenPr(
    target: ForgePrSubmissionTarget,
    submission: ForgePrSubmission,
  ): Promise<RestPr | null> {
    const { owner, name } = target.repo;
    // GitHub filters `head` as `owner:branch` (the head repo's owner). Same-repo
    // own-branch submission is always the target owner's branch.
    const query = new URLSearchParams({
      state: "open",
      head: `${owner}:${submission.head}`,
      base: submission.base,
    });
    const url = `${this.base()}/repos/${owner}/${name}/pulls?${query.toString()}`;
    const res = await this.config.http(url, { method: "GET", headers: await this.authHeaders() });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GitHub PR lookup failed (HTTP ${res.status}): ${text}`);
    }
    const prs = JSON.parse(text) as RestPr[];
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
    const url = `${this.base()}/repos/${owner}/${name}/pulls`;
    const res = await this.config.http(url, {
      method: "POST",
      headers: await this.authHeaders(),
      body: JSON.stringify({
        title: submission.title,
        body: submission.body,
        head: submission.head,
        base: submission.base,
        draft: submission.draft,
      }),
    });
    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      const pr = JSON.parse(text) as RestPr;
      return { url: pr.html_url, number: pr.number, reused: false };
    }

    // (3) A 422 means a PR already exists for this head (a race between the lookup and
    // the create) — resolve it to the existing PR rather than failing the sign.
    if (res.status === 422) {
      const raced = await this.findOpenPr(target, submission);
      if (raced) return { url: raced.html_url, number: raced.number, reused: true };
    }
    throw new Error(`GitHub PR creation failed (HTTP ${res.status}): ${text}`);
  }
}
