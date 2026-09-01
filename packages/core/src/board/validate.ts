/**
 * Board validation loop — the retry ladder of the draft pipeline (#493, B08).
 *
 * `validateDraft` is the deterministic guarantee between a drafter's structured
 * return and a human seeing the board. It is pure over two injected seams — the
 * re-draft channel (`runTurn`) and the cluster-5 post-process editor pass — so no
 * model, no I/O, no Node lives here. It consumes the B03-frozen seam verbatim
 * (`parseDraft`, `DraftBoard`, `Violation`, `Blemish`) and the cluster-2 lint
 * layer (`lint`); it re-models neither (reconciliation 2).
 *
 * The channel (#493): a lint (or parse) failure returns the draft to its seat as
 * ZodError-shaped JSON pointers on ONE channel; the seat returns a patch; passing
 * elements FREEZE (a frozen element is never re-linted's-fault nor re-drafted). A
 * one repair turn ends in an HONEST-OMISSION exit for an offending element: the
 * element is dropped and the hunks it taught move to `skippedHunks` with a reason.
 * Unresolved board or schema violations ship as labeled `blemishes[]`
 * (`Violation` + `attempts`) — visible, never blocking (Rule Zero: no gate).
 *
 * Three gates, in order: **lint** (the loop above, plus a reference check after
 * post-process) → **immutability** (typed lens-output data is byte-identical
 * across the editor pass — L19) → **composition** every-hunk coverage
 * (cluster-4 mechanics; wired here as an injected seam, defaulting to a no-op
 * until `compose` lands).
 */

import type { Blemish, DraftBoard, DraftElement, Violation } from "@rennet/protocol";
import { parseDraft } from "@rennet/protocol";
import { type LintContext, lint, taughtHunkIds } from "./lint";

// ── Tunables ─────────────────────────────────────────────────────────────────

/** The single repair rung: an element still invalid afterward is omitted. */
export const LADDER_RUNGS = 1;
/** The global model-repair cap after the initial draft. */
export const RETRY_CAP = 1;

// ── The seams the cluster-5 runtime injects ──────────────────────────────────

/** One ZodError-shaped pointer fed back to the seat on the retry channel. */
export interface RetryPointer {
  /** The JSON path into the draft, ZodError-shaped (`["elements", 2, "data", "concern"]`). */
  readonly path: readonly (string | number)[];
  readonly message: string;
  /** The lint rule that fired; absent for a parse (schema) issue. */
  readonly ruleId?: string;
  /** Which escalation rung (1..{@link LADDER_RUNGS}) the offending element is on. */
  readonly rung: number;
}

/** The re-draft request handed to the seat — the current draft + why it failed. */
export interface RetryRequest {
  /** The current draft: frozen elements verbatim, only the rest is the seat's to fix. */
  readonly draft: DraftBoard;
  readonly pointers: readonly RetryPointer[];
  /** The global 1-based retry number (bounded by {@link RETRY_CAP}). */
  readonly attempt: number;
}

export interface ValidateSeams {
  /** The re-draft channel: the seat returns a patch (a raw structured board). */
  readonly runTurn: (request: RetryRequest) => Promise<unknown> | unknown;
  /**
   * The cluster-5 board-post-process editor pass, run between the lint loop and
   * the immutability gate. Identity by default (cluster 3 has no editor); it may
   * polish prose but the immutability gate proves it never touches typed data.
   */
  readonly postProcess?: (board: DraftBoard) => Promise<unknown> | unknown;
  /**
   * Gate 3 — composition every-hunk coverage. Cluster 4 supplies the real
   * cross-lens `compose` assertion; the seam is wired here so the ordering holds
   * the day it lands. No-op by default (single-board validation has no coverage
   * obligation — that is cross-lens, cluster 4).
   */
  readonly compositionGate?: (board: DraftBoard, ctx: LintContext) => Violation[];
}

// ── The result ───────────────────────────────────────────────────────────────

/** One honest-omission drop: the element the ladder gave up on and the hunks it shed. */
export interface Omission {
  readonly elementId: string;
  readonly hunks: readonly string[];
  readonly reason: string;
}

