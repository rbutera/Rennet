// Writing a FIXTURE board through the tool surface a production seat is given
// (`lens-board-tools` 3.2).
//
// A board seat no longer returns a document: it writes its board call by call and settles
// by calling `finish` or a settle-absent verb. Fixtures are still authored as `DraftBoard`
// values, because that is the readable way to say what a lens found — so something has to
// turn one into the calls a seat would make. This is that something, and it is shared
// rather than duplicated per test file: `lens-pipeline.test.ts` drives the pipeline with
// it, and `t3-seat-fake.ts` gives the round-level tests the same translation, so both see
// the same refusals for the same reasons.
//
// It is a translation, not a shortcut. Every call goes through the real `BoardWriter` with
// the real tool set, so every boundary rule runs, every id is host-minted and every
// reference is resolved by the writer. A refused call THROWS: a fixture that cannot be
// written is a broken fixture, and swallowing the refusal would leave a test asserting
// over a board that silently lost half its elements.

import type { BoardToolResult, BoardVoiceWriter } from "@rennet/core";
import { elementReferences } from "@rennet/core";
import type { BoardTarget, BoardToolField, DraftBoard, DraftElement } from "@rennet/protocol";
import { boardToolsByName, hostDerivedMemberKind } from "@rennet/protocol";
import { SEAT_BOARD_TARGET, SEAT_BOARD_VOICE, type SeatKind } from "../t3/threads";
import {
  type BoardMcpServer,
  type GenerationBoards,
  generationBoards,
  startBoardMcpServer,
} from "./board-mcp-server";

/** Unwrap a call that must have succeeded, so a refusal fails loudly with its own words. */
export function okCall(result: BoardToolResult): BoardToolResult & { ok: true } {
  if (!result.ok) throw new Error(`the fixture's call was refused: ${result.refusal}`);
  return result;
}

/** The host-minted id an `add`/`cite` returned. */
export function idOf(result: BoardToolResult): string {
  const { outcome } = okCall(result);
  if (outcome.kind !== "element") throw new Error(`expected an element id, got ${outcome.kind}`);
  return outcome.id;
}

/**
 * Replay a fixture board as the calls a seat would make.
 *
 * The inversion is DERIVED from `tool.fields`, never a hand-kept table: each field says
 * which `data` key it feeds and in what form, so a renamed or reshaped input reaches this
 * helper the same turn it reaches the seat. A field the tool does not carry — `author`,
 * `patchset_id`, `children`, a finding's `status` — is simply not there to send, which is
 * the surface's own claim being exercised rather than described.
 */
export function replayBoard(voice: BoardVoiceWriter, target: BoardTarget, board: DraftBoard): void {
  const tools = boardToolsByName(target);
  const minted = new Map<string, string>();
  const byId = new Map(board.elements.map((element) => [element.id, element]));
  const parentOf = new Map<string, string>();
  for (const element of board.elements) {
    const children = (element.data as { children?: unknown }).children;
    if (!Array.isArray(children)) continue;
    for (const child of children) if (typeof child === "string") parentOf.set(child, element.id);
  }

  const call = (name: string, input: Record<string, unknown>): string | undefined => {
    const result = voice.call(name, input);
    if (!result.ok) throw new Error(`fixture refused by \`${name}\`: ${result.refusal}`);
    return result.outcome.kind === "element" ? result.outcome.id : undefined;
  };

  const remap = (id: string): string => minted.get(id) ?? id;

  const inputFrom = (fields: readonly BoardToolField[], data: Record<string, unknown>) => {
    const input: Record<string, unknown> = {};
    for (const field of fields) {
      const source = field.source;
      const raw = data[source.dataField];
      if (raw === undefined) continue;
      if (source.form === "scalar") {
        input[field.name] = raw;
      } else if (source.form === "element-ref") {
        input[field.name] = source.many ? (raw as string[]).map(remap) : remap(raw as string);
      } else if (source.many) {
        const values = (raw as Record<string, unknown>[]).map((entry) => entry[source.part]);
        if (values.every((value) => value !== undefined)) input[field.name] = values;
      } else {
        const value = (raw as Record<string, unknown>)[source.part];
        if (value !== undefined) input[field.name] = value;
      }
    }
    return input;
  };

  const setDocument = tools.get("set_document");
  if (board.document !== undefined && setDocument !== undefined) {
    call("set_document", inputFrom(setDocument.fields, board.document as Record<string, unknown>));
  }

  // Every element goes after its parent and after everything it references, because a
  // reference can only name an element the board already holds (D4). `children` is NOT
  // walked: the host maintains it from the `parent_id` each creating call names, so a
  // parent is written BEFORE its children rather than after them.
  const emitted = new Set<string>();
  const order: DraftElement[] = [];
  const visit = (id: string, seen: ReadonlySet<string>): void => {
    const element = byId.get(id);
    if (element === undefined || emitted.has(id) || seen.has(id)) return;
    const next = new Set([...seen, id]);
    const parent = parentOf.get(id);
    if (parent !== undefined) visit(parent, next);
    for (const reference of elementReferences(element)) {
      if (reference.field === "children") continue;
      visit(reference.targetId, next);
    }
    if (emitted.has(id)) return;
    emitted.add(id);
    order.push(element);
  };
  for (const element of board.elements) visit(element.id, new Set());

  for (const element of order) {
    const tool = [...tools.values()].find(
      (candidate) => candidate.verb === "add" && candidate.kind === element.kind,
    );
    if (tool === undefined) {
      throw new Error(`fixture writes a \`${element.kind}\`, which the ${target} seat cannot add`);
    }
    const input = inputFrom(tool.fields, element.data as Record<string, unknown>);
    const parent = parentOf.get(element.id);
    if (parent !== undefined) input.parent_id = remap(parent);
    const id = call(tool.name, input);
    if (id !== undefined) minted.set(element.id, id);
  }
}

