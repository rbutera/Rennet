/**
 * The board writer — what a board tool call actually does (`lens-board-tools` D4/D5).
 *
 * Pure: no I/O, no model, no Node. It holds one board, applies one tool call at a time,
 * and answers each call with either an outcome or a refusal. The daemon's loopback MCP
 * server (group 2) and the drafting runtime (group 3) are the callers; nothing calls it
 * yet, which is why this ships on its own.
 *
 * ── Ids and structure (D4) ───────────────────────────────────────────────────────
 * The HOST mints every id and returns it; a child names its PARENT and the host keeps
 * the parent's `children` in step. So the parenting graph is a forest, and every other
 * reference names an element minted earlier — a reference can only point backwards in
 * time. That is what makes a dangling reference and a reference cycle unconstructible
 * rather than checked.
 *
 * It is not left to that argument alone. `alternative_ids` is declared as an element
 * reference with no kind constraint, so a decision could in principle name an ancestor
 * section and close a loop through the host-maintained `children` edge, which is the one
 * edge that runs forward. Every mutation therefore goes through
 * {@link BoardWriter.introducedViolations}, which re-runs the boundary tier — including
 * `element-reference-resolves`, which owns both the dangle and the cycle — and refuses
 * any call that would make the board worse than it found it. The invariant is the
 * ordering; the check is what proves it, and `board-writer.test.ts` attempts both.
 *
 * ── Validation (D5) ──────────────────────────────────────────────────────────────
 * A refusal is the BOUNDARY tier: the same rule functions `lint` runs, over the board
 * the call would produce, reporting only what the call INTRODUCED. That is why a
 * refusal already names the field and says what would be admissible — the messages are
 * the lint messages, not a second vocabulary written to sit beside them.
 *
 * `finish` is the FINISH tier over the whole board, and it returns pointers only: a
 * rule id, an element ref and one sentence. No prose, no draft, no restated
 * instructions — the seat is holding all of that already.
 */

import {
  type Author,
  type BoardDocument,
  type BoardTarget,
  type BoardTool,
  boardToolsByName,
  type DraftBoard,
  type DraftElement,
  type DraftKind,
  type LensAbsenceReason,
  parseDraft,
  resolveBoardDocument,
  settleAbsentReasonFor,
  TYPED_KINDS_BY_TARGET,
  type Violation,
} from "@rennet/protocol";
import { type LintContext, type LintTarget, lintTier } from "./lint";

// ── Results ──────────────────────────────────────────────────────────────────

/**
 * One pointer from `finish`: which rule, which element (and field, where the rule
 * knows it), and one sentence. Structurally a {@link Violation} — the pointer grammar
 * the repair channel already speaks.
 */
export type FinishPointer = Violation;

/** What a successful call gives back. */
export type BoardToolOutcome =
  /** An `add`/`cite`/`update` — the host-minted id of the element it touched. */
  | { readonly kind: "element"; readonly id: string }
  | { readonly kind: "removed"; readonly ids: readonly string[] }
  | { readonly kind: "document" }
  | { readonly kind: "absent"; readonly reason: LensAbsenceReason; readonly note: string }
  | { readonly kind: "settled" }
  | { readonly kind: "pointers"; readonly pointers: readonly FinishPointer[] };

/**
 * The answer to one call. A refusal costs no attempt (D6) — the seat reads it and fixes
 * the thing inside the same turn — so it is an ordinary result here, never a throw.
 */
export type BoardToolResult =
  | { readonly ok: true; readonly outcome: BoardToolOutcome }
  | { readonly ok: false; readonly refusal: string };

/** How the board stands: still being written, finished, or declared absent. */
export type BoardWriterState = "drafting" | "settled" | "absent";

// ── Options ──────────────────────────────────────────────────────────────────

