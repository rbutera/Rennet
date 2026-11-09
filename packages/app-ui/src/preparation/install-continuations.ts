import type { SessionPreparation } from "@rennet/protocol";
import { useCallback } from "react";
import { useReadSessionNow } from "../data/session-read";
import { useDropOwnerInstallContinuations } from "../data/tool-install";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT AN INSTALL DOES WHEN IT LANDS, for a preparation.
//
// Install for me under the large-file dialog answers Download when it lands; under the
// failure block it retries the preparation. Both outlive the surface that started them, by
// design (an Escape does not stop the install). So both can land on a session that has moved
// on — and the one move that matters is a CANCEL: an install landing after the reviewer
// cancelled must not resume the review they stopped. Two guards, either of which is enough:
//
//   • Cancel withdraws them. Both Cancel controls drop every continuation either owner holds
//     for the session (`useWithdrawInstallContinuations`).
//   • A continuation acts only on the state it was armed for. When the install lands it reads
//     the session from the daemon and goes ahead only if the session is still asking what
//     the install was answering (`useWhileStillAsking`). That also covers a cancel from
//     another window, or a Retry that already got the review going again.
// ─────────────────────────────────────────────────────────────────────────────

/** The owner an install started from the large-file dialog runs under. */
export function largeFileInstallOwner(sessionId: string): string {
  return `large-file:${sessionId}`;
}

/** The owner an install started from the failure block runs under. */
export function failureInstallOwner(sessionId: string): string {
  return `failure:${sessionId}`;
}

/** Whether the session is asking the large-file question: waiting on it, or failed with
 *  choosing a mode as the recovery. */
export function asksLargeFileChoice(preparation: SessionPreparation | undefined): boolean {
  return (
    preparation?.status === "awaiting" ||
    (preparation?.status === "failed" && preparation.action === "choose-large-files")
  );
}

/** Whether the session failed with installing a tool as the recovery. */
export function asksForInstall(preparation: SessionPreparation | undefined): boolean {
  return preparation?.status === "failed" && preparation.action === "install";
}

/** Drop what every install running for this session would do on landing. */
export function useWithdrawInstallContinuations(): (sessionId: string) => void {
  const drop = useDropOwnerInstallContinuations();
  return useCallback(
    (sessionId) => {
      drop(largeFileInstallOwner(sessionId));
      drop(failureInstallOwner(sessionId));
    },
    [drop],
  );
}

/**
 * `act`, guarded: run it only if the session — read from the daemon at that moment — still
 * `asks` for it. A read that fails acts on nothing: the reviewer still has the button.
 */
export function useWhileStillAsking(): (
  sessionId: string,
  asks: (preparation: SessionPreparation | undefined) => boolean,
  act: () => void,
) => void {
  const readSession = useReadSessionNow();
  return useCallback(
    (sessionId, asks, act) => {
      readSession(sessionId).then(
        (row) => {
          if (asks(row?.preparation)) act();
        },
        () => undefined,
      );
    },
    [readSession],
  );
}
