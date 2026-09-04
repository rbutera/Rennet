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
 * It is not left to that argument alone, because the boundary does not constrain what
 * KIND a reference names — `checkReferences` asks only whether the board holds the id.
 * So `alternative_ids`, `evidence_ref_ids`, `scenario_ids`, `trace_ref_ids` and
 * `code_ref_ids` can all name an ancestor section and close a loop through the
 * host-maintained `children` edge, which is the one edge that runs forward. Every
 * mutation therefore goes through {@link BoardWriter.introducedViolations}, which
 * re-runs the boundary tier — including `element-reference-resolves`, which owns both
 * the dangle and the cycle — and refuses any call that would make the board worse than
 * it found it. The invariant is the ordering; the check is what proves it, and
 * `board-writer.test.ts` attempts a cycle on both the add path and the update path.
 *
 * ── Validation (D5) ──────────────────────────────────────────────────────────────
 * A refusal is the BOUNDARY tier: the same rule functions `lint` runs, over the board
 * the call would produce, reporting only what the call INTRODUCED. That is why a
 * refusal already names the field and says what would be admissible — the messages are
 * the lint messages, not a second vocabulary written to sit beside them.
 *
 * `finish` is the FINISH tier over the whole board, and it returns pointers only: a
 * rule id, an element ref and one sentence. No board, no draft, no restated
 * instructions — the seat is holding all of that already. The sentence stays, because
 * it is the correction; see {@link FinishPointer}.
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
 *
 * **A pointer carries its message, and that is the contract.** "Pointers only" in the
 * spec means the verdict does not re-send the board, the draft or the base prompt —
 * all of which the seat is already holding — and not that a pointer is an address with
 * no words. The words are the correction: a rule id and an element ref tell a seat
 * WHERE, and the sentence is the only part that tells it WHAT, for a handful of tokens.
 * Recorded here because the alias to the full {@link Violation} would otherwise read as
 * an oversight next to a doc that says "pointers only".
 *
 * What is genuinely unbounded is the LIST: a board with many violations returns many
 * pointers, and nothing caps that yet. It is a group-3 item, named in the PR.
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
  /**
   * The patchset knowledge every boundary rule reads, WITHOUT its lens: the lens is
   * {@link BoardWriterOptions.target}, and the writer sets it.
   *
   * It used to be a whole {@link LintContext} whose `lens` was documented as having to
   * match `target` and was never checked — so a Flagged writer could be handed a Noise
   * lint context, hand out Flagged verbs, and let `scaffold-is-noise-lane` through
   * because the rules believed they were linting Noise. One source, no agreement to
   * keep.
   */
  readonly lint: Omit<LintContext, "lens">;
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

  private readonly lint: LintContext;

  constructor(options: BoardWriterOptions) {
    this.options = options;
    this.lint = { ...options.lint, lens: options.target };
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

  /**
   * Drafting, settled by `finish`, or settled absent.
   *
   * A settlement is a statement about the board as it stood when `finish` returned, so
   * any later mutation takes it back to `drafting` ({@link BoardWriter.reopen}). The
   * seat is NOT refused — writing after a finish is ordinary work, and refusing it would
   * be a restriction dressed as bookkeeping. What is not allowed is this method going on
   * reporting a settlement over a board that has moved since.
   */
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
    const alignment = this.checkListAlignment(tool, input);
    if (alignment !== undefined) return refuse(alignment);
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
    if (introduced.length > 0) return refuse(describe(introduced, tool, "/document"));
    this.document = candidate;
    this.reopen();
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

    const alignment = this.checkListAlignment(tool, input);
    if (alignment !== undefined) return refuse(alignment);

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
      return refuse(describe(introduced, tool, id));
    }
    this.elements = withParent;
    this.reopen();
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

    const alignment = this.checkListAlignment(tool, input);
    if (alignment !== undefined) return refuse(alignment);

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
    if (introduced.length > 0) return refuse(describe(introduced, tool, elementId));
    this.elements = nextElements;
    this.reopen();
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
    this.reopen();
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
    const pointers = lintTier(this.board(), this.lint, "finish");
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

  /**
   * A list-valued structured field arrives as parallel arrays the seat keeps in step by
   * index. Two ways to get that wrong, and both used to pass silently: naming a
   * companion without its spine (the rebuilt list was sized off the spine, so an absent
   * spine wrote an EMPTY list over whatever was there), and giving the arrays different
   * lengths (the extras past the spine were dropped, and the entries the spine outran
   * were built missing a key).
   *
   * Both are refused here, naming the field and what would be admissible. This is not a
   * gate: it is the difference between a call doing what the tool says it does and a
   * call quietly discarding the seat's work. `update_*` promises "only the fields given
   * change", and an update that wipes a field it was not given is that promise broken.
   */
  private checkListAlignment(tool: BoardTool, input: Record<string, unknown>): string | undefined {
    const groups = new Map<string, { spine?: string; given: { name: string; length: number }[] }>();
    for (const field of tool.fields) {
      const source = field.source;
      if (source.form !== "json-part" || !source.many) continue;
      const group = groups.get(source.dataField) ?? { given: [] };
      // Field order is schema order, so the first part of a group is its spine.
      group.spine ??= field.name;
      const value = input[field.name];
      if (Array.isArray(value)) group.given.push({ name: field.name, length: value.length });
      groups.set(source.dataField, group);
    }

    for (const group of groups.values()) {
      if (group.given.length === 0) continue;
      const spineName = group.spine;
      const spine = group.given.find((entry) => entry.name === spineName);
      if (spine === undefined) {
        const named = group.given.map((entry) => `\`${entry.name}\``).join(", ");
        return `${named} needs \`${spineName}\` alongside it: this list is written whole, one entry per \`${spineName}\`. Give \`${spineName}\` too, or leave the list out entirely.`;
      }
      const mismatched = group.given.find((entry) => entry.length !== spine.length);
      if (mismatched !== undefined) {
        return `\`${mismatched.name}\` has ${mismatched.length} ${mismatched.length === 1 ? "entry" : "entries"} and \`${spine.name}\` has ${spine.length}. They are index-aligned: give exactly one \`${mismatched.name}\` per \`${spine.name}\`.`;
      }
    }
    return undefined;
  }

  /**
   * A mutation after a settlement un-settles the board. See {@link BoardWriter.status}:
   * the call goes through, and the claim that it finished does not survive it.
   */
  private reopen(): void {
    if (this.state !== "drafting") {
      this.state = "drafting";
      this.absence = undefined;
    }
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
    const before = new Set(lintTier(this.board(), this.lint, "boundary").map(violationKey));
    return lintTier(next, this.lint, "boundary").filter(
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

/**
 * The tool inputs a rule is ABOUT, for the rules that report against a whole element
 * rather than one of its fields. Without this a `cite` refusal named `e7` — an id the
 * host minted and then rolled back, so it names nothing the seat has ever seen or can
 * act on — where task 1.6 asks a refusal to name the field.
 */
const RULE_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "citation-resolves": ["path", "side", "start_line", "end_line"],
  "unresolvable-citation": ["path", "side", "start_line", "end_line"],
  "scaffold-is-noise-lane": ["path"],
};

/**
 * What a violation should be called in a refusal: the tool INPUT field it is about.
 *
 * A violation's `elementRef` is `<id>` or `<id>/<dataField>`, in the element vocabulary
 * — which is the right pointer for `finish`, where the seat holds the ids, and the
 * wrong one for a refusal, where the element does not exist and the id has been
 * returned to the pool. So a violation against the element this call touched is
 * translated: by its data field where it has one, and by {@link RULE_INPUT_FIELDS}
 * where the rule reports element-wide. A violation against any OTHER element keeps its
 * element ref, because that one really is on the board and the seat can address it.
 */
function pointerLabel(
  tool: BoardTool,
  touchedId: string | undefined,
  violation: Violation,
): string {
  const { elementRef, ruleId } = violation;
  if (touchedId === undefined) return `\`${elementRef}\``;

  // The touched thing is an element id, or the board-level `/document`. Anything that
  // is not a suffix of it belongs to another element and keeps its own ref.
  let suffix: string | undefined;
  if (elementRef === touchedId) suffix = undefined;
  else if (elementRef.startsWith(`${touchedId}/`)) suffix = elementRef.slice(touchedId.length + 1);
  else return `\`${elementRef}\``;

  if (suffix === undefined) {
    const own = new Set(tool.fields.map((field) => field.name));
    const about = (RULE_INPUT_FIELDS[ruleId] ?? []).filter((name) => own.has(name));
    return about.length > 0 ? about.map((name) => `\`${name}\``).join(", ") : `\`${tool.name}\``;
  }

  // A pointer into a structured field is NESTED and may carry a list index:
  // `source/line`, `sources/0/path`, `scenarios/2`. The flat input that owns it is
  // named by the data field and, where the pointer goes deeper, by the part —
  // `source/line` is `source_line`, `sources/0/path` is `source_paths`. Matching the
  // whole suffix as one data field found nothing and echoed `source/line` back at the
  // seat, which is not a field it can change.
  const segments = suffix.split("/").filter((segment) => !/^\d+$/.test(segment));
  const [dataField, part] = segments;
  const named = tool.fields.find((field) => {
    if (field.source.dataField !== dataField) return false;
    if (part === undefined) return field.source.form !== "json-part";
    return field.source.form === "json-part" && field.source.part === part;
  });
  return `\`${named?.name ?? suffix}\``;
}

/**
 * A refusal reads as the rules that refused it — the lint messages, verbatim — under
 * the name of the input the seat actually sent.
 */
function describe(violations: readonly Violation[], tool?: BoardTool, touchedId?: string): string {
  return violations
    .map((violation) => {
      const label =
        tool === undefined
          ? `\`${violation.elementRef}\``
          : pointerLabel(tool, touchedId, violation);
      return `${label} (${violation.ruleId}): ${violation.message}`;
    })
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
    // The list form is index-aligned, and `checkListAlignment` has already refused a
    // group whose spine is missing or whose arrays disagree — so by here the spine is
    // present and every companion is the same length. Sizing off the spine when it is
    // ABSENT is what wrote an empty list over a field the call never mentioned.
    //
    // The `continue` below is therefore UNREACHABLE through `call()` today, and no test
    // exercises it: a group only reaches `listed` when the input carried one of its
    // parts, and `checkListAlignment` refuses that group unless its spine is among them.
    // It stays because this helper is otherwise correct only by its caller's ordering,
    // and the failure it guards against is silent.
    const spine = tool.fields.find(
      (field) => field.source.form === "json-part" && field.source.dataField === dataField,
    );
    const spinePart =
      spine !== undefined && spine.source.form === "json-part" ? spine.source.part : undefined;
    const spineValues = spinePart === undefined ? undefined : parts.get(spinePart);
    if (spineValues === undefined) continue; // not this call's field to rewrite
    const entries: Record<string, unknown>[] = [];
    for (let index = 0; index < spineValues.length; index += 1) {
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
