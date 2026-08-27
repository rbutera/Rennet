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
 * (patchset hunk list, file→line-count index, the review lens); assembling it is
 * the cluster-5 runtime's job, not lint's.
 *
 * ── Reconciliation with #493's rule catalog (recorded in proposal.md ledger) ──
 * #493 was written against a RICHER imagined schema (a `finding.fix` field,
 * `finding.details`, `finding.body`, `requirement.status`, drafter-authored
 * section `counts`, a `noise-group` kind, a `thread` kind). B03 froze a leaner
 * 13-kind schema. So:
 *   - S1/S2 (no thread/message/`code` kind) are enforced STRUCTURALLY by
 *     `DraftBoardSchema` at parse time — not lint rules here (`parseDraft`
 *     rejects them with ZodError issues; see lint.test.ts).
 *   - L18 (cross-lens every-hunk coverage) runs at COMPOSITION → cluster 4.
 *   - L19 (typed-data immutability across post-process) is a POST-PASS assertion
 *     → cluster 3.
 *   - L5 (fix-in-body), L6 (body wall), L8 (drafter counts), L12 (noise-group
 *     edges), L16 (requirement-order) reference fields/kinds the frozen schema
 *     does not carry; L12 folds into `citation-resolves` on `noise_verdict.hunk`.
 * The residue — the per-draft rules whose fields DO exist — is implemented here.
 */

import type { DraftBoard, DraftElement, HunkId, LensKind, Violation } from "@rennet/protocol";

// ── The lint context (plain data the caller assembles) ───────────────────────

/** One patchset hunk, with the new-image range citations resolve against. */
export interface LintHunk {
  readonly id: HunkId;
  readonly path: string;
  /** 1-based first line of the hunk's new image. */
  readonly newStart: number;
  /** Line count of the hunk's new image (`newStart .. newStart + newLines - 1`). */
  readonly newLines: number;
}

/**
 * Lint input, per board. `files` maps a repo-relative path to its line count at
 * the review commit (citation resolution); `hunks` is the collation producer's
 * hunk list (coverage rules); `patchsetIdentifiers` is the R20 allowlist built
 * from the changed files (identifiers the change itself defines, so the process-
 * vocabulary screen does not fire on the reviewed code's own nouns).
 */
export interface LintContext {
  readonly lens: LensKind;
  readonly hunks: readonly LintHunk[];
  readonly files: ReadonlyMap<string, number>;
  readonly scaffoldGlobs?: readonly string[];
  readonly patchsetIdentifiers?: ReadonlySet<string>;
  /** Source artifact text, when the caller supplies it — enables `requirement-verbatim`. */
  readonly artifactText?: string;
}

/**
 * Scaffold paths that belong to the Noise lens (R22). A Design/Sequence/etc.
 * board citing one is a lane violation. Overridable via `ctx.scaffoldGlobs`.
 */
export const DEFAULT_SCAFFOLD_GLOBS: readonly string[] = [
  "**/.openspec.yaml",
  "**/openspec/**",
  "**/*.lock",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
];

/**
 * The typed domain kinds each lens owns. Shared structural kinds (`prose`,
 * `section`, `callout`, `annotation`, `code_ref`) are legal on every board; a
 * typed kind on the wrong board, or the report seat's `round_outcome` on any
 * lens board, is a lane violation. [extrapolated] from the lens prompts — the
 * rulings fix the intent (thread/message never from a drafter, S1), not the
 * exact per-lens list.
 */
const SHARED_KINDS: ReadonlySet<string> = new Set([
  "prose",
  "section",
  "callout",
  "annotation",
  "code_ref",
]);
const LENS_TYPED_KINDS: Readonly<Record<LensKind, readonly string[]>> = {
  flagged: ["finding"],
  decisions: ["decision", "requirement"],
  sequence: ["order_step"],
  noise: ["noise_verdict"],
  design: [],
};

// ── Field extraction (frozen-schema aware) ───────────────────────────────────

