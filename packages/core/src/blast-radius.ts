import type { BlastRadiusPaint, BlastRadiusSignal, OwnershipRule, PatchFile } from "@rennet/types";

// ── Blast-radius signal producer (issue #35) ─────────────────────────────────
//
// Deterministic, model-free. It reads the changeset (and CODEOWNERS ownership)
// and marks what carries risk, one line of explanation per mark. Blast radius is
// PAINT (Rule Zero): this computes DATA the overlay renders amber; it never gates
// an action, never reorders what the reviewer sees, and never withholds a
// capability. A blast-radius mark is a claim about danger, so every signal is
// explicit about what it can and cannot see, and the two deferred signals
// (`fan-in`, `contract-surface`) are emitted as visibly NOT ASSESSED rather than
// left silently absent — otherwise "no amber" would read as "checked and clear".
//
// First slice: `deletions`, `irreversibility`, `codeowners`, `safety-net` — the
// four that need only the changeset and ownership. `fan-in` waits on the #200
// reference index being confirmed populated in a real snapshot; `contract-surface`
// waits on exported-API extraction. Never churn-heat: the enum has no such member.

/** The inputs a blast-radius computation reads — the changeset and CODEOWNERS. */
export interface BlastRadiusInput {
  readonly files: readonly PatchFile[];
  /** CODEOWNERS rules in file order (last match wins, git semantics). */
  readonly ownership: readonly OwnershipRule[];
}

/** The added (post-image) content of a patch — the `+` hunk lines, header excluded. */
function addedLines(file: PatchFile): string {
  return file.patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++ "))
    .map((line) => line.slice(1))
    .join("\n");
}

