import { createHash } from "node:crypto";
import type { ForgePort, ForgePullRequest, ForgePullRequestRef, SsoState } from "@rennet/core";
import type { PatchFile, Patchset, PatchsetIntent, PatchsetSpecSnapshot } from "@rennet/types";
import {
  captureRangePatchset,
  DEFAULT_VISIBLE_BYTE_LIMIT,
  type GitExec,
  parseUnifiedDiffFiles,
  visible,
} from "./git-range-diff";
import { snapshotSpec, specPathsOf } from "./patchset-intent-capture";
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
  /**
   * The deep-fetched PR (issue #21). Carried so the caller can build the real
   * post-target (repo + number + `forgeRef` node id + `headOid`) that a real GitHub
   * egress needs, without a second `fetchPullRequest`. Identity only — content still
   * comes from the local diff / REST fallback in `patchset`.
   */
  pullRequest: ForgePullRequest;
}

export interface GitHubChangesetSourceDeps {
  forge: ForgePort;
  git: GitExec;
  pin: GitObjectPinner;
  worktrees: WorktreeProvider;
  visibleByteLimit?: number;
  resolveProjectSnapshotId?: (
    repoRoot: string,
    baseOid: string,
  ) => Promise<string | undefined> | string | undefined;
}

const DEGRADED_REASON =
  "This diff came from GitHub's REST API because the repository is not on disk. Whole-repo-context angles (reach, blast-radius) cannot run on the degraded diff.";

/** The remote the reviewed OIDs are fetched from when they are not yet local. */
const REVIEW_REMOTE = "origin";

/**
 * The reviewed base/head OIDs are not in the local object store and could not be
 * retrieved from the remote either. Thrown (never swallowed) so the caller fails
 * closed with an honest, actionable reason instead of the local-first path pinning
 * a missing object and crashing deep inside git.
 *
 * The common cause is a squash- or rebase-merged PR whose head commit was never
 * fetched into this clone (Rennet's own PRs are all squash-merged), combined with
 * the PR head ref having been deleted on the remote. A wrong `origin` (pointing at
 * a different repository than the PR's) produces the same failure.
 */
export class ReviewedOidUnavailableError extends Error {
  override readonly name = "ReviewedOidUnavailableError";
  constructor(
    readonly prNumber: number,
    readonly missingOids: readonly string[],
    readonly remote: string = REVIEW_REMOTE,
  ) {
    super(
      `Cannot open PR #${prNumber} for review: the reviewed commit(s) ` +
        `${missingOids.join(", ")} are not in the local clone and could not be ` +
        `fetched from '${remote}'. The PR head may have been deleted on the remote, ` +
        `or '${remote}' does not point at the PR's repository.`,
    );
  }
}

export class GitHubChangesetSource {
  constructor(private readonly deps: GitHubChangesetSourceDeps) {}

  /** Open a PR for review, preferring the local clone and pinning the reviewed head. */
  async open(ref: ForgePullRequestRef): Promise<GitHubChangesetResult> {
    const pr = await this.deps.forge.fetchPullRequest(ref);
    const worktrees = await this.deps.worktrees.list();
    const match = matchWorktree(ref.repo, worktrees);

    if (match) {
      // The pin (and the local diff) needs both OIDs already in the object store.
      // For a merge-commit-merged PR the head is reachable from what the clone has,
      // but a squash- or rebase-merged PR's head commit was never fetched here, so
      // retrieve any not-yet-local reviewed OID from the remote FIRST. This is the
      // host-side "fetch the OID before pin" step the pinner's contract defers to
      // composition (#193). Fails closed with a typed error if it cannot.
      await this.ensureReviewedOidsLocal(match.root, pr, ref.number);
      // Local-first: pin the OIDs (survives force-push), then diff locally.
      await this.deps.pin.pin(match.root, [pr.baseOid, pr.headOid]);
      const projectSnapshotId = await this.deps.resolveProjectSnapshotId?.(match.root, pr.baseOid);
      const patchset = await captureRangePatchset(this.deps.git, {
        root: match.root,
        baseOid: pr.baseOid,
        headOid: pr.headOid,
        baseRef: pr.baseRef,
        source: "github-local",
        visibleByteLimit: this.deps.visibleByteLimit,
        projectSnapshotId,
      });
      // Freeze the stated intent onto the patchset (#136): PR title/body plus the
      // spec set snapshotted at the reviewed HEAD OID (the clone is on disk, so we
      // read the committed content — what the change shipped against, immutable).
      const specSnapshots = await this.snapshotSpecsAtHead(match.root, pr.headOid, patchset.files);
      const intent = forgePrIntent("github-pr", pr, specSnapshots);
      return {
        patchset: { ...patchset, intent },
        sso: pr.sso,
        pin: { root: match.root, baseOid: pr.baseOid, headOid: pr.headOid, baseRef: pr.baseRef },
        pullRequest: pr,
      };
    }

    // Degraded fallback: no clone on disk, so take GitHub's REST diff and BADGE it.
    const { diff, sso } = await this.deps.forge.fetchDiff(ref);
    const combinedSso: SsoState = sso.kind === "none" ? pr.sso : sso;
    const restPatchset = this.restPatchset(ref, pr.baseOid, pr.headOid, pr.baseRef, diff);
    // Intent still freezes onto the degraded patchset — the PR title/body come from
    // the forge, not the clone. Spec snapshots need the on-disk committed content,
    // which the REST path does not have, so the spec set is honestly absent.
    return {
      patchset: { ...restPatchset, intent: forgePrIntent("github-rest", pr, []) },
      sso: combinedSso,
      pin: null,
      pullRequest: pr,
    };
  }

