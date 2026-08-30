import { ROUND_NO_REGEN, type RoundRecord } from "@rennet/protocol";

/** Keep a report-regeneration retry on the placeholder row it is completing. */
export function roundNumberForDispatch(
  records: readonly RoundRecord[],
  dispatchId: string,
): number {
  const pending = records.findIndex(
    (record) =>
      record.outcome === "completed" &&
      record.boardGeneration === ROUND_NO_REGEN &&
      record.regeneration === "pending" &&
      record.dispatchId === dispatchId,
  );
  return pending < 0 ? records.length + 1 : pending + 1;
}
