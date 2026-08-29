/**
 * Board lint — the structural gate of the draft validation loop (#493, B08).
 *
 * `lint(draft, ctx) => Violation[]` is a pure function: no model, no I/O, no
 * Node. It rejects what is *false* about a draft board's structure — code bytes
 * in prose, unresolvable citations, boilerplate skip reasons, machinery
 * vocabulary in structural fields — so the drafter gets a scoped, deterministic
 * re-ask (the retry channel is cluster 3). It deliberately owns NO prose-quality
 * or slop-vocabulary judgment; that is the post-process editor's lane (#493 §5).
 *
 * Consumes the B03-frozen `protocol/src/board` seam verbatim — `DraftBoard`,
 * `DraftElement`, `Violation` (`{ ruleId, elementRef, message }`) — and never
 * re-models it (reconciliation 2). The `ctx` is plain data the caller assembles
 * (patchset hunk list, side-specific file→line-count indices, the review lens);
 * assembling it is the cluster-5 runtime's job, not lint's.
 *
 * ── Reconciliation with #493's rule catalog (recorded in proposal.md ledger) ──
 * #493 was written against a RICHER imagined schema (a `finding.fix` field,
 * `finding.details`, `requirement.status`, drafter-authored section `counts`, a
 * `noise-group` kind, a `thread` kind). B03 froze a leaner 13-kind schema. So:
 *   - S1/S2-as-kind (no thread/message/`code` kind) are enforced STRUCTURALLY by
 *     `DraftBoardSchema` at parse time — `parseDraft` rejects an out-of-palette
 *     KIND with ZodError issues (see lint.test.ts). Code bytes inside a *legal*
 *     prose element are NOT a parse-time concern — the `no-code-bytes` lint rule
 *     below owns them.
 *   - L18 (cross-lens every-hunk coverage) runs at COMPOSITION → cluster 4.
 *   - L19 (typed-data immutability across post-process) is a POST-PASS assertion
 *     → cluster 3.
 *   - The residue — the per-draft rules whose fields DO exist — is implemented
 *     here. S6 (decision grounding) and S8 (citation range order) DO have frozen
 *     fields and are enforced; only S4/S5/S7 + L5/L6/L8 reference truly-absent
 *     fields and stay parked (see the ledger for each named field).
 */

import type { DraftBoard, DraftElement, HunkId, LensKind, Violation } from "@rennet/protocol";

// ── The lint context (plain data the caller assembles) ───────────────────────

/** The lint target: one of the five lens boards, or the round-report seat. */
export type LintTarget = LensKind | "report";

/**
 * One patchset hunk. Coverage and citation resolution are SIDE-AWARE: a
 * `side: "head"` code_ref resolves against the new image on {@link path}; a
 * `side: "base"` one resolves against the old image on {@link previousPath}
 * (its own line numbers). A pure addition has no old image (`oldLines === 0`)
 * and is teachable only from the head side; a pure deletion has no new image
 * (`newLines === 0`) and is teachable only from the base side — the geometry
 * finding 8 restores.
 */
export interface LintHunk {
  readonly id: HunkId;
  /** The head-side (post-image) path; a `side: "head"` code_ref resolves here. */
  readonly path: string;
  /** 1-based first line of the hunk's new image. */
  readonly newStart: number;
  /** Line count of the hunk's new image (`newStart .. newStart + newLines - 1`); 0 for a pure deletion. */
  readonly newLines: number;
  /** The base-side (pre-image) path; defaults to {@link path} when the file was not renamed. */
  readonly previousPath?: string;
  /** 1-based first line of the hunk's old image; a `side: "base"` code_ref resolves here. */
  readonly oldStart?: number;
  /** Line count of the hunk's old image (`oldStart .. oldStart + oldLines - 1`); 0 for a pure addition. */
  readonly oldLines?: number;
}

/** A code_ref reduced to what coverage/citation geometry needs: its side, path, and line span. */
export interface CodeRefSpan {
  readonly path: string;
  readonly side: "base" | "head";
  readonly start: number;
  readonly end: number;
}

/** Read a `code_ref` element's coverage span, or `undefined` if it is not a code_ref. */
export function readCodeRefSpan(el: DraftElement): CodeRefSpan | undefined {
  if (el.kind !== "code_ref") return undefined;
  const d = el.data as { path?: unknown; side?: unknown; start_line?: unknown; end_line?: unknown };
  const path = typeof d.path === "string" ? d.path : "";
  const side = d.side === "base" ? "base" : "head";
  const start = typeof d.start_line === "number" ? d.start_line : 0;
  const end = typeof d.end_line === "number" ? d.end_line : start;
  return { path, side, start, end };
}

/**
 * Does `ref` TEACH `hunk`? A base-side ref resolves against the old image and
 * the previous path (a pure addition, `oldLines === 0`, has no old image to
 * teach); a head-side ref resolves against the new image and the current path
 * (a pure deletion, `newLines === 0`, has no new image). A base-side citation
 * therefore can never falsely cover an addition, and a deletion-only hunk is
 * teachable only from the base side (finding 8).
 */
export function codeRefTeaches(ref: CodeRefSpan, hunk: LintHunk): boolean {
  if (ref.side === "base") {
    const oldStart = hunk.oldStart;
    const oldLines = hunk.oldLines;
    if (oldStart === undefined || oldLines === undefined || oldLines === 0) return false;
    if (ref.path !== (hunk.previousPath ?? hunk.path)) return false;
    const hEnd = oldStart + oldLines - 1;
    return ref.start <= hEnd && ref.end >= oldStart;
  }
  if (hunk.newLines === 0 || ref.path !== hunk.path) return false;
  const hEnd = hunk.newStart + hunk.newLines - 1;
  return ref.start <= hEnd && ref.end >= hunk.newStart;
}

/** The hunk ids a set of board elements TEACH (side-aware), across every code_ref among them. */
export function taughtHunkIds(
  elements: readonly DraftElement[],
  hunks: readonly LintHunk[],
): Set<string> {
  const taught = new Set<string>();
  for (const el of elements) {
    const ref = readCodeRefSpan(el);
    if (ref === undefined) continue;
    for (const h of hunks) if (codeRefTeaches(ref, h)) taught.add(h.id);
  }
  return taught;
}

/**
 * Lint input, per board. `files` maps a repo-relative path to its line count on
 * the HEAD (post-image) side at the review commit; `baseFiles`, when supplied,
 * is the BASE (pre-image) inventory a `side: "base"` `code_ref` resolves against
 * (S2 — a base-side citation checked against the head inventory is a false
 * pass/fail). `patchsetId`, when supplied, is the one patchset this board may
 * cite: a `code_ref` naming any other patchset is a cross-patchset leak.
 * `hunks` is the collation producer's hunk list (coverage rules);
 * `patchsetIdentifiers` is the R20 allowlist built from the changed files.
 */
export interface LintContext {
  readonly lens: LintTarget;
  readonly hunks: readonly LintHunk[];
  /** HEAD-side (post-image) path → line-count inventory. */
  readonly files: ReadonlyMap<string, number>;
  /** BASE-side (pre-image) inventory; `side: "base"` code_refs resolve here (S2). */
  readonly baseFiles?: ReadonlyMap<string, number>;
  /** The one patchset this board may cite; a code_ref on another is a leak (S2). */
  readonly patchsetId?: string;
  readonly scaffoldGlobs?: readonly string[];
  readonly patchsetIdentifiers?: ReadonlySet<string>;
  /** Source artifact text, when the caller supplies it — enables `requirement-verbatim`/`-order`. */
  readonly artifactText?: string;
  /**
   * Source-indexed artifact texts for a multi-file Design set. A requirement carrying
   * `data.source.path` is checked only against that exact reviewed artifact, so two
   * files cannot make one another's paraphrase or ordering check pass accidentally.
   */
  readonly artifacts?: readonly {
    readonly candidate?: string;
    readonly path: string;
    readonly text: string;
    readonly role?: string;
    readonly truncated?: boolean;
    readonly sourceBytes?: number;
  }[];
  /** Candidate identity and paths so one selected source set cannot absorb a neighbouring candidate. */
  readonly artifactCandidates?: readonly {
    readonly id: string;
    readonly paths: readonly string[];
    readonly relevance?: "changed-artifact" | "references-changed-path" | "repository-candidate";
  }[];
  readonly artifactBundleIncomplete?: boolean;
}