  /**
   * Ensure the reviewed base AND head OIDs are in the local object store before we
   * pin and diff them, fetching from the remote when they are not (#193).
   *
   * Fast path: when both OIDs are already present (the merge-commit case, or a
   * clone that has fetched the head) nothing runs — no network, no side effects.
   *
   * When an OID is missing, fetch the PR head ref first: `refs/pull/<n>/head` is the
   * one ref GitHub keeps pointing at the reviewed commit even after a squash- or
   * rebase-merge deletes the source branch, and its history carries the base OID too
   * (the head branched from the base), so this single fetch usually supplies both.
   * If anything is still missing, fall back to fetching the specific OIDs directly
   * (GitHub's reachable-SHA fetch). Each attempt is best-effort; the object store,
   * re-checked at the end, is the sole arbiter of success. If an OID still cannot be
   * produced we throw `ReviewedOidUnavailableError` rather than let the pin crash.
   */
  private async ensureReviewedOidsLocal(
    root: string,
    pr: ForgePullRequest,
    prNumber: number,
  ): Promise<void> {
    const wanted = [pr.baseOid, pr.headOid];
    if ((await this.missingOids(root, wanted)).length === 0) return;

    const attempts: string[][] = [
      ["fetch", "--no-tags", "--no-write-fetch-head", REVIEW_REMOTE, `refs/pull/${prNumber}/head`],
      ["fetch", "--no-tags", "--no-write-fetch-head", REVIEW_REMOTE, ...wanted],
    ];
    for (const args of attempts) {
      if ((await this.missingOids(root, wanted)).length === 0) break;
      try {
        await this.deps.git(root, args);
      } catch {
        // Best-effort: a deleted PR ref or a remote that rejects a bare-SHA want
        // makes an attempt fail. The final object-store check below is the arbiter.
      }
    }

    const stillMissing = await this.missingOids(root, wanted);
    if (stillMissing.length > 0) {
      throw new ReviewedOidUnavailableError(prNumber, stillMissing);
    }
  }

  /** Return the subset of `oids` NOT resolvable to a commit in the local store. */
  private async missingOids(root: string, oids: readonly string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const oid of oids) {
      // `rev-parse --verify --quiet` prints the resolved OID on success and nothing
      // on failure, so stdout (all GitExec exposes) distinguishes present from
      // absent without relying on the exit code. `^{commit}` requires the object to
      // be present AND a commit, which is exactly what pin + range-diff need.
      const out = await this.deps.git(
        root,
        ["rev-parse", "--verify", "--quiet", `${oid}^{commit}`],
        {
          reject: false,
        },
      );
      if (out.trim().length === 0) missing.push(oid);
    }
    return missing;
  }

  /**
   * Snapshot the changeset's spec documents from their COMMITTED content at the
   * reviewed head OID. `git show <headOid>:<path>` reads the exact bytes the change
   * shipped against; a document unreadable at head (e.g. deleted by the change) is
   * skipped rather than fabricated. The read is best-effort per file, so a single
   * unreadable spec never fails the whole capture.
   */
  private async snapshotSpecsAtHead(
    root: string,
    headOid: string,
    files: readonly PatchFile[],
  ): Promise<PatchsetSpecSnapshot[]> {
    const snapshots: PatchsetSpecSnapshot[] = [];
    for (const path of specPathsOf(files)) {
      try {
        const content = await this.deps.git(root, ["show", `${headOid}:${path}`]);
        snapshots.push(snapshotSpec(path, content));
      } catch {
        // Unreadable at head (deleted by the change, or a binary/odd object): the
        // spec set omits it honestly rather than inventing a snapshot.
      }
    }
    return snapshots;
  }

  /**
   * Reproduce the reviewed patchset from a pin. This diffs the PINNED OIDs, so it
   * returns the byte-identical reviewed state no matter what the remote head is now
   * — the force-push resilience property (R28: a moved head mints a new patchset via
   * `open`, and it never rewrites this one).
   */
  async reproduce(pin: ReviewedHeadPin): Promise<Patchset> {
    const projectSnapshotId = await this.deps.resolveProjectSnapshotId?.(pin.root, pin.baseOid);
    return captureRangePatchset(this.deps.git, {
      root: pin.root,
      baseOid: pin.baseOid,
      headOid: pin.headOid,
      baseRef: pin.baseRef,
      source: "github-local",
      visibleByteLimit: this.deps.visibleByteLimit,
      projectSnapshotId,
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

/**
 * Build the frozen intent for a GitHub PR review (#136). The title/body come from
 * the forge (GitHub owns identity). An empty PR body is recorded as an honest
 * absence (`prBodyAbsent`) rather than an empty string masquerading as intent, and
 * a blank title is simply omitted.
 */
function forgePrIntent(
  surface: "github-pr" | "github-rest",
  pr: ForgePullRequest,
  specSnapshots: readonly PatchsetSpecSnapshot[],
): PatchsetIntent {
  const intent: {
    surface: "github-pr" | "github-rest";
    prTitle?: string;
    prBody?: string;
    prBodyAbsent?: boolean;
    specSnapshots?: readonly PatchsetSpecSnapshot[];
  } = { surface };
  if (pr.title.trim().length > 0) intent.prTitle = pr.title;
  if (pr.body.trim().length > 0) intent.prBody = pr.body;
  else intent.prBodyAbsent = true;
  if (specSnapshots.length > 0) intent.specSnapshots = specSnapshots;
  return intent;
}
