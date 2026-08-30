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
import type { CommandInput, Project, ProjectDetail, SidebarSession } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router, useSearch } from "wouter";
import { CoachProvider, useCoachStore } from "../coach/context";
import { type CoachStore, createCoachStore } from "../coach/store";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { newChatPath } from "../routes/url";
import { PriorSurfaceProvider } from "../settings/prior-surface";
import { cleanup, fireEvent, mount, screen, waitFor, within } from "../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { NewChatView } from "./new-chat-view";

afterEach(cleanup);

const GITHUB_RENNET = { forge: "github", owner: "rbutera", name: "rennet" } as const;
const GITHUB_WIDGET = { forge: "github", owner: "acme", name: "widget" } as const;
const GITHUB_GADGET = { forge: "github", owner: "acme", name: "gadget" } as const;
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

function crossForgeLocalDetail(): ProjectDetail {
  const base = detailP1().locals[0];
  if (base === undefined) throw new Error("missing local fixture");
  return {
    viewer: { login: "rai" },
    truncated: false,
    locals: [
      {
        ...base,
        id: "github-widget-main",
        branch: "main",
        repository: "acme/widget",
        forgeRepository: GITHUB_WIDGET,
      },
      {
        ...base,
        id: "gitlab-widget-main",
        branch: "main",
        repository: "acme/widget",
        forgeRepository: GITLAB_WIDGET,
      },
    ],
    prs: [],
  };
}

