import { implementationPathFor, isTestPath } from "@rennet/protocol";
import { compareStrings } from "./blast-radius";

/**
 * A test↔implementation pair among the patchset's changed paths — Sequence-drafter
 * candidate data (#464). A hint exists only when BOTH sides changed in this
 * patchset; pairing is the protocol delta seam's reversible suffix convention,
 * the same definitions the UI's counterpart jump resolves with.
 */
export interface CounterpartHint {
  readonly implPath: string;
  readonly testPath: string;
}

/**
 * Derive the counterpart hints for a set of changed paths. Pure and deterministic:
 * the result is sorted by implementation path (then test path). One direction of
 * the reversible convention suffices — a pair requires both sides present, and
 * every test path maps back to exactly one implementation path.
 */
export function buildCounterpartHints(paths: readonly string[]): CounterpartHint[] {
  const changed = new Set(paths);
  const hints: CounterpartHint[] = [];
  for (const path of paths) {
    if (!isTestPath(path)) continue;
    const implPath = implementationPathFor(path);
    if (implPath !== null && changed.has(implPath)) {
      hints.push({ implPath, testPath: path });
    }
  }
  // Code-unit compare: locale-independent, identical order on every host.
  return hints.sort(
    (a, b) => compareStrings(a.implPath, b.implPath) || compareStrings(a.testPath, b.testPath),
  );
}
