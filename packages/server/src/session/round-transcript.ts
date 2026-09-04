import type { RoundOperation, SessionTranscriptRow } from "@rennet/protocol";

function targetLabel(operation: RoundOperation): string {
  return operation.sourceTarget.kind === "branch"
    ? `branch \`${operation.sourceTarget.branch}\``
    : `detached head \`${operation.sourceTarget.head.slice(0, 12)}\``;
}

export function roundDispatchTranscriptRow(operation: RoundOperation): SessionTranscriptRow {
  return {
    kind: "turn",
    id: `round:${operation.dispatchId}:dispatch`,
    speaker: "user",
    status: "complete",
    paragraphs: ["Dispatch it."],
    time: new Date(operation.createdAt).toISOString(),
  };
}

export function roundReturnTranscriptRow(
  operation: RoundOperation,
): SessionTranscriptRow | undefined {
  if (operation.state.phase !== "completed") return undefined;
  const state = operation.state;
  const askCount = operation.askOccurrences.length;
  const commits = `${state.commits.count} commit${state.commits.count === 1 ? "" : "s"}`;
  const result =
    state.result.kind === "changed"
      ? `The report was verified as generation \`${state.result.report.generation}\`.`
      : "The round measured no code changes, so no successor report was drafted.";
  return {
    kind: "turn",
    id: `round:${operation.dispatchId}:return`,
    speaker: "orchestrator",
    status: "complete",
    lead: `Round ${operation.roundNumber} is back`,
    paragraphs: [
      `Round ${operation.roundNumber} is back — ${targetLabel(operation)}, ${askCount} ask${askCount === 1 ? "" : "s"}, ${commits}. ${result}`,
    ],
    time: new Date(state.completedAt).toISOString(),
  };
}
