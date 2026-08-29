import type {
  DomainCountKind,
  HostElement,
  LensBoard,
  LensKind,
  LensSection,
  SkippedHunk,
} from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Protocol-shaped board fixtures (C05 task 1.1). The spike's `lib/fixtures/*` are
// re-expressed here as `LensBoard`s built from the 13-kind HOST vocabulary — a
// `HostElement` tree plus the `LensSection` fold-line projection. Nothing here is
// invented shape: every board these helpers assemble validates against
// `LensBoardSchema` (board-data's parse, proven in the cluster-1 DOM test).
//
// The spike's four composite convenience kinds (spec-header / what-changes /
// capability-grid / task-progress) have no protocol home (Reconciliation 4), so
// their reading affordance is expressed through the canonical kinds — a spec
// header becomes a section title + prose, a capability becomes a `requirement`.
//
// Fixtures arrive ONLY through the bridge/source seam (the import fence): a surface
// never imports this directory; a test hands `fixtureBoardRead` to a MemoryBridge as
// the `board.read` handler. See `./index.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/** The fixture patchset every `code_ref` in these boards cites. */
export const FIXTURE_PATCHSET = "ps-438";

const AUTHOR = { kind: "lens-agent", id: "fixture" } as const;
const HUMAN = { kind: "human", id: "reviewer" } as const;

const withAuthor = <T extends object>(data: T) => ({ author: AUTHOR, ...data });

type SectionDelta = "new" | "reworked";

const DOMAIN_COUNT: Readonly<Record<string, DomainCountKind | undefined>> = {
  finding: "findings",
  decision: "decisions",
  requirement: "requirements",
  order_step: "steps",
  round_outcome: "outcomes",
  noise_verdict: "groups",
  code_ref: "files",
  review_comment: "comments",
};

// ── Element builders (each returns one HostElement in the canonical vocabulary) ──

export const prose = (id: string, markdown: string): HostElement => ({
  id,
  kind: "prose",
  data: withAuthor({ markdown }),
});

export const callout = (id: string, variant: string, body: string): HostElement => ({
  id,
  kind: "callout",
  data: withAuthor({ variant, body }),
});

export const annotation = (id: string, codeRefId: string, body: string): HostElement => ({
  id,
  kind: "annotation",
  data: withAuthor({ code_ref: codeRefId, body }),
});

export const codeRef = (
  id: string,
  path: string,
  startLine: number,
  endLine: number = startLine,
  symbol?: string,
): HostElement => ({
  id,
  kind: "code_ref",
  data: withAuthor({
    patchset_id: FIXTURE_PATCHSET,
    path,
    side: "head",
    start_line: startLine,
    end_line: endLine,
    ...(symbol === undefined ? {} : { symbol }),
  }),
});

export const finding = (
  id: string,
  opts: {
    severity: "high" | "medium" | "low";
    concern: string;
    status?: "open" | "addressed" | "dismissed";
    code?: readonly string[];
    concurrence?: readonly { model: string; agree: number; total: number }[];
  },
): HostElement => ({
  id,
  kind: "finding",
  data: withAuthor({
    severity: opts.severity,
    concern: opts.concern,
    status: opts.status ?? "open",
    code: [...(opts.code ?? [])],
    concurrence: [...(opts.concurrence ?? [])],
  }),
});

export const decision = (
  id: string,
  opts: {
    statement: string;
    why: string;
    evidence?: readonly string[];
    alternatives?: readonly string[];
  },
): HostElement => ({
  id,
  kind: "decision",
  data: withAuthor({
    statement: opts.statement,
    why: opts.why,
    evidence: [...(opts.evidence ?? [])],
    alternatives: [...(opts.alternatives ?? [])],
  }),
});

export const requirement = (
  id: string,
  opts: {
    shall: string;
    coverage?: "met" | "gap" | "partial";
    trace?: readonly string[];
  },
): HostElement => ({
  id,
  kind: "requirement",
  data: withAuthor({
    shall: opts.shall,
    coverage: opts.coverage ?? "met",
    trace: [...(opts.trace ?? [])],
  }),
});

