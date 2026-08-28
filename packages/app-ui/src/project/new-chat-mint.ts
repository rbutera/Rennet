import { type Claim, claimMatchesTarget, newCommandId } from "@rennet/protocol";
import { useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import { useCommand, useMutation } from "../data";
import { sessionPath } from "../routes/url";
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

/** The target a New Chat row claims: a branch, for a pull-request row its number, and the
 *  row's `owner/name` repository identity. */
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
}

/** The target a smart-list row resolves to. A PR row carries its number; a local branch
 *  row is the bare branch. Both halves of the composite `(repository, branch)` ride along. */
export function targetOfRow(row: SmartRow): MintTarget {
  const repository = row.kind === "pr" ? row.pr?.repository : row.local?.repository;
  return {
    branch: row.branch,
    ...(row.kind === "pr" && row.pr !== undefined ? { prNumber: row.pr.number } : {}),
    ...(repository === undefined || repository === "" ? {} : { repository }),
  };
}

/** The live claims held IN this project — the rows New Chat must not offer again. Read off
 *  `session.list`, so archiving a session (which is the only release) puts its rows back on
 *  the next read rather than needing a second signal. */
export function useClaimedTargets(projectId: string): readonly Claim[] {
  const { data } = useCommand("session.list", {});
  const sessions = data?.sessions;
  return useMemo(
    () =>
      (sessions ?? [])
        .filter((session) => session.projectId === projectId && session.archived !== true)
        .flatMap((session) => (session.claim ? [session.claim] : [])),
    [sessions, projectId],
  );
}

/** Claim-dedup on resolve: the rows that SURVIVE — the ones no live claim already owns. */
export function hideClaimedRows(
  rows: readonly SmartRow[],
  claims: readonly Claim[],
): readonly SmartRow[] {
  if (claims.length === 0) return rows;
  return rows.filter((row) => !claims.some((claim) => claimMatchesTarget(claim, targetOfRow(row))));
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
  // The project's reviewable path and primary branch — the capture's two coordinates.
  // Read here rather than drilled: the surface already holds `projects.list`, so this
  // shares its cache entry.
  const { data: projectsData } = useCommand("projects.list", {});
  const project = projectsData?.projects.find((candidate) => candidate.id === projectId);
  // The mint changes the sidebar's rows and the claims New Chat hides by, so it stales
  // `session.list` — the one read both derive from.
  const mint = useMutation("session.mint", { invalidates: ["session.list"] });
  // The capture ATTACHES its review to the session (#587), so it stales `session.list`
  // too — `/s/:slug` reads the attached review id off exactly that list.
  const capture = useMutation("review.capture", { invalidates: ["session.list"] });
  const openPr = useMutation("review.openPr", { invalidates: ["session.list"] });

  const { mutate: mintMutate } = mint;
  const { mutate: captureMutate } = capture;
  const { mutate: openPrMutate } = openPr;

  const start = useCallback(
    (row: SmartRow | undefined, ask: string) => {
      const typed = ask.trim();
      const target = row === undefined ? undefined : targetOfRow(row);
      void mintMutate({
        projectId,
        ...(target?.branch === undefined ? {} : { branch: target.branch }),
        ...(target?.prNumber === undefined ? {} : { prNumber: target.prNumber }),
        ...(target?.repository === undefined ? {} : { repository: target.repository }),
      })
        .then(async ({ session }) => {
          if (session === null) return;
          // Reattaching to a session that already holds its review captures nothing — the
          // patchset is immutable and re-capturing would only mint a second review the
          // session cannot hold. Land straight on it.
          if (session.reviewId === undefined && project) {
            const commandId = newCommandId();
            if (row === undefined) {
              // The current checkout: today's working-tree capture, unchanged.
              await captureMutate({ commandId, repoPath: project.openPath, sessionId: session.id });
            } else if (row.kind === "pr" && row.pr) {
              await openPrMutate({
                commandId,
                ref: `${row.pr.repository}#${row.pr.number}`,
                repoPath: project.openPath,
                sessionId: session.id,
              });
            } else {
              // A branch row: a `merge-base(primary, branch)...branch` range capture. No
              // checkout switch, nothing rewritten on disk. A branch with no unique
              // commits captures an empty range and shows as an honestly empty review.
              await captureMutate({
                commandId,
                repoPath: project.openPath,
                branch: { head: row.branch, base: project.primaryBranch },
                sessionId: session.id,
              });
            }
          }
          navigate(sessionPath(session.id, typed === "" ? {} : { ask: typed }));
        })
        // `useMutation` already holds the reason in `error`, which the surface renders.
        // Absorbing it here only stops an unhandled rejection, never the reporting.
        .catch(noop);
    },
    [mintMutate, captureMutate, openPrMutate, navigate, project, projectId],
  );

  return {
    start,
    pending: mint.pending || capture.pending || openPr.pending,
    error: mint.error ?? capture.error ?? openPr.error,
  };
}
