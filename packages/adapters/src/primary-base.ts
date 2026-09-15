import { type GitExec, isAncestor } from "./git-range-diff";

/**
 * The one place a local surface turns "the primary branch" into a commit
 * (fresh-base-patchset, D1).
 *
 * A clone spells the primary branch more than once — `refs/remotes/origin/main`,
 * `refs/heads/main`, another remote's copy — and the spellings drift apart. Local
 * `main` only moves when the reviewer pulls; `origin/main` only moves when they
 * fetch. Reviewing against whichever spelling a call site happened to name puts the
 * merge-base wherever that ref stopped, so the review silently carries every pull
 * request the primary branch took since. Resolve the base here instead, pick the
 * NEWEST spelling, and every local surface measures the same range.
 *
 * Read verbs only (D2): this never fetches, never writes a ref, and never reaches
 * the network. Capture reads the clone as it stands.
 */

/** The primary-name probe order when neither the caller nor `origin/HEAD` names one. */
const FALLBACK_PRIMARY_NAMES = ["main", "master"] as const;

export interface PrimaryBaseResolution {
  /**
   * The winning ref's short name (`origin/main`, `main`) — what a patchset records as
   * `baseRef` — or `null` when no ref in this clone names the primary branch at all.
   * A `null` is not an error: the caller's own fallback applies (git-capture keeps
   * `HEAD`, the branch-range capture keeps the name it was handed, the New Chat row
   * keeps saying it cannot measure).
   */
  readonly baseRef: string | null;
  /**
   * The winning ref's own tip OID — present exactly when `baseRef` is non-null.
   *
   * A caller that MEASURES against the primary branch (the New Chat row's ahead/behind
   * and diffstat) uses this rather than the short name: `origin/main` as a short name is
   * ambiguous — a tag of that literal name resolves ahead of the remote-tracking ref in
   * git's disambiguation order — so re-resolving the name could measure against a ref the
   * resolver never picked. The OID was read from the fully-qualified ref here and cannot
   * be re-resolved to something else.
   */
  readonly baseTipOid?: string;
  /** `merge-base <winner> <head>`; present only when the caller supplied a head. */
  readonly baseOid?: string;
}

export interface PrimaryBaseOptions {
  /** The project's recorded primary branch name, when the caller has one (`main`). */
  readonly primaryBranch?: string;
  /** The reviewed head (a ref name or an OID). Omit to ask for the ref alone (D3). */
  readonly head?: string;
}

interface Candidate {
  /** Full ref, so the lookup is unambiguous even against a same-named tag. */
  readonly ref: string;
  /** Short name, which is what a patchset records and a row measures against. */
  readonly short: string;
  readonly oid: string;
}

/** The commit a ref points at, or `null` when it does not resolve in this clone. */
async function readOid(git: GitExec, root: string, ref: string): Promise<string | null> {
  // `--verify --quiet` exits non-zero with EMPTY stdout for a ref that is not there,
  // and `reject: false` turns that into a resolved empty string rather than a throw.
  const out = (
    await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { reject: false })
  ).trim();
  return out.length > 0 ? out : null;
}

/** Every remote in this clone, `origin` first, then git's own order. */
async function readRemotes(git: GitExec, root: string): Promise<string[]> {
  const names = (await git(root, ["remote"], { reject: false }))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // `origin` first because it is the remote a pull request opens against by default;
  // the rest keep git's order so a tie between two remotes is decided the same way twice.
  return [...new Set(names.includes("origin") ? ["origin", ...names] : names)];
}

/**
 * `HEAD` is not a branch name — git refuses to create a branch called that — so a caller
 * passing it is saying "I have no name for the primary branch", not naming one. Taken as a
 * name it would build `refs/remotes/origin/HEAD`, which resolves in any ordinary clone, and
 * the base would silently become origin's default tip instead of the caller's own fallback.
 */
const NOT_A_BRANCH_NAME = "HEAD";

/**
 * The primary branch's NAMES (not refs), in probe order. The caller's own answer wins
 * alone — a project that records `main` must never fall through to `master` — and
 * otherwise `origin/HEAD`'s target is tried first, then the conventional pair.
 *
 * `origin/HEAD` goes IN FRONT of the pair rather than replacing it because
 * `symbolic-ref` reports a dangling target happily: a clone whose `origin/HEAD` still
 * points at `refs/remotes/origin/master` after the branch was renamed prints `master`
 * and exits 0, and nothing named `master` resolves. Keeping the pair behind it makes the
 * caller-less probe at least as capable as the working-tree capture's old fallback,
 * which tried `origin/HEAD`, then `main`, then `master` in one list.
 */
