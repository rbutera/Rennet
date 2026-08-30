import { claimMatchesTarget, type ForgeRepoIdentity, newCommandId } from "@rennet/protocol";
import { useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import { useCommand, useMutation } from "../data";
import { sessionPath } from "../routes/url";
import { repositoryIdentitiesAgree } from "./forge-repository";
import type { SmartRow } from "./smart-list";

// ─────────────────────────────────────────────────────────────────────────────
// The New Chat mint seam (C12 cluster 7, built in C21) — the SINGLE module owning
// "a row click starts the session" (R26).
//
// C12 built the picker behind this seam while `session.*` did not exist, and left the
// mint for B9. B9 landed the whole mint path (`SessionEntry`: mint-or-reattach + claim,
// #466 res. 11) and the gate cleared, but nothing bound it — so a row click selected a
// target and did nothing, and the product's front door did not open. This is the binding.
//
// One act, not two: `session.mint` mints the durable session AND claims the target, so the
// claimed row LEAVES New Chat (`hideClaimedRows`) and archive is the only thing that brings
// it back. Both halves decide with the SAME `claimMatchesTarget` the host reattaches with —
// imported from protocol, never re-stated here, because a second copy of "a branch and its
// PR are one claimed thing" would drift into a row that mints a second session.
//
// The claim says WHICH branch the session is about; it does not capture WHAT CHANGED on it
// (#587). So the start also CAPTURES the clicked target's change and attaches the review to
// the session it just minted — one review per row kind:
//
//   • the checkout row → `review.capture` over the working tree (unchanged behaviour);
//   • a local branch row → `review.capture` with a `base...head` range against the primary
//     branch's merge-base — no checkout switch, nothing rewritten on disk, and a
//     `local-branch` snapshot rather than a working-tree capture;
//   • a pull-request row → `review.openPr` against `owner/name#number`.
//
// Without this a click minted a session bound to a branch with no change behind it, and the
// front door opened onto a chat with nothing to review.
// ─────────────────────────────────────────────────────────────────────────────

/** The target a New Chat row claims: a branch, optional PR number, and repository identity. */
export interface MintTarget {
  readonly branch: string;
  readonly prNumber?: number;
  /**
   * The row's repository, as `owner/name` (#580). A workspace project holds several repos, so
   * a branch NAME is unique only within one of them — the smart list already dedupes on the
   * composite `(repository, branch)` for exactly that reason, and the view already shows a repo
   * column when a workspace has more than one. Sending it means the mint discriminates the same
   * way: without it, two repos that both have `main` mint ONE session and clicking one row hands
   * the reviewer the other repo's chat. It is an identity, never a host path, so R19 is untouched.
   * Optional: a row with no repository (there is none today) mints exactly as before.
   */
  readonly repository?: string;
  /** Provider-qualified repository identity. Absent for legacy rows. */
  readonly forgeRepository?: ForgeRepoIdentity;
}

/** The target a smart-list row resolves to. A PR row carries its number; a local branch
 *  row is the bare branch. Both halves of the composite `(repository, branch)` ride along. */
export function targetOfRow(row: SmartRow): MintTarget {
  const repository = row.kind === "pr" ? row.pr?.repository : row.local?.repository;
  const forgeRepository = row.kind === "pr" ? row.pr?.forgeRepository : row.local?.forgeRepository;
  return {
    branch: row.branch,
    ...(row.kind === "pr" && row.pr !== undefined ? { prNumber: row.pr.number } : {}),
    ...(repository === undefined || repository === "" ? {} : { repository }),
    ...(forgeRepository === undefined ? {} : { forgeRepository }),
  };
}

/** The live claims held IN this project — the rows New Chat must not offer again. Read off
 *  `session.list`, so archiving a session (which is the only release) puts its rows back on
 *  the next read rather than needing a second signal. Each claim rides with the structured
 *  identity and legacy `owner/name` its session was minted for, keeping the hide repo-precise. */
export function useClaimedTargets(projectId: string): readonly MintTarget[] {
  const { data } = useCommand("session.list", {});
  const sessions = data?.sessions;
  return useMemo(
    () =>
      (sessions ?? [])
        .filter((session) => session.projectId === projectId && session.archived !== true)
        .flatMap((session) =>
          session.claim
            ? [
                {
                  ...session.claim,
                  ...(session.repository === undefined ? {} : { repository: session.repository }),
                  ...(session.forgeRepository === undefined
                    ? {}
                    : { forgeRepository: session.forgeRepository }),
                },
              ]
            : [],
        ),
    [sessions, projectId],
  );
}

/**
 * The repository half of the match, under #580's silence rule: exclude ONLY on a positive
 * contradiction. Either side absent is silence, not a mismatch — an older or unstamped
 * session (one minted before the row carried a repository) must keep hiding its row, and a
 * row with no repository must keep being hidden by the claim that owns it. Over-tightening
 * here is the worse failure: it un-hides a row whose session already exists, and clicking it
 * mints a SECOND session for one target — the exact collision the claim-dedup prevents.
 *
 * `undefined` is the ONLY absence marker, exactly as the host's `claimingSession` tests it.
 * An empty string is not a second marker to check here: `targetOfRow` normalizes `""` away
 * before a target is built, and every schema that carries a repository is `z.string().min(1)`
 * (`SessionModel`, `sidebarSessionSchema`, `session.mint`), so `""` cannot reach either side.
 * Treating it as absent anyway would make this test STRICTLY LOOSER than the server's, which
 * is how the two ends drift apart — the failure being guarded against, in the other direction.
 */
/**
 * Claim-dedup on resolve: the rows that SURVIVE — the ones no live claim already owns.
 *
 * The repository must agree as well as the branch (#580's mirror, #587). `claimMatchesTarget`
 * decides on branch-or-PR-number alone, because that is all a Claim carries; a workspace
 * project holds several repos, so claiming `main` in repo-a would otherwise hide repo-b's
 * `main` row — a row the reviewer can no longer click, for a repository they never started a
 * session in. Leaving that half unfixed is worse than fixing neither, since #580 made the
 * ledger resolve correctly to a session whose row had vanished.
 *
 * The comparison lives HERE rather than inside `claimMatchesTarget` on purpose: the host's
 * `claimingSession` already owns the server-side rule, and a second copy of it inside the
 * shared protocol matcher is the drift #466 res. 11 warns about.
 */
export function hideClaimedRows(
  rows: readonly SmartRow[],
  claimed: readonly MintTarget[],
): readonly SmartRow[] {
  if (claimed.length === 0) return rows;
  return rows.filter((row) => {
    const target = targetOfRow(row);
    return !claimed.some(
      (claim) =>
        claimMatchesTarget(claim, target) &&
        repositoryIdentitiesAgree(
          { repository: claim.repository, forgeRepository: claim.forgeRepository },
          { repository: target.repository, forgeRepository: target.forgeRepository },
        ),
    );
  });
}

export interface NewChatMint {
  /**
   * Start the session AND the review for a row (or, with no row, the "talk about the
   * project" checkout row): mint + claim, capture the clicked target's change, attach it
   * to the minted session, then land on it carrying the typed ask. A host with no session
   * store mints nothing and answers `null` — this then stays put rather than navigating
   * to a session that does not exist.
   */
  readonly start: (row: SmartRow | undefined, ask: string) => void;
  /** A start is in flight — the surface disables its rows so one click is one session. */
  readonly pending: boolean;
  /** The reason the start failed, shown as-is; nothing is claimed to have started. */
  readonly error: unknown;
}

/** The rejection absorber: `useMutation` already recorded the reason on `error`. */
function noop(): void {
  return;
}

export function useNewChatMint(projectId: string): NewChatMint {
  const [, navigate] = useLocation();
  // ONE command. Starting a session is one host-owned act (#587) — capture, mint, claim,
  // attach — so the client issues it and navigates to what came back.
  //
  // It used to be three calls the renderer sequenced, and every one of this seam's defects
  // lived in that sequencing: a capture skipped because the async `projects.list` read had
  // not settled while the navigate ran anyway (a review-less session, the exact bug this
  // closes), a claim minted before a capture that could reject (stranding the target behind
  // a hidden row with no retry), and `project.openPath` sent as the repo for a row that
  // might belong to any of a workspace's repos. None of them are reachable from here now,
  // because none of those steps happen here.
  const mint = useMutation("session.mint", { invalidates: ["session.list"] });
  const { mutate: mintMutate } = mint;

  const start = useCallback(
    (row: SmartRow | undefined, ask: string) => {
      const typed = ask.trim();
      const target = row === undefined ? undefined : targetOfRow(row);
      void mintMutate({
        projectId,
        commandId: newCommandId(),
        ...(target?.branch === undefined ? {} : { branch: target.branch }),
        ...(target?.prNumber === undefined ? {} : { prNumber: target.prNumber }),
        // Keep the readable owner/name for legacy sessions; the structured identity prevents
        // identical slugs on different forges from resolving to the wrong repository.
        ...(target?.repository === undefined ? {} : { repository: target.repository }),
        ...(target?.forgeRepository === undefined
          ? {}
          : { forgeRepository: target.forgeRepository }),
      })
        .then(({ session }) => {
          // A host with no session store mints nothing and answers `null`; stay put rather
          // than navigating to a session that does not exist.
          if (session === null) return;
          navigate(sessionPath(session.id, typed === "" ? {} : { ask: typed }));
        })
        // `useMutation` already holds the reason in `error`, which the surface renders.
        // Absorbing it here only stops an unhandled rejection, never the reporting. A
        // rejection means nothing was claimed, so the row is still there to click again.
        .catch(noop);
    },
    [mintMutate, navigate, projectId],
  );

  return { start, pending: mint.pending, error: mint.error };
}