interface Field {
  readonly elementId: string;
  readonly field: string;
  readonly text: string;
}

/** Longform prose fields — the code-byte / dialogue / citation / remainder lane. */
function proseFields(el: DraftElement): Field[] {
  const id = el.id;
  const d = el.data as Record<string, unknown>;
  const out: Field[] = [];
  const push = (field: string) => {
    const v = d[field];
    if (typeof v === "string" && v.length > 0) out.push({ elementId: id, field, text: v });
  };
  switch (el.kind) {
    case "prose":
      push("markdown");
      break;
    case "callout":
      push("body");
      break;
    case "annotation":
      push("body");
      break;
    case "finding":
      push("concern");
      break;
    case "decision":
      push("statement");
      push("why");
      break;
    case "requirement":
      push("shall");
      break;
    case "noise_verdict":
      push("reason");
      break;
    case "round_outcome":
      push("note");
      break;
  }
  return out;
}

/**
 * Short structural fields — the process-vocabulary lane (R20). Body prose is NOT
 * lint's (#493 §5: post-process deletes a machinery sentence; lint can only
 * reject the whole element, and a body cannot lose a sentence without content).
 */
function structuralFields(el: DraftElement): Field[] {
  const id = el.id;
  const d = el.data as Record<string, unknown>;
  const out: Field[] = [];
  const push = (field: string) => {
    const v = d[field];
    if (typeof v === "string" && v.length > 0) out.push({ elementId: id, field, text: v });
  };
  switch (el.kind) {
    case "section":
      push("title");
      break;
    case "order_step":
      push("title");
      break;
    case "decision":
      push("statement");
      break;
    case "callout":
      push("variant");
      break;
  }
  return out;
}

const ref = (elementId: string, field?: string): string =>
  field === undefined ? elementId : `${elementId}/${field}`;

// ── R20 exemptions: strip backtick spans + the patchset-identifier allowlist ──

/** Text with inline `code` spans blanked out — a backticked token is not narration. */
function withoutInlineCode(text: string): string {
  return text.replace(/`[^`]*`/g, " ");
}

// ── The rules (each: pure, over one draft + ctx) ─────────────────────────────

type Rule = (draft: DraftBoard, ctx: LintContext) => Violation[];

const FENCE = /```/;
const INDENTED_BLOCK = /^ {4,}\S.*(?:\r?\n {4,}\S.*)+/m; // ≥2 indented lines
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

/** Every `path:line(-line)?` citation mention in a prose string. */
const CITATION = /(`?)([\w./@-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;
/** L3 — prose citations are full repo-relative `path:line`, never absolute/GitHub/basename. */
const citationWellFormed: Rule = (draft) =>
  draft.elements.flatMap((el) =>
    proseFields(el).flatMap(({ elementId, field, text }) => {
      const out: Violation[] = [];
      for (const m of text.matchAll(CITATION)) {
        const path = m[2] ?? "";
        const end = (m.index ?? 0) + m[0].length;
        const absolute = path.startsWith("/") || path.startsWith("~");
        const githubForm = /#l/i.test(text.slice(end, end + 2));
        const basenameOnly = !path.includes("/");
        if (absolute || githubForm || basenameOnly) {
          out.push({
            ruleId: "citation-well-formed",
            elementRef: ref(elementId, field),
            message: `R25/R26: cite \`${path}:${m[3]}\` as a repo-relative path:line — no leading / or ~, no #L form, no bare basename.`,
          });
        }
      }
      return out;
    }),
  );