/**
 * The rest of an ordinary Noise turn: the host handed this seat its members, so grouping
 * them is the whole of what it authors (D16).
 *
 * Done for every fixture rather than scripted per test, because it is not any test's
 * subject and because a Noise seat that does NOT group its members is a Noise seat
 * `finish` refuses — which would make every fixture with a remainder fail its Noise lane
 * for a reason unrelated to what the test is about. The grouping is real: one section, one
 * prose line under it saying why, and the one update verb the seat has for a member, all
 * through the tool surface.
 *
 * A group's reason is prose UNDER the section rather than a field on it, which is what
 * `derived-group-reasoned` asks for and what the frozen `section` kind can hold.
 */
export function groupDerivedMembers(voice: BoardVoiceWriter, target: BoardTarget): void {
  const memberKind = hostDerivedMemberKind(target);
  if (memberKind === undefined) return;
  const board = voice.board();
  const parented = new Set<string>();
  for (const element of board.elements) {
    const children = (element.data as { children?: unknown }).children;
    if (!Array.isArray(children)) continue;
    for (const child of children) if (typeof child === "string") parented.add(child);
  }
  const ungrouped = board.elements.filter(
    (element) => element.kind === memberKind && !parented.has(element.id),
  );
  if (ungrouped.length === 0) return;
  const updateVerb = [...boardToolsByName(target).values()].find(
    (tool) => tool.verb === "update" && tool.kind === memberKind,
  );
  if (updateVerb === undefined) throw new Error(`the ${target} seat cannot update a ${memberKind}`);
  const groupId = idOf(voice.call("add_section", { title: "Mechanical edits" }));
  okCall(
    voice.call("add_prose", {
      parent_id: groupId,
      markdown: "These regions move text around without changing what the code does.",
    }),
  );
  for (const member of ungrouped) {
    okCall(
      voice.call(updateVerb.name, {
        element_id: member.id,
        parent_id: groupId,
        reason: "Renamed only; the call sites read the same.",
      }),
    );
  }
}

/**
 * What a scripted seat does with its turn, in the vocabulary the fixtures already speak.
 *
 * A `DraftBoard` is replayed and finished — the ordinary "this lens found this" fixture.
 * An `{ absence }` is `settle_absent`, which is now the ONLY way a lane settles absent: an
 * empty board is no longer read as a claim, because a seat that means "there is nothing
 * here" has a verb for saying so. A FUNCTION is the turn's own calls, for a fixture that
 * needs to say something a board value cannot — a refused call answered inside the same
 * turn, a turn that stops halfway. Anything else is a turn that wrote nothing.
 */
export type SeatTurnScript =
  | DraftBoard
  | { readonly absence: string }
  | ((voice: BoardVoiceWriter, target: BoardTarget) => void | Promise<void>)
  | undefined;

/** Apply one scripted turn against the seat's own voice on its lane's board. */
export async function applySeatTurn(
  written: unknown,
  seat: SeatKind,
  voice: BoardVoiceWriter,
): Promise<void> {
  const target = SEAT_BOARD_TARGET[seat];
  if (written === undefined || written === null) return;
  const absence = (written as { absence?: unknown }).absence;
  if (typeof absence === "string") {
    okCall(voice.call("settle_absent", { note: `the ${target} lens has nothing to report` }));
    return;
  }
  if (typeof written === "function") {
    await (written as (voice: BoardVoiceWriter, target: BoardTarget) => void | Promise<void>)(
      voice,
      target,
    );
    return;
  }
  // Not a board ⇒ a turn that wrote nothing. Under the document path a malformed return
  // was a parse failure that seeded the ladder; a seat that ACTS has no return to malform,
  // so the honest translation is a turn that made no calls and therefore ends unsettled.
  if (!Array.isArray((written as { elements?: unknown }).elements)) return;
  replayBoard(voice, target, withoutDerivedMembers(written as DraftBoard, target));
  groupDerivedMembers(voice, target);
  okCall(voice.call("finish"));
}

