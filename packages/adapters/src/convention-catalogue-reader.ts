import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConventionCatalogue, ConventionRule, FindingSeverity } from "@rennet/protocol";
import { findingSeveritySchema } from "@rennet/protocol";

/**
 * The per-project convention / anti-pattern catalogue reader (issue #180).
 *
 * Florence's /review-pr agents carry an injected anti-pattern + convention
 * checklist; Rennet's lens runners did not. This adapter sources that catalogue
 * from an OPTIONAL per-project file so the runners can be fed it as a checklist
 * layer (the pure `renderConventionLayer` in `@rennet/prompts`, threaded
 * through `runFindingAngle` / `runDecisionAngle` / `runNoiseAngle`). File I/O
 * lives HERE, at the adapter boundary, so `@rennet/core` stays pure — the model
 * boundary the codebase holds to.
 *
 * The single load-bearing behaviour is HONEST DEGRADATION: an absent file, an
 * unreadable/garbled file, an empty catalogue, or one whose rules are all
 * malformed all resolve to NO catalogue (a typed `reason`), never a throw and
 * never a fabricated rule. A caller threads the catalogue only when at least one
 * valid rule was found; otherwise the runners assemble byte-identically to
 * before. Malformed rules are dropped ITEMWISE (a single bad rule never sinks the
 * valid ones) and counted, mirroring the finding runner's grounded-cull spirit.
 */

/** The per-project catalogue file, relative to the repository root. */
export const CONVENTIONS_FILE = ".rennet/conventions.json";

/**
 * The typed reason no catalogue was produced. `absent` — the file does not exist
 * (the common case, a project with no catalogue). `unreadable` — the file exists
 * but could not be read or parsed as JSON. `empty` — parsed, but no rules array /
 * an empty one. `no-valid-rules` — rules were present but every one was malformed.
 */
export type ConventionLoadReason = "absent" | "unreadable" | "empty" | "no-valid-rules";

export interface ConventionCatalogueLoad {
  /** The catalogue, present only when at least one valid rule was found. */
  readonly catalogue?: ConventionCatalogue;
  /** Why no catalogue was produced; absent when `catalogue` is present. */
  readonly reason?: ConventionLoadReason;
  /** How many rules were dropped as malformed (itemwise degradation). */
  readonly dropped: number;
}

/** True iff `value` is a non-empty (after trim) string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate one raw rule into a {@link ConventionRule}, or return `undefined` when
 * it is malformed (missing/blank convention or rationale, or an out-of-vocabulary
 * severity). `id` and `antiPattern` are optional; a blank one is simply dropped.
 */
function parseRule(raw: unknown): ConventionRule | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (!isNonEmptyString(record.convention) || !isNonEmptyString(record.rationale)) {
    return undefined;
  }
  const severity = findingSeveritySchema.safeParse(record.severity);
  if (!severity.success) return undefined;
  const rule: {
    id?: string;
    convention: string;
    rationale: string;
    severity: FindingSeverity;
    antiPattern?: string;
  } = {
    convention: record.convention.trim(),
    rationale: record.rationale.trim(),
    severity: severity.data,
  };
  if (isNonEmptyString(record.id)) rule.id = record.id.trim();
  if (isNonEmptyString(record.antiPattern)) rule.antiPattern = record.antiPattern.trim();
  return rule;
}

/** Extract the raw rules array from either `{ rules: [...] }` or a bare `[...]`. */
function rawRulesOf(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const rules = (parsed as { rules?: unknown }).rules;
    if (Array.isArray(rules)) return rules;
  }
  return undefined;
}

/**
 * Load the per-project convention catalogue from `<projectRoot>/.rennet/conventions.json`.
 * Never throws: every failure is a typed {@link ConventionLoadReason} and no
 * catalogue. When rules are present, they are validated itemwise; the catalogue is
 * returned iff at least one rule survives, with `source` set to the file path for
 * provenance. The accepted on-disk shape is `{ rules: [...], source? }` or a bare
 * array of rules.
 */
