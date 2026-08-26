import type { LedgerEntry, NoveltyLedger } from "@rennet/protocol";

export interface GitlinkEntry {
  readonly path: string;
  readonly oid: string;
  readonly repoRecordId: string;
}

export function classifyGitlinkAdvances(
  previous: readonly GitlinkEntry[],
  current: readonly GitlinkEntry[],
  snapshotFingerprint: string,
  baseOid: string,
): readonly LedgerEntry[] {
  const before = new Map(previous.map((entry) => [entry.path, entry]));
  return current
    .flatMap((entry): LedgerEntry[] => {
      const old = before.get(entry.path);
      if (!old || old.oid === entry.oid) return [];
      const match = {
        kind: "gitlink-advance" as const,
        path: entry.path,
        repoRecordId: entry.repoRecordId,
        oldOid: old.oid,
        newOid: entry.oid,
      };
      return [
        {
          unit: {
            kind: "gitlink",
            path: entry.path,
            fileStatus: "modified",
            repoRecordId: entry.repoRecordId,
            oldOid: old.oid,
            newOid: entry.oid,
          },
          classification: "extends",
          evidence: {
            snapshotFingerprint,
            baseOid,
            shard: null,
            match,
            context: {
              scope: null,
              isKnownTest: false,
              isConvention: false,
              patchTruncated: false,
            },
          },
        },
      ];
    })
    .sort((a, b) => a.unit.path.localeCompare(b.unit.path));
}

export function appendGitlinkAdvances(
  ledger: NoveltyLedger,
  previous: readonly GitlinkEntry[],
  current: readonly GitlinkEntry[],
): NoveltyLedger {
  const entries = [
    ...ledger.entries,
    ...classifyGitlinkAdvances(previous, current, ledger.snapshotFingerprint, ledger.baseOid),
  ].sort((a, b) =>
    `${a.unit.path}\0${a.unit.kind}\0${a.unit.symbol ?? ""}`.localeCompare(
      `${b.unit.path}\0${b.unit.kind}\0${b.unit.symbol ?? ""}`,
    ),
  );
  return { ...ledger, entries };
}
