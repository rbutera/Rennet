import type { CouncilHarnessId } from "@rennet/protocol";

export const DEFAULT_SEAT_LABELS: Readonly<Record<CouncilHarnessId, string>> = {
  "claude-code": "Claude",
  codex: "Codex",
};

export const DEFAULT_CODEX_SECOND_SEAT_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_SECOND_SEAT_EFFORT = "high";