/**
 * Scaffold paths that belong to the Noise lens (R22). A Design/Sequence/etc.
 * board citing one is a lane violation. Overridable via `ctx.scaffoldGlobs`.
 */
export const DEFAULT_SCAFFOLD_GLOBS: readonly string[] = [
  "**/.openspec.yaml",
  "**/*.lock",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
];

/**
 * The typed domain kinds each target owns. Shared structural kinds (`prose`,
 * `section`, `callout`, `annotation`, `code_ref`) are legal everywhere; a typed
 * kind on the wrong board is a lane violation. Grounded in the lens prompts
 * (`packages/prompts`): the Design prompt renders BOTH requirement regions AND
 * the implementer's stated `decision` calls (a projection the Decisions board
 * shares), so Design admits `decision` + `requirement`; the Decisions prompt is
 * decision-only. The report seat's `round_outcome` is legal ONLY on the report
 * target and never on a lens board (S1).
 */
const SHARED_KINDS: ReadonlySet<string> = new Set([
  "prose",
  "section",
  "callout",
  "annotation",
  "code_ref",
]);
const LENS_TYPED_KINDS: Readonly<Record<LensKind, readonly string[]>> = {
  design: ["decision", "requirement"],
  sequence: ["order_step"],
  decisions: ["decision"],
  flagged: ["finding"],
  noise: ["noise_verdict"],
};
const REPORT_TYPED_KINDS: readonly string[] = ["round_outcome"];

/** The typed kinds the target authors (the report seat, or a named lens). */
function typedKindsFor(target: LintTarget): readonly string[] {
  return target === "report" ? REPORT_TYPED_KINDS : LENS_TYPED_KINDS[target];
}

// ── Field extraction (frozen-schema aware, one field-role table) ─────────────

interface Field {
  readonly elementId: string;
  readonly field: string;
  readonly text: string;
}

/**
 * Per-kind field roles (S5 — one table, no duplicated kind-switch). `prose` is
 * the longform lane (code-byte / dialogue / citation / remainder rules); a
 * kind's `decision.statement` sits in BOTH because a decision statement is both
 * longform prose and a short structural label. `structural` is the process-
 * vocabulary lane (R20): titles and short labels, never body prose (#493 §5:
 * lint can only reject a whole element, and a body cannot lose one machinery
 * sentence without content — that is the post-process editor's lane).
 */
const FIELD_ROLES: Readonly<
  Record<string, { prose: readonly string[]; structural: readonly string[] }>
> = {
  prose: { prose: ["markdown"], structural: [] },
  callout: { prose: ["body"], structural: ["variant"] },
  annotation: { prose: ["body"], structural: [] },
  finding: { prose: ["concern"], structural: [] },
  decision: { prose: ["statement", "why"], structural: ["statement"] },
  requirement: { prose: ["shall"], structural: [] },
  noise_verdict: { prose: ["reason"], structural: [] },
  round_outcome: { prose: ["note"], structural: [] },
  section: { prose: [], structural: ["title"] },
  order_step: { prose: [], structural: ["title"] },
};

function fieldsOf(el: DraftElement, role: "prose" | "structural"): Field[] {
  const roles = FIELD_ROLES[el.kind];
  if (roles === undefined) return [];
  const d = el.data as Record<string, unknown>;
  const out: Field[] = [];
  for (const field of roles[role]) {
    const v = d[field];
    if (typeof v === "string" && v.length > 0) out.push({ elementId: el.id, field, text: v });
  }
  return out;
}
const proseFields = (el: DraftElement): Field[] => fieldsOf(el, "prose");
const structuralFields = (el: DraftElement): Field[] => fieldsOf(el, "structural");

const ref = (elementId: string, field?: string): string =>
  field === undefined ? elementId : `${elementId}/${field}`;

// ── R20 exemptions: strip backtick spans + the patchset-identifier allowlist ──

