import { type Claim, claimMatchesTarget } from "@rennet/protocol";
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
// ─────────────────────────────────────────────────────────────────────────────

/** The target a New Chat row claims: a branch and, for a pull-request row, its number. */
export interface MintTarget {
  readonly branch: string;
  readonly prNumber?: number;
}

/** The target a smart-list row resolves to. A PR row carries its number; a local branch
 *  row is the bare branch. */
export function targetOfRow(row: SmartRow): MintTarget {
  return row.kind === "pr" && row.pr !== undefined
    ? { branch: row.branch, prNumber: row.pr.number }
    : { branch: row.branch };
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
   * Start the session for a row (or, with no target, the "talk about the project" checkout
   * row): mint + claim, then land on the minted session's route carrying the typed ask.
   * A host with no session store mints nothing and answers `null` — this then stays put
   * rather than navigating to a session that does not exist.
   */
  readonly start: (target: MintTarget | undefined, ask: string) => void;
  /** A mint is in flight — the surface disables its rows so one click is one session. */
  readonly pending: boolean;
  /** The reason the mint failed, shown as-is; nothing is claimed to have started. */
  readonly error: unknown;
}

export function useNewChatMint(projectId: string): NewChatMint {
  const [, navigate] = useLocation();
  // The mint changes the sidebar's rows and the claims New Chat hides by, so it stales
  // `session.list` — the one read both derive from.
  const { mutate, pending, error } = useMutation("session.mint", {
    invalidates: ["session.list"],
  });

  const start = useCallback(
    (target: MintTarget | undefined, ask: string) => {
      const typed = ask.trim();
      void mutate({
        projectId,
        ...(target?.branch === undefined ? {} : { branch: target.branch }),
        ...(target?.prNumber === undefined ? {} : { prNumber: target.prNumber }),
      })
        .then(({ session }) => {
          if (session === null) return;
          navigate(sessionPath(session.id, typed === "" ? {} : { ask: typed }));
        })
        // `useMutation` already holds the reason in `error`, which the surface renders.
        // Swallowing here only stops an unhandled rejection, never the reporting.
        .catch(() => {});
    },
    [mutate, navigate, projectId],
  );

  return { start, pending, error };
}
