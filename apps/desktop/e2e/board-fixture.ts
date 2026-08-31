import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  BoardMetaStore,
  GenerationStore,
  RoundRecordStore,
  WhiteboardClient,
} from "@rennet/adapters";
import { WsRennetBridge } from "@rennet/client";
import {
  generationIdForPatchset,
  type HostElement,
  LENS_KINDS,
  type LensKind,
} from "@rennet/protocol";
import { createBoardsRuntime } from "@rennet/server";

export const BOARD_IMPLEMENTATION_PATH = "src/widget.ts";
export const BOARD_TEST_PATH = "src/widget.test.ts";
export const BOARD_DESIGN_SPEC_PATH = "openspec/changes/widget-value/specs/widget/spec.md";
export const BOARD_DESIGN_DECOY_PATH = "openspec/changes/earlier-widget/specs/widget/spec.md";

export const BOARD_DESIGN_SCENARIO =
  "WHEN the widget module is read THEN it returns the reviewed value.";

export interface SeededBoardFixture {
  readonly sessionId: string;
  readonly reviewId: string;
  readonly patchsetId: string;
  readonly liveGeneration: string;
  readonly frozenGeneration: string;
}

const author = { kind: "lens-agent", id: "desktop-e2e" } as const;

function elementsFor(
  lens: LensKind,
  generation: string,
  patchsetId: string,
): readonly HostElement[] {
  const suffix = `${generation}:${lens}`;
  if (lens === "sequence") {
    const implementation: HostElement = {
      id: `implementation:${suffix}`,
      kind: "code_ref",
      data: {
        author,
        patchset_id: patchsetId,
        path: BOARD_IMPLEMENTATION_PATH,
        side: "head",
        start_line: 1,
        end_line: 1,
      },
    };
    const test: HostElement = {
      id: `test:${suffix}`,
      kind: "code_ref",
      data: {
        author,
        patchset_id: patchsetId,
        path: BOARD_TEST_PATH,
        side: "head",
        start_line: 1,
        end_line: 1,
      },
    };
    return [
      implementation,
      test,
      {
        id: `section:${suffix}`,
        kind: "section",
        data: {
          author,
          title: `${generation === generationIdForPatchset(patchsetId) ? "Live" : "Frozen"} sequence`,
          gist: "The implementation and its captured test move together.",
          children: [implementation.id, test.id],
          delta: "new",
        },
      },
    ];
  }

  if (lens === "design") {
    const implementation: HostElement = {
      id: `design-implementation:${suffix}`,
      kind: "code_ref",
      data: {
        author,
        patchset_id: patchsetId,
        path: BOARD_IMPLEMENTATION_PATH,
        side: "head",
        start_line: 1,
        end_line: 1,
      },
    };
    const test: HostElement = {
      id: `design-test:${suffix}`,
      kind: "code_ref",
      data: {
        author,
        patchset_id: patchsetId,
        path: BOARD_TEST_PATH,
        side: "head",
        start_line: 1,
        end_line: 1,
      },
    };
    const scenario: HostElement = {
      id: `design-scenario:${suffix}`,
      kind: "prose",
      data: { author, markdown: BOARD_DESIGN_SCENARIO },
    };
    const requirement: HostElement = {
      id: `design-requirement:${suffix}`,
      kind: "requirement",
      data: {
        author,
        name: "Expose the reviewed widget value",
        capability: "widget-value",
        shall: "The widget SHALL expose the reviewed value.",
        scenarios: [scenario.id],
        related_files: [BOARD_IMPLEMENTATION_PATH, BOARD_TEST_PATH],
        source: {
          path: BOARD_DESIGN_SPEC_PATH,
          label: "widget/spec.md",
          line: 8,
        },
        spec_delta: "modified",
        coverage: "met",
        trace: [implementation.id, test.id],
        tests: 1,
      },
    };
    return [
      implementation,
      test,
      scenario,
      requirement,
      {
        id: `design-section:${suffix}`,
        kind: "section",
        data: {
          author,
          title: "Widget value",
          children: [requirement.id],
          sources: [
            {
              path: BOARD_DESIGN_SPEC_PATH,
              label: "widget/spec.md",
              line: 6,
            },
          ],
          spec_delta: "modified",
          delta: "new",
        },
      },
    ];
  }

  if (lens === "flagged") {
    const source: HostElement = {
      id: `flagged-source:${suffix}`,
      kind: "code_ref",
      data: {
        author,
        patchset_id: patchsetId,
        path: BOARD_IMPLEMENTATION_PATH,
        side: "head",
        start_line: 1,
        end_line: 1,
      },
    };
    const finding: HostElement = {
      id: `finding:${suffix}`,
      kind: "finding",
      data: {
        author,
        severity: "high",
        concern:
          "The widget can return the stale value.\n\n**Fix:** Return the reviewed value from the implementation.",
        code: [source.id],
        concurrence: [],
        status: "open",
      },
    };
    return [
      source,
      finding,
      {
        id: `section:${suffix}`,
        kind: "section",
        data: {
          author,
          title: `${generation === generationIdForPatchset(patchsetId) ? "Live" : "Frozen"} flagged`,
          children: [finding.id],
          delta: "new",
        },
      },
    ];
  }

  const prose: HostElement = {
    id: `prose:${suffix}`,
    kind: "prose",
    data: { author, markdown: `${lens} evidence for ${generation}.` },
  };
  return [
    prose,
    {
      id: `section:${suffix}`,
      kind: "section",
      data: {
        author,
        title: `${generation === generationIdForPatchset(patchsetId) ? "Live" : "Frozen"} ${lens}`,
        gist: `The ${lens} reading is persisted for this generation.`,
        children: [prose.id],
        delta: "new",
      },
    },
  ];
}