/** A repo-relative path that is a test file. */
function isTestPath(path: string): boolean {
  return /(?:^|\/)__tests__\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

const IRREVERSIBLE_PATH =
  /(?:^|\/)migrations?\/|(?:^|\/)migrate\/|\.sql$|(?:^|\/)schema\.(?:prisma|sql)$/i;
const DESTRUCTIVE_SQL =
  /\b(?:DROP\s+(?:TABLE|COLUMN|DATABASE|SCHEMA|INDEX)|TRUNCATE\s+TABLE|DELETE\s+FROM|ALTER\s+TABLE\s+\w+\s+DROP)\b/i;
const CI_PATH =
  /(?:^|\/)\.github\/workflows\/|(?:^|\/)\.gitlab-ci\.ya?ml$|(?:^|\/)Jenkinsfile$|(?:^|\/)\.circleci\//;
const SECURITY_HINT =
  /\b(auth|authn|authz|security|session|token|crypto|password|login|permission|rbac|acl)\b/i;
const LINT_DISABLE = /\b(?:eslint-disable|biome-ignore)\b|@ts-(?:ignore|nocheck|expect-error)\b/;
const TEST_SKIP = /\b(?:it|test|describe)\.(?:skip|only)\b|\bx(?:it|describe)\s*\(/;
const MOCK_CALL = /\b(?:vi|jest)\.mock\s*\(/;

/**
 * Convert a CODEOWNERS/gitignore-style pattern to a path regex. `/` anchors to the
 * repo root, otherwise the pattern may match at any depth; the body is also treated
 * as a directory prefix (so it covers files beneath it); `**` crosses separators,
 * `*` stays within a segment. Pragmatic, not a full gitignore engine — enough for
 * the CODEOWNERS shapes that occur in practice, and the honest scope is stated on
 * the signal. `**`/`*` are expanded in ONE pass so no placeholder byte is needed.
 */
function codeownersRegExp(pattern: string): RegExp {
  let body = pattern.trim();
  const anchored = body.startsWith("/");
  if (anchored) body = body.slice(1);
  if (body.endsWith("/")) body = body.slice(0, -1);
  const escaped = body
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*|\*/g, (match) => (match === "**" ? ".*" : "[^/]*"));
  const prefix = anchored ? "^" : "(?:^|/)";
  // The body must be followed by end-of-path OR a separator, so a directory
  // pattern covers the files under it.
  return new RegExp(`${prefix}${escaped}(?:$|/)`);
}

/** Owners of a path: the LAST matching CODEOWNERS rule wins (git semantics). */
function resolveOwners(path: string, rules: readonly OwnershipRule[]): readonly string[] {
  let owners: readonly string[] = [];
  for (const rule of rules) {
    if (codeownersRegExp(rule.pattern).test(path)) owners = rule.owners;
  }
  return owners;
}

function filePaint(signal: BlastRadiusSignal, path: string, reason: string): BlastRadiusPaint {
  return { target: `rennet:file/${path}`, signal, reason, assessed: true };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Compute the blast-radius overlay for a changeset. Pure and deterministic; the
 * result is sorted for byte-stable canvas replay. Each returned paint carries the
 * signal, a one-line reason, and `assessed` (false only for the deferred signals).
 */
export function computeBlastRadius(input: BlastRadiusInput): BlastRadiusPaint[] {
  const paint: BlastRadiusPaint[] = [];

  // 1. DELETIONS — a removed file: anything importing it breaks. Deterministic.
  for (const file of input.files) {
    if (file.status === "deleted") {
      const lines = file.deletions != null ? ` (${file.deletions} lines)` : "";
      paint.push(
        filePaint("deletions", file.path, `File deleted${lines}; anything importing it breaks.`),
      );
    }
  }

  // 2. IRREVERSIBILITY — migration/schema paths, or a destructive SQL statement in
  //    the added lines. Honest scope: path + added-text heuristics, not execution.
  for (const file of input.files) {
    if (IRREVERSIBLE_PATH.test(file.path)) {
      paint.push(
        filePaint(
          "irreversibility",
          file.path,
          "Migration/schema path — hard to roll back once applied.",
        ),
      );
    } else if (DESTRUCTIVE_SQL.test(addedLines(file))) {
      paint.push(
        filePaint(
          "irreversibility",
          file.path,
          "Adds a destructive statement (DROP/DELETE/TRUNCATE).",
        ),
      );
    }
  }

  // 3. CODEOWNERS OVERLAP — the change spans more than one owner group. Honest
  //    scope: only as good as the CODEOWNERS file; an unowned path contributes no
  //    signal (not a claim that it is safe).
  const ownerByFile = new Map<string, readonly string[]>();
  const distinctOwners = new Set<string>();
  for (const file of input.files) {
    const owners = resolveOwners(file.path, input.ownership);
    if (owners.length > 0) {
      ownerByFile.set(file.path, owners);
      for (const owner of owners) distinctOwners.add(owner);
    }
  }
  if (distinctOwners.size >= 2) {
    for (const [path, owners] of ownerByFile) {
      paint.push(
        filePaint(
          "codeowners",
          path,
          `Owned by ${owners.join(", ")}; change spans ${distinctOwners.size} code-owner groups.`,
        ),
      );
    }
  }

  // 4. SAFETY-NET — changes that weaken the checks that would have caught a
  //    regression. One paint per file, reasons joined. Honest scope: pattern-based
  //    on paths + added lines (regex, not a parse), so it sees the common shapes
  //    and can miss a cleverly-disguised one.
  for (const file of input.files) {
    const added = addedLines(file);
    const reasons: string[] = [];
    if (file.status === "deleted" && isTestPath(file.path)) reasons.push("deletes a test file");
    if (TEST_SKIP.test(added)) reasons.push("skips or narrows tests (.skip/.only/xit)");
    if (MOCK_CALL.test(added) && (SECURITY_HINT.test(file.path) || SECURITY_HINT.test(added))) {
      reasons.push("adds a mock on a security/auth path");
    }
    if (CI_PATH.test(file.path)) reasons.push("changes CI configuration");
    if (LINT_DISABLE.test(added)) reasons.push("disables a linter or type check");
    if (reasons.length > 0) {
      paint.push(
        filePaint("safety-net", file.path, `Weakens the safety net: ${reasons.join("; ")}.`),
      );
    }
  }

  // DEFERRED — surfaced as NOT ASSESSED so their absence never reads as "clear".
  paint.push({
    target: "rennet:review/blast-radius",
    signal: "fan-in",
    assessed: false,
    reason:
      "Fan-in not assessed — the identifier-occurrence reference index (#200) is not wired into this overlay yet.",
  });
  paint.push({
    target: "rennet:review/blast-radius",
    signal: "contract-surface",
    assessed: false,
    reason: "Contract surface not assessed — exported-API impact is not computed in this slice.",
  });

  // Deterministic order for byte-stable replay (tuple compare, no delimiter).
  return paint.sort(
    (left, right) =>
      compareStrings(left.target, right.target) ||
      compareStrings(left.signal ?? "", right.signal ?? "") ||
      compareStrings(left.reason ?? "", right.reason ?? ""),
  );
}