/** L4 — every citation resolves against the worktree index (prose + typed code_ref). */
const citationResolves: Rule = (draft, ctx) => {
  const out: Violation[] = [];
  const lineOk = (path: string, line: number): boolean => {
    const count = ctx.files.get(path);
    return count !== undefined && line >= 1 && line <= count;
  };
  for (const el of draft.elements) {
    // Prose path:line mentions.
    for (const { elementId, field, text } of proseFields(el)) {
      for (const m of text.matchAll(CITATION)) {
        const path = m[2] ?? "";
        // Malformed citations (absolute / bare basename) are L3's lane, not L4's.
        if (!path.includes("/") || path.startsWith("/") || path.startsWith("~")) continue;
        const start = Number(m[3]);
        const end = m[4] === undefined ? start : Number(m[4]);
        if (!ctx.files.has(path)) {
          out.push({
            ruleId: "citation-resolves",
            elementRef: ref(elementId, field),
            message: `Citation \`${path}:${m[3]}\` does not resolve: no such file at the review commit.`,
          });
        } else if (!lineOk(path, end)) {
          out.push({
            ruleId: "citation-resolves",
            elementRef: ref(elementId, field),
            message: `Citation \`${path}:${m[3]}\` overruns the file (${ctx.files.get(path)} lines).`,
          });
        }
      }
    }
    // Typed code_ref elements (also covers L12's noise_verdict.hunk edge).
    if (el.kind === "code_ref") {
      const d = el.data as { path?: unknown; start_line?: unknown; end_line?: unknown };
      const path = typeof d.path === "string" ? d.path : "";
      const startLine = typeof d.start_line === "number" ? d.start_line : 0;
      const endLine = typeof d.end_line === "number" ? d.end_line : startLine;
      if (!ctx.files.has(path)) {
        out.push({
          ruleId: "citation-resolves",
          elementRef: ref(el.id),
          message: `code_ref cites \`${path}\` — no such file at the review commit.`,
        });
      } else if (!lineOk(path, endLine)) {
        out.push({
          ruleId: "citation-resolves",
          elementRef: ref(el.id),
          message: `code_ref \`${path}:${startLine}-${endLine}\` overruns the file (${ctx.files.get(path)} lines).`,
        });
      }
    }
  }
  return out;
};

const PROCESS_VOCAB =
  /\b(?:lens(?:es)?|boards?|agents?|seats?|drafts?|orchestrator|unslop|post-process|the review process|this review|the pipeline)\b/i;
/** L7 — no machinery vocabulary in structural fields (R20), with the F2 exemptions. */
const processVocabulary: Rule = (draft, ctx) =>
  draft.elements.flatMap((el) =>
    structuralFields(el).flatMap(({ elementId, field, text }) => {
      // Exemption 1: a match inside backticks is a code token, not narration.
      let screened = withoutInlineCode(text);
      // Exemption 2: identifiers the changed files themselves define are the
      // change's vocabulary, not the pipeline's — blank them out.
      if (ctx.patchsetIdentifiers) {
        for (const id of ctx.patchsetIdentifiers) {
          if (id.length > 0) screened = screened.split(id).join(" ");
        }
      }
      if (PROCESS_VOCAB.test(screened)) {
        return [
          {
            ruleId: "process-vocabulary",
            elementRef: ref(elementId, field),
            message:
              "R20: a structural field names the machinery (lens/board/agent/seat/draft/…). Name the domain object, not the pipeline. Backtick a real identifier to exempt it.",
          },
        ];
      }
      return [];
    }),
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
  // Minimal glob: `**` → any run (incl. /), `*` → any run without /. Split on
  // `**` first so the two wildcards never collide (no sentinel needed).
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .split("**")
    .map((seg) => seg.replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`).test(path);
}
/** L10 — scaffold stamps are the Noise lane (R22): only Noise cites a scaffold path. */
const scaffoldIsNoiseLane: Rule = (draft, ctx) => {
  if (ctx.lens === "noise") return [];
  const globs = ctx.scaffoldGlobs ?? DEFAULT_SCAFFOLD_GLOBS;
  return draft.elements.flatMap((el) => {
    if (el.kind !== "code_ref") return [];
    const path = (el.data as { path?: unknown }).path;
    if (typeof path !== "string") return [];
    return globs.some((g) => matchesGlob(path, g))
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
  // "Taught": any code_ref whose new-image line range overlaps a hunk on its path.
  const taught = new Set<string>();
  for (const el of draft.elements) {
    if (el.kind !== "code_ref") continue;
    const d = el.data as { path?: unknown; start_line?: unknown; end_line?: unknown };
    const path = typeof d.path === "string" ? d.path : "";
    const start = typeof d.start_line === "number" ? d.start_line : 0;
    const end = typeof d.end_line === "number" ? d.end_line : start;
    for (const h of ctx.hunks) {
      if (h.path !== path) continue;
      const hEnd = h.newStart + h.newLines - 1;
      if (start <= hEnd && end >= h.newStart) taught.add(h.id);
    }
  }
  const both = [...skipped].filter((id) => taught.has(id));
  return both.map((id) => ({
    ruleId: "no-taught-and-skipped",
    elementRef: "/skippedHunks",
    message: `R19: hunk \`${id}\` is both taught and skipped on this board — incoherent. Teach it or skip it, not both.`,
  }));
};

