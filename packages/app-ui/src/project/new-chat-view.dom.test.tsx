// @vitest-environment happy-dom
//
// The New Chat view (C12 §10.8) over a MemoryBridge: the smart list is built from
// `project.detail` through the reused `smart-list.ts`, the tabs filter with live
// counts, the text filter matches the documented fields, Escape is two-stage (clear
// the filter, then close), the headline project picker rewrites the URL, and the empty /
// filtered-empty copy is honest.
//
// C21 binds the mint (C12 cluster 7, gated on B9 and never returned to): a row click
// STARTS the session — `session.mint` mints it and claims the target, the client lands on
// `/s/<sessionId>` carrying the typed ask, and the claimed row LEAVES the list until its
// session is archived. Those legs are driven here over a MemoryBridge holding a real
// session list, with the row-vanish positive control both ways.
import type {
  CommandInput,
  CommandOutput,
  Project,
  ProjectDetail,
  SidebarSession,
} from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router, useSearch } from "wouter";
import { CoachProvider, useCoachStore } from "../coach/context";
import { type CoachStore, createCoachStore } from "../coach/store";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { newChatPath } from "../routes/url";
import { PriorSurfaceProvider } from "../settings/prior-surface";
import { act, cleanup, fireEvent, mount, screen, waitFor, within } from "../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { NewChatView } from "./new-chat-view";

afterEach(cleanup);

const GITHUB_RENNET = { forge: "github", owner: "rbutera", name: "rennet" } as const;
const GITHUB_WIDGET = { forge: "github", owner: "acme", name: "widget" } as const;
const GITLAB_WIDGET = { forge: "gitlab", owner: "acme", name: "widget" } as const;

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
        repository: "rbutera/rennet",
        forgeRepository: GITHUB_RENNET,
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
        repository: "rbutera/rennet",
        forgeRepository: GITHUB_RENNET,
        author: "rai",
        state: "open",
        reviewRequestedFromViewer: false,
        ci: "passing",
        additions: 10,
        deletions: 2,
        changedFiles: 3,
        createdAt: "2026-08-24T08:00:00.000Z",
        lastActivityAt: "2026-08-26T08:00:00.000Z",
      },
      {
        id: "pr-review",
        number: 202,
        title: "Teammate span fix",
        branch: "fix/span",
        repository: "rbutera/rennet",
        forgeRepository: GITHUB_RENNET,
        author: "emma",
        state: "open",
        reviewRequestedFromViewer: true,
        ci: "failing",
        additions: 4,
        deletions: 1,
        changedFiles: 1,
        createdAt: "2026-08-20T08:00:00.000Z",
        lastActivityAt: "2026-08-26T10:00:00.000Z",
      },
      {
        id: "pr-merged",
        number: 199,
        title: "Old merged work",
        branch: "feat/done",
        repository: "rbutera/rennet",
        forgeRepository: GITHUB_RENNET,
        author: "rai",
        state: "merged",
        reviewRequestedFromViewer: false,
        ci: "passing",
        additions: 100,
        deletions: 20,
        changedFiles: 8,
        createdAt: "2026-08-10T08:00:00.000Z",
        lastActivityAt: "2026-08-25T08:00:00.000Z",
      },
    ],
  };
}