export interface ValidateResult {
  /** The validated board — frozen passers, patched fixes, omitted drops removed. */
  readonly board: DraftBoard;
  /** Honest-omission drops; their hunks are already folded into `board.skippedHunks`. */
  readonly omissions: readonly Omission[];
  /** Cap-exhaustion leftovers — visible, never blocking. */
  readonly blemishes: readonly Blemish[];
  /** Gate 2 — typed-data immutability across post-process (empty = clean). */
  readonly immutability: readonly Violation[];
  /** Gate 3 — composition every-hunk coverage (cluster-4 seam; empty by default). */
  readonly composition: readonly Violation[];
  /** How many model repair turns were spent. */
  readonly attempts: number;
  /**
   * Whether ANY drafter return parsed. `false` means every turn (initial + retries)
   * failed to parse and the board is the synthetic empty fallback — the caller must
   * surface this as a lens FAILURE, never as an empty-but-successful board (finding 6).
   */
  readonly everParsed: boolean;
}

// ── ZodError-shaped pointers (elementRef → JSON path) ────────────────────────

const OMISSION_REASON_KINDS: ReadonlySet<string> = new Set([
  "finding",
  "decision",
  "requirement",
  "noise_verdict",
  "order_step",
  "round_outcome",
]);

/**
 * The narrative kinds the post-process editor may freely add, drop, or rewrite —
 * pure connective furniture. EVERY OTHER kind is typed lens output, immutable
 * across the editor pass (L19 / finding 4: a `code_ref`, `section`, or any typed
 * block is not the editor's to alter, drop, or forge).
 */
const EDITOR_NARRATIVE_KINDS: ReadonlySet<string> = new Set(["prose", "callout", "annotation"]);

/** The element id a violation is against (elementRef is `id` or `id/field` or `/board...`). */
function offendingId(elementRef: string): string | undefined {
  if (elementRef.startsWith("/")) return undefined; // board-level (skippedHunks) — not an element
  const slash = elementRef.indexOf("/");
  return slash === -1 ? elementRef : elementRef.slice(0, slash);
}

/** Turn a `Violation.elementRef` into a ZodError-shaped JSON path against `draft`. */
function pointerPath(elementRef: string, draft: DraftBoard): (string | number)[] {
  if (elementRef.startsWith("/")) {
    // Board-level: `/skippedHunks` or `/skippedHunks/0`.
    return elementRef
      .slice(1)
      .split("/")
      .map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
  }
  const slash = elementRef.indexOf("/");
  const id = slash === -1 ? elementRef : elementRef.slice(0, slash);
  const field = slash === -1 ? undefined : elementRef.slice(slash + 1);
  const index = draft.elements.findIndex((el) => el.id === id);
  const base: (string | number)[] = index === -1 ? ["elements"] : ["elements", index];
  return field === undefined ? base : [...base, "data", field];
}

// ── Honest omission: the hunks a dropped element taught ──────────────────────

/** The code_ref ids a dropped element owns — itself if it is one, plus any it references. */
function ownedCodeRefs(el: DraftElement, codeRefIds: ReadonlySet<string>): Set<string> {
  const owned = new Set<string>();
  if (el.kind === "code_ref") owned.add(el.id);
  for (const value of Object.values(el.data as Record<string, unknown>)) {
    if (typeof value === "string" && codeRefIds.has(value)) owned.add(value);
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string" && codeRefIds.has(v)) owned.add(v);
    }
  }
  return owned;
}

/**
 * Rewrite an element to remove `dropped` ids from its ARRAY reference fields (a
 * finding's `code`, a section's `children`), and report whether a SCALAR
 * reference field (a `noise_verdict`'s `hunk`) still points at a dropped id — an
 * unpatchable dangle that forces the element to cascade-omit (finding 5).
 */
function patchOutDropped(
  el: DraftElement,
  dropped: ReadonlySet<string>,
): { el: DraftElement; danglingScalar: boolean } {
  const data = el.data as Record<string, unknown>;
  let changed = false;
  let danglingScalar = false;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      const filtered = v.filter((x) => !(typeof x === "string" && dropped.has(x)));
      if (filtered.length !== v.length) changed = true;
      next[k] = filtered;
    } else {
      if (typeof v === "string" && dropped.has(v)) danglingScalar = true;
      next[k] = v;
    }
  }
  return { el: changed ? ({ ...el, data: next } as DraftElement) : el, danglingScalar };
}

