import type {
  LedgerEntry,
  NoveltyJudgmentEvidence,
  NoveltyLedger,
  Stage2NoveltyJudgment,
} from "@rennet/protocol";

export interface NoveltyClassificationChange {
  readonly entryKey: string;
  readonly previous: LedgerEntry;
  readonly current: LedgerEntry;
}

export function noveltyEntryKey(entry: LedgerEntry): string {
  const { unit } = entry;
  return JSON.stringify([
    unit.kind,
    unit.path,
    unit.previousPath ?? "",
    unit.symbol ?? "",
    unit.repoRecordId ?? "",
    unit.oldOid ?? "",
    unit.newOid ?? "",
    unit.fileStatus,
  ]);
}

export function diffNoveltyClassifications(
  previous: NoveltyLedger,
  current: NoveltyLedger,
): readonly NoveltyClassificationChange[] {
  const oldEntries = new Map(previous.entries.map((entry) => [noveltyEntryKey(entry), entry]));
  return current.entries.flatMap((entry) => {
    const prior = oldEntries.get(noveltyEntryKey(entry));
    return prior && prior.classification !== entry.classification
      ? [{ entryKey: noveltyEntryKey(entry), previous: prior, current: entry }]
      : [];
  });
}

export interface NoveltyFeedInput {
  readonly baseline: readonly string[];
  readonly primer: string;
  readonly knowledge?: readonly string[];
  readonly diffPack: string;
  readonly novelty: string;
}

export function composeNoveltyFeed(input: NoveltyFeedInput): string {
  return [
    ...input.baseline.map((part) => `BASELINE\n${part}`),
    `PRIMER\n${input.primer}`,
    ...(input.knowledge ?? []).map((part) => `KNOWLEDGE\n${part}`),
    `DIFF\n${input.diffPack}`,
    `NOVELTY\n${input.novelty}`,
  ].join("\n\n");
}

export type NoveltyJudgmentValidation =
  | { readonly ok: true; readonly judgment: Stage2NoveltyJudgment }
  | { readonly ok: false; readonly reason: string };

export type NoveltyEvidenceResolver = (evidence: NoveltyJudgmentEvidence) => boolean;

export function validateStage2NoveltyJudgment(
  value: unknown,
  resolvesEvidence?: NoveltyEvidenceResolver,
): NoveltyJudgmentValidation {
  if (!value || typeof value !== "object")
    return { ok: false, reason: "judgment must be an object" };
  const judgment = value as Record<string, unknown>;
  if (judgment.status !== "finding" && judgment.status !== "hypothesis") {
    return { ok: false, reason: "status must be finding or hypothesis" };
  }
  if (typeof judgment.entryKey !== "string" || judgment.entryKey.length === 0) {
    return { ok: false, reason: "entryKey is required" };
  }
  if (!(["novel", "extends", "conforms"] as unknown[]).includes(judgment.classification)) {
    return { ok: false, reason: "classification is invalid" };
  }
  if (typeof judgment.rationale !== "string" || judgment.rationale.length === 0) {
    return { ok: false, reason: "rationale is required" };
  }
  const evidence = judgment.evidence;
  if (judgment.status === "finding" && (!Array.isArray(evidence) || evidence.length === 0)) {
    return { ok: false, reason: "a finding must cite evidence" };
  }
  if (evidence !== undefined && (!Array.isArray(evidence) || !evidence.every(validEvidence))) {
    return { ok: false, reason: "evidence is invalid" };
  }
  if (
    judgment.status === "finding" &&
    (!resolvesEvidence ||
      !(evidence as readonly NoveltyJudgmentEvidence[])?.every(resolvesEvidence))
  ) {
    return { ok: false, reason: "a finding must cite resolvable evidence" };
  }
  return { ok: true, judgment: value as Stage2NoveltyJudgment };
}

function validEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Record<string, unknown>;
  return evidence.kind === "snapshot-shard"
    ? typeof evidence.projectSnapshotId === "string" &&
        evidence.projectSnapshotId.length > 0 &&
        typeof evidence.shardRef === "string" &&
        evidence.shardRef.length > 0
    : evidence.kind === "knowledge" &&
        typeof evidence.statementId === "string" &&
        evidence.statementId.length > 0;
}

export interface NoveltyLifecycleState {
  readonly ledger: NoveltyLedger;
  readonly judgments: ReadonlyMap<string, Stage2NoveltyJudgment>;
}

export interface NoveltyAdvance {
  readonly next: NoveltyLifecycleState;
  readonly changed: readonly NoveltyClassificationChange[];
  readonly pendingEntryKeys: readonly string[];
}

/** Advance deterministic state while retaining prior Stage-2 output until replacement succeeds. */
export function advanceNoveltyLifecycle(
  state: NoveltyLifecycleState,
  ledger: NoveltyLedger,
): NoveltyAdvance {
  const changed = diffNoveltyClassifications(state.ledger, ledger);
  return {
    next: { ledger, judgments: state.judgments },
    changed,
    pendingEntryKeys: changed.map((entry) => entry.entryKey),
  };
}

export function applyNoveltyRegeneration(
  state: NoveltyLifecycleState,
  replacements: ReadonlyMap<string, Stage2NoveltyJudgment>,
): NoveltyLifecycleState {
  const judgments = new Map(state.judgments);
  for (const [key, judgment] of replacements) judgments.set(key, judgment);
  return { ...state, judgments };
}
