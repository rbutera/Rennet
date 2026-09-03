/**
 * Board lint — the structural gate of the draft validation loop (#493, B08).
 *
 * `lint(draft, ctx) => Violation[]` is a pure function: no model, no I/O, no
 * Node. It rejects what is *false* about a draft board's structure — code bytes
 * in prose, citations outside the change, machinery vocabulary in structural
 * fields — so the drafter gets a scoped, deterministic
 * re-ask (the retry channel is cluster 3). It deliberately owns NO prose-quality
 * or slop-vocabulary judgment; that is the post-process editor's lane (#493 §5).
 *
 * Consumes the B03-frozen `protocol/src/board` seam verbatim — `DraftBoard`,
 * `DraftElement`, `Violation` (`{ ruleId, elementRef, message }`) — and never
 * re-models it (reconciliation 2). The `ctx` is plain data the caller assembles
 * (the patchset's changed regions per path and side, side-specific file→line-count
 * indices, the review lens); assembling it is the cluster-5 runtime's job, not lint's.
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
 *   - L19 (typed-data immutability across post-process) is a POST-PASS assertion
 *     → cluster 3.
 *   - The residue — the per-draft rules whose fields DO exist — is implemented
 *     here. S6 (decision grounding) and S8 (citation range order) DO have frozen
 *     fields and are enforced; only S4/S5/S7 + L5/L6/L8 reference truly-absent
 *     fields and stay parked (see the ledger for each named field).
 */

import {
  AUTHORED_BOARD_SCHEMA,
  type DraftBoard,
  type DraftElement,
  type LensKind,
  type Violation,
} from "@rennet/protocol";
import { parseOpenSpecChange } from "../delta/openspec-change";
import {
  type DesignSourceFormat,
  type DesignSourceObligation,
  type DesignTaskManifest,
  deriveDesignTaskProgress,
  parseDesignSourceObligations,
} from "./design-obligations";

// ── The lint context (plain data the caller assembles) ───────────────────────

/** The lint target: one of the five lens boards, or the round-report seat. */
export type LintTarget = LensKind | "report";

/**
 * One changed region of the patchset: a 1-based inclusive line range on one side of
 * one path (session-bound-workspace D5). The daemon builds these from the delta packet
 * it already has — one region per hunk per side that has lines, on the head path for
 * `head` and the pre-image path for `base` — so a citation resolves when every line it
 * names is inside a region on its own side, and a pure addition (no base lines) can never
 * be cited from the base side. No hunk identifier reaches this shape. A region whose `end`
 * is {@link REGION_OPEN_END} runs to the end of its file: the capture was truncated there,
 * so the daemon cannot say which later lines changed and claims none of them are outside.
 */
export interface ChangedRegion {
  readonly path: string;
  readonly side: "base" | "head";
  readonly start: number;
  readonly end: number;
}

/** The `end` of a region that runs to the end of its file (a truncated capture's tail). */
export const REGION_OPEN_END = Number.MAX_SAFE_INTEGER;

/** A code_ref reduced to what citation geometry needs: its side, path, and line span. */
export type CodeRefSpan = ChangedRegion;

/** Read a `code_ref` element's citation span, or `undefined` if it is not a code_ref. */
export function readCodeRefSpan(el: DraftElement): CodeRefSpan | undefined {
  if (el.kind !== "code_ref") return undefined;
  const d = el.data as { path?: unknown; side?: unknown; start_line?: unknown; end_line?: unknown };
  const path = typeof d.path === "string" ? d.path : "";
  const side = d.side === "base" ? "base" : "head";
  const start = typeof d.start_line === "number" ? d.start_line : 0;
  const end = typeof d.end_line === "number" ? d.end_line : start;
  return { path, side, start, end };
}

/** Does the citation overlap the region — same path, same side, ranges intersect? */
export function regionOverlaps(ref: CodeRefSpan, region: ChangedRegion): boolean {
  return (
    ref.side === region.side &&
    ref.path === region.path &&
    ref.start <= region.end &&
    ref.end >= region.start
  );
}

/**
 * Resolve a citation against the changed regions: the region its first line falls in, or
 * `undefined` unless EVERY cited line lies in a region on the named path and side. This is
 * the one readability predicate — `patchset.readSpan` serves a citation from the captured
 * hunks line by line, so a citation one line past a region, or spanning the gap between
 * two, passes no weaker test here than it meets when opened. Pure; lint's
 * `unresolvable-citation` rule and the daemon's reader share it.
 */
export function resolveCitation(
  ref: CodeRefSpan,
  regions: readonly ChangedRegion[],
): ChangedRegion | undefined {
  const onSide = regions.filter((r) => r.side === ref.side && r.path === ref.path);
  let first: ChangedRegion | undefined;
  for (let line = ref.start; line <= ref.end; ) {
    const region = onSide.find((r) => r.start <= line && line <= r.end);
    if (region === undefined) return undefined;
    first ??= region;
    if (region.end >= ref.end) break;
    line = region.end + 1;
  }
  return first;
}

/** The changed regions a set of board elements cite (every region some code_ref overlaps). */
export function citedRegions(
  elements: readonly DraftElement[],
  regions: readonly ChangedRegion[],
): Set<ChangedRegion> {
  const cited = new Set<ChangedRegion>();
  for (const el of elements) {
    const ref = readCodeRefSpan(el);
    if (ref === undefined) continue;
    for (const region of regions) if (regionOverlaps(ref, region)) cited.add(region);
  }
  return cited;
}

/**
 * Lint input, per board. `files` maps a repo-relative path to its line count on
 * the HEAD (post-image) side at the review commit; `baseFiles`, when supplied,
 * is the BASE (pre-image) inventory a `side: "base"` `code_ref` resolves against
 * (S2 — a base-side citation checked against the head inventory is a false
 * pass/fail). `patchsetId`, when supplied, is the one patchset this board may
 * cite: a `code_ref` naming any other patchset is a cross-patchset leak.
 * `regions` is the patchset's changed regions (the `unresolvable-citation` rule). REQUIRED:
 * the daemon always holds the diff a board was drafted from, so a context without regions
 * is a programming error, never an "unchecked" board — an EMPTY list is a patchset with no
 * changed lines, against which every citation is outside the change.
 * `patchsetIdentifiers` is the R20 allowlist built from the changed files.
 */