/** Text with inline `code` spans blanked out — a backticked token is not narration. */
function withoutInlineCode(text: string): string {
  return text.replace(/`[^`]*`/g, " ");
}

/** Blank out the identifiers the changed files themselves define (R20 exemption 2). */
function screenPatchsetIdentifiers(text: string, ids: ReadonlySet<string> | undefined): string {
  if (ids === undefined) return text;
  let out = text;
  for (const id of ids) {
    if (id.length > 0) out = out.split(id).join(" ");
  }
  return out;
}

// ── Shared prose checks (board fields AND the review-draft register reuse) ────

/** Every `path:line(-line)?` citation mention in a prose string. */
const CITATION = /(`?)([\w./@-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;
/** The GitHub blob form `path#L12` / `path#L12-L15` — a bare basename or full path. */
const GITHUB_CITATION = /([\w./@-]+\.[A-Za-z0-9]+)#L\d+(?:-L?\d+)?/gi;

/** L3 — one prose string's citations are full repo-relative `path:line`. */
function checkCitationWellFormed(text: string, elementRef: string): Violation[] {
  const out: Violation[] = [];
  for (const m of text.matchAll(CITATION)) {
    const path = m[2] ?? "";
    const absolute = path.startsWith("/") || path.startsWith("~");
    const basenameOnly = !path.includes("/");
    if (absolute || basenameOnly) {
      out.push({
        ruleId: "citation-well-formed",
        elementRef,
        message: `R25/R26: cite \`${path}:${m[3]}\` as a repo-relative path:line — no leading / or ~, no bare basename.`,
      });
    }
  }
  // The GitHub `#L` form never carries a colon, so `CITATION` never sees it — screen it directly.
  for (const m of text.matchAll(GITHUB_CITATION)) {
    out.push({
      ruleId: "citation-well-formed",
      elementRef,
      message: `R25/R26: \`${m[0]}\` is a GitHub \`#L\` citation — cite a repo-relative \`path:line\` instead.`,
    });
  }
  return out;
}

/** L4/L8 — one prose string's `path:line` citations resolve (existence + range order). */
function checkCitationResolves(
  text: string,
  files: ReadonlyMap<string, number>,
  elementRef: string,
): Violation[] {
  const out: Violation[] = [];
  for (const m of text.matchAll(CITATION)) {
    const path = m[2] ?? "";
    // Malformed citations (absolute / bare basename) are L3's lane, not L4's.
    if (!path.includes("/") || path.startsWith("/") || path.startsWith("~")) continue;
    const start = Number(m[3]);
    const end = m[4] === undefined ? start : Number(m[4]);
    if (end < start) {
      out.push({
        ruleId: "citation-resolves",
        elementRef,
        message: `Citation \`${path}:${start}-${end}\` is inverted: the end line precedes the start.`,
      });
      continue;
    }
    const count = files.get(path);
    if (count === undefined) {
      out.push({
        ruleId: "citation-resolves",
        elementRef,
        message: `Citation \`${path}:${m[3]}\` does not resolve: no such file at the review commit.`,
      });
    } else if (start < 1 || end > count) {
      out.push({
        ruleId: "citation-resolves",
        elementRef,
        message: `Citation \`${path}:${m[3]}\` overruns the file (${count} lines).`,
      });
    }
  }
  return out;
}

const PROCESS_VOCAB =
  /\b(?:lens(?:es)?|boards?|agents?|seats?|drafts?|orchestrator|unslop|post-process|the review process|this review|the pipeline)\b/i;
/** L7 — one string screened for machinery vocabulary (R20), with the F2/F3 exemptions. */
function checkProcessVocab(
  text: string,
  ctx: Pick<LintContext, "patchsetIdentifiers">,
  elementRef: string,
  pattern: RegExp = PROCESS_VOCAB,
): Violation[] {
  const screened = screenPatchsetIdentifiers(withoutInlineCode(text), ctx.patchsetIdentifiers);
  return pattern.test(screened)
    ? [
        {
          ruleId: "process-vocabulary",
          elementRef,
          message:
            "R20: this names the machinery (lens/board/agent/seat/draft/…). Name the domain object, not the pipeline. Backtick a real identifier to exempt it.",
        },
      ]
    : [];
}

// ── The rules (each: pure, over one draft + ctx) ─────────────────────────────

type Rule = (draft: DraftBoard, ctx: LintContext) => Violation[];

const FENCE = /```/;
// ponytail: a run of ≥2 four-space-indented lines. A markdown list/paragraph
// continuation is also four-space-indented, so a deliberately-indented prose
// block can false-positive; the ceiling is acceptable because board prose is
// short and fenced blocks are the real target. Upgrade path: track list context.
const INDENTED_BLOCK = /^ {4,}\S.*(?:\r?\n {4,}\S.*)+/m;
/**
 * L1 — no fenced or indented code block in prose (R17/R26). A fence is three
 * backticks and an indented block is ≥2 lines; a single-backtick inline
 * identifier (R20-required) matches neither, so it is exempt by construction.
 */
const noCodeBytes: Rule = (draft) =>
  draft.elements.flatMap((el) =>
    proseFields(el).flatMap(({ elementId, field, text }) => {
      if (FENCE.test(text) || INDENTED_BLOCK.test(text)) {
        return [
          {
            ruleId: "no-code-bytes",
            elementRef: ref(elementId, field),
            message:
              "R17/R26: code on a board is a `code_ref`, not bytes in prose. Cite the patchset; single-backtick identifiers are fine.",
          },
        ];
      }
      return [];
    }),
  );

const DIALOGUE = /^\s*(?:\*\*)?(?:User|Reviewer|Orchestrator|Assistant|Agent|Q|A)(?:\*\*)?\s*:/gim;
/** L2 — no authored dialogue smuggled into a prose field (R17). Two-turn threshold. */
const noDialogue: Rule = (draft) =>
  draft.elements.flatMap((el) =>
    proseFields(el).flatMap(({ elementId, field, text }) => {
      const turns = text.match(DIALOGUE);
      if (turns !== null && turns.length >= 2) {
        return [
          {
            ruleId: "no-dialogue",
            elementRef: ref(elementId, field),
            message:
              "R17: authored dialogue does not belong in prose — the thread/message kinds are curation-only, never a drafter's.",
          },
        ];
      }
      return [];
    }),
  );

/** L3 — prose citations are full repo-relative `path:line`, never absolute/GitHub/basename. */
const citationWellFormed: Rule = (draft) =>
  draft.elements.flatMap((el) =>
    proseFields(el).flatMap(({ elementId, field, text }) =>
      checkCitationWellFormed(text, ref(elementId, field)),
    ),
  );

/**
 * L4/L12/S2/S8 — every citation resolves against the right side's worktree index.
 * Prose `path:line` mentions resolve against the HEAD inventory; typed `code_ref`
 * elements resolve against their `side`'s inventory, must name the one expected
 * patchset (S2), and must not invert their line span (S8). A `noise_verdict`'s
 * `hunk` element reference (L12) must point at a real `code_ref` on this board.
 */
const citationResolves: Rule = (draft, ctx) => {
  const out: Violation[] = [];
  const byId = new Map(draft.elements.map((el) => [el.id, el]));
  for (const el of draft.elements) {
    // Prose path:line mentions — HEAD side.
    for (const { elementId, field, text } of proseFields(el)) {
      out.push(...checkCitationResolves(text, ctx.files, ref(elementId, field)));
    }
    // Typed code_ref elements: patchset identity + side inventory + range order.
    if (el.kind === "code_ref") {
      const d = el.data as {
        path?: unknown;
        side?: unknown;
        patchset_id?: unknown;
        start_line?: unknown;
        end_line?: unknown;
      };
      const path = typeof d.path === "string" ? d.path : "";
      const side = d.side === "base" ? "base" : "head";
      const startLine = typeof d.start_line === "number" ? d.start_line : 0;
      const endLine = typeof d.end_line === "number" ? d.end_line : startLine;
      const cited = typeof d.patchset_id === "string" ? d.patchset_id : "";
      if (ctx.patchsetId !== undefined && cited !== ctx.patchsetId) {
        out.push({
          ruleId: "citation-resolves",
          elementRef: ref(el.id),
          message: `code_ref cites patchset \`${cited}\`, not this board's \`${ctx.patchsetId}\` — cross-patchset citations do not resolve.`,
        });
        continue;
      }
      if (endLine < startLine) {
        out.push({
          ruleId: "citation-resolves",
          elementRef: ref(el.id),
          message: `code_ref \`${path}:${startLine}-${endLine}\` is inverted: the end line precedes the start.`,
        });
        continue;
      }
      // Resolve against the cited side's inventory. A base-side ref with no base
      // inventory supplied degrades to unchecked (never checked against HEAD).
      const inventory = side === "base" ? ctx.baseFiles : ctx.files;
      if (inventory === undefined) continue;
      const count = inventory.get(path);
      if (count === undefined) {
        out.push({
          ruleId: "citation-resolves",
          elementRef: ref(el.id),
          message: `code_ref cites \`${path}\` (${side}) — no such file at the review commit.`,
        });
      } else if (startLine < 1 || endLine > count) {
        out.push({
          ruleId: "citation-resolves",
          elementRef: ref(el.id),
          message: `code_ref \`${path}:${startLine}-${endLine}\` (${side}) overruns the file (${count} lines).`,
        });
      }
    }
    // L12 — a noise_verdict's `hunk` is an element reference to a code_ref on this board.
    if (el.kind === "noise_verdict") {
      const hunkRef = (el.data as { hunk?: unknown }).hunk;
      const target = typeof hunkRef === "string" ? byId.get(hunkRef) : undefined;
      if (target === undefined || target.kind !== "code_ref") {
        out.push({
          ruleId: "citation-resolves",
          elementRef: ref(el.id, "hunk"),
          message:
            "A noise verdict's `hunk` must reference a `code_ref` element on this board; it points at nothing citable.",
        });
      }
    }
  }
  return out;
};

/** L7 — no machinery vocabulary in structural fields (R20), with the F2 exemptions. */
const processVocabulary: Rule = (draft, ctx) =>
  draft.elements.flatMap((el) =>
    structuralFields(el).flatMap(({ elementId, field, text }) =>
      checkProcessVocab(text, ctx, ref(elementId, field)),
    ),
  );

const REMAINDER =
  /\b(?:not (?:covered|shown|discussed) (?:here|on this)|left to (?:another|the other)|covered elsewhere|out of scope (?:here|for this)|handled separately|the rest of the (?:diff|change))\b/i;
/** L9 — no remainder narration; skipped material is `skippedHunks` data, never prose. */
const noRemainderNarration: Rule = (draft) =>
  draft.elements.flatMap((el) =>
    proseFields(el).flatMap(({ elementId, field, text }) =>
      REMAINDER.test(text)
        ? [
            {
              ruleId: "no-remainder-narration",
              elementRef: ref(elementId, field),
              message:
                "R18/R19: what a board skips is `skippedHunks` data, not prose. Drop the remainder sentence; record the hunk with a reason.",
            },
          ]
        : [],
    ),
  );

function matchesGlob(path: string, glob: string): boolean {
  // Minimal glob. Split on `**` FIRST so the single-`*` pass never corrupts a
  // `**` run. A `**/` boundary (the next segment starts with `/`) becomes an
  // optional directory prefix `(?:.*/)?` matching ZERO or more dirs, so a
  // root-level `openspec/x` matches `**/openspec/**`. A bare `**` becomes `.*`
  // (any run incl. `/`); a single `*` becomes `[^/]*` (a run without `/`).
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const parts = escaped.split("**");
  let body = "";
  for (let i = 0; i < parts.length; i += 1) {
    let seg = parts[i] ?? "";
    if (i > 0) {
      if (seg.startsWith("/")) {
        body += "(?:.*/)?";
        seg = seg.slice(1);
      } else {
        body += ".*";
      }
    }
    body += seg.replace(/\*/g, "[^/]*");
  }
  return new RegExp(`^${body}$`).test(path);
}

export function isScaffoldPath(
  path: string,
  globs: readonly string[] = DEFAULT_SCAFFOLD_GLOBS,
): boolean {
  return globs.some((glob) => matchesGlob(path, glob));
}

/** L10 — scaffold stamps are the Noise lane (R22): only Noise cites a scaffold path. */
const scaffoldIsNoiseLane: Rule = (draft, ctx) => {
  if (ctx.lens === "noise") return [];
  const globs = ctx.scaffoldGlobs ?? DEFAULT_SCAFFOLD_GLOBS;
  return draft.elements.flatMap((el) => {
    if (el.kind !== "code_ref") return [];
    const path = (el.data as { path?: unknown }).path;
    if (typeof path !== "string") return [];
    return isScaffoldPath(path, globs)
      ? [
          {
            ruleId: "scaffold-is-noise-lane",
            elementRef: ref(el.id),
            message: `R22: \`${path}\` is scaffold — it belongs to the Noise lens, not the ${ctx.lens} board.`,
          },
        ]
      : [];
  });
};