export interface BoardWriterOptions {
  /** Which board this is: one of the five lenses, or the round-report seat. */
  readonly target: LintTarget;
  /** The patchset knowledge every boundary rule reads. `lens` must match `target`. */
  readonly lint: LintContext;
  /** The seat that wrote each element. Host-supplied: it is on no tool input. */
  readonly author: Author;
  /**
   * Prefixes every minted id. Flagged runs two seats over one board (D9); giving each
   * writer its own prefix is what makes the ids they receive unable to collide when the
   * two are not sharing one counter.
   */
  readonly idPrefix?: string;
  /** The typed-kind assignment, overridable so a test can vary it. */
  readonly typedKinds?: Readonly<Record<BoardTarget, readonly DraftKind[]>>;
}

// ── Host-owned values (on no tool input; the host writes them) ───────────────

/** What the host stamps on each kind, over and above the `author` every kind carries. */
const HOST_DEFAULTS: Readonly<Partial<Record<DraftKind, Readonly<Record<string, unknown>>>>> = {
  // A drafted finding is `open` and has no cross-seat agreement yet: `reconcileFindings`
  // stamps concurrence and accord when both Flagged voices have settled.
  finding: { status: "open", concurrence: [] },
  // A seat is an `llm` judge; the deterministic one is a different producer entirely.
  noise_verdict: { judge: "llm" },
  // Maintained from the parent each call names.
  section: { children: [] },
  order_step: { children: [] },
};

/** How many ids a refusal lists before it says how many more there are. */
const HELD_ID_SAMPLE = 20;

// ── The writer ───────────────────────────────────────────────────────────────

export class BoardWriter {
  private readonly options: BoardWriterOptions;
  private readonly tools: ReadonlyMap<string, BoardTool>;
  private elements: DraftElement[] = [];
  private document: BoardDocument | undefined;
  private minted = 0;
  private state: BoardWriterState = "drafting";
  private absence: { reason: LensAbsenceReason; note: string } | undefined;

  constructor(options: BoardWriterOptions) {
    this.options = options;
    this.tools = boardToolsByName(options.target, options.typedKinds ?? TYPED_KINDS_BY_TARGET);
  }

  /** The tools this seat is given, in the order the surface builds them. */
  toolNames(): readonly string[] {
    return [...this.tools.keys()];
  }

  /** The board as it stands. Readable at any moment — a partial board is kept, not hidden. */
  board(): DraftBoard {
    return this.document === undefined
      ? { elements: [...this.elements] }
      : { document: this.document, elements: [...this.elements] };
  }

  /** Drafting, settled by `finish`, or settled absent. */
  status(): BoardWriterState {
    return this.state;
  }

  /** The absence a `settle_absent` declared, with the note the seat wrote. */
  declaredAbsence(): { readonly reason: LensAbsenceReason; readonly note: string } | undefined {
    return this.absence;
  }