/** The patchset hunks a set of code_ref elements overlaps (side-aware, finding 8). */
function hunksTaughtBy(
  codeRefIds: ReadonlySet<string>,
  draft: DraftBoard,
  ctx: LintContext,
): string[] {
  const shed = draft.elements.filter((el) => el.kind === "code_ref" && codeRefIds.has(el.id));
  return [...taughtHunkIds(shed, ctx.hunks)];
}

// ── Skipped-hunks passthrough helpers ────────────────────────────────────────

interface SkipEntry {
  readonly hunk: string;
  readonly reason: string;
}
function readSkips(board: DraftBoard): SkipEntry[] {
  const raw = (board as { skippedHunks?: unknown }).skippedHunks;
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => {
    const o = (e ?? {}) as { hunk?: unknown; reason?: unknown };
    return {
      hunk: typeof o.hunk === "string" ? o.hunk : "",
      reason: typeof o.reason === "string" ? o.reason : "",
    };
  });
}

// ── Immutability gate (L19 — typed data survives the editor pass byte-for-byte) ─

/** Stable JSON: object keys sorted, so an insertion-order shuffle is not a diff. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Gate 2 — the board is compared BIDIRECTIONALLY across the editor pass (L19 /
 * finding 4). Every typed element (any kind outside {@link EDITOR_NARRATIVE_KINDS})
 * must survive with byte-identical `data`, its kind unchanged; a typed element may
 * neither VANISH nor APPEAR (a forged finding or a post-process-edited `code_ref`
 * is caught), and the board's SET of skipped hunk ids may not change (the editor
 * may polish a skip's reason prose, never invent or drop coverage). A fault
 * surfaces (visible), never blocks.
 */
export function checkImmutability(before: DraftBoard, after: DraftBoard): Violation[] {
  const beforeById = new Map(before.elements.map((el) => [el.id, el]));
  const afterById = new Map(after.elements.map((el) => [el.id, el]));
  const out: Violation[] = [];

  // A typed element present before the pass must survive it byte-identical.
  for (const el of before.elements) {
    if (EDITOR_NARRATIVE_KINDS.has(el.kind)) continue;
    const post = afterById.get(el.id);
    if (post === undefined) {
      out.push({
        ruleId: "typed-data-immutable",
        elementRef: el.id,
        message: `Post-process dropped typed \`${el.kind}\` element \`${el.id}\` — typed lens output is immutable across the editor pass.`,
      });
    } else if (post.kind !== el.kind) {
      out.push({
        ruleId: "typed-data-immutable",
        elementRef: el.id,
        message: `Post-process changed \`${el.id}\`'s kind from \`${el.kind}\` to \`${post.kind}\` — an element's kind is typed lens output.`,
      });
    } else if (stableStringify(post.data) !== stableStringify(el.data)) {
      out.push({
        ruleId: "typed-data-immutable",
        elementRef: el.id,
        message: `Post-process altered typed \`${el.kind}\` element \`${el.id}\`'s data — the editor may polish prose, never typed lens output.`,
      });
    }
  }

  // A typed element must not be INTRODUCED by the pass (a forged finding/code_ref).
  for (const el of after.elements) {
    if (EDITOR_NARRATIVE_KINDS.has(el.kind)) continue;
    if (!beforeById.has(el.id)) {
      out.push({
        ruleId: "typed-data-immutable",
        elementRef: el.id,
        message: `Post-process introduced typed \`${el.kind}\` element \`${el.id}\` — the editor may add connective prose, never typed lens output.`,
      });
    }
  }

  // The board's coverage record — the SET of skipped hunk ids — is typed. Reasons
  // are prose the editor may polish; the skip set is not the editor's to touch.
  const beforeSkips = new Set(readSkips(before).map((s) => s.hunk));
  const afterSkips = new Set(readSkips(after).map((s) => s.hunk));
  if (beforeSkips.size !== afterSkips.size || [...afterSkips].some((h) => !beforeSkips.has(h))) {
    out.push({
      ruleId: "typed-data-immutable",
      elementRef: "/skippedHunks",
      message:
        "Post-process changed the board's set of skipped hunks — coverage is typed lens output, not the editor's to invent or drop.",
    });
  }

  return out;
}

// ── The loop ─────────────────────────────────────────────────────────────────