// ── Skipped-hunks rules (the draft carries `skippedHunks` as passthrough) ─────

interface SkipEntry {
  hunk: string;
  reason: string;
}
function skippedHunks(draft: DraftBoard): SkipEntry[] | undefined {
  const raw = (draft as { skippedHunks?: unknown }).skippedHunks;
  if (!Array.isArray(raw)) return undefined;
  return raw.map((e) => {
    const o = (e ?? {}) as { hunk?: unknown; reason?: unknown };
    return {
      hunk: typeof o.hunk === "string" ? o.hunk : "",
      reason: typeof o.reason === "string" ? o.reason : "",
    };
  });
}

/** S3-as-lint — a board carries a `skippedHunks` array (present, even if empty). */
const skippedHunksPresent: Rule = (draft) =>
  skippedHunks(draft) === undefined
    ? [
        {
          ruleId: "skipped-hunks-present",
          elementRef: "/skippedHunks",
          message:
            "R19: every board carries a `skippedHunks` array — coverage is data, not silence. Include it even when empty.",
        },
      ]
    : [];

const BOILERPLATE_REASON = /^(n\/a|none|other lens|not relevant|see above|mechanical)\.?$/i;
/** L11 — skip reasons are specific, never boilerplate. */
const skipReasonSpecific: Rule = (draft) => {
  const skips = skippedHunks(draft);
  if (skips === undefined) return [];
  return skips.flatMap((s, i) =>
    s.reason.trim().length === 0 || BOILERPLATE_REASON.test(s.reason.trim())
      ? [
          {
            ruleId: "skip-reason-specific",
            elementRef: `/skippedHunks/${i}`,
            message:
              "R19: name which lens owns this hunk and why, specific to this change — not a boilerplate reason.",
          },
        ]
      : [],
  );
};

/** L14 — every `skippedHunks` entry resolves against the patchset hunk list. */
const skippedHunksResolve: Rule = (draft, ctx) => {
  const skips = skippedHunks(draft);
  if (skips === undefined) return [];
  const ids = new Set(ctx.hunks.map((h) => h.id));
  return skips.flatMap((s, i) =>
    ids.has(s.hunk)
      ? []
      : [
          {
            ruleId: "skipped-hunks-resolve",
            elementRef: `/skippedHunks/${i}`,
            message: `R19: skipped hunk \`${s.hunk}\` is not in the patchset — it cannot be skipped.`,
          },
        ],
  );
};

/** L15 — a hunk is never both taught (cited) and skipped on the same board. */
const noTaughtAndSkipped: Rule = (draft, ctx) => {
  const skips = skippedHunks(draft);
  if (skips === undefined || skips.length === 0) return [];
  const skipped = new Set(skips.map((s) => s.hunk));
  // "Taught": any code_ref whose side-appropriate range overlaps a hunk (finding 8).
  const taught = taughtHunkIds(draft.elements, ctx.hunks);
  const both = [...skipped].filter((id) => taught.has(id));
  return both.map((id) => ({
    ruleId: "no-taught-and-skipped",
    elementRef: "/skippedHunks",
    message: `R19: hunk \`${id}\` is both taught and skipped on this board — incoherent. Teach it or skip it, not both.`,
  }));
};

// ── Decisions grounding (S6 — the frozen decision carries evidence + alternatives) ──

/**
 * S6 — a `decision` names at least one real alternative and cites at least one
 * evidence anchor. The Decisions prompt's own test: "if you cannot name a viable
 * alternative, it is not a decision, it is just code"; evidence is where the call
 * is visible. Both `evidence` and `alternatives` are frozen `string[]` fields, so
 * the emptiness residue IS enforceable (proposal ledger P4). `requirement.trace`
 * is deliberately NOT required non-empty — an empty trace is an honest
 * unimplemented obligation (Design prompt: "Zero hunks renders as unimplemented").
 */
const decisionGrounded: Rule = (draft, ctx) =>
  draft.elements.flatMap((el) => {
    if (el.kind !== "decision") return [];
    const d = el.data as {
      evidence?: unknown;
      alternatives?: unknown;
      inferred?: unknown;
      source?: unknown;
    };
    const out: Violation[] = [];
    const evidence = Array.isArray(d.evidence) ? d.evidence : [];
    const alternatives = Array.isArray(d.alternatives) ? d.alternatives : [];
    const statedDesign =
      ctx.lens === "design" &&
      d.inferred === false &&
      typeof d.source === "object" &&
      d.source !== null;
    if (evidence.length === 0 && !statedDesign) {
      out.push({
        ruleId: "decision-grounded",
        elementRef: ref(el.id, "evidence"),
        message:
          "A decision cites where the call is visible: `evidence` is empty. Anchor it to the code (a code_ref).",
      });
    }
    if (alternatives.length === 0 && !statedDesign) {
      out.push({
        ruleId: "decision-grounded",
        elementRef: ref(el.id, "alternatives"),
        message:
          "If you cannot name a viable alternative it is not a decision, it is just code: `alternatives` is empty.",
      });
    }
    return out;
  });

// ── Report-seat coherence (round_outcome) ────────────────────────────────────

const STATUS_ORDER = ["addressed", "partial", "untouched", "beyond"] as const;
/**
 * L17 — round-report items are status-sorted; a `beyond` item is real self-
 * directed work, so it carries a `note` accounting for it (report prompt: "for
 * `beyond`, say why the worker's detour was or was not sound").
 *
 * Reconciliation (proposal ledger, S1): the frozen `askRefSchema.ref` is
 * `.min(1)` and `ask` is a REQUIRED field on `roundOutcomeData`, so a schema-
 * valid `beyond` round_outcome cannot carry an empty `ask.ref`. R57's original
 * "leave `ask.ref` empty" is therefore unenforceable against the frozen schema;
 * lint enforces the enforceable half — a non-empty `note` — and the sort order.
 */
const reportCoherent: Rule = (draft) => {
  const out: Violation[] = [];
  const outcomes = draft.elements.filter((el) => el.kind === "round_outcome");
  let prevRank = -1;
  for (const el of outcomes) {
    const d = el.data as { status?: unknown; note?: unknown };
    const status = typeof d.status === "string" ? d.status : "";
    const rank = STATUS_ORDER.indexOf(status as (typeof STATUS_ORDER)[number]);
    if (rank !== -1 && rank < prevRank) {
      out.push({
        ruleId: "report-coherent",
        elementRef: ref(el.id, "status"),
        message: `R57: round items sort addressed < partial < untouched < beyond; \`${status}\` is out of order.`,
      });
    }
    if (rank !== -1) prevRank = rank;
    if (status === "beyond") {
      const note = typeof d.note === "string" ? d.note : "";
      if (note.trim().length === 0) {
        out.push({
          ruleId: "report-coherent",
          elementRef: ref(el.id),
          message:
            "R57: a `beyond` item names work the round did on its own — account for it in a `note`.",
        });
      }
    }
  }
  return out;
};

function requirementArtifact(
  element: DraftElement,
  ctx: LintContext,
): { readonly key: string; readonly text: string } | undefined {
  const data = element.data as { source?: unknown };
  const source =
    typeof data.source === "object" && data.source !== null
      ? (data.source as { path?: unknown; candidate?: unknown })
      : undefined;
  const path = source?.path;
  const candidate = source?.candidate;
  if (ctx.artifacts !== undefined) {
    if (typeof path !== "string") return undefined;
    const artifact = ctx.artifacts.find(
      (entry) =>
        entry.path === path &&
        (typeof candidate !== "string" ||
          entry.candidate === undefined ||
          entry.candidate === candidate),
    );
    return artifact === undefined
      ? undefined
      : { key: `${artifact.candidate ?? "legacy"}\u0000${artifact.path}`, text: artifact.text };
  }
  return ctx.artifactText === undefined
    ? undefined
    : { key: "legacy-artifact", text: ctx.artifactText };
}

