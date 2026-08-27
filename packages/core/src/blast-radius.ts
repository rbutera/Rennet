import type { BlastRadiusSignal, OwnershipRule, PatchFile } from "@rennet/protocol";

/**
 * A single amber blast-radius paint, targeting an element or anchor. Local shape —
 * protocol's `BlastRadiusPaint` (a canvas-overlay type) was deleted (#489, B2); this
 * deterministic producer survives standalone for the B-series to re-home. `assessed:
 * false` marks a signal that was NOT computed (rendered "not assessed", never silently
 * absent, so no-amber never reads as no-risk).
 */
export interface BlastRadiusPaint {
  target: string;
  docId?: string;
  signal?: BlastRadiusSignal;
  reason?: string;
  assessed?: boolean;
}

// ── Blast-radius signal producer (issue #35) ─────────────────────────────────
//
// Deterministic, model-free. It reads the changeset (and CODEOWNERS ownership)
// and marks what carries risk, one line of explanation per mark. Blast radius is
// PAINT (Rule Zero): this computes DATA the overlay renders amber; it never gates
// an action, never reorders what the reviewer sees, and never withholds a
// capability. A blast-radius mark is a claim about danger, so every signal is
// explicit about what it can and cannot see, and a signal that cannot be computed
// is emitted as visibly NOT ASSESSED rather than left silently absent — otherwise
// "no amber" would read as "checked and clear".
//
// Signals: `deletions`, `irreversibility`, `codeowners`, `safety-net` compute from the
// changeset + ownership. `fan-in` (#200) computes dependent counts when the reference
// index is supplied (per-file), and stays NOT ASSESSED when it is not — never a silent
// zero. `contract-surface` waits on exported-API extraction and stays NOT ASSESSED.
// Never churn-heat: the enum has no such member.

/**
 * The identifier-occurrence lookups the FAN-IN signal needs (issue #200 → #35 follow-on).
 * Two pure reads over the project snapshot's symbol + reference indices, injected so the
 * producer stays pure and node-free (the composition root builds this from a LoadedSnapshot).
 *
 * ⭐ Providing this at all is the ASSESSED signal: the composition supplies it ONLY when
 * the reference index is genuinely POPULATED. When it is absent, fan-in stays a NOT-ASSESSED
 * chip — never a silent zero. A zero-dependents result must mean "we checked and nothing
 * depends on this", provable, not "the index was missing" (the whole point of the overlay:
 * unmeasured must look unmeasured, not clean).
 */
export interface FanInIndex {
  /** Symbol names DEFINED in the given changed file (its exports/declarations). */
  definedSymbols(path: string): readonly string[];
  /** Repo-relative paths that REFERENCE the given identifier name (its occurrence sites' files). */
  referencingFiles(name: string): readonly string[];
}

/** The inputs a blast-radius computation reads — the changeset, CODEOWNERS, and (optional) fan-in index. */
export interface BlastRadiusInput {
  readonly files: readonly PatchFile[];
  /** CODEOWNERS rules in file order (last match wins, git semantics). */
  readonly ownership: readonly OwnershipRule[];
  /**
   * The fan-in index (#200). Present ⇒ fan-in is ASSESSED (per-file dependent counts);
   * absent ⇒ fan-in stays a NOT-ASSESSED chip. The composition supplies it only when the
   * reference index is populated, so absence is honest, never a masked empty.
   */
  readonly fanIn?: FanInIndex;
}

/** The added (post-image) content of a patch — the `+` hunk lines, header excluded. */
function addedLines(file: PatchFile): string {
  return file.patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++ "))
    .map((line) => line.slice(1))
    .join("\n");
}

