// @vitest-environment happy-dom
import type { PatchFile, Review, SidebarSession, SymbolInspection } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { AppLayout } from "../routes/layout";
import { useRennetStore } from "../store";
import { cleanup, mount, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { CodeBlock, type CodeBlockProps } from "./code-block";
import { DiffView } from "./diff-view";

const IMPLEMENTATION = "src/parser.ts";
const TEST = "src/parser.test.ts";
const OUTSIDE = "src/outside.ts";
const OUTSIDE_TEST = "src/outside.test.ts";

function changedFile(path: string): PatchFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    binary: false,
    patch: `diff --git a/${path} b/${path}\n@@ -0,0 +1 @@\n+export const parser = true;`,
  };
}

const REVIEW: Review = {
  id: "review-1",
  repositoryRoot: "/repo",
  patchsets: [
    {
      id: "patchset-old",
      createdAt: "2026-08-28T00:00:00.000Z",
      repository: {
        id: "repo-1",
        root: "/repo",
        commonDir: "/repo/.git",
        baseRef: "main",
        baseOid: "older-base",
        headOid: "older-head",
      },
      files: [changedFile(OUTSIDE), changedFile(OUTSIDE_TEST)],
      rawDiff: "old captured diff",
      byteLength: 17,
      truncated: false,
    },
    {
      id: "patchset-1",
      createdAt: "2026-08-29T00:00:00.000Z",
      repository: {
        id: "repo-1",
        root: "/repo",
        commonDir: "/repo/.git",
        baseRef: "main",
        baseOid: "base",
        headOid: "head",
      },
      files: [changedFile(IMPLEMENTATION), changedFile(TEST)],
      rawDiff: "captured diff",
      byteLength: 13,
      truncated: false,
    },
  ],
  activePatchsetId: "patchset-1",
  dispositions: [],
  status: "current",
};

const SESSION: SidebarSession = {
  id: "session-1",
  projectId: "project-1",
  title: "Parser review",
  target: "your-branch",
  reviewId: REVIEW.id,
  createdAt: 0,
};

beforeEach(() => {
  useRennetStore.getState().reviewActions.resetReview();
  useRennetStore.setState((state) => ({
    ui: { ...state.ui, chatOpen: false, sidebarOpen: true },
  }));
});

afterEach(cleanup);

function mountEvidence(
  path: string,
  overrides: Pick<CodeBlockProps, "onOpenPath" | "counterpart"> = {},
  options: { handlers?: MemoryBridgeHandlers; diff?: boolean } = {},
) {
  let reviewLoads = 0;
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "session.list": () => ({ sessions: [SESSION] }),
    "review.load": ({ reviewId }) => {
      expect(reviewId).toBe(REVIEW.id);
      reviewLoads += 1;
      return { review: REVIEW, repositoryPresent: true };
    },
    ...options.handlers,
  });
  const history = memoryHistory(
    "/s/session-1?lens=sequence&generation=generation-1&ask=keep%20me&round=2&file=old.ts",
  );
  const view = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <AppLayout>
          {options.diff ? (
            <DiffView files={[changedFile(path)]} patchsetId={REVIEW.activePatchsetId} />
          ) : (
            <CodeBlock code="export const parser = true" path={path} {...overrides} />
          )}
        </AppLayout>
      </Router>
    </BridgeProvider>,
  );
  return { ...view, history, reviewLoads: () => reviewLoads };
}

