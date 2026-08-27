import { randomUUID } from "node:crypto";
import type { ApplyResponse, DescribeResponse, EventsResponse, Op, WireSchema } from "@wboard/core";
import type { BoardService } from "@wboard/server";

/**
 * An op as callers hand it to {@link WhiteboardClient.apply}: the same shape
 * the wire's `Op` union carries, but `op_id` is optional — the client mints a
 * UUID when it is absent, so #453's replay dedup holds by construction.
 * Callers that need deliberate replay (retry a possibly-applied batch) supply
 * their own stable `op_id`s.
 */
export type DraftOp = Op extends infer O
  ? O extends Op
    ? Omit<O, "op_id"> & { op_id?: string }
    : never
  : never;

/**
 * The five #455-locked whiteboard tools — `create`, `schema`, `apply`,
 * `describe`, `events` — as a typed client over an injected embedded
 * {@link BoardService}.
 *
 * **This module is the only writer of board ops in Rennet.** Everything that
 * mutates a board (the B8 drafters, the orchestrator, curation) routes its ops
 * through {@link WhiteboardClient.apply}; nothing else in the workspace calls
 * `BoardService.apply` or constructs board ops. Reads may go anywhere, writes
 * come through here.
 */
export class WhiteboardClient {
  readonly #service: BoardService;

  constructor(service: BoardService) {
    this.#service = service;
  }

  /** Mint a board declared with `schema`; returns the new board id. */
  create(schema: WireSchema): Promise<string> {
    return this.#service.createBoard(schema);
  }

  /** The board's declared schema — an agent's first call on an unfamiliar board. */
  schema(boardId: string): Promise<WireSchema> {
    return this.#service.getSchema(boardId);
  }

  /**
   * Apply a flat ordered ops list, all-or-nothing, attributed to `actor`.
   * Ops without an `op_id` get one minted here; the service's rejection (or
   * acceptance) is returned verbatim.
   */
  apply(boardId: string, ops: readonly DraftOp[], actor: string): Promise<ApplyResponse> {
    return this.#service.apply(boardId, ops.map(withOpId), actor);
  }

  /** Board metadata plus the implemented protocol version. */
  describe(boardId: string): Promise<DescribeResponse> {
    return this.#service.describe(boardId);
  }

  /** Events with `seq > cursor` (default: from the start), in order. */
  events(boardId: string, cursor?: number): Promise<EventsResponse> {
    return this.#service.getEvents(boardId, cursor);
  }
}

function withOpId(op: DraftOp): Op {
  // The spread reconstructs the same union arm with op_id present; TS cannot
  // re-associate the distributed Omit, hence the cast.
  return { ...op, op_id: op.op_id ?? randomUUID() } as Op;
}