  /** Apply one tool call. Never throws on bad input: a refusal is a result. `finish` and
   * every other argument-free verb take none. */
  call(name: string, rawInput?: unknown): BoardToolResult {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return refuse(
        `There is no \`${name}\` on this board. This lens writes with: ${this.toolNames().join(", ")}.`,
      );
    }
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `\`${issue.path.join(".") || "(input)"}\`: ${issue.message}`)
        .join("; ");
      return refuse(`\`${name}\` did not accept its arguments — ${issues}.`);
    }
    const input = parsed.data as Record<string, unknown>;

    switch (tool.verb) {
      case "set_document":
        return this.setDocument(tool, input);
      case "add":
        return this.add(tool, input);
      case "update":
        return this.update(tool, input);
      case "remove_element":
        return this.remove(input);
      case "settle_absent":
        return this.settleAbsent(input);
      case "finish":
        return this.finish();
    }
  }

  // ── Verbs ──────────────────────────────────────────────────────────────────

  private setDocument(tool: BoardTool, input: Record<string, unknown>): BoardToolResult {
    const authored = dataFromInput(tool, input, {});
    // `measure` is the target's, never the seat's: `resolveBoardDocument` is the one
    // place that decides it and it overrides whatever a board carries.
    const candidate = resolveBoardDocument(this.options.target, {
      ...(authored as BoardDocument),
      measure: "reading",
    });
    const next: DraftBoard = { document: candidate, elements: [...this.elements] };
    const structural = this.structuralRefusal(next);
    if (structural !== undefined) return refuse(structural);
    const introduced = this.introducedViolations(next);
    if (introduced.length > 0) return refuse(describe(introduced));
    this.document = candidate;
    return { ok: true, outcome: { kind: "document" } };
  }

  private add(tool: BoardTool, input: Record<string, unknown>): BoardToolResult {
    const kind = tool.kind;
    if (kind === undefined) return refuse(`\`${tool.name}\` authors no element.`);

    const parentId = typeof input.parent_id === "string" ? input.parent_id : undefined;
    const parentRefusal = this.checkParent(parentId);
    if (parentRefusal !== undefined) return refuse(parentRefusal);

    const referenceRefusal = this.checkReferences(tool, input);
    if (referenceRefusal !== undefined) return refuse(referenceRefusal);

    const id = this.mintId();
    const element = {
      id,
      kind,
      data: {
        author: this.options.author,
        ...(HOST_DEFAULTS[kind] ?? {}),
        ...dataFromInput(tool, input, {}),
      },
    } as DraftElement;

    const nextElements = [...this.elements, element];
    const withParent = parentId === undefined ? nextElements : adopt(nextElements, parentId, id);
    const next = this.withElements(withParent);

    const structural = this.structuralRefusal(next);
    if (structural !== undefined) {
      this.minted -= 1; // the call is refused, so the id was never handed out
      return refuse(structural);
    }
    const introduced = this.introducedViolations(next);
    if (introduced.length > 0) {
      this.minted -= 1;
      return refuse(describe(introduced));
    }
    this.elements = withParent;
    return { ok: true, outcome: { kind: "element", id } };
  }

  private update(tool: BoardTool, input: Record<string, unknown>): BoardToolResult {
    const elementId = String(input.element_id);
    const index = this.elements.findIndex((element) => element.id === elementId);
    if (index === -1) return refuse(this.unheldMessage(elementId));
    const current = this.elements[index];
    if (current === undefined) return refuse(this.unheldMessage(elementId));
    if (current.kind !== tool.kind) {
      return refuse(
        `\`${elementId}\` is a \`${current.kind}\`, not a \`${tool.kind}\`. Use this board's \`${tool.kind}\` verb instead.`,
      );
    }
    const referenceRefusal = this.checkReferences(tool, input);
    if (referenceRefusal !== undefined) return refuse(referenceRefusal);

    const patched = {
      ...current,
      data: {
        ...(current.data as Record<string, unknown>),
        ...dataFromInput(tool, input, current.data as Record<string, unknown>),
      },
    } as DraftElement;
    const nextElements = this.elements.map((element, at) => (at === index ? patched : element));
    const next = this.withElements(nextElements);

    const structural = this.structuralRefusal(next);
    if (structural !== undefined) return refuse(structural);
    const introduced = this.introducedViolations(next);
    if (introduced.length > 0) return refuse(describe(introduced));
    this.elements = nextElements;
    return { ok: true, outcome: { kind: "element", id: elementId } };
  }

  private remove(input: Record<string, unknown>): BoardToolResult {
    const elementId = String(input.element_id);
    if (!this.elements.some((element) => element.id === elementId)) {
      return refuse(this.unheldMessage(elementId));
    }
    const doomed = this.subtreeOf(elementId);
    const survivors = this.elements
      .filter((element) => !doomed.has(element.id))
      // The host maintains `children`, so a removed child leaves its parent's list with
      // it. Every OTHER reference is the seat's, and a survivor still pointing at a
      // removed element is what the boundary check below refuses on.
      .map((element) => withoutChildren(element, doomed));
    const next = this.withElements(survivors);

    const structural = this.structuralRefusal(next);
    if (structural !== undefined) return refuse(structural);
    const introduced = this.introducedViolations(next);
    if (introduced.length > 0) return refuse(describe(introduced));
    this.elements = survivors;
    return { ok: true, outcome: { kind: "removed", ids: [...doomed] } };
  }

  private settleAbsent(input: Record<string, unknown>): BoardToolResult {
    const reason = settleAbsentReasonFor(this.options.target);
    if (reason === undefined) {
      // Unreachable through the surface: a target with no admissible absence is given
      // no settle-absent verb at all. Answered rather than thrown, because a tool call
      // is never a crash.
      return refuse(`The ${this.options.target} lens admits no absence.`);
    }
    const note = String(input.note);
    this.absence = { reason, note };
    this.state = "absent";
    return { ok: true, outcome: { kind: "absent", reason, note } };
  }

  private finish(): BoardToolResult {
    const pointers = lintTier(this.board(), this.options.lint, "finish");
    if (pointers.length > 0) return { ok: true, outcome: { kind: "pointers", pointers } };
    this.state = "settled";
    return { ok: true, outcome: { kind: "settled" } };
  }

  // ── Refusal machinery ──────────────────────────────────────────────────────

  private mintId(): string {
    this.minted += 1;
    return `${this.options.idPrefix ?? ""}e${this.minted}`;
  }

  private withElements(elements: readonly DraftElement[]): DraftBoard {
    return this.document === undefined
      ? { elements: [...elements] }
      : { document: this.document, elements: [...elements] };
  }

  /** The ids the board holds, bounded — a tool result is not an inline payload. */
  private heldIds(): string {
    const ids = this.elements.map(({ id }) => id);
    if (ids.length === 0) return "the board is empty";
    const shown = ids.slice(0, HELD_ID_SAMPLE).join(", ");
    return ids.length > HELD_ID_SAMPLE
      ? `${shown}, and ${ids.length - HELD_ID_SAMPLE} more`
      : shown;
  }

  private unheldMessage(targetId: string): string {
    return `This board holds no \`${targetId}\`. It holds: ${this.heldIds()}.`;
  }

  /** D4 — a parent must be an element this board already holds, and must take children. */
  private checkParent(parentId: string | undefined): string | undefined {
    if (parentId === undefined) return undefined;
    const parent = this.elements.find((element) => element.id === parentId);
    if (parent === undefined) return this.unheldMessage(parentId);
    if (parent.kind !== "section" && parent.kind !== "order_step") {
      return `\`${parentId}\` is a \`${parent.kind}\`, which holds no children. A parent is a section or a step.`;
    }
    return undefined;
  }

  /** D4 — every reference argument names an element the board already holds. */
  private checkReferences(tool: BoardTool, input: Record<string, unknown>): string | undefined {
    const held = new Set(this.elements.map(({ id }) => id));
    for (const field of tool.fields) {
      if (field.source.form !== "element-ref") continue;
      const value = input[field.name];
      if (value === undefined) continue;
      const ids = Array.isArray(value) ? value : [value];
      for (const id of ids) {
        if (typeof id === "string" && held.has(id)) continue;
        return `\`${field.name}\` names \`${String(id)}\`, which this board does not hold. It holds: ${this.heldIds()}.`;
      }
    }
    return undefined;
  }

  /** The wire boundary: the board a call would produce must still parse as a draft. */
  private structuralRefusal(next: DraftBoard): string | undefined {
    const parsed = parseDraft(next);
    if (parsed.ok) return undefined;
    return `The call would not produce a valid element — ${parsed.issues
      .map((issue) => `\`${issue.path.join(".")}\`: ${issue.message}`)
      .join("; ")}.`;
  }

  /**
   * The boundary tier over the board the call WOULD produce, reporting only what the
   * call introduced. Comparing against what the board already carries is deliberate:
   * every call is checked, so the board is clean by induction, and a call is refused
   * for what IT did rather than for something a caller cannot fix from here.
   */
  private introducedViolations(next: DraftBoard): Violation[] {
    const before = new Set(lintTier(this.board(), this.options.lint, "boundary").map(violationKey));
    return lintTier(next, this.options.lint, "boundary").filter(
      (violation) => !before.has(violationKey(violation)),
    );
  }

  private subtreeOf(rootId: string): Set<string> {
    const byId = new Map(this.elements.map((element) => [element.id, element]));
    const doomed = new Set<string>();
    const visit = (id: string): void => {
      if (doomed.has(id)) return;
      doomed.add(id);
      const element = byId.get(id);
      if (element === undefined) return;
      const children = (element.data as { children?: unknown }).children;
      if (!Array.isArray(children)) return;
      for (const child of children) if (typeof child === "string") visit(child);
    };
    visit(rootId);
    return doomed;
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

const refuse = (refusal: string): BoardToolResult => ({ ok: false, refusal });

const violationKey = (violation: Violation): string =>
  `${violation.ruleId} ${violation.elementRef} ${violation.message}`;

/** A refusal reads as the rules that refused it — the lint messages, verbatim. */
function describe(violations: readonly Violation[]): string {
  return violations
    .map((violation) => `\`${violation.elementRef}\` (${violation.ruleId}): ${violation.message}`)
    .join(" ");
}