/** Coerce a raw seat return into a `DraftBoard`, or the parse issues that rejected it. */
function coerceBoard(
  raw: unknown,
):
  | { ok: true; board: DraftBoard }
  | { ok: false; issues: readonly { path: readonly (string | number)[]; message: string }[] } {
  const parsed = parseDraft(raw);
  return parsed.ok
    ? { ok: true, board: parsed.value }
    : {
        ok: false,
        issues: parsed.issues.map((i) => ({
          path: i.path as (string | number)[],
          message: i.message,
        })),
      };
}

/**
 * Rebuild the working draft from a seat patch: frozen elements verbatim (never
 * re-drafted), the patch's version for everything else, dropped ids removed.
 * Original element order is preserved; brand-new patch elements append.
 */
function mergePatch(
  current: DraftBoard,
  patch: DraftBoard,
  frozen: ReadonlyMap<string, DraftElement>,
  dropped: ReadonlySet<string>,
): DraftBoard {
  const patchById = new Map(patch.elements.map((el) => [el.id, el]));
  const placed = new Set<string>();
  const elements: DraftElement[] = [];
  for (const el of current.elements) {
    if (dropped.has(el.id)) continue;
    placed.add(el.id);
    const frozenEl = frozen.get(el.id);
    if (frozenEl !== undefined) elements.push(frozenEl);
    else elements.push(patchById.get(el.id) ?? el);
  }
  for (const el of patch.elements) {
    if (!placed.has(el.id) && !dropped.has(el.id)) elements.push(el);
  }
  // The seat owns the board-level passthrough (its own skippedHunks fixes win);
  // honest-omission additions are re-folded by `withOmissionSkips` after merge.
  return { ...(current as object), ...(patch as object), elements } as DraftBoard;
}

/** Fold the accumulated honest-omission skip entries into a board (dedup by hunk). */
function withOmissionSkips(board: DraftBoard, omissionSkips: readonly SkipEntry[]): DraftBoard {
  if (omissionSkips.length === 0) return board;
  const base = readSkips(board);
  const seen = new Set(base.map((s) => s.hunk));
  const merged = [...base];
  for (const s of omissionSkips) {
    if (!seen.has(s.hunk)) {
      seen.add(s.hunk);
      merged.push(s);
    }
  }
  return { ...(board as object), elements: board.elements, skippedHunks: merged } as DraftBoard;
}

/**
 * Validate one drafter return: run the lint retry ladder to a clean-or-flagged
 * board, then the immutability and composition gates in order. Pure over the
 * injected seams. Never throws on a bad draft and never blocks — an unfixable
 * element becomes an honest omission, exhaustion becomes labeled blemishes.
 */
