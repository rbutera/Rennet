import { renderLayer } from "@rennet/prompts";
import {
  type AskProjection,
  findingRefKey,
  LENS_KINDS,
  type LensBoard,
  sha256Hex,
} from "@rennet/protocol";
import type { ForgeReviewEvent } from "./publish-review";
import type { SessionContextFile } from "./session-context";

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

/**
 * The opener's context as FILES under the session's context directory (design D4), not as
 * a JSON line in the prompt. The boards split per lens so the seat can open the one it is
 * writing about; the asks, the dismissals and the review's frame are one file each. The
 * voice rules travel as a file too: they live inside the installed `@rennet/prompts`
 * bundle, which is not a path the seat's cwd can reach.
 *
 * Namespaced under `opener/` because a session's other turns write `asks.json` and
 * `dispositions.json` of their own, and one directory holds them all.
 */
export function reviewOpenerContextFiles(
  input: ReviewOpenerDraftInput,
  voiceRules: string,
): readonly SessionContextFile[] {
  const context = buildReviewOpenerContext(input);
  return [
    ...context.boards.map((board) => ({
      name: `opener/boards/${board.lens}.json`,
      body: JSON.stringify(board),
      holds: `The ${board.lens} board's title, intro and section gists with their counts.`,
      readWhen: "when the opener needs to say what this lens found.",
    })),
    {
      name: "opener/asks.json",
      body: JSON.stringify({
        stagedAsks: context.stagedAsks,
        lineComments: context.lineComments,
      }),
      holds: "The asks the reviewer staged and the line comments they wrote, verbatim.",
      readWhen: "always — these are what the review actually says.",
    },
    {
      name: "opener/dispositions.json",
      body: JSON.stringify(context.dismissedFindings),
      holds: "The findings the reviewer dismissed, with the concern and severity each carried.",
      readWhen: "when the opener would otherwise imply a dismissed finding still stands.",
    },
    {
      name: "opener/review-facts.json",
      body: JSON.stringify({ verdict: context.verdict, changedPaths: context.changedPaths }),
      holds: "The review's verdict and the paths the change touched.",
      readWhen: "always — the opener must be correct for the verdict.",
    },
    {
      name: "opener/voice-rules.md",
      body: voiceRules,
      holds: "The writing rules for the reviewer's first-person GitHub register.",
      readWhen: "always, before writing a word.",
    },
  ];
}

/**
 * The opener prompt: instructions plus the paths of the files above, never their contents.
 * Everything it names is relative to the turn's working directory, which is the session's
 * bound root, so the seat reads them with its own tools the way it reads the checkout.
 */
export function buildReviewOpenerPrompt(contextDir: string): string {
  const dir = contextDir;
  const task = [
    "Write the opening paragraph for the signed GitHub review this session holds.",
    "The opener must be concise Markdown prose and correct for the recorded verdict.",
    "Ground every statement only in the persisted review facts and reviewer acts named below.",
    "Do not claim the reviewer viewed or walked every section: viewed state is not among the facts.",
    "Do not repeat all comments, add a heading, mention Rennet, or mention models, boards, lenses, seats, or drafting machinery.",
    'Return JSON: {"opener":"<one non-empty paragraph>"}.',
  ].join("\n");
  const context = [
    "Read these files from your working directory before you write. Nothing here was sent",
    "to you inline; open what you need with your own tools.",
    "",
    `- \`${dir}/opener/voice-rules.md\` — the register to write in. Read it first.`,
    `- \`${dir}/opener/review-facts.json\` — the verdict and the changed paths.`,
    `- \`${dir}/opener/asks.json\` — the staged asks and the line comments.`,
    `- \`${dir}/opener/dispositions.json\` — the findings the reviewer dismissed.`,
    `- \`${dir}/opener/boards/\` — one JSON per lens board (title, intro, section gists, counts).`,
    `- \`${dir}/README.md\` — the index of everything this session wrote for you.`,
  ].join("\n");
  return [renderLayer("task", task), renderLayer("context", context)].join("\n\n");
}

export async function draftReviewOpener(
  contextDir: string,
  port: ReviewOpenerPort,
  resolvedModel: string,
): Promise<ReviewOpenerDraftResult> {
  const turn = await port(buildReviewOpenerPrompt(contextDir));
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