// ── Report-seat coherence (round_outcome) ────────────────────────────────────

const STATUS_ORDER = ["addressed", "partial", "untouched", "beyond"] as const;
/** L17 — round-report items are status-sorted; a `beyond` item names work, not an ask. */
const reportCoherent: Rule = (draft) => {
  const out: Violation[] = [];
  const outcomes = draft.elements.filter((el) => el.kind === "round_outcome");
  let prevRank = -1;
  for (const el of outcomes) {
    const d = el.data as { status?: unknown; ask?: unknown; note?: unknown };
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
      const ask = d.ask as { ref?: unknown } | undefined;
      const note = typeof d.note === "string" ? d.note : "";
      const askRef = ask && typeof ask.ref === "string" ? ask.ref : "";
      if (askRef.length > 0 || note.trim().length === 0) {
        out.push({
          ruleId: "report-coherent",
          elementRef: ref(el.id),
          message:
            "R57: a `beyond` item names work the round did on its own — leave `ask.ref` empty and give a `note`.",
        });
      }
    }
  }
  return out;
};

/** L13 — a requirement's `shall` text is verbatim in the source artifact (anti-paraphrase). */
const requirementVerbatim: Rule = (draft, ctx) => {
  if (ctx.artifactText === undefined) return []; // degrade: only checkable with the source
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const haystack = normalize(ctx.artifactText);
  return draft.elements.flatMap((el) => {
    if (el.kind !== "requirement") return [];
    const shall = (el.data as { shall?: unknown }).shall;
    if (typeof shall !== "string" || shall.length === 0) return [];
    return haystack.includes(normalize(shall))
      ? []
      : [
          {
            ruleId: "requirement-verbatim",
            elementRef: ref(el.id, "shall"),
            message:
              "SHALL text is quoted, not summarized: the requirement's `shall` is not a verbatim substring of the source artifact.",
          },
        ];
  });
};

/** Kind allowlist — no message/thread/off-lens typed kind, nor the report seat's kind. */
const kindAllowlist: Rule = (draft, ctx) => {
  const allowed = new Set<string>([...SHARED_KINDS, ...LENS_TYPED_KINDS[ctx.lens]]);
  return draft.elements.flatMap((el) =>
    allowed.has(el.kind)
      ? []
      : [
          {
            ruleId: "kind-allowlist",
            elementRef: ref(el.id),
            message: `Kind \`${el.kind}\` is not one the ${ctx.lens} lens authors (S1: thread/message are curation-only; typed kinds belong to their home lens).`,
          },
        ],
  );
};

/** The per-draft rule registry, in evaluation order. */
export const LINT_RULES: readonly Rule[] = [
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
  reportCoherent,
  requirementVerbatim,
];

/**
 * Lint a draft board against its context. Pure. Returns every {@link Violation}
 * across all rules; an empty array is a clean board. The retry channel that
 * feeds violations back to the drafter is cluster 3 (`validate.ts`).
 */
export function lint(draft: DraftBoard, ctx: LintContext): Violation[] {
  return LINT_RULES.flatMap((rule) => rule(draft, ctx));
}
