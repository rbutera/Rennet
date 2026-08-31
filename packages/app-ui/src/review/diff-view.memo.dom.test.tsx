// @vitest-environment happy-dom
//
// perf-audit §5 H7: `DiffFileCard` was unmemoized AND subscribed to the whole
// `stagedAsks` map, so staging one request-change re-rendered — and re-tokenized —
// every mounted card. The probe is tokenization: a card that re-renders runs
// `tokenizeDiffLine` over its own painted rows, and every fixture file's line text is
// unique, so the recorded texts say WHICH card rendered.
import type { PatchFile } from "@rennet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, mount } from "../test/dom";
import { DiffView } from "./diff-view";

const probe = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("../syntax/shiki", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../syntax/shiki")>();
  return {
    ...actual,
    tokenizeDiffLine: (code: string, languageId: Parameters<typeof actual.tokenizeDiffLine>[1]) => {
      probe.lines.push(code);
      return actual.tokenizeDiffLine(code, languageId);
    },
  };
});

beforeEach(() => {
  useRennetStore.getState().reviewActions.resetReview();
  probe.lines = [];
});

const FILE_A: PatchFile = {
  path: "packages/core/src/alpha.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  binary: false,
  patch: [
    "@@ -1,2 +1,2 @@",
    " const alphaKeep = 1",
    "-const alphaOld = 2",
    "+const alphaNew = 3",
  ].join("\n"),
};

const FILE_B: PatchFile = {
  path: "packages/ui/src/bravo.tsx",
  status: "added",
  additions: 2,
  deletions: 0,
  binary: false,
  patch: ["@@ -0,0 +1,2 @@", "+export const bravoOne = 1", "+export const bravoTwo = 2"].join("\n"),
};

function mountDiff(files: readonly PatchFile[]) {
  const history = memoryHistory("/s/x?view=diff");
  return mount(
    <Router hook={history.hook} searchHook={history.searchHook}>
      <DiffView files={files} />
    </Router>,
  );
}

function stage(path: string, line: number, body: string) {
  act(() =>
    useRennetStore.getState().reviewActions.stageAsk({
      id: `${path}:${line}:RIGHT`,
      anchor: `${path}:${line}`,
      type: "request-change",
      body,
      side: "RIGHT",
    }),
  );
}

/** Which fixture files re-tokenized since the probe was last cleared. */
function touched(): { alpha: boolean; bravo: boolean } {
  const joined = probe.lines.join("\n");
  return { alpha: joined.includes("alpha"), bravo: joined.includes("bravo") };
}

describe("DiffView — staging one ask touches one card", () => {
  it("re-renders only the card whose file the ask lands on", () => {
    mountDiff([FILE_A, FILE_B]);
    // Both cards mounted and tokenized on the first paint — the probe sees both.
    expect(touched()).toEqual({ alpha: true, bravo: true });

    probe.lines = [];
    stage(FILE_A.path, 1, "please rename this");
    expect(touched()).toEqual({ alpha: true, bravo: false });

    // Positive control, symmetric: the probe and the store path are both live, so an
    // ask on the OTHER file touches the other card and leaves this one alone. Without
    // it, `bravo: false` above would also be what a probe that stopped recording says.
    probe.lines = [];
    stage(FILE_B.path, 1, "and this one too");
    expect(touched()).toEqual({ alpha: false, bravo: true });
  });

  it("marks the staged line on its own card without disturbing the other", () => {
    const { container } = mountDiff([FILE_A, FILE_B]);
    stage(FILE_A.path, 1, "please rename this");

    const marked = container.querySelectorAll('[data-line-state="ask"]');
    expect(marked).toHaveLength(1);
    expect(
      container
        .querySelector(`[id="diff-${FILE_A.path}"]`)
        ?.querySelector('[data-line-state="ask"]'),
    ).toBeTruthy();
    // Positive control: the marker is derived per card from the store, not hard-coded —
    // a second ask on the other file marks a second row.
    stage(FILE_B.path, 1, "and this one too");
    expect(container.querySelectorAll('[data-line-state="ask"]')).toHaveLength(2);
  });

  it("a card whose props did not move is skipped when the surface re-renders", () => {
    // Opening a comment editor on the LATER file re-lays the surface out, but the
    // earlier card's geometry, model and handlers are all unchanged — `React.memo`
    // must skip it. (A card after the change legitimately re-renders: its top moves.)
    const { container } = mountDiff([FILE_A, FILE_B]);
    const bravoCard = container.querySelector(`[id="diff-${FILE_B.path}"]`);
    const openBravo = bravoCard?.querySelector<HTMLButtonElement>(
      'button[aria-label="Comment on line 1"]',
    );
    if (!openBravo) throw new Error("bravo's comment gutter did not mount");

    probe.lines = [];
    act(() => openBravo.click());
    expect(touched()).toEqual({ alpha: false, bravo: true });

    // Positive control: the same interaction on the FIRST file does re-render it, so
    // the skip above is memoization and not a card that stopped painting.
    const alphaCard = container.querySelector(`[id="diff-${FILE_A.path}"]`);
    const openAlpha = alphaCard?.querySelector<HTMLButtonElement>(
      'button[aria-label="Comment on line 1"]',
    );
    if (!openAlpha) throw new Error("alpha's comment gutter did not mount");
    probe.lines = [];
    act(() => openAlpha.click());
    expect(touched().alpha).toBe(true);
  });
});