function crossForgeDetail(): ProjectDetail {
  const base = detailP1().prs[0];
  if (base === undefined) throw new Error("missing PR fixture");
  return {
    viewer: { login: "rai" },
    truncated: false,
    locals: [],
    prs: [
      {
        ...base,
        id: "github-widget-7",
        number: 7,
        title: "GitHub widget",
        branch: "main",
        repository: "acme/widget",
        forgeRepository: GITHUB_WIDGET,
      },
      {
        ...base,
        id: "gitlab-widget-7",
        number: 7,
        title: "GitLab widget",
        branch: "main",
        repository: "acme/widget",
        forgeRepository: GITLAB_WIDGET,
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

/**
 * A MemoryBridge session store: `session.mint` really mints and claims (mint-or-reattach
 * on the branch, as the host does), `session.list` really serves what was minted. So the
 * row-vanish this suite proves is driven by a claim the click actually created.
 *
 * `session.mint` also CAPTURES and attaches, as the host does (#587) — one act — and records
 * what it was asked to start, so the suite can assert the target each row kind sent. There is
 * no `review.capture` handler on purpose: the client no longer issues one, and a MemoryBridge
 * throws on an unhandled command, so a regression that reintroduces client-side capture
 * sequencing fails here rather than passing quietly.
 */
function sessionStore(seeded: SidebarSession[] = []) {
  const sessions = [...seeded];
  const captures: Array<Record<string, unknown>> = [];
  let reviews = 0;
  return {
    sessions,
    captures,
    handlers: {
      "session.list": () => ({ sessions: [...sessions] }),
      "session.mint": (input: CommandInput<"session.mint">) => {
        captures.push({ command: "session.mint", ...input });
        reviews += 1;
        const claimed =
          input.branch === undefined
            ? undefined
            : sessions.find(
                (s) =>
                  s.projectId === input.projectId &&
                  s.claim?.branch === input.branch &&
                  (s.forgeRepository !== undefined && input.forgeRepository !== undefined
                    ? s.forgeRepository.forge === input.forgeRepository.forge &&
                      s.forgeRepository.owner === input.forgeRepository.owner &&
                      s.forgeRepository.name === input.forgeRepository.name
                    : s.repository === undefined ||
                      input.repository === undefined ||
                      s.repository === input.repository),
              );
        if (claimed) return { session: claimed, reattached: true };
        const session: SidebarSession = {
          id: `sess-${sessions.length + 1}`,
          projectId: input.projectId,
          title: input.branch ?? "New review",
          target: input.prNumber === undefined ? "your-branch" : "your-pr",
          createdAt: 1,
          // The host captures and attaches inside the mint, so the session it answers with
          // ALREADY holds its review. That is what `/s/:slug` resolves the workspace from.
          reviewId: `rev-${reviews}`,
          ...(input.repository === undefined ? {} : { repository: input.repository }),
          ...(input.forgeRepository === undefined
            ? {}
            : { forgeRepository: input.forgeRepository }),
          ...(input.branch === undefined
            ? {}
            : {
                claim: {
                  branch: input.branch,
                  ...(input.prNumber === undefined ? {} : { prNumber: input.prNumber }),
                },
              }),
        };
        sessions.push(session);
        return { session, reattached: false };
      },
    },
  };
}

/** Mount the view at /new-chat?project=<id>, resolving projectId from the URL exactly
 *  as the real `NewChatScreen` route does, so a picker navigation re-renders the view. */
function renderView(
  id: string,
  details: Record<string, ProjectDetail>,
  ask?: string,
  store = sessionStore(),
  priorSurface = { current: newChatPath() },
  coachStore?: CoachStore,
) {
  const history = memoryHistory(newChatPath(id, ask));
  const bridge = new MemoryBridge({
    "projects.list": () => ({ projects: [project("p1", "rennet"), project("p2", "whiteboard")] }),
    "project.detail": (input) => details[input.projectId] ?? EMPTY_DETAIL,
    ...store.handlers,
  } satisfies MemoryBridgeHandlers);

  function Harness() {
    const project = new URLSearchParams(useSearch()).get("project") ?? "";
    // Mirror `NewChatScreen`: it resolves a project before mounting the view and shows the
    // add-project entry otherwise, so `NewChatView` never runs on an empty id. The harness
    // used to mount it anyway, which fired `project.detail` with `projectId: ""` — a read
    // the daemon rejects (`z.string().min(1)`), invisible until MemoryBridge started
    // parsing. A harness that reaches states the app cannot reach tests a different app.
    return project === "" ? null : <NewChatView projectId={project} />;
  }

  function CoachReadout() {
    const store = useCoachStore();
    const active = store((state) => state.active);
    return <output data-testid="active-coach">{active ?? "none"}</output>;
  }

  const content = (
    <PriorSurfaceProvider value={priorSurface}>
      <Harness />
      {coachStore ? <CoachReadout /> : null}
    </PriorSurfaceProvider>
  );

  const view = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        {coachStore ? <CoachProvider store={coachStore}>{content}</CoachProvider> : content}
      </Router>
    </BridgeProvider>,
  );
  return { ...view, history, store };
}

/** The list row (`data-row="target"`) carrying `name` — scoped to the rows so the
 *  composer's own "Current Checkout" chip text is never a false match. */
function rowButton(name: RegExp): HTMLButtonElement {
  const match = screen
    .getAllByText(name)
    .map((node) => node.closest('button[data-row="target"]'))
    .find((button): button is HTMLButtonElement => button !== null);
  if (!match) throw new Error(`no row button for ${name}`);
  return match;
}

describe("NewChatView", () => {
  it("renders the smart list from project.detail with live tab counts", async () => {
    renderView("p1", { p1: detailP1() });
    await screen.findByText("My open change");

    // Merged work stays hidden until the toggle is enabled.
    expect(screen.getByRole("button", { name: /^All/ }).textContent).toContain("3");
    expect(screen.getByRole("button", { name: /^Needs you/ }).textContent).toContain("1");
    expect(screen.getByRole("button", { name: /^Yours/ }).textContent).toContain("2");
    expect(screen.getByRole("button", { name: /^Local branches/ }).textContent).toContain("1");
    expect(screen.getByRole("button", { name: /^Pull requests/ }).textContent).toContain("2");
  });

  it("names an unavailable forge on the routed surface without hiding healthy rows", async () => {
    renderView("p1", {
      p1: {
        ...detailP1(),
        forgeUnavailable: [
          {
            repository: GITLAB_WIDGET,
            reason: "tooling",
            repair: "Install `glab` and run `glab auth login`.",
          },
        ],
      },
    });

    const warning = await screen.findByRole("note");
    expect(warning.textContent).toContain("acme/widget could not load from GitLab");
    expect(warning.textContent).toContain("Install `glab` and run `glab auth login`.");
    expect(screen.getByText("My open change")).toBeTruthy();
    expect(screen.getByText("feat/local-x")).toBeTruthy();
  });

  it("filters by tab", async () => {
    renderView("p1", { p1: detailP1() });
    await screen.findByText("Teammate span fix");

    fireEvent.click(screen.getByRole("button", { name: /^Needs you/ }));
    expect(screen.getByText("Teammate span fix")).toBeTruthy();
    expect(screen.queryByText("My open change")).toBeNull();
    expect(screen.queryByText("feat/local-x")).toBeNull();
  });

  it("sorts by activity by default and by created time from the headers", async () => {
    renderView("p1", { p1: detailP1() });
    await screen.findByText("Teammate span fix");
    const titles = () =>
      screen
        .getAllByRole("button")
        .filter((button) => button.dataset.row === "target")
        .map((button) => button.textContent);

    expect(titles()[0]).toContain("Teammate span fix");
    fireEvent.click(screen.getByRole("button", { name: "Sort by created" }));
    expect(titles()[0]).toContain("My open change");
    fireEvent.click(screen.getByRole("button", { name: "Sort by created" }));
    expect(titles()[0]).toContain("Teammate span fix");
  });

  it("text-filters across the documented fields", async () => {
    renderView("p1", { p1: detailP1() });
    const filter = await screen.findByLabelText("Search branches, pull requests, and authors");

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
    const filter = await screen.findByLabelText("Search branches, pull requests, and authors");
    fireEvent.change(filter, { target: { value: "zzz-nothing" } });
    expect(screen.getByText("nothing matches")).toBeTruthy();

    cleanup();
    renderView("p2", { p2: EMPTY_DETAIL });
    await screen.findByText("no open branches or change requests yet");
  });

  // #872, the same family as the chat dock's: a surface that cannot tell "nothing here"
  // from "still looking" defaulted to the settled reading. `rows` is `[]` until
  // `project.detail` answers, and on a network-mounted clone that scan runs for minutes —
  // so the list stated an empty result for a scan that had not finished.
  //
  // The read is held OPEN here (a promise that never settles), which is the state the
  // reviewer was actually in. A fixture that resolved fast would never render this frame.
  it("says it is still scanning while project.detail has not answered", async () => {
    const history = memoryHistory(newChatPath("p1"));
    const bridge = new MemoryBridge({
      "projects.list": () => ({ projects: [project("p1", "rennet")] }),
      "project.detail": () => new Promise<CommandOutput<"project.detail">>(() => undefined),
      ...sessionStore().handlers,
    } satisfies MemoryBridgeHandlers);
    mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <PriorSurfaceProvider value={{ current: newChatPath() }}>
            <NewChatView projectId="p1" />
          </PriorSurfaceProvider>
        </Router>
      </BridgeProvider>,
    );
    await screen.findByText("scanning this project's branches and change requests…");
    // The settled sentence must NOT be on screen at the same time, or the fix would be a
    // second line rather than a different state.
    expect(screen.queryByText("no open branches or change requests yet")).toBeNull();
  });

  it("Escape is two-stage: clear the filter, then return to the prior surface", async () => {
    const { history } = renderView("p1", { p1: detailP1() }, undefined, sessionStore(), {
      current: "/s/session-before-new-chat?view=diff",
    });
    const filter = await screen.findByLabelText("Search branches, pull requests, and authors");
    fireEvent.change(filter, { target: { value: "span" } });

    // First Escape (filter non-empty): clears it, does NOT navigate.
    fireEvent.keyDown(filter, { key: "Escape" });
    expect((filter as HTMLInputElement).value).toBe("");
    expect(history.history.at(-1)).toBe(newChatPath("p1"));

    // Second Escape (empty filter): bubbles to the window handler → leaves the takeover.
    fireEvent.keyDown(filter, { key: "Escape" });
    await waitFor(() =>
      expect(history.history.at(-1)).toBe("/s/session-before-new-chat?view=diff"),
    );
  });

  it("the headline picker rewrites the URL", async () => {
    const { history, user } = renderView("p1", { p1: detailP1(), p2: EMPTY_DETAIL });
    await screen.findByText("My open change");

    await user.click(screen.getByRole("button", { name: "Choose project" }));
    await user.click(await screen.findByText("whiteboard"));

    await waitFor(() => expect(history.history.at(-1)).toBe(newChatPath("p2")));
  });

  it("the headline picker is a bordered pill with a glyph, over a searchable host-grouped list", async () => {
    // The picker used to be a borderless gold dotted-underline link over a plain button
    // list: no glyph, no search, no host grouping. It is the Projects page's picker now,
    // at headline size, so all three arrive with it — and there is ONE picker to drift.
    const { user } = renderView("p1", { p1: detailP1(), p2: EMPTY_DETAIL });
    await screen.findByText("My open change");

    const trigger = screen.getByRole("button", { name: "Choose project" });
    expect(trigger.className).toContain("border-line");
    expect(trigger.className).not.toContain("decoration-dotted");
    // The glyph, at the headline's size step rather than the inline one.
    expect(trigger.querySelector("svg")?.classList.value).toContain("size-5");
    // No size class of its own: it INHERITS the `<h1>`'s display face and size.
    expect(trigger.className).not.toMatch(/\btext-(13|sm|base|xs)\b/);

    await user.click(trigger);
    // A search box, and the host heading the sidebar groups by.
    expect(await screen.findByPlaceholderText("Search projects")).toBeTruthy();
    expect(screen.getByText("This machine")).toBeTruthy();
    // Every row carries its project glyph.
    const row = screen.getByText("whiteboard").closest("[data-slot='command-item']");
    expect(row?.querySelector("svg")).not.toBeNull();
  });

  it("merged rows dim (read-only lift), single-repo drops the repo column", async () => {
    renderView("p1", { p1: detailP1() });
    expect(screen.queryByText("Old merged work")).toBeNull();
    fireEvent.click(await screen.findByRole("switch", { name: "Show merged PRs" }));
    await screen.findByText("Old merged work");
    const merged = rowButton(/Old merged work/);
    expect(merged.className).toContain("opacity-50");
    // Single-repo workspace: the repo name is not rendered as a column.
    expect(within(merged).queryByText("rennet")).toBeNull();
  });

  it("state chips read the DERIVED target vocabulary, not just the bare kind", async () => {
    renderView("p1", { p1: detailP1() });
    await screen.findByText("Teammate span fix");
    expect(within(rowButton(/Teammate span fix/)).getByText("Review requested")).toBeTruthy();
    expect(within(rowButton(/Teammate span fix/)).queryByText("Teammate PR")).toBeNull();
    expect(within(rowButton(/feat\/local-x/)).queryByText("Your PR")).toBeNull();
    expect(within(rowButton(/My open change/)).getByText("Your PR")).toBeTruthy();
  });

  it("keeps ownership distinct when your own PR has failing CI", async () => {
    const detail = detailP1();
    detail.prs = detail.prs.map((pr) =>
      pr.id === "pr-mine" ? { ...pr, ci: "failing" as const } : pr,
    );
    renderView("p1", { p1: detail });

    await screen.findByText("My open change");
    expect(within(rowButton(/My open change/)).getByText("Your PR")).toBeTruthy();
    expect(within(rowButton(/My open change/)).getByLabelText("CI failing")).toBeTruthy();
  });

  // The `new-chat` mark ("Start Here") anchors the SIDEBAR's New Chat row now, not this
  // view — a mark pointing at a surface you had to already find teaches nothing. So this
  // view elects `smart-list` whatever the session state is, and never `new-chat`. The
  // first-run GATE that used to live here is proved on its new anchor, in
  // `coach/every-anchor.dom.test.tsx` ("only while there are no sessions").
  it("elects smart-list on this surface, never the sidebar's first-run mark", async () => {
    const coach = () =>
      createCoachStore({ initial: { seen: [], skipAll: false }, persist: () => undefined });

    const emptyCoach = coach();
    const empty = renderView(
      "p1",
      { p1: detailP1() },
      undefined,
      sessionStore(),
      undefined,
      emptyCoach,
    );
    // Zero sessions anywhere — the state that USED to elect `new-chat` here.
    await waitFor(() => expect(empty.getByTestId("active-coach").textContent).toBe("smart-list"));
    empty.unmount();
    cleanup();

    const activeCoach = coach();
    const active = renderView(
      "p1",
      { p1: detailP1() },
      undefined,
      sessionStore([
        {
          id: "s-active",
          projectId: "p2",
          title: "Elsewhere",
          target: "your-branch",
          createdAt: 1,
        },
      ]),
      undefined,
      activeCoach,
    );
    await waitFor(() => expect(active.getByTestId("active-coach").textContent).toBe("smart-list"));
    active.unmount();
    cleanup();

    const archivedCoach = coach();
    const archived = renderView(
      "p1",
      { p1: detailP1() },
      undefined,
      sessionStore([
        {
          id: "s-archived",
          projectId: "p2",
          title: "Archived elsewhere",
          target: "your-branch",
          createdAt: 1,
          archived: true,
        },
      ]),
      undefined,
      archivedCoach,
    );
    await waitFor(() =>
      expect(archived.getByTestId("active-coach").textContent).toBe("smart-list"),
    );

    archivedCoach.getState().replay();
    expect(archived.getByTestId("active-coach").textContent).toBe("smart-list");
  });
});

describe("NewChatView — a row click starts the session (C21, R26)", () => {
  it("mints a session, claims the PR target, and lands on it", async () => {
    const { history, store } = renderView("p1", { p1: detailP1() });
    await screen.findByText("My open change");

    fireEvent.click(rowButton(/My open change/));

    // The mint really happened on the host: one session, claiming the row's branch AND
    // its PR number (the two halves of one claimed thing).
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    expect(store.sessions[0]?.claim).toEqual({ branch: "feat/mine", prNumber: 201 });
    // …in ONE command (#587). The mint carries the PR number AND the row's `owner/name`,
    // which is what tells the host which repo of the workspace to open the PR against —
    // no `repoPath` is sent, because the client has no business naming a host path (R19).
    await waitFor(() => expect(store.captures).toHaveLength(1));
    expect(store.captures[0]).toMatchObject({
      command: "session.mint",
      branch: "feat/mine",
      prNumber: 201,
      repository: "rbutera/rennet",
      forgeRepository: GITHUB_RENNET,
    });
    expect(store.captures[0]?.repoPath).toBeUndefined();
    // The session the host answers with ALREADY holds its review — that is the whole act.
    expect(store.sessions[0]?.reviewId).toBe("rev-1");
    await waitFor(() => expect(history.history.at(-1)).toBe("/s/sess-1"));
  });

  it("keeps identical GitHub and GitLab targets separate through mint and session reload", async () => {
    const store = sessionStore();
    const first = renderView("p1", { p1: crossForgeDetail() }, undefined, store);
    await screen.findByText("GitHub widget");

    fireEvent.click(rowButton(/GitHub widget/));
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    expect(store.captures[0]).toMatchObject({
      command: "session.mint",
      branch: "main",
      prNumber: 7,
      repository: "acme/widget",
      forgeRepository: GITHUB_WIDGET,
    });
    expect(store.sessions[0]?.forgeRepository).toEqual(GITHUB_WIDGET);
    first.unmount();
    cleanup();

    renderView("p1", { p1: crossForgeDetail() }, undefined, store);
    expect(await screen.findByText("GitLab widget")).toBeTruthy();
    expect(screen.queryByText("GitHub widget")).toBeNull();
    expect(rowButton(/GitLab widget/).textContent).toContain("!7");
  });

  it("POSITIVE CONTROL: a claimed row leaves the list, and comes back on archive", async () => {
    // A live session already claiming `feat/mine` — exactly what the click above creates.
    const claimed: SidebarSession = {
      id: "sess-old",
      projectId: "p1",
      title: "feat/mine",
      target: "your-pr",
      createdAt: 1,
      claim: { branch: "feat/mine" },
    };
    const withClaim = renderView("p1", { p1: detailP1() }, undefined, sessionStore([claimed]));
    await screen.findByText("Teammate span fix");
    // GONE — and the tab counts fall with it, so the list never advertises a row it hides.
    expect(screen.queryByText("My open change")).toBeNull();
    expect(screen.getByRole("button", { name: /^All/ }).textContent).toContain("2");
    withClaim.unmount();
    cleanup();

    // The SAME substrate with that session ARCHIVED (the only release): the row is back.
    // If the filter keyed on anything but a live claim, this control would not flip.
    renderView("p1", { p1: detailP1() }, undefined, sessionStore([{ ...claimed, archived: true }]));
    expect(await screen.findByText("My open change")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^All/ }).textContent).toContain("3");
  });

  it("the row a click just claimed is gone when New Chat is reopened", async () => {
    const { history, store } = renderView("p1", { p1: detailP1() });
    await screen.findByText("feat/local-x");
    fireEvent.click(rowButton(/feat\/local-x/));
    await waitFor(() => expect(history.history.at(-1)).toBe("/s/sess-1"));
    // A LOCAL BRANCH row sends its branch AND its `owner/name`. The identity is the whole
    // point: `Project.openPath` is "the repo, or the FIRST included repo", so a workspace's
    // second repo would otherwise be captured against its first — silently, under the right
    // label. The host resolves the identity to a root; the client never names one.
    expect(store.captures[0]).toMatchObject({
      command: "session.mint",
      branch: "feat/local-x",
      repository: "rbutera/rennet",
      forgeRepository: GITHUB_RENNET,
    });
    expect(store.captures[0]?.repoPath).toBeUndefined();
    cleanup();

    // Reopen New Chat against the SAME store the click wrote into: the target it claimed
    // is not offered a second time (the host would reattach, not mint again).
    renderView("p1", { p1: detailP1() }, undefined, store);
    await screen.findByText("My open change");
    expect(screen.queryByText("feat/local-x")).toBeNull();
    expect(store.sessions).toHaveLength(1);
  });

  it("marks the row that is STARTING, and only that row, while its mint is in flight", async () => {
    // The spike marked the row you had SELECTED. This list has no selection — R26 made the
    // click the start — so the mark says "this row is starting". Held on a mint that never
    // settles, which is the only state in which the mark is on screen at all.
    const history = memoryHistory(newChatPath("p1"));
    const bridge = new MemoryBridge({
      "projects.list": () => ({ projects: [project("p1", "rennet")] }),
      "project.detail": () => detailP1(),
      "session.list": () => ({ sessions: [] }),
      "session.mint": () => new Promise(() => undefined),
    } satisfies MemoryBridgeHandlers);

    mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <PriorSurfaceProvider value={{ current: newChatPath() }}>
            <NewChatView projectId="p1" />
          </PriorSurfaceProvider>
        </Router>
      </BridgeProvider>,
    );
    await screen.findByText("My open change");

    // Before any click every row reserves the mark column, and none of them wears it — so
    // the list cannot shift sideways when one appears.
    const rows = () => screen.getAllByRole("button").filter((b) => b.dataset.row === "target");
    expect(rows().length).toBeGreaterThan(1);
    for (const row of rows()) expect(row.dataset.starting).toBeUndefined();

    fireEvent.click(rowButton(/My open change/));

    await waitFor(() => expect(rowButton(/My open change/).dataset.starting).toBe("true"));
    const started = rowButton(/My open change/);
    expect(started.className).toContain("bg-secondary/60");
    // The mark itself is the tick that faded IN on this row…
    expect(started.querySelector('[data-mark="start"]')?.classList.value).toContain("opacity-100");
    // …and stayed faded OUT everywhere else. Exactly one row is starting.
    const others = rows().filter((row) => row !== started);
    expect(others.length).toBeGreaterThan(0);
    for (const row of others) {
      expect(row.dataset.starting).toBeUndefined();
      expect(row.className).not.toContain("bg-secondary/60");
      const checks = row.querySelectorAll('[data-mark="start"]');
      expect(checks).toHaveLength(1);
      expect(checks[0]?.classList.value).toContain("opacity-0");
    }
  });

  // ── The starting mark's IDENTITY, not just its visibility ────────────────────
  //
  // `mint.pending` decides whether the mark is drawn; it never decided which row it names.
  // A mark is only on screen DURING a flight, so a stale id from a settled flight is
  // invisible until a LATER start puts the mark back — which is why every test below needs
  // a second start to observe the first one's leftovers.

  /**
   * A `session.mint` the test settles by hand on its FIRST call; every call after that
   * hangs, holding the second flight open so the mark it draws can be read.
   *
   * `session: null` is the honest resolve to use here: a host with no session store mints
   * nothing and the client stays on New Chat (`new-chat-mint.ts`), so the surface survives
   * its own success. A real mint navigates away and takes the mark with it.
   */
  function stagedMint() {
    let settleFirst: ((outcome: "resolve" | "reject") => void) | undefined;
    let calls = 0;
    const handler = (): Promise<CommandOutput<"session.mint">> => {
      calls += 1;
      if (calls > 1) return new Promise<CommandOutput<"session.mint">>(() => undefined);
      return new Promise<CommandOutput<"session.mint">>((resolve, reject) => {
        settleFirst = (outcome) => {
          if (outcome === "resolve") resolve({ session: null, reattached: false });
          else reject(new Error("session store unavailable"));
        };
      });
    };
    return {
      handler,
      async settle(outcome: "resolve" | "reject") {
        await act(async () => {
          settleFirst?.(outcome);
        });
      },
    };
  }

  /** `renderView`'s URL-driven harness with the mint handler swapped for a staged one. */
  function renderStaged(handler: () => Promise<CommandOutput<"session.mint">>) {
    const history = memoryHistory(newChatPath("p1"));
    const bridge = new MemoryBridge({
      "projects.list": () => ({ projects: [project("p1", "rennet"), project("p2", "whiteboard")] }),
      "project.detail": (input) => (input.projectId === "p1" ? detailP1() : EMPTY_DETAIL),
      "session.list": () => ({ sessions: [] }),
      "session.mint": handler,
    } satisfies MemoryBridgeHandlers);

    function Harness() {
      const id = new URLSearchParams(useSearch()).get("project") ?? "";
      return id === "" ? null : <NewChatView projectId={id} />;
    }

    const view = mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <PriorSurfaceProvider value={{ current: newChatPath() }}>
            <Harness />
          </PriorSurfaceProvider>
        </Router>
      </BridgeProvider>,
    );
    return { ...view, history };
  }

  function startAnotherRow(): void {
    fireEvent.click(rowButton(/feat\/local-x/));
  }

  it("a RESOLVED mint releases the row it marked before another row starts", async () => {
    const mint = stagedMint();
    renderStaged(mint.handler);
    await screen.findByText("My open change");

    fireEvent.click(rowButton(/My open change/));
    await waitFor(() => expect(rowButton(/My open change/).dataset.starting).toBe("true"));
    await mint.settle("resolve");
    await waitFor(() => expect(rowButton(/My open change/).dataset.starting).toBeUndefined());

    startAnotherRow();
    await waitFor(() => expect(rowButton(/feat\/local-x/).dataset.starting).toBe("true"));
    expect(rowButton(/My open change/).dataset.starting).toBeUndefined();
  });

  it("a REJECTED mint releases it too — a failed row does not resurrect", async () => {
    const mint = stagedMint();
    renderStaged(mint.handler);
    await screen.findByText("My open change");

    fireEvent.click(rowButton(/My open change/));
    await waitFor(() => expect(rowButton(/My open change/).dataset.starting).toBe("true"));
    await mint.settle("reject");
    await screen.findByRole("alert");

    startAnotherRow();
    await waitFor(() => expect(rowButton(/feat\/local-x/).dataset.starting).toBe("true"));
    expect(rowButton(/My open change/).dataset.starting).toBeUndefined();
  });

  it("switching project mid-flight does not carry the mark onto the new project's row", async () => {
    const { user } = renderStaged(
      () => new Promise<CommandOutput<"session.mint">>(() => undefined),
    );
    await screen.findByText("My open change");

    fireEvent.click(rowButton(/My open change/));
    await waitFor(() => expect(rowButton(/My open change/).dataset.starting).toBe("true"));

    await user.click(screen.getByRole("button", { name: "Choose project" }));
    await user.click(await screen.findByText("whiteboard"));

    await waitFor(() =>
      expect(screen.getByText("no open branches or change requests yet")).toBeTruthy(),
    );
    expect(document.querySelector('[data-starting="true"]')).toBeNull();
  });

  it("a failed mint says so and stays put — nothing is claimed to have started", async () => {
    const history = memoryHistory(newChatPath("p1"));
    const bridge = new MemoryBridge({
      "projects.list": () => ({ projects: [project("p1", "rennet")] }),
      "project.detail": () => detailP1(),
      "session.list": () => ({ sessions: [] }),
      "session.mint": () => {
        throw new Error("session store unavailable");
      },
    } satisfies MemoryBridgeHandlers);

    function Harness() {
      const id = new URLSearchParams(useSearch()).get("project") ?? "";
      return <NewChatView projectId={id} />;
    }
    mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <Harness />
        </Router>
      </BridgeProvider>,
    );

    await screen.findByText("My open change");
    fireEvent.click(rowButton(/My open change/));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("session store unavailable");
    // Still on New Chat: a failed mint never navigates into a session that does not exist.
    expect(history.history.at(-1)).toBe(newChatPath("p1"));
  });
});