export async function validateDraft(
  input: unknown,
  ctx: LintContext,
  seams: ValidateSeams,
): Promise<ValidateResult> {
  // Gate 1 — the lint loop. `input` is the drafter's first structured return.
  const first = coerceBoard(input);
  let current: DraftBoard = first.ok ? first.board : { elements: [] };
  // A parse failure on the very first return still seeds the channel: the seat
  // is re-asked with the schema issues as pointers (attempt 1 below).
  let pendingParseIssues = first.ok ? [] : first.issues;
  // Did ANY seat return ever parse? A run that never parses ships the synthetic
  // empty board — the caller must surface that as a failure, not empty success (finding 6).
  let everParsed = first.ok;

  const frozen = new Map<string, DraftElement>();
  const rungByElement = new Map<string, number>();
  const omissions: Omission[] = [];
  const omissionSkips: SkipEntry[] = [];
  let attempts = 0;
  let blemishes: Blemish[] = [];

  for (;;) {
    // If the last seat return failed to parse, that is this round's feedback.
    let violations: Violation[];
    let parsePointers: RetryPointer[] = [];
    if (pendingParseIssues.length > 0) {
      parsePointers = pendingParseIssues.map((i) => ({
        path: i.path,
        message: i.message,
        rung: 1,
      }));
      violations = [];
    } else {
      // A frozen element is never re-linted's fault: drop violations against a
      // frozen id, so a passer stays passed even if a later drop dangles a ref.
      violations = lint(current, ctx).filter((v) => {
        const id = offendingId(v.elementRef);
        return id === undefined || !frozen.has(id);
      });
      if (violations.length === 0) break; // clean
    }

    // Freeze every element with no violation this round; escalate the offenders.
    const offenders = new Set<string>();
    for (const v of violations) {
      const id = offendingId(v.elementRef);
      if (id !== undefined) offenders.add(id);
    }
    const codeRefIds = new Set(
      current.elements.filter((el) => el.kind === "code_ref").map((el) => el.id),
    );
    // First pass: an offender that survived the repair turn drops; before the
    // repair it advances onto the single rung. Passing elements freeze.
    const primaryDrops = new Set<string>();
    for (const el of current.elements) {
      if (offenders.has(el.id)) {
        const rung = rungByElement.get(el.id) ?? 0;
        if (attempts >= RETRY_CAP || rung >= LADDER_RUNGS) primaryDrops.add(el.id);
        else rungByElement.set(el.id, rung + 1);
      } else if (pendingParseIssues.length === 0) {
        // No violation this round ⇒ passing ⇒ freeze (never re-drafted).
        frozen.set(el.id, el);
      }
    }

    // Second pass: the honest-omission exit + incoming-reference closure (finding 5).
    // Drop each post-repair offender; resolve the closure so NO surviving element dangles
    // a reference to a dropped one; shed the hunks nothing on the board still teaches.
    const dropped = new Set<string>(primaryDrops);
    if (primaryDrops.size > 0) {
      const pre = current.elements;
      const omitReason = (el: DraftElement): string =>
        OMISSION_REASON_KINDS.has(el.kind)
          ? `The ${ctx.lens} ${ctx.lens === "report" ? "seat" : "lens"} could not teach \`${el.id}\` after one repair turn; left to another lens.`
          : `\`${el.id}\` could not be made valid after one repair turn; omitted honestly.`;
      // Ordered reason per dropped element (primary first, cascades appended).
      const reasonById = new Map<string, string>();
      for (const el of pre) if (primaryDrops.has(el.id)) reasonById.set(el.id, omitReason(el));

      // (a) Backward closure: a survivor's ARRAY refs to a dropped id are PATCHED
      // out (the element thawed to re-lint); a survivor whose SCALAR ref points at
      // a dropped id cannot be patched and CASCADE-omits. Iterated to a fixpoint.
      const patchedById = new Map<string, DraftElement>();
      for (;;) {
        let grew = false;
        for (const el of pre) {
          if (dropped.has(el.id)) continue;
          const source = patchedById.get(el.id) ?? el;
          const { el: patched, danglingScalar } = patchOutDropped(source, dropped);
          if (danglingScalar) {
            dropped.add(el.id);
            frozen.delete(el.id);
            reasonById.set(
              el.id,
              `\`${el.id}\` cited an omitted element and cannot stand without it; omitted to avoid a dangling reference.`,
            );
            grew = true;
          } else if (patched !== source) {
            patchedById.set(el.id, patched);
            frozen.delete(el.id); // thawed — its refs changed, re-lint next round
            grew = true;
          }
        }
        if (!grew) break;
      }

      // (b) Forward shed: a code_ref no PATCHED survivor still cites is orphaned by
      // the drop — remove it too, so a hunk we are about to skip is not still "taught".
      const survivorEls = pre
        .filter((el) => !dropped.has(el.id))
        .map((el) => patchedById.get(el.id) ?? el);
      const citedBySurvivors = new Set<string>();
      for (const el of survivorEls) {
        for (const cr of ownedCodeRefs(el, codeRefIds)) if (cr !== el.id) citedBySurvivors.add(cr);
      }
      const candidates = new Set<string>();
      for (const el of pre) {
        if (dropped.has(el.id)) {
          for (const cr of ownedCodeRefs(el, codeRefIds)) candidates.add(cr); // incl. a dropped code_ref itself
        } else {
          const lost = [...ownedCodeRefs(el, codeRefIds)].filter(
            (cr) =>
              cr !== el.id && !ownedCodeRefs(patchedById.get(el.id) ?? el, codeRefIds).has(cr),
          );
          for (const cr of lost) candidates.add(cr); // a survivor stopped citing it via patching
        }
      }
      for (const cr of candidates) if (!citedBySurvivors.has(cr)) dropped.add(cr);

      // (c) Assign shed hunks to each omission: hunks its owned code_refs taught
      // that NO surviving code_ref still teaches. Record omissions in drop order.
      const stillTaught = taughtHunkIds(
        pre.filter((el) => el.kind === "code_ref" && !dropped.has(el.id)),
        ctx.hunks,
      );
      for (const [id, reason] of reasonById) {
        const el = pre.find((e) => e.id === id);
        const ownedDropped = el
          ? [...ownedCodeRefs(el, codeRefIds)].filter((cr) => dropped.has(cr))
          : [];
        const hunks = hunksTaughtBy(new Set(ownedDropped), current, ctx).filter(
          (h) => !stillTaught.has(h),
        );
        omissions.push({ elementId: id, hunks, reason });
      }

      // (d) Fold the shed hunks into the accumulator, then rebuild the working board
      // from the PATCHED survivors (dropped removed, dangling refs stripped).
      const seen = new Set(omissionSkips.map((s) => s.hunk));
      for (const om of omissions) {
        for (const hunk of om.hunks) {
          if (!seen.has(hunk)) {
            seen.add(hunk);
            omissionSkips.push({ hunk, reason: om.reason });
          }
        }
      }
      const finalEls = pre
        .filter((el) => !dropped.has(el.id))
        .map((el) => patchedById.get(el.id) ?? el);
      current = withOmissionSkips(
        { ...(current as object), elements: finalEls } as DraftBoard,
        omissionSkips,
      );
    }

    // Re-lint after an omission. This is deterministic work and does not spend
    // another model turn.
    if (primaryDrops.size > 0) {
      pendingParseIssues = [];
      continue;
    }

    // Ask the seat to re-draft the still-offending elements.
    const askable = violations.filter((v) => {
      const id = offendingId(v.elementRef);
      return id === undefined || !dropped.has(id);
    });
    if (attempts >= RETRY_CAP) {
      // Exhaustion: whatever still fails ships as labeled blemishes. Visible,
      // never blocking. A run stuck on parse issues labels those as blemishes,
      // never an empty `blemishes[]` hiding a broken run (finding 6).
      const unresolved: Violation[] =
        pendingParseIssues.length > 0
          ? pendingParseIssues.map((i) => ({
              ruleId: "schema-invalid",
              elementRef: `/${i.path.join("/")}`,
              message: i.message,
            }))
          : askable;
      blemishes = unresolved.map((v) => ({ ...v, attempts }));
      break;
    }

    const pointers: RetryPointer[] =
      parsePointers.length > 0
        ? parsePointers
        : askable.map((v) => ({
            path: pointerPath(v.elementRef, current),
            message: v.message,
            ruleId: v.ruleId,
            rung: rungByElement.get(offendingId(v.elementRef) ?? "") ?? 1,
          }));

    attempts += 1;
    const raw = await seams.runTurn({ draft: current, pointers, attempt: attempts });
    const coerced = coerceBoard(raw);
    if (coerced.ok) {
      everParsed = true;
      pendingParseIssues = [];
      current = withOmissionSkips(
        mergePatch(current, coerced.board, frozen, dropped),
        omissionSkips,
      );
    } else {
      // The seat's return did not parse — feed the schema issues back next round.
      pendingParseIssues = coerced.issues;
    }
  }

  // Gate 2 — post-process editor pass, reference safety, then typed-data immutability.
  const beforeEditor = current;
  const editedRaw = seams.postProcess ? await seams.postProcess(current) : current;
  const edited = coerceBoard(editedRaw);
  const afterEditor = edited.ok ? edited.board : current;
  const editorReferenceViolations = lint(afterEditor, ctx).filter(
    ({ ruleId }) => ruleId === "element-reference-resolves",
  );
  current = editorReferenceViolations.length === 0 ? afterEditor : beforeEditor;
  const immutability = checkImmutability(beforeEditor, current);

  // Gate 3 — composition every-hunk coverage (cluster-4 seam).
  const composition = seams.compositionGate ? seams.compositionGate(current, ctx) : [];

  // Final wire-boundary check (finding 5/6): the shipped board must re-parse clean.
  // The closure strips array refs and the loop drops elements, so surface any
  // residual structural issue as a labeled blemish rather than shipping it silently.
  const finalParse = coerceBoard(current);
  if (!finalParse.ok) {
    const wire = finalParse.issues.map((i) => ({
      ruleId: "schema-invalid",
      elementRef: `/${i.path.join("/")}`,
      message: i.message,
      attempts,
    }));
    blemishes = [...blemishes, ...wire];
  }

  return { board: current, omissions, blemishes, immutability, composition, attempts, everParsed };
}