async function currentSessionReview(page: Page): Promise<{
  readonly sessionId: string;
  readonly reviewId: string;
  readonly patchsetId: string;
  readonly baseOid: string;
  readonly headOid: string;
}> {
  const hash = await page.evaluate(() => location.hash);
  const slug = /^#\/s\/([^?]+)/.exec(hash)?.[1];
  if (slug === undefined) throw new Error(`expected a session route, got ${hash}`);
  const sessionId = decodeURIComponent(slug);
  const port = await page.evaluate(() =>
    (window as unknown as { rennet: { wsPort(): Promise<number> } }).rennet.wsPort(),
  );
  const bridge = new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
  try {
    const session = (await bridge.invoke("session.list", {})).sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (session?.reviewId === undefined) {
      throw new Error(`session ${sessionId} has no captured review`);
    }
    const { review } = await bridge.invoke("review.load", {
      commandId: crypto.randomUUID(),
      reviewId: session.reviewId,
    });
    const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
    if (patchset === undefined) throw new Error(`review ${review.id} has no active patchset`);
    const paths = new Set(patchset.files.map((file) => file.path));
    for (const path of [BOARD_IMPLEMENTATION_PATH, BOARD_TEST_PATH, BOARD_DESIGN_SPEC_PATH]) {
      if (!paths.has(path)) throw new Error(`${path} is not in the captured patchset`);
    }
    if (paths.has(BOARD_DESIGN_DECOY_PATH)) {
      throw new Error(`${BOARD_DESIGN_DECOY_PATH} must remain outside the captured patchset`);
    }
    return {
      sessionId,
      reviewId: review.id,
      patchsetId: patchset.id,
      baseOid: patchset.repository.baseOid,
      headOid: patchset.repository.headOid,
    };
  } finally {
    bridge.close();
  }
}

/**
 * Persist two complete generations through the production board writer, then write the
 * production metadata and round record that make the frozen generation reachable in History.
 */
export async function seedBoardFixture(
  page: Page,
  repository: string,
  userData: string,
): Promise<SeededBoardFixture> {
  const review = await currentSessionReview(page);
  const liveGeneration = generationIdForPatchset(review.patchsetId);
  const frozenGeneration = `gen:desktop-e2e-frozen:${review.patchsetId}`;
  const runtime = createBoardsRuntime(repository);
  const whiteboard = new WhiteboardClient(runtime.service);
  const write = whiteboard.apply.bind(whiteboard);
  const meta = new BoardMetaStore(join(userData, "board-meta"));
  const generations = new GenerationStore(join(userData, "generations"));

  for (const generation of [frozenGeneration, liveGeneration]) {
    const lensBoards: Partial<Record<LensKind, string>> = {};
    for (const lens of LENS_KINDS) {
      const boardId = await runtime.createRennetBoard();
      lensBoards[lens] = boardId;
      const elements = elementsFor(lens, generation, review.patchsetId);
      const applied = await write(
        boardId,
        elements.map((element) => ({ op: "create" as const, element })),
        `lens:${lens}`,
      );
      if (!applied.response.ok) {
        throw new Error(`fixture board ${generation}/${lens} was rejected`);
      }
      meta.save({
        lens,
        boardId,
        document:
          lens === "design"
            ? {
                title: "Widget value specification",
                introMarkdown:
                  "Reviewers need the specification and implementation evidence in one reading path.",
                measure: "structured",
                sources: [
                  {
                    path: BOARD_DESIGN_SPEC_PATH,
                    label: "widget/spec.md",
                    line: 1,
                  },
                ],
                stats: [
                  { label: "Requirements", value: "1" },
                  { label: "Capabilities", value: "0 new / 1 modified" },
                ],
              }
            : {
                title: `${generation === liveGeneration ? "Live" : "Frozen"} ${lens}`,
                introMarkdown: `Persisted ${lens} evidence for the launched desktop journey.`,
                measure: "reading",
              },
        skippedHunks: [],
        blemishes: [],
        omissions: [],
        immutability: [],
        session: review.sessionId,
        generation,
      });
    }
    generations.save({
      id: generation,
      patchsetId: review.patchsetId,
      lensBoards,
      status: generation === liveGeneration ? "live" : "frozen",
    });
  }

  new RoundRecordStore(join(userData, "rounds")).record(review.sessionId, {
    asksDispatched: [],
    workerCommitRange: { from: review.baseOid, to: review.headOid },
    mintedPatchsetGeneration: liveGeneration,
    frozenPredecessor: frozenGeneration,
    boardGeneration: liveGeneration,
    reportBoard: "desktop-e2e-report",
    reworkCount: 0,
  });

  return {
    sessionId: review.sessionId,
    reviewId: review.reviewId,
    patchsetId: review.patchsetId,
    liveGeneration,
    frozenGeneration,
  };
}