/** Source chips and related-file links resolve before the client makes them actionable. */
function sourceLineKnown(source: unknown, elementRef: string, ctx: LintContext): Violation[] {
  if (typeof source !== "object" || source === null) return [];
  const { path, candidate, line } = source as {
    path?: unknown;
    candidate?: unknown;
    line?: unknown;
  };
  if (typeof path !== "string" || typeof line !== "number") return [];
  const artifactText = ctx.artifacts?.find(
    (artifact) =>
      artifact.path === path &&
      (typeof candidate !== "string" ||
        artifact.candidate === undefined ||
        artifact.candidate === candidate),
  )?.text;
  const lineCount =
    ctx.files.get(path) ??
    (artifactText === undefined ? undefined : artifactText.split(/\r?\n/).length);
  if (lineCount !== undefined && line <= lineCount) return [];
  return [
    {
      ruleId: "design-source-line-known",
      elementRef: `${elementRef}/line`,
      message:
        lineCount === undefined
          ? `Source line ${line} cannot resolve because \`${path}\` is absent from the reviewed file inventory.`
          : `Source line ${line} is outside \`${path}\`, which has ${lineCount} lines in the reviewed state.`,
    },
  ];
}

function sourceCandidateKnown(source: unknown, elementRef: string, ctx: LintContext): Violation[] {
  if (ctx.artifactCandidates === undefined || ctx.artifactCandidates.length === 0) return [];
  if (typeof source !== "object" || source === null) return [];
  const { path, candidate } = source as { path?: unknown; candidate?: unknown };
  if (candidate === undefined && ctx.artifactCandidates.length === 1) return [];
  const match =
    typeof candidate === "string"
      ? ctx.artifactCandidates.find((entry) => entry.id === candidate)
      : undefined;
  if (match !== undefined && typeof path === "string" && match.paths.includes(path)) return [];
  return [
    {
      ruleId: "design-source-candidate-known",
      elementRef: `${elementRef}/candidate`,
      message:
        candidate === undefined
          ? "A source shared among multiple discovered candidates names the exact candidate it belongs to."
          : `Source candidate \`${String(candidate)}\` is unknown or does not contain \`${String(path)}\`.`,
    },
  ];
}

const designSourcesKnown: Rule = (draft, ctx) => {
  if (ctx.artifacts === undefined) return [];
  const artifactPaths = new Set(ctx.artifacts.map((artifact) => artifact.path));
  const out: Violation[] = [];
  const checkSources = (sources: unknown, elementRef: string): void => {
    if (!Array.isArray(sources)) return;
    sources.forEach((source, index) => {
      const path =
        typeof source === "object" && source !== null
          ? (source as { path?: unknown }).path
          : undefined;
      if (typeof path === "string" && artifactPaths.has(path)) {
        out.push(...sourceCandidateKnown(source, `${elementRef}/${index}`, ctx));
        out.push(...sourceLineKnown(source, `${elementRef}/${index}`, ctx));
        return;
      }
      out.push({
        ruleId: "design-source-known",
        elementRef: `${elementRef}/${index}/path`,
        message:
          typeof path === "string"
            ? `Source chip \`${path}\` is not one of the discovered artifacts.`
            : "Each source chip names an exact discovered artifact path.",
      });
    });
  };

  checkSources(draft.document?.sources, "/document/sources");
  for (const element of draft.elements) {
    if (element.kind === "section") {
      checkSources((element.data as { sources?: unknown }).sources, `${element.id}/sources`);
    }
    if (element.kind === "decision" && ctx.lens === "design") {
      const data = element.data as { inferred?: unknown; source?: unknown };
      if (data.inferred !== false) {
        out.push({
          ruleId: "design-decision-stated",
          elementRef: `${element.id}/inferred`,
          message:
            "A decision taken from a Design artifact is explicitly marked `inferred: false`.",
        });
      }
      const source = data.source;
      const path =
        typeof source === "object" && source !== null
          ? (source as { path?: unknown }).path
          : undefined;
      if (typeof path !== "string" || !artifactPaths.has(path)) {
        out.push({
          ruleId: "design-source-known",
          elementRef: `${element.id}/source/path`,
          message: "A stated Design decision names its exact discovered artifact source.",
        });
      } else {
        out.push(...sourceCandidateKnown(source, `${element.id}/source`, ctx));
        out.push(...sourceLineKnown(source, `${element.id}/source`, ctx));
      }
    }
    if (element.kind !== "requirement") continue;
    const related = (element.data as { related_files?: unknown }).related_files;
    if (!Array.isArray(related)) continue;
    related.forEach((path, index) => {
      if (typeof path === "string" && ctx.files.has(path)) return;
      out.push({
        ruleId: "design-related-file-known",
        elementRef: `${element.id}/related_files/${index}`,
        message:
          typeof path === "string"
            ? `Related file \`${path}\` does not exist in the reviewed repository.`
            : "Each related file is an exact repo-relative path.",
      });
    });
  }
  return out;
};

function resolvedCandidateId(source: { readonly candidate?: unknown }, ctx: LintContext): string {
  if (typeof source.candidate === "string") return source.candidate;
  return ctx.artifactCandidates?.length === 1 ? (ctx.artifactCandidates[0]?.id ?? "") : "";
}

function sourceKey(
  source: { readonly path?: unknown; readonly candidate?: unknown },
  ctx: LintContext,
): string | undefined {
  return typeof source.path === "string"
    ? `${resolvedCandidateId(source, ctx)}\u0000${source.path}`
    : undefined;
}

/** Every artifact in each header-selected candidate has a named rendered region. */
const designArtifactSetComplete: Rule = (draft, ctx) => {
  if (ctx.artifactCandidates === undefined || ctx.artifactCandidates.length === 0) {
    return [];
  }
  const documentSourceRefs = draft.document?.sources ?? [];
  const sectionSourceRefs = draft.elements.flatMap((element) =>
    element.kind === "section"
      ? ((element.data as { sources?: readonly { path?: unknown; candidate?: unknown }[] })
          .sources ?? [])
      : [],
  );
  const requirementSourceRefs = draft.elements.flatMap((element) => {
    if (element.kind !== "requirement") return [];
    const source = (element.data as { source?: { path?: unknown; candidate?: unknown } }).source;
    return source === undefined ? [] : [source];
  });
  const documentSources = new Set(
    documentSourceRefs.flatMap((source) => {
      const key = sourceKey(source, ctx);
      return key === undefined ? [] : [key];
    }),
  );
  const sectionSources = new Set(
    sectionSourceRefs.flatMap((source) => {
      const key = sourceKey(source, ctx);
      return key === undefined ? [] : [key];
    }),
  );
  if (documentSources.size === 0) {
    return [
      {
        ruleId: "design-artifact-set-complete",
        elementRef: "/document/sources",
        message: "The Design document must select one discovered artifact candidate.",
      },
    ];
  }
  const out: Violation[] = [];
  const selectedCandidateIds = new Set(
    documentSourceRefs.map((source) => resolvedCandidateId(source, ctx)).filter(Boolean),
  );
  for (const candidate of ctx.artifactCandidates) {
    if (!selectedCandidateIds.has(candidate.id)) continue;
    for (const path of candidate.paths) {
      const key = `${candidate.id}\u0000${path}`;
      if (!documentSources.has(key)) {
        out.push({
          ruleId: "design-artifact-set-complete",
          elementRef: "/document/sources",
          message: `Selected candidate \`${candidate.id}\` is missing artifact \`${path}\` from the header roll-up.`,
        });
      }
      if (!sectionSources.has(key)) {
        out.push({
          ruleId: "design-artifact-set-complete",
          elementRef: "/elements",
          message: `Selected artifact \`${path}\` has no named source-linked section.`,
        });
      }
    }
  }
  const renderedSources = new Set([
    ...sectionSources,
    ...requirementSourceRefs.flatMap((source) => {
      const value = sourceKey(source, ctx);
      return value === undefined ? [] : [value];
    }),
  ]);
  for (const key of renderedSources) {
    if (documentSources.has(key)) continue;
    const path = key.slice(key.indexOf("\u0000") + 1);
    out.push({
      ruleId: "design-artifact-set-complete",
      elementRef: "/document/sources",
      message: `Rendered artifact \`${path}\` is missing from the document source roll-up.`,
    });
  }
  return out;
};

