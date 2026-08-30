import { renderLayer } from "@rennet/prompts";
import {
  type AskProjection,
  findingRefKey,
  LENS_KINDS,
  type LensBoard,
  sha256Hex,
} from "@rennet/protocol";
import type { ForgeReviewEvent } from "./publish-review";

export interface ReviewOpenerDraftInput {
  readonly verdict: ForgeReviewEvent;
  readonly boards: readonly LensBoard[];
  readonly projection: AskProjection;
  readonly changedPaths: readonly string[];
}

export interface ReviewOpenerBoardFact {
  readonly lens: LensBoard["lens"];
  readonly generation: string;
  readonly boardId: string;
  readonly document: {
    readonly title: string;
    readonly introMarkdown: string;
  };
  readonly sections: readonly {
    readonly ref: string;
    readonly title: string;
    readonly gist: string;
    readonly counts: Readonly<Record<string, number>>;
    readonly delta?: "new" | "reworked";
  }[];
}

export interface ReviewOpenerContext {
  readonly verdict: ForgeReviewEvent;
  readonly changedPaths: readonly string[];
  readonly boards: readonly ReviewOpenerBoardFact[];
  readonly stagedAsks: readonly {
    readonly id: string;
    readonly anchor: string;
    readonly type: string;
    readonly body: string;
  }[];
  readonly lineComments: readonly {
    readonly path: string;
    readonly line: number;
    readonly body: string;
  }[];
  readonly dismissedFindings: readonly {
    readonly key: string;
    readonly concern?: string;
    readonly severity?: string;
  }[];
}

export type ReviewOpenerPortResult =
  | {
      readonly status: "emitted";
      readonly opener?: string;
      readonly model?: string;
    }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string; readonly retryable?: boolean };

export type ReviewOpenerPort = (prompt: string) => Promise<ReviewOpenerPortResult>;

export type ReviewOpenerDraftResult =
  | {
      readonly status: "drafted";
      readonly opener: string;
      readonly model: string;
    }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string; readonly retryable?: boolean };

const lensOrder = new Map(LENS_KINDS.map((lens, index) => [lens, index]));

function boardFact(board: LensBoard): ReviewOpenerBoardFact {
  const sectionTitles = new Map(
    board.elements
      .filter((element) => element.kind === "section")
      .map((element) => [element.id, element.data.title]),
  );
  return {
    lens: board.lens,
    generation: board.generation,
    boardId: board.boardId,
    document: {
      title: board.document.title,
      introMarkdown: board.document.introMarkdown,
    },
    sections: board.sections.map((section) => ({
      ref: section.ref,
      title: sectionTitles.get(section.ref) ?? section.ref,
      gist: section.gist,
      counts: Object.fromEntries(
        Object.entries(section.counts).sort(([left], [right]) => left.localeCompare(right)),
      ),
      ...(section.delta === undefined ? {} : { delta: section.delta }),
    })),
  };
}

export function buildReviewOpenerContext(input: ReviewOpenerDraftInput): ReviewOpenerContext {
  const boards = [...input.boards].sort((left, right) => {
    const byLens = (lensOrder.get(left.lens) ?? 0) - (lensOrder.get(right.lens) ?? 0);
    if (byLens !== 0) return byLens;
    return left.boardId.localeCompare(right.boardId);
  });
  const findings = new Map(
    boards.flatMap((board) =>
      board.elements
        .filter((element) => element.kind === "finding")
        .map(
          (element) =>
            [
              findingRefKey({
                generation: board.generation,
                boardId: board.boardId,
                findingId: element.id,
              }),
              element.data,
            ] as const,
        ),
    ),
  );
  const lineComments = Object.entries(input.projection.lineComments)
    .flatMap(([path, lines]) =>
      Object.entries(lines).map(([line, body]) => ({ path, line: Number(line), body })),
    )
    .sort((left, right) =>
      left.path === right.path ? left.line - right.line : left.path.localeCompare(right.path),
    );
  const dismissedFindings = Object.values(input.projection.findingDispositions)
    .map(({ finding }) => {
      const key = findingRefKey(finding);
      const resolved = findings.get(key);
      return {
        key,
        ...(resolved === undefined
          ? {}
          : { concern: resolved.concern, severity: resolved.severity }),
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));

  return {
    verdict: input.verdict,
    changedPaths: [...new Set(input.changedPaths)].sort((left, right) => left.localeCompare(right)),
    boards: boards.map(boardFact),
    stagedAsks: Object.values(input.projection.stagedAsks)
      .map((ask) => ({
        id: ask.id,
        anchor: ask.anchor,
        type: ask.type,
        body: ask.body,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    lineComments,
    dismissedFindings,
  };
}

export function reviewOpenerSourceId(
  reviewId: string,
  patchsetId: string,
  input: ReviewOpenerDraftInput,
): string {
  return sha256Hex(
    JSON.stringify({ reviewId, patchsetId, context: buildReviewOpenerContext(input) }),
  );
}

export function buildReviewOpenerPrompt(input: ReviewOpenerDraftInput, voiceRules: string): string {
  const task = [
    "Write the opening paragraph for the signed GitHub review described by the context.",
    "The opener must be concise Markdown prose and correct for the supplied verdict.",
    "Ground every statement only in the supplied persisted review facts and reviewer acts.",
    "Do not claim the reviewer viewed or walked every supplied section: viewed state is not among the facts.",
    "Do not repeat all comments, add a heading, mention Rennet, or mention models, boards, lenses, seats, or drafting machinery.",
    'Return JSON: {"opener":"<one non-empty paragraph>"}.',
  ].join("\n");
  return [
    renderLayer("payload", voiceRules),
    renderLayer("task", task),
    renderLayer("context", JSON.stringify(buildReviewOpenerContext(input))),
  ].join("\n\n");
}

export async function draftReviewOpener(
  input: ReviewOpenerDraftInput,
  voiceRules: string,
  port: ReviewOpenerPort,
  resolvedModel: string,
): Promise<ReviewOpenerDraftResult> {
  const turn = await port(buildReviewOpenerPrompt(input, voiceRules));
  if (turn.status !== "emitted") return turn;
  const opener = (turn.opener ?? "").trim();
  if (opener === "") {
    return {
      status: "failed",
      reason: "the review-opener drafter returned an empty opener",
      retryable: true,
    };
  }
  return { status: "drafted", opener, model: turn.model ?? resolvedModel };
}
