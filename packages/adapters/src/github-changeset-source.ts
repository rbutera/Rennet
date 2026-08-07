import { createHash } from "node:crypto";
import type { ForgePort, ForgePullRequestRef, SsoState } from "@rennet/core";
import type { Patchset } from "@rennet/types";
import {
  captureRangePatchset,
  DEFAULT_VISIBLE_BYTE_LIMIT,
  type GitExec,
  parseUnifiedDiffFiles,
  visible,
} from "./git-range-diff";
import { type LocalWorktree, matchWorktree } from "./worktree-discovery";

/**
 * The GitHub changeset source — the second v1 review mode (GitHub Integration
 * Plan §2/§4). One engine, one review-state model, two sources: this produces the
 * SAME immutable `Patchset` the local working-tree capture does, so both feed the
 * identical decomposition/canvas pipeline.
 *
 * The flow: deep-fetch the PR (GitHub owns identity) → map its repo onto a local
 * clone by identity → pin the head/base OIDs locally so a force-push cannot make
 * the reviewed state unreachable → diff the range locally (git owns content). When
 * no clone matches, fall back to GitHub's REST diff with a VISIBLE degraded badge,
 * because the whole-repo-context angles cannot run without the clone.
 *
 * Every effect is injected (forge port, git runner, object pinner, worktree
 * provider), so no test touches the network and the token never leaves the forge
 * adapter's process memory.
 */

/** Fetches and pins the reviewed OIDs locally so a remote force-push cannot GC them. */
export interface GitObjectPinner {
  pin(root: string, oids: string[]): Promise<void>;
}

/** The ref namespace under which reviewed OIDs are kept alive. */
const PIN_REF_PREFIX = "refs/rennet/pins/";

/**
 * A `GitObjectPinner` that writes a protective ref per reviewed OID, so a remote
 * force-push followed by GC cannot make the reviewed head unreachable — the ref
 * keeps the object alive locally, which is what makes acceptance #5's
 * force-push-survival a real property rather than an accident of ancestry.
 *
 * The OIDs must already be present in the local object store; the host-side
 * "fetch the OID first" step for a not-yet-local commit (e.g. a fork PR whose head
 * was never fetched) is composition's concern. This is the keep-alive half of the
 * pin, and it is the half acceptance #5 turns on.
 */
export function createRefPinner(git: GitExec): GitObjectPinner {
  return {
    async pin(root, oids) {
      for (const oid of oids) {
        await git(root, ["update-ref", `${PIN_REF_PREFIX}${oid}`, oid]);
      }
    },
  };
}

/** Lists the local worktrees whose remotes are candidates for identity matching. */
export interface WorktreeProvider {
  list(): Promise<LocalWorktree[]>;
}

/**
 * The pin needed to reproduce a reviewed patchset byte-identically at any later
 * time, regardless of what the remote head is now. Persisting this (in the review)
 * is what makes the reviewed state unreachable-proof against a force-push.
 */
export interface ReviewedHeadPin {
  root: string;
  baseOid: string;
  headOid: string;
  baseRef: string;
}

export interface GitHubChangesetResult {
  patchset: Patchset;
  /** SSO state observed while fetching — a partial-results banner, if any. */
  sso: SsoState;
  /** The pin for force-push-proof reproduction; null on the degraded REST path. */
  pin: ReviewedHeadPin | null;
}

export interface GitHubChangesetSourceDeps {
  forge: ForgePort;
  git: GitExec;
  pin: GitObjectPinner;
  worktrees: WorktreeProvider;
  visibleByteLimit?: number;
}

const DEGRADED_REASON =
  "This diff came from GitHub's REST API because the repository is not on disk. Whole-repo-context angles (reach, blast-radius) cannot run on the degraded diff.";

export class GitHubChangesetSource {
  constructor(private readonly deps: GitHubChangesetSourceDeps) {}

  /** Open a PR for review, preferring the local clone and pinning the reviewed head. */
  async open(ref: ForgePullRequestRef): Promise<GitHubChangesetResult> {
    const pr = await this.deps.forge.fetchPullRequest(ref);
    const worktrees = await this.deps.worktrees.list();
    const match = matchWorktree(ref.repo, worktrees);

    if (match) {
      // Local-first: pin the OIDs (survives force-push), then diff locally.
      await this.deps.pin.pin(match.root, [pr.baseOid, pr.headOid]);
      const patchset = await captureRangePatchset(this.deps.git, {
        root: match.root,
        baseOid: pr.baseOid,
        headOid: pr.headOid,
        baseRef: pr.baseRef,
        source: "github-local",
        visibleByteLimit: this.deps.visibleByteLimit,
      });
      return {
        patchset,
        sso: pr.sso,
        pin: { root: match.root, baseOid: pr.baseOid, headOid: pr.headOid, baseRef: pr.baseRef },
      };
    }

    // Degraded fallback: no clone on disk, so take GitHub's REST diff and BADGE it.
    const { diff, sso } = await this.deps.forge.fetchDiff(ref);
    const combinedSso: SsoState = sso.kind === "none" ? pr.sso : sso;
    return {
      patchset: this.restPatchset(ref, pr.baseOid, pr.headOid, pr.baseRef, diff),
      sso: combinedSso,
      pin: null,
    };
  }

  /**
   * Reproduce the reviewed patchset from a pin. This diffs the PINNED OIDs, so it
   * returns the byte-identical reviewed state no matter what the remote head is now
   * — the force-push resilience property (R28: a moved head mints a new patchset via
   * `open`, and it never rewrites this one).
   */
  async reproduce(pin: ReviewedHeadPin): Promise<Patchset> {
    return captureRangePatchset(this.deps.git, {
      root: pin.root,
      baseOid: pin.baseOid,
      headOid: pin.headOid,
      baseRef: pin.baseRef,
      source: "github-local",
      visibleByteLimit: this.deps.visibleByteLimit,
    });
  }

  private restPatchset(
    ref: ForgePullRequestRef,
    baseOid: string,
    headOid: string,
    baseRef: string,
    diff: string,
  ): Patchset {
    const visibleByteLimit = this.deps.visibleByteLimit ?? DEFAULT_VISIBLE_BYTE_LIMIT;
    const files = parseUnifiedDiffFiles(diff);
    const identity = `${ref.repo.forge}:${ref.repo.owner}/${ref.repo.name}`;
    const repository = {
      // Path-less: the clone is not on disk. Identity is the forge repo, not a path.
      id: createHash("sha256").update(identity).digest("hex"),
      root: identity,
      commonDir: "",
      baseRef,
      baseOid,
      headOid,
    };
    const bytes = Buffer.from(diff);
    const id = createHash("sha256")
      .update(
        JSON.stringify({ repository, files: files.map(({ path, status }) => ({ path, status })) }),
      )
      .update(bytes)
      .digest("hex");
    return {
      id,
      createdAt: new Date().toISOString(),
      repository,
      files,
      rawDiff: visible(diff, visibleByteLimit),
      byteLength: bytes.length,
      truncated: bytes.length > visibleByteLimit,
      source: "github-rest",
      degraded: true,
      degradationReason: DEGRADED_REASON,
    };
  }
}