/** Deterministic relevance prevents a complete nearby decoy from validating. */
const designCandidateRelevant: Rule = (draft, ctx) => {
  if (ctx.artifactCandidates === undefined) return [];
  const strong = ctx.artifactCandidates.filter(
    (candidate) =>
      candidate.relevance !== undefined && candidate.relevance !== "repository-candidate",
  );
  if (strong.length === 0) return [];
  const selectedIds = new Set(
    (draft.document?.sources ?? []).map((source) => resolvedCandidateId(source, ctx)),
  );
  return ctx.artifactCandidates.flatMap((candidate) =>
    selectedIds.has(candidate.id) && candidate.relevance === "repository-candidate"
      ? [
          {
            ruleId: "design-candidate-relevant",
            elementRef: "/document/sources",
            message: `Candidate \`${candidate.id}\` has no deterministic relation to the change while a changed or path-referencing candidate exists.`,
          },
        ]
      : [],
  );
};

type DesignObligationKind = "requirement" | "scenario" | "task";
interface DesignObligation {
  readonly kind: DesignObligationKind;
  readonly text: string;
  readonly line: number;
  readonly done?: boolean;
}

const normalizeDesignText = (text: string): string => text.replace(/\s+/g, " ").trim();

function designObligations(text: string): DesignObligation[] {
  const lines = text.split(/\r?\n/);
  const obligations: DesignObligation[] = [];
  const add = (obligation: DesignObligation): void => {
    if (obligation.text.length > 0) obligations.push(obligation);
  };

  let offset = 0;
  for (const paragraph of text.split(/\r?\n\s*\r?\n/)) {
    const start = text.indexOf(paragraph, offset);
    offset = Math.max(offset, start + paragraph.length);
    if (!/\bSHALL\b/.test(paragraph)) continue;
    const cleaned = paragraph
      .split(/\r?\n/)
      .filter((line) => !/^\s*#{1,6}\s+/.test(line))
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
      .filter(Boolean)
      .join(" ");
    add({
      kind: "requirement",
      text: normalizeDesignText(cleaned),
      line: text.slice(0, Math.max(0, start)).split(/\r?\n/).length,
    });
  }

  let inAcceptanceCriteria = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      inAcceptanceCriteria = /acceptance criteria/i.test(heading[2] ?? "");
      const scenario = /^#{3,6}\s+Scenario:\s*(.+?)\s*$/i.exec(line);
      if (scenario !== null) {
        const parts = [`Scenario: ${scenario[1] ?? ""}`];
        for (let next = index + 1; next < lines.length; next += 1) {
          const candidate = lines[next] ?? "";
          if (/^#{1,6}\s+/.test(candidate)) break;
          if (candidate.trim().length > 0) parts.push(candidate.trim());
        }
        add({ kind: "scenario", text: normalizeDesignText(parts.join(" ")), line: index + 1 });
      }
      const task = /^###\s+(Task\s+\d+:\s*.+?)\s*$/i.exec(line);
      if (task !== null) {
        add({ kind: "task", text: normalizeDesignText(task[1] ?? ""), line: index + 1 });
      }
      continue;
    }
    const checkbox = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (checkbox !== null) {
      add({
        kind: "task",
        text: normalizeDesignText(line.trim()),
        line: index + 1,
        done: (checkbox[1] ?? "").toLowerCase() === "x",
      });
      continue;
    }
    if (inAcceptanceCriteria) {
      const item = /^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/.exec(line)?.[1];
      if (item !== undefined) {
        add({ kind: "scenario", text: normalizeDesignText(item), line: index + 1 });
      }
    }
  }
  return obligations.sort((left, right) => left.line - right.line);
}

function orderedDesignElements(draft: DraftBoard): DraftElement[] {
  const byId = new Map(draft.elements.map((element) => [element.id, element]));
  const nested = new Set<string>();
  for (const element of draft.elements) {
    const children = (element.data as { children?: unknown }).children;
    if (Array.isArray(children)) {
      for (const child of children) if (typeof child === "string") nested.add(child);
    }
  }
  const ordered: DraftElement[] = [];
  const visited = new Set<string>();
  const visit = (element: DraftElement): void => {
    if (visited.has(element.id)) return;
    visited.add(element.id);
    ordered.push(element);
    const children = (element.data as { children?: unknown }).children;
    if (!Array.isArray(children)) return;
    for (const child of children) {
      if (typeof child !== "string") continue;
      const nestedElement = byId.get(child);
      if (nestedElement !== undefined) visit(nestedElement);
    }
  };
  for (const element of draft.elements) if (!nested.has(element.id)) visit(element);
  for (const element of draft.elements) visit(element);
  return ordered;
}

function sectionDescendants(section: DraftElement, draft: DraftBoard): DraftElement[] {
  const byId = new Map(draft.elements.map((element) => [element.id, element]));
  const descendants: DraftElement[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const element = byId.get(id);
    if (element === undefined) return;
    descendants.push(element);
    const children = (element.data as { children?: unknown }).children;
    if (Array.isArray(children)) {
      for (const child of children) if (typeof child === "string") visit(child);
    }
  };
  const children = (section.data as { children?: unknown }).children;
  if (Array.isArray(children)) {
    for (const child of children) if (typeof child === "string") visit(child);
  }
  return descendants;
}

function markdownH2Section(text: string, title: string): string[] | undefined {
  const lines = text.split(/\r?\n/);
  const target = normalizeDesignText(title).toLowerCase();
  const start = lines.findIndex((line) => {
    const heading = /^##\s+(.+?)\s*$/.exec(line)?.[1];
    return heading !== undefined && normalizeDesignText(heading).toLowerCase() === target;
  });
  if (start === -1) return undefined;
  const section: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^##\s+/.test(line)) break;
    section.push(line);
  }
  return section;
}

function topLevelListItems(lines: readonly string[]): string[] {
  const items: string[] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    const item = /^[-*]\s+(.+?)\s*$/.exec(line)?.[1];
    if (item !== undefined) {
      if (current !== undefined) items.push(normalizeDesignText(current.join(" ")));
      current = [item];
      continue;
    }
    if (current !== undefined && line.trim().length > 0 && !/^#{1,6}\s+/.test(line)) {
      current.push(line.trim());
    }
  }
  if (current !== undefined) items.push(normalizeDesignText(current.join(" ")));
  return items;
}

function designArtifactKey(
  artifact: { readonly candidate?: string; readonly path: string },
  ctx: LintContext,
): string | undefined {
  const candidate =
    artifact.candidate ??
    (ctx.artifactCandidates?.length === 1 ? ctx.artifactCandidates[0]?.id : undefined);
  return candidate === undefined ? undefined : `${candidate}\u0000${artifact.path}`;
}

function selectedDesignArtifacts(draft: DraftBoard, ctx: LintContext) {
  const selected = new Set(
    (draft.document?.sources ?? []).flatMap((source) => {
      const key = sourceKey(source, ctx);
      return key === undefined ? [] : [key];
    }),
  );
  return (ctx.artifacts ?? []).filter((artifact) => {
    const key = designArtifactKey(artifact, ctx);
    return key !== undefined && selected.has(key);
  });
}