describe("route-scoped code destinations", () => {
  it("opens a captured filename in Diff and preserves the other session query state", async () => {
    const { findByRole, history, user } = mountEvidence(IMPLEMENTATION);
    const before = history.history.length;
    await user.click(await findByRole("button", { name: IMPLEMENTATION }));
    expect(history.history.length).toBe(before);
    expect(history.history.at(-1)).toBe(
      "/s/session-1?view=diff&lens=sequence&generation=generation-1&file=src%2Fparser.ts&round=2&ask=keep+me",
    );
  });

  it("jumps between captured implementation and test files", async () => {
    const { findByRole, history, user } = mountEvidence(IMPLEMENTATION);
    await user.click(await findByRole("button", { name: "View test" }));
    expect(history.history.at(-1)).toContain("view=diff");
    expect(history.history.at(-1)).toContain("file=src%2Fparser.test.ts");
  });

  it("ignores files captured only by an inactive patchset", async () => {
    const { getByText, queryByRole, reviewLoads } = mountEvidence(OUTSIDE);
    await waitFor(() => expect(reviewLoads()).toBeGreaterThan(0));
    expect(getByText(OUTSIDE).tagName).toBe("SPAN");
    expect(queryByRole("button", { name: "View test" })).toBeNull();
  });

  it("lets explicit props override the route defaults", async () => {
    const onOpenPath = vi.fn();
    const onView = vi.fn();
    const { findByRole, history, user } = mountEvidence(IMPLEMENTATION, {
      onOpenPath,
      counterpart: { label: "Custom jump", path: "custom.ts", onView },
    });
    await user.click(await findByRole("button", { name: IMPLEMENTATION }));
    await user.click(await findByRole("button", { name: "Custom jump" }));
    expect(onOpenPath).toHaveBeenCalledWith(IMPLEMENTATION);
    expect(onView).toHaveBeenCalledTimes(1);
    expect(history.history.at(-1)).toBe(
      "/s/session-1?lens=sequence&generation=generation-1&ask=keep%20me&round=2&file=old.ts",
    );
  });

  it("lets null props suppress the route defaults", async () => {
    const { getByText, queryByRole, reviewLoads } = mountEvidence(IMPLEMENTATION, {
      onOpenPath: null,
      counterpart: null,
    });
    await waitFor(() => expect(reviewLoads()).toBeGreaterThan(0));
    expect(getByText(IMPLEMENTATION).tagName).toBe("SPAN");
    expect(queryByRole("button", { name: "View test" })).toBeNull();
  });
});

describe("symbol inspection through the live layout", () => {
  const inspection: SymbolInspection = {
    name: "parser",
    definition: {
      status: "ok",
      sites: [{ path: IMPLEMENTATION, line: 4, kind: "function", scope: null }],
      tier: { kind: "exact", method: "structural" },
    },
    references: {
      status: "ok",
      sites: [{ path: TEST, line: 9, scope: null }],
      truncated: false,
      tier: { kind: "guess", method: "textual" },
    },
  };

  it.each([
    { surface: "board snippet", diff: false },
    { surface: "diff", diff: true },
  ])("opens a symbol from the $surface and restores focus on Escape", async ({ diff }) => {
    const lookup = vi.fn(() => inspection);
    const openEditor = vi.fn(() => ({ ok: true }));
    const { findByRole, getByRole, queryByRole, user } = mountEvidence(
      IMPLEMENTATION,
      {},
      {
        diff,
        handlers: {
          "review.symbolLookup": lookup,
          "review.openInEditor": openEditor,
        },
      },
    );
    const token = await findByRole("button", { name: "Inspect parser" });
    token.focus();
    await user.keyboard("{Enter}");
    expect(lookup).toHaveBeenCalledWith({ reviewId: REVIEW.id, name: "parser", side: "head" });
    await findByRole("complementary", { name: "Symbol: parser" });
    await user.click(await findByRole("button", { name: "parser.ts:4" }));
    expect(openEditor).toHaveBeenCalledWith({
      reviewId: REVIEW.id,
      path: IMPLEMENTATION,
      line: 4,
    });
    expect(getByRole("button", { name: "parser.test.ts:9" })).toBeTruthy();
    expect(queryByRole("button", { name: "Inspect export" })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(queryByRole("complementary", { name: "Symbol: parser" })).toBeNull(),
    );
    expect(document.activeElement).toBe(token);
  });

  it("shows the lookup failure and retries when the symbol is opened again", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error("index offline"))
      .mockResolvedValue(inspection);
    const { findByRole, getByRole, user } = mountEvidence(
      IMPLEMENTATION,
      {},
      {
        handlers: { "review.symbolLookup": lookup },
      },
    );
    await user.click(await findByRole("button", { name: "Inspect parser" }));
    expect((await findByRole("alert")).textContent).toContain("index offline");
    await user.click(getByRole("button", { name: "Close symbol inspector" }));
    await user.click(getByRole("button", { name: "Inspect parser" }));
    await findByRole("button", { name: "parser.ts:4" });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