/**
 * Drop the members of a HOST-DERIVED board from a fixture before replaying it.
 *
 * A fixture that predates D16 authors the Noise board's `noise_verdict` elements, because
 * that is what the seat used to return. The seat has no verb for one now — membership is a
 * derivation and the host places it — so replaying them would be refused, and refusing them
 * is the surface being right rather than the fixture being broken. What the fixture still
 * says, and what is replayed, is everything the seat DOES author; the members it named come
 * from the complement, and {@link groupDerivedMembers} groups whatever the host placed.
 *
 * The citations only a dropped member cited go with it: a `code_ref` no surviving element
 * names would land as an orphan the fixture never meant to write.
 */
function withoutDerivedMembers(board: DraftBoard, target: BoardTarget): DraftBoard {
  const memberKind = hostDerivedMemberKind(target);
  if (memberKind === undefined) return board;
  const members = board.elements.filter((element) => element.kind === memberKind);
  if (members.length === 0) return board;
  const dropped = new Set(members.map((element) => element.id));
  const survivors = board.elements.filter((element) => !dropped.has(element.id));
  const stillCited = new Set(
    survivors.flatMap((element) =>
      elementReferences(element).map((reference) => reference.targetId),
    ),
  );
  const orphanedCitations = new Set(
    members
      .flatMap((element) => elementReferences(element).map((reference) => reference.targetId))
      .filter((id) => !stillCited.has(id)),
  );
  return {
    ...board,
    elements: survivors
      .filter((element) => !orphanedCitations.has(element.id))
      .map((element) => withoutDroppedChildren(element, dropped)),
  };
}

/** Re-write a section's `children` so it does not name a member the host will place. */
function withoutDroppedChildren(element: DraftElement, dropped: ReadonlySet<string>): DraftElement {
  const children = (element.data as { children?: unknown }).children;
  if (!Array.isArray(children)) return element;
  const kept = children.filter((child) => typeof child !== "string" || !dropped.has(child));
  return kept.length === children.length
    ? element
    : ({ ...element, data: { ...(element.data as object), children: kept } } as DraftElement);
}

/** This seat's handle on its lane's board, or `undefined` when its lane is not open. */
export function seatVoiceOn(
  boards: GenerationBoards | undefined,
  seat: SeatKind,
): BoardVoiceWriter | undefined {
  return boards?.lane(SEAT_BOARD_TARGET[seat])?.writer().voice(SEAT_BOARD_VOICE[seat]);
}

// ── The loopback board server a test's lanes live on ─────────────────────────

/**
 * ONE loopback board server per module registry, started on first use.
 *
 * The lanes every test drives are the real ones — `startBoardMcpServer`'s own
 * `BoardWriter` per target, reached through `generationBoards` exactly as
 * `create-server.ts` reaches them — so a seat writes through the real tool surface and is
 * refused by the real boundary rules. `board-mcp-server.test.ts` owns the HTTP half;
 * nothing that goes through here goes over the wire.
 */
let sharedServer: Promise<BoardMcpServer> | undefined;
let generationCounter = 0;

const ensureFixtureBoardServer = (): Promise<BoardMcpServer> => {
  sharedServer ??= startBoardMcpServer({ bearer: () => "fixture-sidecar-bearer" });
  return sharedServer;
};

/**
 * A generation's lanes, on a FRESH generation id every call.
 *
 * Always fresh, never the caller's own generation id, and that is the load-bearing part:
 * the lane registry is keyed on (generation, target) and lives for the process, so two
 * tests — or two attempts inside one test — that named the same generation would share one
 * `BoardWriter` and read each other's elements. A lane re-opened for a retry keeping its
 * board is a real production property; it is `board-mcp-server.test.ts`'s to assert, and
 * letting it leak across unrelated fixtures here would make a failed lane look settled
 * because some earlier test had filled it.
 */
export function fixtureGenerationBoards(): GenerationBoards {
  generationCounter += 1;
  return generationBoards(`fixture-gen-${generationCounter}`, () => ensureFixtureBoardServer());
}

/** Close the shared listener. Every file that opened lanes calls this from `afterAll`. */
export async function closeFixtureBoardServer(): Promise<void> {
  const server = sharedServer;
  sharedServer = undefined;
  await (await server)?.close();
}