/** Reverse-check source obligations so an empty sourced region cannot certify completeness. */
const designArtifactContentComplete: Rule = (draft, ctx) => {
  if (ctx.artifacts === undefined || ctx.artifactCandidates === undefined) return [];
  const ordered = orderedDesignElements(draft);
  const orderIndex = new Map(ordered.map((element, index) => [element.id, index]));
  const byId = new Map(draft.elements.map((element) => [element.id, element]));
  const out: Violation[] = [];

  for (const artifact of selectedDesignArtifacts(draft, ctx)) {
    const key = designArtifactKey(artifact, ctx);
    if (key === undefined) continue;
    const sections = draft.elements.filter((element) => {
      if (element.kind !== "section") return false;
      const sources = (
        element.data as { sources?: readonly { path?: unknown; candidate?: unknown }[] }
      ).sources;
      return sources?.some((source) => sourceKey(source, ctx) === key) ?? false;
    });
    const descendants = sections.flatMap((section) => sectionDescendants(section, draft));
    if (sections.length === 0 || descendants.length === 0) {
      out.push({
        ruleId: "design-artifact-content-complete",
        elementRef: "/elements",
        message: `Artifact \`${artifact.path}\` needs a non-empty source-linked region.`,
      });
      continue;
    }

    const obligations = designObligations(artifact.text);
    const requirements = draft.elements.filter((element) => {
      if (element.kind !== "requirement") return false;
      const source = (element.data as { source?: { path?: unknown; candidate?: unknown } }).source;
      return source !== undefined && sourceKey(source, ctx) === key;
    });
    const scenarioElements = requirements.flatMap((requirement) => {
      const scenarios = (requirement.data as { scenarios?: unknown }).scenarios;
      return Array.isArray(scenarios)
        ? scenarios.flatMap((id) => {
            const element = typeof id === "string" ? byId.get(id) : undefined;
            return element?.kind === "prose" ? [element] : [];
          })
        : [];
    });
    const taskElements = descendants.filter((element) => element.kind === "prose");
    const used = new Set<string>();
    const previousIndex: Partial<Record<DesignObligationKind, number>> = {};

    for (const obligation of obligations) {
      const candidates =
        obligation.kind === "requirement"
          ? requirements
          : obligation.kind === "scenario"
            ? scenarioElements
            : taskElements;
      const match = candidates.find((element) => {
        if (used.has(element.id)) return false;
        const data = element.data as { shall?: unknown; markdown?: unknown };
        const text =
          element.kind === "requirement"
            ? data.shall
            : element.kind === "prose"
              ? data.markdown
              : undefined;
        return typeof text === "string" && normalizeDesignText(text) === obligation.text;
      });
      if (match === undefined) {
        out.push({
          ruleId: "design-artifact-content-complete",
          elementRef: "/elements",
          message: `Artifact \`${artifact.path}\` is missing its ${obligation.kind}: ${obligation.text}`,
        });
        continue;
      }
      used.add(match.id);
      const index = orderIndex.get(match.id) ?? Number.MAX_SAFE_INTEGER;
      const previous = previousIndex[obligation.kind];
      if (previous !== undefined && index < previous) {
        out.push({
          ruleId: "design-artifact-content-order",
          elementRef: ref(match.id),
          message: `${obligation.kind} elements from \`${artifact.path}\` must preserve source order.`,
        });
      }
      previousIndex[obligation.kind] = index;
    }

    if (artifact.role === "proposal") {
      for (const title of ["what changes", "impact"]) {
        const sourceSection = markdownH2Section(artifact.text, title);
        if (sourceSection === undefined) continue;
        const renderedSection = descendants.find(
          (element) =>
            element.kind === "section" &&
            normalizeDesignText(
              String((element.data as { title?: unknown }).title ?? ""),
            ).toLowerCase() === title,
        );
        if (renderedSection === undefined) {
          out.push({
            ruleId: "design-artifact-anatomy",
            elementRef: sections[0]?.id ?? "/elements",
            message: `Artifact \`${artifact.path}\` needs a nested \`${title}\` section.`,
          });
          continue;
        }
        const prose = sectionDescendants(renderedSection, draft).filter(
          (element) => element.kind === "prose",
        );
        if (sourceSection.some((line) => line.trim().length > 0) && prose.length === 0) {
          out.push({
            ruleId: "design-artifact-anatomy",
            elementRef: ref(renderedSection.id),
            message: `Artifact \`${artifact.path}\` needs its declared ${title} prose.`,
          });
          continue;
        }
        if (title !== "what changes") continue;
        const declaredChanges = topLevelListItems(sourceSection);
        const renderedChanges = prose.map((element) =>
          normalizeDesignText(
            String((element.data as { markdown?: unknown }).markdown ?? "").replace(/^[-*]\s+/, ""),
          ),
        );
        const remaining = [...renderedChanges];
        for (const change of declaredChanges) {
          const index = remaining.indexOf(change);
          if (index !== -1) {
            remaining.splice(index, 1);
            continue;
          }
          out.push({
            ruleId: "design-artifact-anatomy",
            elementRef: ref(renderedSection.id),
            message: `Artifact \`${artifact.path}\` needs one exact What Changes row for: ${change}`,
          });
        }
      }
    }
  }
  return out;
};

const designHeaderComplete: Rule = (draft, ctx) => {
  if (ctx.artifacts === undefined || ctx.artifactCandidates === undefined) return [];
  const artifacts = selectedDesignArtifacts(draft, ctx);
  if (artifacts.length === 0) return [];
  const selectedKeys = new Set(
    artifacts.flatMap((artifact) => {
      const key = designArtifactKey(artifact, ctx);
      return key === undefined ? [] : [key];
    }),
  );
  const requirements = draft.elements.filter((element) => {
    if (element.kind !== "requirement") return false;
    const source = (element.data as { source?: { path?: unknown; candidate?: unknown } }).source;
    const key = source === undefined ? undefined : sourceKey(source, ctx);
    return key !== undefined && selectedKeys.has(key);
  });
  const capabilities = new Map<string, string>();
  for (const requirement of requirements) {
    const data = requirement.data as { capability?: unknown; spec_delta?: unknown };
    if (typeof data.capability === "string") {
      capabilities.set(data.capability, typeof data.spec_delta === "string" ? data.spec_delta : "");
    }
  }
  const tasks = artifacts.flatMap((artifact) =>
    designObligations(artifact.text).filter((obligation) => obligation.kind === "task"),
  );
  const expected = new Map<string, string>([
    ["requirements", String(requirements.length)],
    [
      "capabilities",
      `${[...capabilities.values()].filter((delta) => delta === "added").length} new / ${[...capabilities.values()].filter((delta) => delta === "modified").length} modified`,
    ],
  ]);
  if (tasks.length > 0) {
    expected.set("tasks", `${tasks.filter((task) => task.done).length}/${tasks.length}`);
  }
  const actual = new Map(
    (draft.document?.stats ?? []).map((stat) => [stat.label.toLowerCase(), stat.value]),
  );
  return [...expected].flatMap(([label, value]) =>
    actual.get(label) === value
      ? []
      : [
          {
            ruleId: "design-header-complete",
            elementRef: "/document/stats",
            message: `Design header stat \`${label}\` must be \`${value}\` from the selected artifacts.`,
          },
        ],
  );
};

const designIncompletenessVisible: Rule = (draft, ctx) => {
  if (ctx.artifactBundleIncomplete !== true) return [];
  const visible = draft.elements.some(
    (element) =>
      element.kind === "callout" &&
      /\b(incomplete|truncated|omitted|shortened)\b/i.test(
        String((element.data as { body?: unknown }).body ?? ""),
      ),
  );
  return visible
    ? []
    : [
        {
          ruleId: "design-incompleteness-visible",
          elementRef: "/elements",
          message:
            "A bounded or truncated discovery bundle needs an explicit incompleteness callout.",
        },
      ];
};

/** A discovered artifact bundle makes each requirement's source path checkable. */
const requirementSourceKnown: Rule = (draft, ctx) => {
  if (ctx.artifacts === undefined) return [];
  const paths = new Set(ctx.artifacts.map((artifact) => artifact.path));
  return draft.elements.flatMap((element) => {
    if (element.kind !== "requirement") return [];
    const source = (element.data as { source?: unknown }).source;
    const path =
      typeof source === "object" && source !== null
        ? (source as { path?: unknown }).path
        : undefined;
    if (typeof path === "string" && paths.has(path)) {
      return [
        ...sourceCandidateKnown(source, ref(element.id, "source"), ctx),
        ...sourceLineKnown(source, ref(element.id, "source"), ctx),
      ];
    }
    return [
      {
        ruleId: "requirement-source-known",
        elementRef: ref(element.id, "source"),
        message:
          typeof path === "string"
            ? `Requirement source \`${path}\` is not one of the discovered artifacts.`
            : "A requirement drawn from discovered artifacts names its exact source path.",
      },
    ];
  });
};

/** Requirement scenario refs resolve only to narrative scenario regions. */
const requirementScenariosNarrative: Rule = (draft) => {
  const byId = new Map(draft.elements.map((element) => [element.id, element]));
  return draft.elements.flatMap((element) => {
    if (element.kind !== "requirement") return [];
    const scenarios = (element.data as { scenarios?: unknown }).scenarios;
    if (!Array.isArray(scenarios)) return [];
    return scenarios.flatMap((scenarioId, index) => {
      const scenario = typeof scenarioId === "string" ? byId.get(scenarioId) : undefined;
      if (scenario?.kind === "prose") return [];
      return [
        {
          ruleId: "requirement-scenario-narrative",
          elementRef: ref(element.id, `scenarios/${index}`),
          message:
            typeof scenarioId === "string" && scenario !== undefined
              ? `Requirement scenario \`${scenarioId}\` resolves to \`${scenario.kind}\`; scenarios must resolve to prose regions.`
              : `Requirement scenario \`${String(scenarioId)}\` does not resolve to a prose region.`,
        },
      ];
    });
  });
};

