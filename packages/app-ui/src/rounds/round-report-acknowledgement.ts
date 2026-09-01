const STORAGE_PREFIX = "rennet.round-report.acknowledged:";

function storageKey(reportBoardId: string): string {
  return `${STORAGE_PREFIX}${reportBoardId}`;
}

export function hasAcknowledgedRoundReport(reportBoardId: string): boolean {
  if (reportBoardId.length === 0) return false;
  try {
    return globalThis.localStorage?.getItem(storageKey(reportBoardId)) === "1";
  } catch {
    return false;
  }
}

export function acknowledgeRoundReport(reportBoardId: string): void {
  if (reportBoardId.length === 0) return;
  try {
    globalThis.localStorage?.setItem(storageKey(reportBoardId), "1");
  } catch {
    return;
  }
}