export interface LintContext {
  readonly lens: LintTarget;
  readonly regions: readonly ChangedRegion[];
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
    readonly format?: DesignSourceFormat;
    readonly role?: string;
    readonly truncated?: boolean;
    readonly sourceBytes?: number;
  }[];
  /** Candidate identity and paths so one selected source set cannot absorb a neighbouring candidate. */
  readonly artifactCandidates?: readonly {
    readonly id: string;
    readonly name?: string;
    readonly format?: DesignSourceFormat;
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

export interface ElementReference {
  readonly sourceId: string;
  readonly field: string;
  readonly targetId: string;
}

export function elementReferenceFields(el: DraftElement): readonly string[] {
  return Object.entries(AUTHORED_BOARD_SCHEMA[el.kind].attributes).flatMap(([field, attribute]) =>
    attribute.type === "element" ? [field] : [],
  );
}

/** Read only the fields the authoritative board schema declares as element references. */
export function elementReferences(el: DraftElement): ElementReference[] {
  const attributes = AUTHORED_BOARD_SCHEMA[el.kind].attributes;
  const data = el.data as Record<string, unknown>;
  const references: ElementReference[] = [];
  for (const [field, attribute] of Object.entries(attributes)) {
    if (attribute.type !== "element") continue;
    const value = data[field];
    const targetIds =
      "many" in attribute && attribute.many
        ? Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : []
        : typeof value === "string"
          ? [value]
          : [];
    for (const targetId of targetIds) references.push({ sourceId: el.id, field, targetId });
  }
  return references;
}

/**
 * Every schema-declared element reference must name an element in this exact
 * draft, and the reference graph must be acyclic so the board service can mint
 * every target before its citer.
 */
const elementReferencesResolve: Rule = (draft) => {
  const references = draft.elements.flatMap(elementReferences);
  const liveIds = new Set(draft.elements.map(({ id }) => id));
  const out: Violation[] = references.flatMap(({ sourceId, field, targetId }) =>
    liveIds.has(targetId)
      ? []
      : [
          {
            ruleId: "element-reference-resolves",
            elementRef: ref(sourceId, field),
            message: `Element reference \`${targetId}\` is not present in this board. Emit the referenced element or remove the reference.`,
          },
        ],
  );

  const outgoing = new Map<string, ElementReference[]>();
  for (const reference of references) {
    if (!liveIds.has(reference.targetId)) continue;
    const edges = outgoing.get(reference.sourceId) ?? [];
    edges.push(reference);
    outgoing.set(reference.sourceId, edges);
  }
  const state = new Map<string, "visiting" | "visited">();
  const visit = (elementId: string): void => {
    state.set(elementId, "visiting");
    for (const edge of outgoing.get(elementId) ?? []) {
      const targetState = state.get(edge.targetId);
      if (targetState === "visiting") {
        out.push({
          ruleId: "element-reference-resolves",
          elementRef: ref(edge.sourceId, edge.field),
          message: `Element reference \`${edge.targetId}\` creates a cycle. Board references must be orderable so every target exists before its citer.`,
        });
      } else if (targetState === undefined) {
        visit(edge.targetId);
      }
    }
    state.set(elementId, "visited");
  };
  for (const { id } of draft.elements) if (state.get(id) === undefined) visit(id);
  return out;
};

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

/** `path:start-end`, collapsing a one-line range to `path:start` and an open tail to `path:start-`. */
function rangeLabel(path: string, start: number, end: number): string {
  if (end === REGION_OPEN_END) return `${path}:${start}-`;
  return start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
}

/** Line distance from a citation to a region; 0 when they overlap. */
function regionDistance(ref: CodeRefSpan, region: ChangedRegion): number {
  if (ref.end < region.start) return region.start - ref.end;
  if (ref.start > region.end) return ref.start - region.end;
  return 0;
}

/**
 * D5 — every line a `code_ref` cites lies in a changed region of the patchset on its own
 * side ({@link resolveCitation}). A citation the regions do not cover is the violation; its
 * pointer names the nearest changed range on that path and side so the repair turn can
 * move it, or says the path has no changed lines on that side at all. Range order and file
 * existence are `citation-resolves`'s lane, so an inverted or overrunning citation is not
 * reported twice.
 */
const unresolvableCitation: Rule = (draft, ctx) => {
  const regions = ctx.regions;
  const out: Violation[] = [];
  for (const el of draft.elements) {
    const span = readCodeRefSpan(el);
    if (span === undefined || span.end < span.start || span.start < 1) continue;
    const count = (span.side === "base" ? ctx.baseFiles : ctx.files)?.get(span.path);
    if (count !== undefined && span.end > count) continue; // an overrun is citation-resolves's report
    if (resolveCitation(span, regions) !== undefined) continue;
    const onSide = regions.filter((r) => r.path === span.path && r.side === span.side);
    const nearest = onSide.reduce<ChangedRegion | undefined>(
      (best, r) =>
        best === undefined || regionDistance(span, r) < regionDistance(span, best) ? r : best,
      undefined,
    );
    out.push({
      ruleId: "unresolvable-citation",
      elementRef: ref(el.id),
      message:
        nearest === undefined
          ? `code_ref \`${rangeLabel(span.path, span.start, span.end)}\` (${span.side}) cites no changed line: \`${span.path}\` has no changed lines on the ${span.side} side of this patchset.`
          : `code_ref \`${rangeLabel(span.path, span.start, span.end)}\` (${span.side}) lies outside the change; the nearest changed range on that side is \`${rangeLabel(nearest.path, nearest.start, nearest.end)}\`.`,
    });
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
/** L9 — no remainder narration; a board says what it cites, never what it leaves out. */
const noRemainderNarration: Rule = (draft) =>
  draft.elements.flatMap((el) =>
    proseFields(el).flatMap(({ elementId, field, text }) =>
      REMAINDER.test(text)
        ? [
            {
              ruleId: "no-remainder-narration",
              elementRef: ref(elementId, field),
              message:
                "R18: a board never narrates what it leaves out. Drop the remainder sentence; cite what you read and say nothing about the rest.",
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
          ? "A discovered source names the exact candidate it belongs to."
          : `Source candidate \`${String(candidate)}\` is unknown or does not contain \`${String(path)}\`.`,
    },
  ];
}

function sourceBearingDesignElements(draft: DraftBoard): readonly {
  readonly element: DraftElement;
  readonly source: {
    readonly path?: unknown;
    readonly candidate?: unknown;
    readonly line?: unknown;
  };
}[] {
  return draft.elements.flatMap((element) => {
    if (element.kind !== "requirement" && element.kind !== "decision") return [];
    const source = (element.data as { source?: unknown }).source;
    return typeof source === "object" && source !== null
      ? [{ element, source: source as { path?: unknown; candidate?: unknown; line?: unknown } }]
      : [];
  });
}

function exactDesignDecisionSource(source: unknown): source is {
  readonly path: string;
  readonly candidate: string;
  readonly line: number;
} {
  if (typeof source !== "object" || source === null) return false;
  const { path, candidate, line } = source as {
    readonly path?: unknown;
    readonly candidate?: unknown;
    readonly line?: unknown;
  };
  return (
    typeof path === "string" &&
    path.length > 0 &&
    typeof candidate === "string" &&
    candidate.length > 0 &&
    typeof line === "number" &&
    Number.isInteger(line) &&
    line > 0
  );
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
  for (const { element, source } of sourceBearingDesignElements(draft)) {
    if (element.kind !== "decision") continue;
    if (ctx.lens === "design" && !exactDesignDecisionSource(source)) {
      continue;
    }
    const path = source.path;
    if (typeof path !== "string" || !artifactPaths.has(path)) {
      out.push({
        ruleId: "design-source-known",
        elementRef: `${element.id}/source/path`,
        message: `A sourced Design ${element.kind} names its exact discovered artifact source.`,
      });
      continue;
    }
    out.push(...sourceCandidateKnown(source, `${element.id}/source`, ctx));
    out.push(...sourceLineKnown(source, `${element.id}/source`, ctx));
  }
  for (const element of draft.elements) {
    if (element.kind === "section") {
      checkSources((element.data as { sources?: unknown }).sources, `${element.id}/sources`);
    }
    if (element.kind === "decision" && ctx.lens === "design") {
      const data = element.data as { inferred?: unknown; source?: unknown };
      if (!exactDesignDecisionSource(data.source)) {
        out.push({
          ruleId: "design-source-known",
          elementRef: `${element.id}/source`,
          message:
            "Every Design decision names its exact discovered candidate, artifact path, and positive source line.",
        });
      }
      if (data.inferred !== false) {
        out.push({
          ruleId: "design-decision-stated",
          elementRef: `${element.id}/inferred`,
          message:
            "A decision taken from a Design artifact is explicitly marked `inferred: false`.",
        });
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
  const sections = draft.elements.filter((element) => element.kind === "section");
  const sectionSourceRefs = sections.flatMap(
    (element) =>
      (element.data as { sources?: readonly { path?: unknown; candidate?: unknown }[] }).sources ??
      [],
  );
  const typedSourceRefs = sourceBearingDesignElements(draft).map(({ source }) => source);
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
  const sectionSourceKeys = new Map(
    sections.map((section) => [
      section.id,
      new Set(
        (section.data.sources ?? []).flatMap((source) => {
          const key = sourceKey(source, ctx);
          return key === undefined ? [] : [key];
        }),
      ),
    ]),
  );
  const parentByChild = new Map<string, string>();
  for (const element of draft.elements) {
    for (const child of designStructuralChildren(element)) {
      if (!parentByChild.has(child)) parentByChild.set(child, element.id);
    }
  }
  const hasLinkedAncestor = (sectionId: string, key: string): boolean => {
    const visited = new Set<string>();
    let parent = parentByChild.get(sectionId);
    while (parent !== undefined && !visited.has(parent)) {
      visited.add(parent);
      if (sectionSourceKeys.get(parent)?.has(key) === true) return true;
      parent = parentByChild.get(parent);
    }
    return false;
  };
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
  if (selectedCandidateIds.size !== 1) {
    out.push({
      ruleId: "design-artifact-set-complete",
      elementRef: "/document/sources",
      message: "The Design document must select exactly one discovered artifact candidate.",
    });
  }
  for (const candidate of ctx.artifactCandidates) {
    if (!selectedCandidateIds.has(candidate.id)) continue;
    const expectedKeys = candidate.paths.map((path) => `${candidate.id}\u0000${path}`);
    const actualKeys = documentSourceRefs.flatMap((source) => {
      const key = sourceKey(source, ctx);
      return key?.startsWith(`${candidate.id}\u0000`) ? [key] : [];
    });
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      out.push({
        ruleId: "design-artifact-set-complete",
        elementRef: "/document/sources",
        message: `Design header sources must list selected candidate \`${candidate.id}\` artifacts exactly once in discovered order.`,
      });
    }
    const firstRegionKeys: string[] = [];
    const seenRegionKeys = new Set<string>();
    const firstRegionSectionByKey = new Map<string, string>();
    for (const element of orderedDesignElements(draft)) {
      if (element.kind !== "section") continue;
      for (const source of element.data.sources ?? []) {
        const key = sourceKey(source, ctx);
        if (key === undefined || !expectedKeys.includes(key) || seenRegionKeys.has(key)) {
          continue;
        }
        seenRegionKeys.add(key);
        firstRegionKeys.push(key);
        firstRegionSectionByKey.set(key, element.id);
      }
    }
    if (
      firstRegionKeys.length === expectedKeys.length &&
      firstRegionKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      out.push({
        ruleId: "design-artifact-set-complete",
        elementRef: "/elements",
        message: `The first source-linked region for each selected candidate artifact must preserve discovered order.`,
      });
    }
    if (
      firstRegionKeys.length === expectedKeys.length &&
      new Set(firstRegionSectionByKey.values()).size !== firstRegionKeys.length
    ) {
      out.push({
        ruleId: "design-artifact-set-complete",
        elementRef: "/elements",
        message: `Each selected candidate artifact needs a distinct first named source-linked region.`,
      });
    }
    for (const key of expectedKeys) {
      const firstRegion = firstRegionSectionByKey.get(key);
      if (firstRegion !== undefined && parentByChild.has(firstRegion)) {
        out.push({
          ruleId: "design-artifact-set-complete",
          elementRef: ref(firstRegion),
          message: `The first named source-linked region for \`${key.slice(key.indexOf("\u0000") + 1)}\` must be a top-level board topology root.`,
        });
      }
    }
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
      const sourceRoots = sections.filter(
        (section) =>
          sectionSourceKeys.get(section.id)?.has(key) === true &&
          !hasLinkedAncestor(section.id, key),
      );
      if (sourceRoots.length > 1) {
        out.push({
          ruleId: "design-artifact-set-complete",
          elementRef: "/elements",
          message: `Selected artifact \`${path}\` needs one named source-linked root; repeated links must stay nested beneath it.`,
        });
      }
    }
  }
  const renderedSources = new Set([
    ...sectionSources,
    ...typedSourceRefs.flatMap((source) => {
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

const normalizeDesignText = (text: string): string => text.replace(/\s+/g, " ").trim();

function isLooseRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function exactOptionalStringList(
  actual: unknown,
  expected: readonly string[] | undefined,
): boolean {
  if (expected === undefined) return actual === undefined;
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function exactTaskManifest(actual: unknown, expected: DesignTaskManifest | undefined): boolean {
  if (expected === undefined) return actual === undefined;
  if (!isLooseRecord(actual) || !hasExactKeys(actual, ["files", "interfaces", "verifications"])) {
    return false;
  }
  const files = Reflect.get(actual, "files");
  const interfaces = Reflect.get(actual, "interfaces");
  const verifications = Reflect.get(actual, "verifications");
  return (
    Array.isArray(files) &&
    files.length === expected.files.length &&
    files.every((value, index) => {
      const item = expected.files[index];
      return (
        item !== undefined &&
        isLooseRecord(value) &&
        hasExactKeys(value, ["operation", "value"]) &&
        Reflect.get(value, "operation") === item.operation &&
        Reflect.get(value, "value") === item.value
      );
    }) &&
    Array.isArray(interfaces) &&
    interfaces.length === expected.interfaces.length &&
    interfaces.every((value, index) => {
      const item = expected.interfaces[index];
      return (
        item !== undefined &&
        isLooseRecord(value) &&
        hasExactKeys(value, ["direction", "value"]) &&
        Reflect.get(value, "direction") === item.direction &&
        Reflect.get(value, "value") === item.value
      );
    }) &&
    Array.isArray(verifications) &&
    verifications.length === expected.verifications.length &&
    verifications.every((value, index) => {
      const item = expected.verifications[index];
      return (
        item !== undefined &&
        isLooseRecord(value) &&
        hasExactKeys(value, ["run", "expected"]) &&
        Reflect.get(value, "run") === item.run &&
        Reflect.get(value, "expected") === item.expected
      );
    })
  );
}

function exactGlossaryTerm(
  actual: unknown,
  expected: Extract<DesignSourceObligation, { readonly kind: "glossary-term" }>,
): boolean {
  return (
    isLooseRecord(actual) &&
    hasExactKeys(actual, ["term", "definition", "avoid"]) &&
    Reflect.get(actual, "term") === expected.term &&
    Reflect.get(actual, "definition") === expected.definition &&
    exactOptionalStringList(Reflect.get(actual, "avoid"), expected.avoid)
  );
}

function hasRigidGlossaryShape(markdown: unknown): boolean {
  return (
    typeof markdown === "string" &&
    /^\s*(?:[-*+]\s+)?\*\*[^*]+\*\*:\s*\S[\s\S]*\s_Avoid_:\s*\S/i.test(markdown)
  );
}

function designStructuralChildren(element: DraftElement): readonly string[] {
  const children = (element.data as { children?: unknown }).children;
  const scenarios =
    element.kind === "requirement"
      ? (element.data as { scenarios?: unknown }).scenarios
      : undefined;
  return [
    ...(Array.isArray(children)
      ? children.flatMap((child) => (typeof child === "string" ? [child] : []))
      : []),
    ...(Array.isArray(scenarios)
      ? scenarios.flatMap((scenario) => (typeof scenario === "string" ? [scenario] : []))
      : []),
  ];
}

function orderedDesignElements(draft: DraftBoard): DraftElement[] {
  const byId = new Map(draft.elements.map((element) => [element.id, element]));
  const nested = new Set<string>();
  for (const element of draft.elements) {
    for (const child of designStructuralChildren(element)) nested.add(child);
  }
  const ordered: DraftElement[] = [];
  const visited = new Set<string>();
  const visit = (element: DraftElement): void => {
    if (visited.has(element.id)) return;
    visited.add(element.id);
    ordered.push(element);
    for (const child of designStructuralChildren(element)) {
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
    for (const child of designStructuralChildren(element)) visit(child);
  };
  for (const child of designStructuralChildren(section)) visit(child);
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

function designArtifactCapability(artifact: {
  readonly format?: DesignSourceFormat;
  readonly path: string;
}): string | undefined {
  if (artifact.format !== undefined && artifact.format !== "openspec") return undefined;
  return /(?:^|\/)specs\/([^/]+)\/spec\.md$/i.exec(artifact.path.replace(/\\/g, "/"))?.[1];
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
  const parentByChild = new Map<string, string>();
  for (const element of draft.elements) {
    for (const child of designStructuralChildren(element)) {
      if (!parentByChild.has(child)) {
        parentByChild.set(child, element.id);
      }
    }
  }
  const nearestSectionParent = (id: string): string | undefined => {
    const visited = new Set<string>();
    let parent = parentByChild.get(id);
    while (parent !== undefined && !visited.has(parent)) {
      visited.add(parent);
      if (byId.get(parent)?.kind === "section") return parent;
      parent = parentByChild.get(parent);
    }
    return undefined;
  };
  const sectionAncestors = (id: string): DraftElement[] => {
    const sections: DraftElement[] = [];
    const visited = new Set<string>();
    let parent = parentByChild.get(id);
    while (parent !== undefined && !visited.has(parent)) {
      visited.add(parent);
      const element = byId.get(parent);
      if (element?.kind === "section") sections.push(element);
      parent = parentByChild.get(parent);
    }
    return sections;
  };
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

    const obligations = parseDesignSourceObligations({
      ...(artifact.format === undefined ? {} : { format: artifact.format }),
      role: artifact.role ?? "",
      path: artifact.path,
      text: artifact.text,
    });
    const sourceDeltasByCapability = new Map<string, string[]>();
    const taskManifestsByGroup = new Map<string, DesignTaskManifest | undefined>();
    for (const obligation of obligations) {
      if (obligation.kind === "requirement" && obligation.capability !== undefined) {
        const deltas = sourceDeltasByCapability.get(obligation.capability) ?? [];
        const delta = /#requirements:(added|modified|removed|renamed)$/.exec(
          obligation.parentKey,
        )?.[1];
        if (delta !== undefined && !deltas.includes(delta)) deltas.push(delta);
        sourceDeltasByCapability.set(obligation.capability, deltas);
      }
      if (obligation.kind === "task") {
        const known = taskManifestsByGroup.get(obligation.parentKey);
        if (known === undefined || obligation.manifest !== undefined) {
          taskManifestsByGroup.set(obligation.parentKey, obligation.manifest);
        }
      }
    }
    const descendantIds = new Set(descendants.map(({ id }) => id));
    const sourcedRequirements = draft.elements.filter((element) => {
      if (element.kind !== "requirement") return false;
      const source = (element.data as { source?: { path?: unknown; candidate?: unknown } }).source;
      return source !== undefined && sourceKey(source, ctx) === key;
    });
    const requirements = sourcedRequirements.filter((element) => descendantIds.has(element.id));
    const sourcedDecisions = draft.elements.filter((element) => {
      if (element.kind !== "decision") return false;
      const source = (element.data as { source?: { path?: unknown; candidate?: unknown } }).source;
      return source !== undefined && sourceKey(source, ctx) === key;
    });
    const decisions = sourcedDecisions.filter((element) => descendantIds.has(element.id));
    const proseElements = descendants.filter((element) => element.kind === "prose");
    const used = new Set<string>();
    const matchedByObligation = new Map<string, DraftElement>();
    const boardGroupBySourceGroup = new Map<string, string>();
    const sourceGroupByBoardGroup = new Map<string, string>();
    const boardCapabilityBySourceCapability = new Map<string, string>();
    const reportedGroupDeltas = new Set<string>();
    const reportedCapabilityDeltas = new Set<string>();
    const reportedCapabilityRoots = new Set<string>();
    const reportedGroupTitles = new Set<string>();
    const reportedTaskManifests = new Set<string>();
    const allowedSectionDeltas = new Map<string, string | undefined>();
    let previousIndex: number | undefined;

    for (const obligation of obligations) {
      let candidates: readonly DraftElement[];
      switch (obligation.kind) {
        case "requirement":
          candidates = requirements;
          break;
        case "scenario": {
          const parent = matchedByObligation.get(obligation.parentKey);
          const scenarios = (parent?.data as { scenarios?: unknown } | undefined)?.scenarios;
          candidates = Array.isArray(scenarios)
            ? scenarios.flatMap((id) => {
                const element = typeof id === "string" ? byId.get(id) : undefined;
                return element?.kind === "prose" && descendantIds.has(element.id) ? [element] : [];
              })
            : [];
          break;
        }
        case "decision":
          candidates = decisions;
          break;
        case "task":
        case "source-section":
        case "glossary-term":
        case "progress-entry":
          candidates = proseElements;
          break;
        default: {
          const exhaustive: never = obligation;
          candidates = exhaustive;
        }
      }
      const match = candidates.find((element) => {
        if (used.has(element.id)) return false;
        const data = element.data as { shall?: unknown; markdown?: unknown; statement?: unknown };
        const text =
          element.kind === "requirement"
            ? data.shall
            : element.kind === "decision"
              ? data.statement
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
      matchedByObligation.set(obligation.key, match);
      if (obligation.kind === "requirement" || obligation.kind === "decision") {
        const source = (match.data as { source?: { line?: unknown } }).source;
        if (source?.line !== obligation.line) {
          out.push({
            ruleId: "design-artifact-content-complete",
            elementRef: ref(match.id, "source/line"),
            message: `${obligation.kind} ${obligation.address} from \`${artifact.path}\` must cite exact source line ${obligation.line}.`,
          });
        }
      }
      if (obligation.kind === "decision") {
        const data = match.data as {
          why?: unknown;
          alternatives?: unknown;
          evidence?: unknown;
          source_cells?: unknown;
        };
        const expectedRationale = obligation.rationale ?? "";
        if (typeof data.why !== "string" || normalizeDesignText(data.why) !== expectedRationale) {
          out.push({
            ruleId: "design-artifact-content-complete",
            elementRef: ref(match.id, "why"),
            message: `Decision ${obligation.address} from \`${artifact.path}\` must preserve its stated rationale verbatim.`,
          });
        }
        const actualAlternatives = Array.isArray(data.alternatives)
          ? data.alternatives.flatMap((value) =>
              typeof value === "string" ? [normalizeDesignText(value)] : [],
            )
          : [];
        const expectedAlternatives = obligation.alternatives ?? [];
        if (
          actualAlternatives.length !== expectedAlternatives.length ||
          actualAlternatives.some((value, index) => value !== expectedAlternatives[index])
        ) {
          out.push({
            ruleId: "design-artifact-content-complete",
            elementRef: ref(match.id, "alternatives"),
            message: `Decision ${obligation.address} from \`${artifact.path}\` must preserve only its stated alternatives, in source order.`,
          });
        }
        const actualEvidence = Array.isArray(data.evidence)
          ? data.evidence.flatMap((id) => {
              const evidence = typeof id === "string" ? byId.get(id) : undefined;
              if (evidence?.kind !== "code_ref") return [];
              const value = evidence.data as {
                path?: unknown;
                start_line?: unknown;
                end_line?: unknown;
              };
              return typeof value.path === "string" &&
                typeof value.start_line === "number" &&
                typeof value.end_line === "number"
                ? [
                    {
                      path: value.path,
                      startLine: value.start_line,
                      endLine: value.end_line,
                    },
                  ]
                : [];
            })
          : [];
        const expectedEvidence = obligation.evidence ?? [];
        if (
          actualEvidence.length !== expectedEvidence.length ||
          actualEvidence.some((value, index) => {
            const expected = expectedEvidence[index];
            return (
              expected === undefined ||
              value.path !== expected.path ||
              value.startLine !== expected.startLine ||
              value.endLine !== expected.endLine
            );
          })
        ) {
          out.push({
            ruleId: "design-artifact-content-complete",
            elementRef: ref(match.id, "evidence"),
            message: `Decision ${obligation.address} from \`${artifact.path}\` must preserve only its stated evidence anchors, in source order.`,
          });
        }
        if (!exactOptionalStringList(data.source_cells, obligation.sourceCells)) {
          out.push({
            ruleId: "design-artifact-content-complete",
            elementRef: ref(match.id, "source_cells"),
            message: `Decision ${obligation.address} from \`${artifact.path}\` must preserve its exact ordered source cells.`,
          });
        }
      }
      if (
        obligation.kind === "requirement" ||
        obligation.kind === "task" ||
        obligation.kind === "glossary-term"
      ) {
        const boardGroup = nearestSectionParent(match.id);
        const knownBoardGroup = boardGroupBySourceGroup.get(obligation.parentKey);
        const claimedSourceGroup =
          boardGroup === undefined ? undefined : sourceGroupByBoardGroup.get(boardGroup);
        if (
          boardGroup === undefined ||
          (knownBoardGroup !== undefined && knownBoardGroup !== boardGroup) ||
          (claimedSourceGroup !== undefined && claimedSourceGroup !== obligation.parentKey)
        ) {
          out.push({
            ruleId: "design-artifact-content-hierarchy",
            elementRef: ref(match.id),
            message: `Task ${obligation.address} from \`${artifact.path}\` must remain in its source task group.`,
          });
        } else {
          boardGroupBySourceGroup.set(obligation.parentKey, boardGroup);
          sourceGroupByBoardGroup.set(boardGroup, obligation.parentKey);
        }
        const expectedGroupTitle =
          obligation.kind === "requirement" ||
          obligation.kind === "task" ||
          obligation.kind === "glossary-term"
            ? obligation.groupTitle
            : undefined;
        const titleKey = `${boardGroup ?? match.id}\u0000${expectedGroupTitle ?? ""}`;
        const groupTitle =
          boardGroup === undefined
            ? undefined
            : (byId.get(boardGroup)?.data as { title?: unknown } | undefined)?.title;
        if (
          expectedGroupTitle !== undefined &&
          normalizeDesignText(String(groupTitle ?? "")) !==
            normalizeDesignText(expectedGroupTitle) &&
          !reportedGroupTitles.has(titleKey)
        ) {
          reportedGroupTitles.add(titleKey);
          out.push({
            ruleId: "design-artifact-content-hierarchy",
            elementRef: ref(boardGroup ?? match.id, "title"),
            message: `Source group \`${obligation.parentKey}\` must keep exact title \`${expectedGroupTitle}\`.`,
          });
        }
        if (obligation.kind === "task" && !reportedTaskManifests.has(obligation.parentKey)) {
          reportedTaskManifests.add(obligation.parentKey);
          const actualManifest =
            boardGroup === undefined
              ? undefined
              : Reflect.get(byId.get(boardGroup)?.data ?? {}, "task_manifest");
          const expectedManifest = taskManifestsByGroup.get(obligation.parentKey);
          if (!exactTaskManifest(actualManifest, expectedManifest)) {
            out.push({
              ruleId: "design-artifact-content-complete",
              elementRef: ref(boardGroup ?? match.id, "task_manifest"),
              message: `Source task group \`${obligation.parentKey}\` must preserve its exact task manifest once on the group section.`,
            });
          }
        }
      }
      if (obligation.kind === "task") {
        const data = match.data as {
          requirement_refs?: unknown;
          acceptance_criteria?: unknown;
          task_manifest?: unknown;
        };
        if (!exactOptionalStringList(data.requirement_refs, obligation.requirementRefs)) {
          out.push({
            ruleId: "design-artifact-content-complete",
            elementRef: ref(match.id, "requirement_refs"),
            message: `Task ${obligation.address} from \`${artifact.path}\` must preserve its exact ordered requirement references.`,
          });
        }
        if (!exactOptionalStringList(data.acceptance_criteria, obligation.acceptanceCriteria)) {
          out.push({
            ruleId: "design-artifact-content-complete",
            elementRef: ref(match.id, "acceptance_criteria"),
            message: `Task ${obligation.address} from \`${artifact.path}\` must preserve its exact ordered acceptance-criteria references.`,
          });
        }
        if (data.task_manifest !== undefined) {
          out.push({
            ruleId: "design-artifact-content-complete",
            elementRef: ref(match.id, "task_manifest"),
            message: `Task ${obligation.address} must keep its source manifest on the task-group section, not the step anchor.`,
          });
        }
      }
      if (obligation.kind === "glossary-term") {
        const glossary = Reflect.get(match.data, "glossary_term");
        if (!exactGlossaryTerm(glossary, obligation)) {
          out.push({
            ruleId: "design-artifact-content-complete",
            elementRef: ref(match.id, "glossary_term"),
            message: `Glossary term ${obligation.address} from \`${artifact.path}\` must preserve its exact term, definition, and ordered avoid list.`,
          });
        }
      }
      if (obligation.kind === "requirement") {
        const expectedDelta = /#requirements:(added|modified|removed|renamed)$/.exec(
          obligation.parentKey,
        )?.[1];
        const data = match.data as {
          capability?: unknown;
          spec_delta?: unknown;
          status?: unknown;
        };
        if (data.status !== obligation.status) {
          out.push({
            ruleId: "design-artifact-content-complete",
            elementRef: ref(match.id, "status"),
            message: `Requirement ${obligation.address} from \`${artifact.path}\` must preserve its exact source status.`,
          });
        }
        const actualDelta = data.spec_delta;
        if (actualDelta !== expectedDelta) {
          out.push({
            ruleId: "design-artifact-content-hierarchy",
            elementRef: ref(match.id, "spec_delta"),
            message:
              expectedDelta === undefined
                ? `Requirement ${obligation.address} has no source spec delta and must not invent one.`
                : `Requirement ${obligation.address} must remain in source group \`requirements:${expectedDelta}\` with \`spec_delta: ${expectedDelta}\`.`,
          });
        }
        const boardGroup = nearestSectionParent(match.id);
        if (boardGroup !== undefined) allowedSectionDeltas.set(boardGroup, expectedDelta);
        const groupDelta =
          boardGroup === undefined
            ? undefined
            : (byId.get(boardGroup)?.data as { spec_delta?: unknown } | undefined)?.spec_delta;
        const groupDeltaKey = `${boardGroup ?? match.id}\u0000${expectedDelta ?? "none"}`;
        if (groupDelta !== expectedDelta && !reportedGroupDeltas.has(groupDeltaKey)) {
          reportedGroupDeltas.add(groupDeltaKey);
          out.push({
            ruleId: "design-artifact-content-hierarchy",
            elementRef: ref(boardGroup ?? match.id, "spec_delta"),
            message:
              expectedDelta === undefined
                ? `Containing section for ${obligation.address} has no source spec delta and must not invent one.`
                : `Capability section for ${obligation.address} must use source delta \`${expectedDelta}\`, not \`${String(groupDelta)}\`.`,
          });
        }
        const expectedCapability = obligation.capability ?? designArtifactCapability(artifact);
        if (expectedCapability !== undefined && data.capability !== expectedCapability) {
          out.push({
            ruleId: "design-artifact-content-hierarchy",
            elementRef: ref(match.id, "capability"),
            message: `Requirement ${obligation.address} must remain on source capability \`${expectedCapability}\`.`,
          });
        }
        const requirementData = match.data as { name?: unknown };
        if (
          requirementData.name !== undefined &&
          (obligation.label === undefined ||
            normalizeDesignText(String(requirementData.name)) !==
              normalizeDesignText(obligation.label))
        ) {
          out.push({
            ruleId: "design-artifact-content-hierarchy",
            elementRef: ref(match.id, "name"),
            message: `Requirement ${obligation.address} may use only its exact source label \`${obligation.label ?? ""}\`.`,
          });
        }
        if (obligation.capabilityTitle !== undefined) {
          const capabilitySection = sectionAncestors(match.id).find(
            (section) =>
              normalizeDesignText(String((section.data as { title?: unknown }).title ?? "")) ===
              normalizeDesignText(obligation.capabilityTitle ?? ""),
          );
          if (capabilitySection === undefined) {
            out.push({
              ruleId: "design-artifact-content-hierarchy",
              elementRef: ref(nearestSectionParent(match.id) ?? match.id, "title"),
              message: `Requirement ${obligation.address} must stay inside source capability/group \`${obligation.capabilityTitle}\`.`,
            });
          } else if (obligation.capability !== undefined) {
            const knownCapabilitySection = boardCapabilityBySourceCapability.get(
              obligation.capability,
            );
            if (
              knownCapabilitySection !== undefined &&
              knownCapabilitySection !== capabilitySection.id &&
              !reportedCapabilityRoots.has(obligation.capability)
            ) {
              reportedCapabilityRoots.add(obligation.capability);
              out.push({
                ruleId: "design-artifact-content-hierarchy",
                elementRef: ref(capabilitySection.id),
                message: `All requirements for source capability \`${obligation.capability}\` must share one exact capability section.`,
              });
            }
            if (knownCapabilitySection === undefined) {
              boardCapabilityBySourceCapability.set(obligation.capability, capabilitySection.id);
            }
            if (!reportedCapabilityDeltas.has(capabilitySection.id)) {
              reportedCapabilityDeltas.add(capabilitySection.id);
              const sourceDeltas = sourceDeltasByCapability.get(obligation.capability) ?? [];
              const expectedRootDelta = sourceDeltas.length === 1 ? sourceDeltas[0] : undefined;
              allowedSectionDeltas.set(capabilitySection.id, expectedRootDelta);
              const actualRootDelta = (capabilitySection.data as { spec_delta?: unknown })
                .spec_delta;
              if (actualRootDelta !== expectedRootDelta) {
                out.push({
                  ruleId: "design-artifact-content-hierarchy",
                  elementRef: ref(capabilitySection.id, "spec_delta"),
                  message:
                    sourceDeltas.length > 1
                      ? `Capability \`${obligation.capability}\` combines multiple source deltas and must omit scalar \`spec_delta\`.`
                      : expectedRootDelta === undefined
                        ? `Capability \`${obligation.capability}\` has no source spec delta and must not invent one.`
                        : `Capability \`${obligation.capability}\` must use source delta \`${expectedRootDelta}\`.`,
                });
              }
            }
          }
        }
      }
      if (obligation.kind === "scenario") {
        const parent = matchedByObligation.get(obligation.parentKey);
        if (
          parent === undefined ||
          nearestSectionParent(parent.id) !== nearestSectionParent(match.id)
        ) {
          out.push({
            ruleId: "design-artifact-content-hierarchy",
            elementRef: ref(match.id),
            message: `Scenario ${obligation.address} from \`${artifact.path}\` must remain with its source requirement.`,
          });
        }
      }
      if (obligation.kind === "source-section") {
        const parent = nearestSectionParent(match.id);
        const title =
          parent === undefined
            ? undefined
            : (byId.get(parent)?.data as { title?: unknown } | undefined)?.title;
        if (
          typeof title !== "string" ||
          normalizeDesignText(title).toLowerCase() !==
            normalizeDesignText(obligation.heading).toLowerCase()
        ) {
          out.push({
            ruleId: "design-artifact-content-hierarchy",
            elementRef: ref(match.id),
            message: `Source section \`${obligation.heading}\` from \`${artifact.path}\` must remain an exact nested section.`,
          });
        }
      }
      const index = orderIndex.get(match.id) ?? Number.MAX_SAFE_INTEGER;
      if (previousIndex !== undefined && index < previousIndex) {
        out.push({
          ruleId: "design-artifact-content-order",
          elementRef: ref(match.id),
          message: `Source obligations from \`${artifact.path}\` must preserve total source order.`,
        });
      }
      previousIndex = index;
    }

    const scannedDeltaSections = new Set<string>();
    for (const element of [...sections, ...descendants]) {
      if (element.kind !== "section" || scannedDeltaSections.has(element.id)) continue;
      scannedDeltaSections.add(element.id);
      const specDelta = Reflect.get(element.data, "spec_delta");
      if (specDelta === undefined || allowedSectionDeltas.has(element.id)) continue;
      out.push({
        ruleId: "design-artifact-content-hierarchy",
        elementRef: ref(element.id, "spec_delta"),
        message: `Section ${element.id} invents spec_delta: ${String(specDelta)} without a matching source capability or operation.`,
      });
    }

    const glossaryMatches = new Set(
      obligations.flatMap((obligation) => {
        if (obligation.kind !== "glossary-term") return [];
        const match = matchedByObligation.get(obligation.key);
        return match === undefined ? [] : [match.id];
      }),
    );
    const hasGlossaryObligations = obligations.some(
      (obligation) => obligation.kind === "glossary-term",
    );
    for (const prose of proseElements) {
      const unmatchedGlossaryShape =
        hasGlossaryObligations &&
        hasRigidGlossaryShape((prose.data as { markdown?: unknown }).markdown);
      if (
        !glossaryMatches.has(prose.id) &&
        (Reflect.get(prose.data, "glossary_term") !== undefined || unmatchedGlossaryShape)
      ) {
        out.push({
          ruleId: "design-artifact-content-complete",
          elementRef: ref(prose.id, "glossary_term"),
          message: `Prose \`${prose.id}\` invents glossary structure not present in source artifact \`${artifact.path}\`.`,
        });
      }
    }
    const mappedTaskGroups = new Set(
      [...taskManifestsByGroup.keys()].flatMap((sourceGroup) => {
        const boardGroup = boardGroupBySourceGroup.get(sourceGroup);
        return boardGroup === undefined ? [] : [boardGroup];
      }),
    );
    const seenManifestSections = new Set<string>();
    for (const element of [...sections, ...descendants]) {
      if (
        element.kind !== "section" ||
        seenManifestSections.has(element.id) ||
        mappedTaskGroups.has(element.id)
      ) {
        continue;
      }
      seenManifestSections.add(element.id);
      if (Reflect.get(element.data, "task_manifest") === undefined) continue;
      out.push({
        ruleId: "design-artifact-content-complete",
        elementRef: ref(element.id, "task_manifest"),
        message: `Section \`${element.id}\` duplicates a task manifest outside its uniquely mapped source task group.`,
      });
    }

    const extras = new Map<string, { readonly element: DraftElement; readonly kind: string }>();
    for (const element of sourcedRequirements) {
      if (!used.has(element.id)) extras.set(element.id, { element, kind: "requirement" });
      const scenarios = (element.data as { scenarios?: unknown }).scenarios;
      if (!Array.isArray(scenarios)) continue;
      for (const scenarioId of scenarios) {
        const scenario = typeof scenarioId === "string" ? byId.get(scenarioId) : undefined;
        if (scenario?.kind === "prose" && !used.has(scenario.id)) {
          extras.set(scenario.id, { element: scenario, kind: "scenario" });
        }
      }
    }
    for (const element of sourcedDecisions) {
      if (!used.has(element.id)) extras.set(element.id, { element, kind: "decision" });
    }
    const taskBoardGroups = new Set(
      obligations.flatMap((obligation) => {
        if (obligation.kind !== "task") return [];
        const boardGroup = boardGroupBySourceGroup.get(obligation.parentKey);
        return boardGroup === undefined ? [] : [boardGroup];
      }),
    );
    if (artifact.format === "superpowers" && artifact.role === "plan") {
      for (const element of descendants) {
        if (element.kind !== "section") continue;
        const title = (element.data as { title?: unknown }).title;
        if (typeof title === "string" && /^Task\s+\d+(?:\.\d+)*\s*:/i.test(title)) {
          taskBoardGroups.add(element.id);
        }
      }
    }
    if (artifact.format === "bmad" && artifact.role === "story") {
      for (const element of [...sections, ...descendants]) {
        if (element.kind !== "section") continue;
        const title = (element.data as { title?: unknown }).title;
        if (title === "Tasks / Subtasks") taskBoardGroups.add(element.id);
      }
    }
    const isInsideTaskGroup = (id: string): boolean => {
      const visited = new Set<string>();
      let parent = parentByChild.get(id);
      while (parent !== undefined && !visited.has(parent)) {
        if (taskBoardGroups.has(parent)) return true;
        visited.add(parent);
        parent = parentByChild.get(parent);
      }
      return false;
    };
    const taskArtifactOwnsAllCheckboxes = artifact.role === "tasks";
    if (taskArtifactOwnsAllCheckboxes || taskBoardGroups.size > 0) {
      for (const element of proseElements) {
        const markdown = (element.data as { markdown?: unknown }).markdown;
        if (
          !used.has(element.id) &&
          typeof markdown === "string" &&
          /^\s*[-*+]\s+\[[ xX]\]\s+/.test(markdown) &&
          (taskArtifactOwnsAllCheckboxes || isInsideTaskGroup(element.id))
        ) {
          extras.set(element.id, { element, kind: "task" });
        }
      }
    }
    if (obligations.some((obligation) => obligation.kind === "progress-entry")) {
      for (const element of proseElements) {
        if (!used.has(element.id)) extras.set(element.id, { element, kind: "progress line" });
      }
    }
    for (const { element, kind } of extras.values()) {
      out.push({
        ruleId: "design-artifact-content-complete",
        elementRef: ref(element.id),
        message: `Rendered ${kind} \`${element.id}\` is not present in source artifact \`${artifact.path}\`.`,
      });
    }

    if (artifact.role === "proposal") {
      for (const title of ["why", "what changes", "impact"]) {
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
        if (title === "what changes") {
          const declaredChanges = topLevelListItems(sourceSection);
          const renderedChanges = prose.map((element) =>
            normalizeDesignText(
              String((element.data as { markdown?: unknown }).markdown ?? "").replace(
                /^[-*]\s+/,
                "",
              ),
            ),
          );
          if (
            declaredChanges.length !== renderedChanges.length ||
            declaredChanges.some((change, index) => renderedChanges[index] !== change)
          ) {
            out.push({
              ruleId: "design-artifact-anatomy",
              elementRef: ref(renderedSection.id),
              message: `Artifact \`${artifact.path}\` needs the exact ordered What Changes rows.`,
            });
          }
          continue;
        }
        const declaredProse = normalizeDesignText(sourceSection.join(" "));
        const renderedProse = normalizeDesignText(
          prose
            .map((element) => String((element.data as { markdown?: unknown }).markdown ?? ""))
            .join(" "),
        );
        if (declaredProse !== renderedProse) {
          out.push({
            ruleId: "design-artifact-anatomy",
            elementRef: ref(renderedSection.id),
            message: `Artifact \`${artifact.path}\` needs its exact declared ${title} prose.`,
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
  const artifactObligations = artifacts.map((artifact) => ({
    artifact,
    obligations: parseDesignSourceObligations({
      ...(artifact.format === undefined ? {} : { format: artifact.format }),
      role: artifact.role ?? "",
      path: artifact.path,
      text: artifact.text,
    }),
  }));
  const requirements = artifactObligations.flatMap(({ obligations }) =>
    obligations.filter((obligation) => obligation.kind === "requirement"),
  );
  const taskProgress = deriveDesignTaskProgress(
    artifacts.flatMap((artifact) => {
      const key = designArtifactKey(artifact, ctx);
      if (key === undefined) return [];
      return [
        {
          candidate: key.slice(0, key.indexOf("\u0000")),
          ...(artifact.format === undefined ? {} : { format: artifact.format }),
          role: artifact.role ?? "",
          path: artifact.path,
          text: artifact.text,
        },
      ];
    }),
  );
  const capabilityDeltas = new Map<string, Set<string>>();
  for (const { artifact, obligations } of artifactObligations) {
    for (const obligation of obligations) {
      if (obligation.kind !== "requirement") continue;
      const delta = /#requirements:(added|modified|removed|renamed)$/.exec(
        obligation.parentKey,
      )?.[1];
      if (delta === undefined) continue;
      const capability = `${artifact.candidate ?? "legacy"}\u0000${artifact.path}`;
      const deltas = capabilityDeltas.get(capability) ?? new Set<string>();
      deltas.add(delta);
      capabilityDeltas.set(capability, deltas);
    }
  }
  const proposals = artifacts.filter((artifact) => artifact.role === "proposal");
  const proposalCapabilities = proposals.map(
    (artifact) =>
      parseOpenSpecChange({
        name: artifact.candidate ?? artifact.path,
        proposalMd: artifact.text,
      }).proposal,
  );
  const newCapabilities =
    proposals.length > 0
      ? new Set(
          proposalCapabilities.flatMap(
            (proposal) => proposal?.newCapabilities.map(({ name }) => name) ?? [],
          ),
        ).size
      : [...capabilityDeltas.values()].filter(
          (deltas) => deltas.has("added") && !deltas.has("modified"),
        ).length;
  const modifiedCapabilities =
    proposals.length > 0
      ? new Set(
          proposalCapabilities.flatMap(
            (proposal) => proposal?.modifiedCapabilities.map(({ name }) => name) ?? [],
          ),
        ).size
      : [...capabilityDeltas.values()].filter((deltas) => deltas.has("modified")).length;
  const expected = new Map<string, string>([["requirements", String(requirements.length)]]);
  if (newCapabilities > 0 || modifiedCapabilities > 0) {
    expected.set("capabilities", `${newCapabilities} new / ${modifiedCapabilities} modified`);
  }
  const selectedCandidateIds = new Set(
    (draft.document?.sources ?? []).flatMap((source) =>
      typeof source.candidate === "string" ? [source.candidate] : [],
    ),
  );
  const selectedCandidate =
    selectedCandidateIds.size === 1
      ? ctx.artifactCandidates.find(
          (candidate) => candidate.id === selectedCandidateIds.values().next().value,
        )
      : undefined;
  if (selectedCandidate?.format !== undefined) {
    const formatLabels: Readonly<Record<DesignSourceFormat, string>> = {
      openspec: "OpenSpec",
      kiro: "Kiro",
      bmad: "BMAD",
      superpowers: "Superpowers",
      "grill-with-docs": "grill-with-docs",
    };
    expected.set("format", formatLabels[selectedCandidate.format]);
  }
  if (taskProgress.total > 0) {
    expected.set("tasks", `${taskProgress.done}/${taskProgress.total}`);
  }
  const canonicalLabels = new Map([
    ["requirements", "Requirements"],
    ["capabilities", "Capabilities"],
    ["format", "Format"],
    ["tasks", "Tasks"],
  ]);
  const actual = new Map<string, { readonly label: string; readonly value: string }[]>();
  for (const stat of draft.document?.stats ?? []) {
    const label = stat.label.toLowerCase();
    actual.set(label, [...(actual.get(label) ?? []), stat]);
  }
  const out: Violation[] = [];
  for (const [label, value] of expected) {
    const stats = actual.get(label) ?? [];
    if (stats.length !== 1) {
      out.push({
        ruleId: "design-header-complete",
        elementRef: "/document/stats",
        message: `Design header stat \`${label}\` must appear exactly once.`,
      });
      continue;
    }
    const stat = stats[0];
    if (stat === undefined) continue;
    const canonicalLabel = canonicalLabels.get(label);
    if (stat.label !== canonicalLabel) {
      out.push({
        ruleId: "design-header-complete",
        elementRef: "/document/stats",
        message: `Design header stat \`${label}\` must use exact label \`${canonicalLabel}\`.`,
      });
      continue;
    }
    if (stat.value !== value) {
      out.push({
        ruleId: "design-header-complete",
        elementRef: "/document/stats",
        message: `Design header stat \`${label}\` must be \`${value}\` from the selected artifacts.`,
      });
    }
  }
  for (const label of actual.keys()) {
    if (!expected.has(label)) {
      out.push({
        ruleId: "design-header-complete",
        elementRef: "/document/stats",
        message: `Design header has unexpected stat \`${label}\`; selected artifacts do not support it.`,
      });
    }
  }
  if (selectedCandidateIds.size === 1) {
    const expectedTitle = selectedCandidate?.name;
    if (
      expectedTitle !== undefined &&
      normalizeDesignText(draft.document?.title ?? "") !== normalizeDesignText(expectedTitle)
    ) {
      out.push({
        ruleId: "design-header-complete",
        elementRef: "/document/title",
        message: `Design header title must be \`${expectedTitle}\` from the selected artifact candidate.`,
      });
    }
  }
  return out;
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
  const sectionChildren = new Set(
    draft.elements.flatMap((element) => (element.kind === "section" ? element.data.children : [])),
  );
  const owners = new Map<string, string>();
  return draft.elements.flatMap((element) => {
    if (element.kind !== "requirement") return [];
    const scenarios = (element.data as { scenarios?: unknown }).scenarios;
    if (!Array.isArray(scenarios)) return [];
    return scenarios.flatMap((scenarioId, index) => {
      const scenario = typeof scenarioId === "string" ? byId.get(scenarioId) : undefined;
      if (scenario?.kind === "prose") {
        const priorOwner = owners.get(scenario.id);
        owners.set(scenario.id, element.id);
        return [
          ...(sectionChildren.has(scenario.id)
            ? [
                {
                  ruleId: "requirement-scenario-parenting",
                  elementRef: ref(scenario.id),
                  message: `Scenario \`${scenario.id}\` is a child only through \`requirement.scenarios\`; do not repeat it in a section \`children\` list.`,
                },
              ]
            : []),
          ...(priorOwner !== undefined && priorOwner !== element.id
            ? [
                {
                  ruleId: "requirement-scenario-parenting",
                  elementRef: ref(element.id, `scenarios/${index}`),
                  message: `Scenario \`${scenario.id}\` already belongs to requirement \`${priorOwner}\`.`,
                },
              ]
            : []),
          ...(priorOwner === element.id
            ? [
                {
                  ruleId: "requirement-scenario-parenting",
                  elementRef: ref(element.id, `scenarios/${index}`),
                  message: `Requirement \`${element.id}\` repeats scenario \`${scenario.id}\`; each source scenario appears exactly once.`,
                },
              ]
            : []),
        ];
      }
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
    for (const child of designStructuralChildren(element)) nested.add(child);
  }
  const ordered: DraftElement[] = [];
  const visited = new Set<string>();
  const visit = (element: DraftElement): void => {
    if (visited.has(element.id)) return;
    visited.add(element.id);
    if (element.kind === "requirement") ordered.push(element);
    for (const child of designStructuralChildren(element)) {
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
 * seat runs {@link REPORT_RULES} instead — it cites the round's own diff, not the
 * reviewed patchset, so the changed-region rule does not apply to it.
 */
export const LENS_RULES: readonly Rule[] = [
  kindAllowlist,
  noCodeBytes,
  noDialogue,
  citationWellFormed,
  elementReferencesResolve,
  citationResolves,
  unresolvableCitation,
  processVocabulary,
  noRemainderNarration,
  scaffoldIsNoiseLane,
  decisionGrounded,
  reportCoherent,
  designSourcesKnown,
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
 * The round-report seat's rule set (S1). The report is not a lens board: it cites
 * the round's own diff, so only the prose/kind screens plus report coherence apply.
 */
export const REPORT_RULES: readonly Rule[] = [
  kindAllowlist,
  noCodeBytes,
  noDialogue,
  citationWellFormed,
  elementReferencesResolve,
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