/** L13 — requirement and scenario text stay verbatim in their source artifact. */
const requirementVerbatim: Rule = (draft, ctx) => {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const byId = new Map(draft.elements.map((element) => [element.id, element]));
  return draft.elements.flatMap((el) => {
    if (el.kind !== "requirement") return [];
    const artifact = requirementArtifact(el, ctx);
    if (artifact === undefined) return []; // degrade: only checkable with the exact source
    const data = el.data as { shall?: unknown; scenarios?: unknown };
    const haystack = normalize(artifact.text);
    const violations: Violation[] = [];
    if (
      typeof data.shall === "string" &&
      data.shall.length > 0 &&
      !haystack.includes(normalize(data.shall))
    ) {
      violations.push({
        ruleId: "requirement-verbatim",
        elementRef: ref(el.id, "shall"),
        message:
          "SHALL text is quoted, not summarized: the requirement's `shall` is not a verbatim substring of the source artifact.",
      });
    }
    const scenarioIds = Array.isArray(data.scenarios) ? data.scenarios : [];
    for (const scenarioId of scenarioIds) {
      if (typeof scenarioId !== "string") continue;
      const scenario = byId.get(scenarioId);
      if (scenario?.kind !== "prose") continue;
      const markdown = (scenario.data as { markdown?: unknown }).markdown;
      if (
        typeof markdown === "string" &&
        markdown.length > 0 &&
        !haystack.includes(normalize(markdown))
      ) {
        violations.push({
          ruleId: "requirement-verbatim",
          elementRef: ref(scenario.id, "markdown"),
          message:
            "Scenario text is quoted, not summarized: the referenced scenario is not a verbatim substring of the requirement's source artifact.",
        });
      }
    }
    return violations;
  });
};

/**
 * L16 — requirements render in the source artifact's own order (Design prompt:
 * "Do not renumber or reorder requirements; keep the artifact's own addressing").
 * Enforced via L13's offsets (proposal ledger P5): a verbatim `shall`'s position
 * in the artifact must be non-decreasing down the board. Degrades to a no-op
 * without the source text; a `shall` not found verbatim is L13's lane, skipped here.
 */
const requirementOrder: Rule = (draft, ctx) => {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const out: Violation[] = [];
  const previousOffset = new Map<string, number>();
  const byId = new Map(draft.elements.map((element) => [element.id, element]));
  const nested = new Set<string>();
  for (const element of draft.elements) {
    const children = (element.data as { children?: unknown }).children;
    if (!Array.isArray(children)) continue;
    for (const child of children) if (typeof child === "string") nested.add(child);
  }
  const ordered: DraftElement[] = [];
  const visited = new Set<string>();
  const visit = (element: DraftElement): void => {
    if (visited.has(element.id)) return;
    visited.add(element.id);
    if (element.kind === "requirement") ordered.push(element);
    const children = (element.data as { children?: unknown }).children;
    if (!Array.isArray(children)) return;
    for (const child of children) {
      if (typeof child !== "string") continue;
      const target = byId.get(child);
      if (target !== undefined) visit(target);
    }
  };
  for (const element of draft.elements) {
    if (element.kind === "section" && !nested.has(element.id)) visit(element);
  }
  for (const element of draft.elements) visit(element);

  for (const el of ordered) {
    if (el.kind !== "requirement") continue;
    const artifact = requirementArtifact(el, ctx);
    if (artifact === undefined) continue;
    const shall = (el.data as { shall?: unknown }).shall;
    if (typeof shall !== "string" || shall.length === 0) continue;
    const haystack = normalize(artifact.text);
    const offset = haystack.indexOf(normalize(shall));
    if (offset === -1) continue; // not verbatim — L13 owns it
    const prior = previousOffset.get(artifact.key) ?? -1;
    if (offset < prior) {
      out.push({
        ruleId: "requirement-order",
        elementRef: ref(el.id, "shall"),
        message:
          "Requirements keep the artifact's own order: this `shall` appears before a requirement already rendered above it.",
      });
    }
    previousOffset.set(artifact.key, offset);
  }
  return out;
};

/** Kind allowlist — no message/thread/off-target typed kind, nor a foreign lens's. */
const kindAllowlist: Rule = (draft, ctx) => {
  const allowed = new Set<string>([...SHARED_KINDS, ...typedKindsFor(ctx.lens)]);
  return draft.elements.flatMap((el) =>
    allowed.has(el.kind)
      ? []
      : [
          {
            ruleId: "kind-allowlist",
            elementRef: ref(el.id),
            message: `Kind \`${el.kind}\` is not one the ${ctx.lens} ${
              ctx.lens === "report" ? "seat" : "lens"
            } authors (S1: thread/message are curation-only; typed kinds belong to their home lens/seat).`,
          },
        ],
  );
};

/**
 * The per-draft rule registry for a LENS board, in evaluation order. The report
 * seat runs {@link REPORT_RULES} instead — it carries no coverage/skipped-hunks
 * obligation, so the lens coverage rules do not apply to it.
 */
export const LENS_RULES: readonly Rule[] = [
  kindAllowlist,
  noCodeBytes,
  noDialogue,
  citationWellFormed,
  citationResolves,
  processVocabulary,
  noRemainderNarration,
  scaffoldIsNoiseLane,
  skippedHunksPresent,
  skipReasonSpecific,
  skippedHunksResolve,
  noTaughtAndSkipped,
  decisionGrounded,
  reportCoherent,
  designSourcesKnown,
  designCandidateRelevant,
  designArtifactSetComplete,
  designArtifactContentComplete,
  designHeaderComplete,
  designIncompletenessVisible,
  requirementSourceKnown,
  requirementScenariosNarrative,
  requirementVerbatim,
  requirementOrder,
];

/**
 * The round-report seat's rule set (S1). The report is not a lens board: it has
 * no hunk coverage or `skippedHunks` obligation, so only the prose/kind screens
 * plus report coherence apply.
 */
export const REPORT_RULES: readonly Rule[] = [
  kindAllowlist,
  noCodeBytes,
  noDialogue,
  citationWellFormed,
  citationResolves,
  processVocabulary,
  reportCoherent,
];

/**
 * Lint a draft board against its context. Pure. Returns every {@link Violation}
 * across all rules; an empty array is a clean board. The report seat runs a
 * report-specific rule set; every lens runs {@link LENS_RULES}. The retry
 * channel that feeds violations back to the drafter is cluster 3 (`validate.ts`).
 */
export function lint(draft: DraftBoard, ctx: LintContext): Violation[] {
  const rules = ctx.lens === "report" ? REPORT_RULES : LENS_RULES;
  return rules.flatMap((rule) => rule(draft, ctx));
}

// ── The review-draft register (P3 — review-draft-voice.md gets lint coverage) ─

/**
 * The living-review draft (`review-draft-voice.md`) is authored write-through as
 * one prose text, not a board of typed elements — there is no post-process stage
 * between the orchestrator and the text the reviewer reads. It still owes the
 * citation and machinery screens (packet: the process-vocabulary screen applies
 * to the write-through authoring register too). This is that entry point.
 *
 * The register's machinery screen is NARROWER than a board's: the draft IS the
 * review, so it may speak of "this review" — it may not name the pipeline's
 * parts (lenses, boards, seats, drafts, agents, the pipeline).
 */
const REGISTER_MACHINERY =
  /\b(?:lens(?:es)?|boards?|agents?|seats?|drafts?|orchestrator|unslop|post-process|pipeline)\b/i;

export interface RegisterLintContext {
  /** HEAD-side path → line-count inventory, for citation resolution (L4). */
  readonly files: ReadonlyMap<string, number>;
  /** The R20 identifier allowlist built from the changed files (L7 exemption). */
  readonly patchsetIdentifiers?: ReadonlySet<string>;
}

/**
 * Lint the review-draft register text: L3 (citations well-formed), L4 (citations
 * resolve), L7 (no machinery). Pure. The whole text is the machinery lane here,
 * not just short labels — the draft never mentions the pipeline's parts.
 */
export function lintReviewDraft(text: string, ctx: RegisterLintContext): Violation[] {
  const at = "/draft";
  return [
    ...checkCitationWellFormed(text, at),
    ...checkCitationResolves(text, ctx.files, at),
    ...checkProcessVocab(text, ctx, at, REGISTER_MACHINERY),
  ];
}
