// @vitest-environment happy-dom
//
// The New Chat view (C12 §10.8) over a MemoryBridge: the smart list is built from
// `project.detail` through the reused `smart-list.ts`, the tabs filter with live
// counts, the text filter matches the documented fields, Escape is two-stage (clear
// the filter, then close), the headline project picker rewrites the URL and resets
// the target, selecting a row ticks it, and the empty / filtered-empty copy is honest.
// Live minting is the GATED cluster 7 (B9) — not exercised here.
import type { Project, ProjectDetail } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router, useSearch } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { newChatPath } from "../routes/url";
import { cleanup, fireEvent, mount, screen, waitFor, within } from "../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { NewChatView } from "./new-chat-view";

afterEach(cleanup);

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/code/${name}`,
    kind: "repo",
    repoCount: 1,
    branchCount: 3,
    primaryBranch: "main",
    openPath: `/code/${name}`,
    addedAt: "2026-08-27T00:00:00.000Z",
    source: "local",
  };
}

/** p1's substrate: one local, a mine-open PR, a teammate needs-you PR, a merged PR. */
function detailP1(): ProjectDetail {
  return {
    viewer: { login: "rai" },
    truncated: false,
    locals: [
      {
        id: "local-x",
        branch: "feat/local-x",
        repository: "rennet",
        author: "rai",
        dirty: true,
        ahead: 2,
        behind: 0,
        stage: "reviewed",
        lastActivityAt: "2026-08-26T09:00:00.000Z",
      },
    ],
    prs: [
      {
        id: "pr-mine",
        number: 201,
        title: "My open change",
        branch: "feat/mine",
        repository: "rennet",
        author: "rai",
        state: "open",
        reviewRequestedFromViewer: false,
        ci: "passing",
        additions: 10,
        deletions: 2,
        changedFiles: 3,
        lastActivityAt: "2026-08-26T08:00:00.000Z",
      },
      {
        id: "pr-review",
        number: 202,
        title: "Teammate span fix",
        branch: "fix/span",
        repository: "rennet",
        author: "emma",
        state: "open",
        reviewRequestedFromViewer: true,
        ci: "failing",
        additions: 4,
        deletions: 1,
        changedFiles: 1,
        lastActivityAt: "2026-08-26T10:00:00.000Z",
      },
      {
        id: "pr-merged",
        number: 199,
        title: "Old merged work",
        branch: "feat/done",
        repository: "rennet",
        author: "rai",
        state: "merged",
        reviewRequestedFromViewer: false,
        ci: "passing",
        additions: 100,
        deletions: 20,
        changedFiles: 8,
        lastActivityAt: "2026-08-25T08:00:00.000Z",
      },
    ],
  };
}

const EMPTY_DETAIL: ProjectDetail = {
  viewer: { login: "rai" },
  truncated: false,
  locals: [],
  prs: [],
};

/** Mount the view at /new-chat?project=<id>, resolving projectId from the URL exactly
 *  as the real `NewChatScreen` route does, so a picker navigation re-renders the view. */
function renderView(id: string, details: Record<string, ProjectDetail>, ask?: string) {
  const history = memoryHistory(newChatPath(id, ask));
  const bridge = new MemoryBridge({
    "projects.list": () => ({ projects: [project("p1", "rennet"), project("p2", "whiteboard")] }),
    "project.detail": (input) => details[input.projectId] ?? EMPTY_DETAIL,
  } satisfies MemoryBridgeHandlers);

  function Harness() {
    const project = new URLSearchParams(useSearch()).get("project") ?? "";
    return <NewChatView projectId={project} />;
  }

  const view = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <Harness />
      </Router>
    </BridgeProvider>,
  );
  return { ...view, history };
}

/** The list row (a picker button with aria-pressed) carrying `name` — scoped to the
 *  rows so the composer's own "Current Checkout" chip text is never a false match. */
function rowButton(name: RegExp): HTMLButtonElement {
  const match = screen
    .getAllByText(name)
    .map((node) => node.closest("button[aria-pressed]"))
    .find((button): button is HTMLButtonElement => button !== null);
  if (!match) throw new Error(`no row button for ${name}`);
  return match;
}

describe("NewChatView", () => {
  it("renders the smart list from project.detail with live tab counts", async () => {
    renderView("p1", { p1: detailP1() });
    await screen.findByText("My open change");

    // 1 local + 3 PRs, no dedupe (distinct branches).
    expect(screen.getByRole("button", { name: /^All/ }).textContent).toContain("4");
    expect(screen.getByRole("button", { name: /^Needs you/ }).textContent).toContain("1");
    expect(screen.getByRole("button", { name: /^Mine/ }).textContent).toContain("3");
    expect(screen.getByRole("button", { name: /^Local/ }).textContent).toContain("1");
    expect(screen.getByRole("button", { name: /^PRs/ }).textContent).toContain("3");
  });

  it("filters by tab", async () => {
    renderView("p1", { p1: detailP1() });
    await screen.findByText("Teammate span fix");

    fireEvent.click(screen.getByRole("button", { name: /^Needs you/ }));
    expect(screen.getByText("Teammate span fix")).toBeTruthy();
    expect(screen.queryByText("My open change")).toBeNull();
    expect(screen.queryByText("feat/local-x")).toBeNull();
  });

  it("text-filters across the documented fields", async () => {
    renderView("p1", { p1: detailP1() });
    const filter = await screen.findByLabelText("Filter branches and pull requests");

    // A PR title match.
    fireEvent.change(filter, { target: { value: "span" } });
    expect(screen.getByText("Teammate span fix")).toBeTruthy();
    expect(screen.queryByText("My open change")).toBeNull();

    // A local branch match (branch+repo is the local field set).
    fireEvent.change(filter, { target: { value: "local-x" } });
    expect(screen.getByText("feat/local-x")).toBeTruthy();
    expect(screen.queryByText("Teammate span fix")).toBeNull();
  });

  it("filtered-empty and empty states read honestly", async () => {
    renderView("p1", { p1: detailP1() });
    const filter = await screen.findByLabelText("Filter branches and pull requests");
    fireEvent.change(filter, { target: { value: "zzz-nothing" } });
    expect(screen.getByText("Nothing matches.")).toBeTruthy();

    cleanup();
    renderView("p2", { p2: EMPTY_DETAIL });
    await screen.findByText("No open branches or pull requests yet.");
  });

  it("Escape is two-stage: clear the filter, then close", async () => {
    const { history } = renderView("p1", { p1: detailP1() });
    const filter = await screen.findByLabelText("Filter branches and pull requests");
    fireEvent.change(filter, { target: { value: "span" } });

    // First Escape (filter non-empty): clears it, does NOT navigate.
    fireEvent.keyDown(filter, { key: "Escape" });
    expect((filter as HTMLInputElement).value).toBe("");
    expect(history.history.at(-1)).toBe(newChatPath("p1"));

    // Second Escape (empty filter): bubbles to the window handler → closes.
    fireEvent.keyDown(filter, { key: "Escape" });
    await waitFor(() => expect(history.history.at(-1)).toBe(newChatPath()));
  });

  it("selecting a row ticks it and sets the composer target; the checkout is the default", async () => {
    renderView("p1", { p1: detailP1() });
    await screen.findByText("My open change");
    const checkout = rowButton(/Current Checkout/);
    expect(checkout.getAttribute("aria-pressed")).toBe("true");

    const row = rowButton(/My open change/);
    fireEvent.click(row);
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(checkout.getAttribute("aria-pressed")).toBe("false");
    // The composer chip now names the selected PR.
    expect(screen.getByLabelText("Reset target to current checkout")).toBeTruthy();
  });

  it("the headline picker rewrites the URL and resets the target", async () => {
    const { history, user } = renderView("p1", { p1: detailP1(), p2: EMPTY_DETAIL });
    await screen.findByText("My open change");

    // Select a row so there is a non-default target to reset.
    fireEvent.click(rowButton(/My open change/));
    expect(screen.getByLabelText("Reset target to current checkout")).toBeTruthy();

    // Change the project via the headline picker.
    await user.click(screen.getByRole("button", { name: /^Project:/ }));
    await user.click(await screen.findByText("whiteboard"));

    // URL rewritten to p2, and the target is back to the checkout (reset chip gone).
    await waitFor(() => expect(history.history.at(-1)).toBe(newChatPath("p2")));
    await waitFor(() =>
      expect(rowButton(/Current Checkout/).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(screen.queryByLabelText("Reset target to current checkout")).toBeNull();
  });

  it("merged rows dim (read-only lift), single-repo drops the repo column", async () => {
    renderView("p1", { p1: detailP1() });
    await screen.findByText("Old merged work");
    const merged = rowButton(/Old merged work/);
    expect(merged.className).toContain("opacity-50");
    // Single-repo workspace: the repo name is not rendered as a column.
    expect(within(merged).queryByText("rennet")).toBeNull();
  });

  it("seeds the composer from an ?ask= handoff (the context map's discuss lands here)", async () => {
    renderView("p1", { p1: detailP1() }, "About X: is this claim right?");
    const composer = (await screen.findByLabelText(
      "Message the orchestrator",
    )) as HTMLTextAreaElement;
    expect(composer.value).toBe("About X: is this claim right?");
  });

  it("state chips read the DERIVED target vocabulary, not just the bare kind", async () => {
    renderView("p1", { p1: detailP1() });
    await screen.findByText("Teammate span fix");
    // A teammate PR that needs you reads "Needs you" — the derived state, never the flat
    // "Teammate PR" the kind-only label would print (finding 13).
    expect(within(rowButton(/Teammate span fix/)).getByText("Needs you")).toBeTruthy();
    expect(within(rowButton(/Teammate span fix/)).queryByText("Teammate PR")).toBeNull();
    // A merged PR reads "Merged".
    expect(within(rowButton(/Old merged work/)).getByText("Merged")).toBeTruthy();
    // A mine open PR has no derived state → it reads by its kind, "Your PR".
    expect(within(rowButton(/My open change/)).getByText("Your PR")).toBeTruthy();
  });
});