export const noiseVerdict = (
  id: string,
  opts: {
    hunk: string;
    verdict?: "noise" | "signal";
    reason: string;
    judge?: "llm" | "deterministic";
  },
): HostElement => ({
  id,
  kind: "noise_verdict",
  data: withAuthor({
    hunk: opts.hunk,
    verdict: opts.verdict ?? "noise",
    reason: opts.reason,
    judge: opts.judge ?? "deterministic",
  }),
});

export const orderStep = (
  id: string,
  opts: { title: string; span: string; children?: readonly string[] },
): HostElement => ({
  id,
  kind: "order_step",
  data: withAuthor({ title: opts.title, span: opts.span, children: [...(opts.children ?? [])] }),
});

export const message = (
  id: string,
  opts: {
    role: "finding" | "question" | "discuss" | "request-change";
    replyTo?: string;
    codeRef?: string;
    quoteTarget?: string;
    quote?: string;
    lifecycle?: "staged" | "dispatched" | "addressed" | "retired" | "detached";
  },
): HostElement => ({
  id,
  kind: "message",
  // Human discussion, so a human author; the exchange TEXT lives transcript-side
  // (the review slice), never on the board element (Reconciliation 5).
  data: {
    author: HUMAN,
    role: opts.role,
    ...(opts.replyTo === undefined ? {} : { reply_to: opts.replyTo }),
    ...(opts.codeRef === undefined ? {} : { code_ref: opts.codeRef }),
    ...(opts.quoteTarget === undefined || opts.quote === undefined
      ? {}
      : { quote_target: opts.quoteTarget, quote: { quote: opts.quote } }),
    ...(opts.lifecycle === undefined ? {} : { lifecycle: opts.lifecycle }),
  },
});

// ── Section + board assembly ─────────────────────────────────────────────────

/** One assembled section: its `section` element + children (+ referenced elements),
 *  and the {@link LensSection} fold-line entry (gist + per-kind counts + delta). */
export interface AssembledSection {
  readonly elements: readonly HostElement[];
  readonly entry: LensSection;
}

/**
 * Build a top-level section from its title + rendered children. `refs` are elements
 * the children CITE (a finding's `code_ref`, a decision's evidence) — carried in the
 * board's element pool so a citation resolves, but not section children and not
 * counted on the fold line.
 */
export function section(
  id: string,
  title: string,
  gist: string,
  children: readonly HostElement[],
  opts: { delta?: SectionDelta; refs?: readonly HostElement[] } = {},
): AssembledSection {
  const sectionEl: HostElement = {
    id,
    kind: "section",
    data: withAuthor({
      title,
      children: children.map((c) => c.id),
      ...(opts.delta === undefined ? {} : { delta: opts.delta }),
    }),
  };
  const counts: Record<string, number> = {};
  const countedFilePaths = new Set<string>();
  for (const child of children) {
    const domain = DOMAIN_COUNT[child.kind];
    if (domain === undefined) continue;
    if (domain === "files") {
      if (child.kind !== "code_ref" || countedFilePaths.has(child.data.path)) continue;
      countedFilePaths.add(child.data.path);
    }
    counts[domain] = (counts[domain] ?? 0) + 1;
  }
  return {
    elements: [sectionEl, ...children, ...(opts.refs ?? [])],
    entry: {
      ref: id,
      gist,
      counts,
      ...(opts.delta === undefined ? {} : { delta: opts.delta }),
    },
  };
}

/** Assemble a {@link LensBoard} from its lens/generation identity and its sections. */
export function board(
  lens: LensKind,
  generation: string,
  boardId: string,
  sections: readonly AssembledSection[],
  opts: { skippedHunks?: readonly SkippedHunk[]; document?: LensBoard["document"] } = {},
): LensBoard {
  const title = `${lens[0]?.toUpperCase() ?? ""}${lens.slice(1)}`;
  return {
    lens,
    generation,
    boardId,
    document: opts.document ?? {
      title,
      introMarkdown: sections[0]?.entry.gist ?? `The ${title} reading of this change.`,
      measure: lens === "design" ? "structured" : "reading",
    },
    sections: sections.map((s) => s.entry),
    elements: sections.flatMap((s) => [...s.elements]),
    skippedHunks: [...(opts.skippedHunks ?? [])],
  };
}

/** A skipped-hunk entry — the path stands in as the stable hunk id in fixtures. */
export const skip = (path: string, reason: string): SkippedHunk => ({ hunk: path, reason });