/** Append `childId` to `parentId`'s host-maintained `children`. */
function adopt(
  elements: readonly DraftElement[],
  parentId: string,
  childId: string,
): DraftElement[] {
  return elements.map((element) => {
    if (element.id !== parentId) return element;
    const data = element.data as Record<string, unknown>;
    const children = Array.isArray(data.children) ? data.children : [];
    return { ...element, data: { ...data, children: [...children, childId] } } as DraftElement;
  });
}

/** Drop `removed` ids from an element's host-maintained `children`. */
function withoutChildren(element: DraftElement, removed: ReadonlySet<string>): DraftElement {
  const data = element.data as Record<string, unknown>;
  if (!Array.isArray(data.children)) return element;
  const kept = data.children.filter((child) => !(typeof child === "string" && removed.has(child)));
  if (kept.length === data.children.length) return element;
  return { ...element, data: { ...data, children: kept } } as DraftElement;
}

/**
 * Rebuild an element's `data` from a flat tool input, using the tool's own field plan.
 * The plan is the derivation's other half: `protocol` decided which flat names exist and
 * where each lands, so nothing here re-states the mapping.
 */
function dataFromInput(
  tool: BoardTool,
  input: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // A `json` field arrives as its parts, so collect them before assembling.
  const single = new Map<string, Record<string, unknown>>();
  const listed = new Map<string, Map<string, unknown[]>>();

  for (const field of tool.fields) {
    const value = input[field.name];
    if (value === undefined) continue;
    const source = field.source;
    if (source.form === "scalar" || source.form === "element-ref") {
      out[source.dataField] = value;
      continue;
    }
    if (source.many) {
      const parts = listed.get(source.dataField) ?? new Map<string, unknown[]>();
      parts.set(source.part, Array.isArray(value) ? value : [value]);
      listed.set(source.dataField, parts);
    } else {
      const parts = single.get(source.dataField) ?? {
        ...((current[source.dataField] as Record<string, unknown> | undefined) ?? {}),
      };
      parts[source.part] = value;
      single.set(source.dataField, parts);
    }
  }

  for (const [dataField, parts] of single) out[dataField] = parts;
  for (const [dataField, parts] of listed) {
    // The list form is index-aligned: the first part is the spine, and a shorter or
    // absent companion list simply leaves that key off the entry it would have filled.
    const spine = tool.fields.find(
      (field) => field.source.form === "json-part" && field.source.dataField === dataField,
    );
    const spinePart =
      spine !== undefined && spine.source.form === "json-part" ? spine.source.part : undefined;
    const length = spinePart === undefined ? 0 : (parts.get(spinePart)?.length ?? 0);
    const entries: Record<string, unknown>[] = [];
    for (let index = 0; index < length; index += 1) {
      const entry: Record<string, unknown> = {};
      for (const [part, values] of parts) {
        const value = values[index];
        if (value !== undefined) entry[part] = value;
      }
      entries.push(entry);
    }
    out[dataField] = entries;
  }
  return out;
}