function sameForgeLocalDetail(): ProjectDetail {
  const base = detailP1().locals[0];
  if (base === undefined) throw new Error("missing local fixture");
  return {
    viewer: { login: "rai" },
    truncated: false,
    locals: [
      {
        ...base,
        id: "github-widget-main",
        branch: "main",
        repository: "acme/widget",
        forgeRepository: GITHUB_WIDGET,
      },
      {
        ...base,
        id: "github-gadget-release",
        branch: "release",
        repository: "acme/gadget",
        forgeRepository: GITHUB_GADGET,
      },
    ],
    prs: [],
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

    // 1 local + 3 PRs, no dedupe (distinct branches).
    expect(screen.getByRole("button", { name: /^All/ }).textContent).toContain("4");
    expect(screen.getByRole("button", { name: /^Needs you/ }).textContent).toContain("1");
    expect(screen.getByRole("button", { name: /^Mine/ }).textContent).toContain("3");
    expect(screen.getByRole("button", { name: /^Local/ }).textContent).toContain("1");
    expect(screen.getByRole("button", { name: /^Requests/ }).textContent).toContain("3");
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
    const filter = await screen.findByLabelText("Filter branches and change requests");

    // A PR title match.
    fireEvent.change(filter, { target: { value: "span" } });
    expect(screen.getByText("Teammate span fix")).toBeTruthy();
    expect(screen.queryByText("My open change")).toBeNull();

    // A local branch match (branch+repo is the local field set).
    fireEvent.change(filter, { target: { value: "local-x" } });
    expect(screen.getByText("feat/local-x")).toBeTruthy();
    expect(screen.queryByText("Teammate span fix")).toBeNull();
  });

  it("visibly and accessibly disambiguates identical local targets from different forges", async () => {
    renderView("p1", { p1: crossForgeLocalDetail() });

    const github = await screen.findByRole("button", {
      name: /main.*GitHub.*acme\/widget.*Reviewed/i,
    });
    const gitlab = screen.getByRole("button", {
      name: /main.*GitLab.*acme\/widget.*Reviewed/i,
    });
    expect(within(github).getByText("GitHub")).toBeTruthy();
    expect(within(gitlab).getByText("GitLab")).toBeTruthy();
    expect(within(github).getByText("acme/widget")).toBeTruthy();
    expect(within(gitlab).getByText("acme/widget")).toBeTruthy();

    const filter = screen.getByLabelText("Filter branches and change requests");
    fireEvent.change(filter, { target: { value: "gitlab" } });
    expect(
      screen.getByRole("button", { name: /main.*GitLab.*acme\/widget.*Reviewed/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /main.*GitHub.*acme\/widget.*Reviewed/i }),
    ).toBeNull();
  });

  it("keeps ordinary same-forge repository labels as plain owner/name", async () => {
    renderView("p1", { p1: sameForgeLocalDetail() });

    expect(await screen.findByText("acme/widget")).toBeTruthy();
    expect(screen.getByText("acme/gadget")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();

    fireEvent.change(screen.getByLabelText("Filter branches and change requests"), {
      target: { value: "github" },
    });
    expect(await screen.findByText("Nothing matches.")).toBeTruthy();
  });

  it("filtered-empty and empty states read honestly", async () => {
    renderView("p1", { p1: detailP1() });
    const filter = await screen.findByLabelText("Filter branches and change requests");
    fireEvent.change(filter, { target: { value: "zzz-nothing" } });
    expect(screen.getByText("Nothing matches.")).toBeTruthy();

    cleanup();
    renderView("p2", { p2: EMPTY_DETAIL });
    await screen.findByText("No open branches or change requests yet.");
  });

  it("Escape is two-stage: clear the filter, then return to the prior surface", async () => {
    const { history } = renderView("p1", { p1: detailP1() }, undefined, sessionStore(), {
      current: "/s/session-before-new-chat?view=diff",
    });
    const filter = await screen.findByLabelText("Filter branches and change requests");
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

    await user.click(screen.getByRole("button", { name: /^Project:/ }));
    await user.click(await screen.findByText("whiteboard"));

    await waitFor(() => expect(history.history.at(-1)).toBe(newChatPath("p2")));
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
    // A local target whose served pipeline stage is reviewed reads "Reviewed".
    expect(within(rowButton(/feat\/local-x/)).getByText("Reviewed")).toBeTruthy();
    // A mine open PR has no derived state → it reads by its kind, "Your PR".
    expect(within(rowButton(/My open change/)).getByText("Your PR")).toBeTruthy();
  });

  it("shows Needs you ahead of the owner kind when the review state demands attention", async () => {
    const detail = detailP1();
    detail.prs = detail.prs.map((pr) =>
      pr.id === "pr-mine" ? { ...pr, ci: "failing" as const } : pr,
    );
    renderView("p1", { p1: detail });

    await screen.findByText("My open change");
    expect(within(rowButton(/My open change/)).getByText("Needs you")).toBeTruthy();
    expect(within(rowButton(/My open change/)).queryByText("Your PR")).toBeNull();
  });

  it("offers the first-run New Chat coach only before any session exists anywhere", async () => {
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
    await waitFor(() => expect(empty.getByTestId("active-coach").textContent).toBe("new-chat"));
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
  it("mints a session, claims the PR target, and lands on it carrying the typed ask", async () => {
    const { history, store } = renderView("p1", { p1: detailP1() });
    await screen.findByText("My open change");

    const composer = screen.getByLabelText("Message the orchestrator") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "  Why is this diff so large?  " } });
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
    // …and the client landed on THAT session's route, carrying the trimmed ask.
    await waitFor(() =>
      expect(history.history.at(-1)).toBe("/s/sess-1?ask=Why+is+this+diff+so+large%3F"),
    );
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

  it("the Current Checkout row starts a NO-TARGET session — it claims nothing", async () => {
    const { history, store } = renderView("p1", { p1: detailP1() });
    await screen.findByText("My open change");

    fireEvent.click(rowButton(/Current Checkout/));

    await waitFor(() => expect(store.sessions).toHaveLength(1));
    expect(store.sessions[0]?.claim).toBeUndefined();
    // No branch, no repository: the no-target row is the project as a whole, which is the
    // one case where the project's own path IS the right repo.
    await waitFor(() => expect(store.captures).toHaveLength(1));
    expect(store.captures[0]).toMatchObject({ command: "session.mint", projectId: "p1" });
    expect(store.captures[0]?.branch).toBeUndefined();
    expect(store.captures[0]?.repository).toBeUndefined();
    // It still holds a review — the checkout row starts a REVIEW, not a bare chat.
    expect(store.sessions[0]?.reviewId).toBe("rev-1");
    // No ask typed ⇒ no `?ask=` on the route; nothing is invented.
    await waitFor(() => expect(history.history.at(-1)).toBe("/s/sess-1"));
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
    expect(screen.getByRole("button", { name: /^All/ }).textContent).toContain("3");
    withClaim.unmount();
    cleanup();

    // The SAME substrate with that session ARCHIVED (the only release): the row is back.
    // If the filter keyed on anything but a live claim, this control would not flip.
    renderView("p1", { p1: detailP1() }, undefined, sessionStore([{ ...claimed, archived: true }]));
    expect(await screen.findByText("My open change")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^All/ }).textContent).toContain("4");
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