export function loadConventionCatalogue(projectRoot: string): ConventionCatalogueLoad {
  const path = join(projectRoot, CONVENTIONS_FILE);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // ENOENT is the common "no catalogue" case; any other read error is a real
    // failure to read a file that does exist — both degrade to no catalogue.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { reason: code === "ENOENT" ? "absent" : "unreadable", dropped: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: "unreadable", dropped: 0 };
  }

  const rawRules = rawRulesOf(parsed);
  if (rawRules === undefined || rawRules.length === 0) {
    return { reason: "empty", dropped: 0 };
  }

  const rules: ConventionRule[] = [];
  let dropped = 0;
  for (const item of rawRules) {
    const rule = parseRule(item);
    if (rule === undefined) {
      dropped += 1;
      continue;
    }
    rules.push(rule);
  }

  if (rules.length === 0) {
    return { reason: "no-valid-rules", dropped };
  }

  const source =
    typeof parsed === "object" &&
    parsed !== null &&
    isNonEmptyString((parsed as { source?: unknown }).source)
      ? (parsed as { source: string }).source.trim()
      : path;
  return { catalogue: { rules, source }, dropped };
}

/** The file's top-level fields OTHER than `rules` — `source` and anything else an
 *  author put there. Read raw so a write preserves the envelope it did not author;
 *  a bare-array or unreadable file has no envelope to keep. */
function readEnvelope(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const envelope = { ...(parsed as Record<string, unknown>) };
    delete envelope.rules;
    return envelope;
  } catch {
    return {};
  }
}

/**
 * Write the per-project catalogue back to `<projectRoot>/.rennet/conventions.json`
 * (C18 group A) — the WRITER beside the reader, so the Guidance section's edits are
 * kept in the same file the lens runners read before every review. Atomic (temp file
 * + rename), so a crash mid-write never leaves a half-catalogue the reader would
 * degrade on. Throws when the file cannot be written; the caller reports that rather
 * than claiming a save that did not happen.
 *
 * NOTHING the edit did not author is lost. A rule is addressed by its stable `id`
 * where it has one, so RETYPING a rule's statement still keeps its rationale, its
 * anti-pattern and its id (matching on the mutable text alone silently dropped all
 * three); a rule with no id falls back to matching on its unchanged text. The file's
 * top-level envelope — `source`, and any field an author added — is preserved too.
 *
 * The settings surface authors only a statement and a severity, and the reader
 * REQUIRES a rationale (#180: a rule with none is dropped as malformed), so a NEWLY
 * authored rule takes its own statement as its reason. Nothing is invented on the
 * author's behalf.
 */
export function saveConventionCatalogue(
  projectRoot: string,
  rules: readonly {
    readonly id?: string;
    readonly convention: string;
    readonly severity: FindingSeverity;
  }[],
): ConventionCatalogueLoad {
  const path = join(projectRoot, CONVENTIONS_FILE);
  const current = loadConventionCatalogue(projectRoot).catalogue?.rules ?? [];
  const byId = new Map(current.filter((rule) => rule.id).map((rule) => [rule.id, rule]));
  const byText = new Map(current.map((rule) => [rule.convention, rule]));
  const next: ConventionRule[] = rules
    .filter((rule) => isNonEmptyString(rule.convention))
    .map((rule) => {
      const convention = rule.convention.trim();
      // Identity first, text only as the fallback for a rule that never had an id.
      const kept = (rule.id ? byId.get(rule.id) : undefined) ?? byText.get(convention);
      return {
        ...((kept?.id ?? rule.id) ? { id: kept?.id ?? rule.id } : {}),
        convention,
        rationale: kept?.rationale ?? convention,
        severity: rule.severity,
        ...(kept?.antiPattern ? { antiPattern: kept.antiPattern } : {}),
      };
    });
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ ...readEnvelope(path), rules: next }, null, 2)}\n`);
  renameSync(tmp, path);
  // Read back through the reader, so the caller renders what the FILE now holds —
  // never the request echoed as if it had been stored.
  return loadConventionCatalogue(projectRoot);
}