async function primaryNames(
  git: GitExec,
  root: string,
  primaryBranch: string | undefined,
): Promise<string[]> {
  const named = primaryBranch?.trim();
  if (named !== undefined && named.length > 0) {
    return named === NOT_A_BRANCH_NAME ? [] : [named];
  }
  const originHead = (
    await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      reject: false,
    })
  ).trim();
  // `origin/HEAD` prints `origin/<name>`, and the name itself may contain slashes.
  const slash = originHead.indexOf("/");
  const derived = slash > 0 ? originHead.slice(slash + 1) : "";
  const names =
    derived.length > 0 && derived !== NOT_A_BRANCH_NAME
      ? [derived, ...FALLBACK_PRIMARY_NAMES]
      : [...FALLBACK_PRIMARY_NAMES];
  return [...new Set(names)];
}

/**
 * The newest candidate: the one no other candidate contains. Candidates arrive in
 * priority order (remote-tracking refs, `origin` first, then the local branch), and
 * the first maximal element in that order is returned — so when two spellings have
 * each moved past the other (diverged), the remote-tracking one wins, because the
 * remote is what a pull request opens against.
 */
async function pickNewest(
  git: GitExec,
  root: string,
  // The highest-priority candidate is a SEPARATE parameter, so "there is at least one"
  // is a fact the type carries and the fallback below needs no cast to state.
  first: Candidate,
  rest: readonly Candidate[],
): Promise<Candidate> {
  // Two spellings at the same commit are the same answer; name the higher-priority one.
  const distinct: Candidate[] = [first];
  for (const candidate of rest) {
    if (!distinct.some((kept) => kept.oid === candidate.oid)) distinct.push(candidate);
  }
  if (distinct.length === 1) return first;
  for (const candidate of distinct) {
    let contained = false;
    for (const other of distinct) {
      if (other === candidate) continue;
      if (await isAncestor(git, root, candidate.oid, other.oid)) {
        contained = true;
        break;
      }
    }
    if (!contained) return candidate;
  }
  // Unreachable: ancestry is a partial order over distinct commits, so at least one
  // candidate is maximal. Answer with the highest-priority ref rather than throwing.
  return first;
}

/**
 * Resolve the commit a local branch or working tree is measured from.
 *
 * Candidates are every ref in the clone naming the primary branch:
 * `refs/remotes/<remote>/<name>` for each remote with `origin` first, then
 * `refs/heads/<name>`. Whatever does not resolve is dropped; the newest survivor
 * wins. With a `head`, `baseOid` is the merge-base of the winner and that head, so a
 * branch that already contains the primary branch's newest commits is based where it
 * LEFT the primary branch rather than at an older tip.
 *
 * A `primaryBranch` of `HEAD` names no branch and yields no candidates, so the answer is
 * `{ baseRef: null }` and the caller's own verbatim fallback runs.
 */
export async function resolvePrimaryBase(
  git: GitExec,
  root: string,
  options: PrimaryBaseOptions = {},
): Promise<PrimaryBaseResolution> {
  const remotes = await readRemotes(git, root);
  for (const name of await primaryNames(git, root, options.primaryBranch)) {
    const specs = [
      ...remotes.map((remote) => ({
        ref: `refs/remotes/${remote}/${name}`,
        short: `${remote}/${name}`,
      })),
      { ref: `refs/heads/${name}`, short: name },
    ];
    const resolved = await Promise.all(
      specs.map(async (spec) => {
        const oid = await readOid(git, root, spec.ref);
        return oid === null ? null : { ...spec, oid };
      }),
    );
    const [first, ...rest] = resolved.filter(
      (candidate): candidate is Candidate => candidate !== null,
    );
    if (first === undefined) continue;
    const winner = await pickNewest(git, root, first, rest);
    if (options.head === undefined) return { baseRef: winner.short, baseTipOid: winner.oid };
    // The winner's OID rather than its name: the ref was just read, and a merge-base
    // against the exact commit cannot be re-resolved to something else mid-capture.
    const baseOid = (await git(root, ["merge-base", winner.oid, options.head])).trim();
    return { baseRef: winner.short, baseTipOid: winner.oid, baseOid };
  }
  return { baseRef: null };
}