/** True when the patch REMOVES at least one line (a `-` hunk line, header excluded). */
function hasRemovedLines(file: PatchFile): boolean {
  return file.patch.split("\n").some((line) => line.startsWith("-") && !line.startsWith("--- "));
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
// The ts-expect-error directive is DELIBERATELY excluded: unlike ts-ignore /
// ts-nocheck (which silence a check), it ASSERTS an error must exist and FAILS if
// the error goes away — the opposite of weakening the safety net, so it must not be
// counted. (Written without the leading "@" so biome's noTsIgnore does not rewrite
// this prose into a live directive.)
const LINT_DISABLE = /\b(?:eslint-disable|biome-ignore)\b|@ts-(?:ignore|nocheck)\b/;
const TEST_SKIP = /\b(?:it|test|describe)\.(?:skip|only)\b|\bx(?:it|describe)\s*\(/;
// A `vi.mock(...)`/`jest.mock(...)` call, capturing the mocked module SPECIFIER —
// the security match binds to THIS, not to the whole added text, so an unrelated
// security word elsewhere in the hunk (a `token` local beside a `vi.mock('../format')`)
// can never render as "a mock on a security/auth path".
const MOCK_SPECIFIER = /\b(?:vi|jest)\.mock\s*\(\s*['"]([^'"]+)['"]/g;
const MOCK_CALL = /\b(?:vi|jest)\.mock\s*\(/;

/** True when the added text contains any `vi.mock`/`jest.mock` call. */
function hasMock(added: string): boolean {
  return MOCK_CALL.test(added);
}

/** True when the added text mocks a module whose SPECIFIER looks security-related. */
function mocksSecurityModule(added: string): boolean {
  for (const match of added.matchAll(MOCK_SPECIFIER)) {
    const specifier = match[1];
    if (specifier && SECURITY_HINT.test(specifier)) return true;
  }
  return false;
}

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
    // Escape every regex metacharacter that is NOT a glob wildcard this function
    // translates. `?` is escaped as a LITERAL (issue #279): this is a minimal `*`/`**`
    // translator, not a full gitignore engine, so a `?` in a CODEOWNERS path must
    // compile to a literal `?` — never a regex quantifier that would match the wrong
    // files and show a reviewer the wrong owning teams.
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
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
    } else if (file.status === "renamed" && file.previousPath && file.previousPath !== file.path) {
      // A rename removes the OLD path (neighbour case, probed): importers of the
      // old path break exactly as for a deletion. Painted on the NEW path (a
      // visible element), naming the old path so the reviewer checks its importers.
      paint.push(
        filePaint(
          "deletions",
          file.path,
          `Renamed from ${file.previousPath}; importers of the old path must be updated.`,
        ),
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
    // Resolve the new path AND, for a rename, the OLD path (neighbour case,
    // probed): a file renamed across an ownership boundary touches BOTH owner
    // groups, so counting only the new path would undercount the overlap.
    const owners = new Set<string>(resolveOwners(file.path, input.ownership));
    if (file.status === "renamed" && file.previousPath && file.previousPath !== file.path) {
      for (const owner of resolveOwners(file.previousPath, input.ownership)) owners.add(owner);
    }
    if (owners.size > 0) {
      ownerByFile.set(file.path, [...owners]);
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
    // Fire only for a mock whose target is security-related: the mocked module
    // specifier looks like a security path, OR the file adding the mock is itself
    // one. Never on a security word that merely co-occurs elsewhere in the hunk.
    if (mocksSecurityModule(added) || (hasMock(added) && SECURITY_HINT.test(file.path))) {
      reasons.push("adds a mock on a security/auth path");
    }
    // A CI change weakens the safety net only when it REMOVES content (issue #278): a
    // purely additive CI change ADDS coverage, which strengthens the net, so it must not
    // read as weakening. The wording is derived from what was matched — CI lines removed,
    // not merely "CI changed".
    // A CI change weakens the safety net only when it REMOVES content (issue #278): a
    // purely additive CI change ADDS coverage, which strengthens the net, so it must not
    // read as weakening. The wording is derived from what was matched — CI lines removed,
    // not merely "CI changed".
    if (CI_PATH.test(file.path) && hasRemovedLines(file)) reasons.push("removes CI configuration");
    if (LINT_DISABLE.test(added)) reasons.push("disables a linter or type check");
    if (reasons.length > 0) {
      paint.push(
        filePaint("safety-net", file.path, `Weakens the safety net: ${reasons.join("; ")}.`),
      );
    }
  }

  // 5. FAN-IN (#200 → #35 follow-on) — how many OTHER files depend on each changed file,
  //    counted from the snapshot's symbol + reference indices. ASSESSED only when the index
  //    is supplied (the composition supplies it only when populated); otherwise a NOT-
  //    ASSESSED chip, never a silent zero. A changed file with zero dependents gets no
  //    paint — "checked, nothing depends on it" — exactly like the other per-file signals.
  if (input.fanIn) {
    const fanIn = input.fanIn;
    for (const file of input.files) {
      const dependents = new Set<string>();
      for (const name of fanIn.definedSymbols(file.path)) {
        for (const referencingPath of fanIn.referencingFiles(name)) {
          if (referencingPath !== file.path) dependents.add(referencingPath);
        }
      }
      if (dependents.size > 0) {
        const n = dependents.size;
        paint.push(
          filePaint(
            "fan-in",
            file.path,
            `${n} file${n === 1 ? "" : "s"} reference this file's symbols; changes here ripple to them.`,
          ),
        );
      }
    }
    // ASSESSED — emitted WHENEVER the index is supplied, independent of whether any
    // per-file paint fired. Without this, a review where every changed file has zero
    // dependents produces NO fan-in entry at all — structurally identical to a review
    // where this producer never ran. That collapse is the thing the whole overlay
    // exists to prevent one layer out: absence-of-index is already a distinct NOT-
    // ASSESSED chip (below), but "assessed, zero dependents" was mere silence. A
    // consumer (another lens, an export, a telemetry counter) must be able to read
    // "fan-in WAS computed" as a positive fact, never infer it from what is not there.
    // Review-scoped target ⇒ paints no chunk and shows no chip (canvas/logic.ts); it
    // is a data-level statement of assessment, not a mark on the surface.
    paint.push({
      target: "rennet:review/blast-radius",
      signal: "fan-in",
      assessed: true,
      reason: "Fan-in assessed from the identifier-occurrence reference index (#200).",
    });
  } else {
    // DEFERRED — surfaced as NOT ASSESSED so its absence never reads as "clear".
    paint.push({
      target: "rennet:review/blast-radius",
      signal: "fan-in",
      assessed: false,
      reason:
        "Fan-in not assessed — the identifier-occurrence reference index (#200) is not available for this review.",
    });
  }
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
