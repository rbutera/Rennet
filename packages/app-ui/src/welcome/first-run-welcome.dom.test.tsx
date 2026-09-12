// @vitest-environment happy-dom
import type {
  CommandInput,
  DiscoveryResult,
  FsListDirResult,
  Project,
  ReviewRoleMapping,
  SettingsView,
} from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { cleanup, fireEvent, mount, screen, waitFor, within } from "../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import {
  bindWelcomeIdleLoops,
  welcomeFragmentIdleAnimation,
  welcomeParticleIdleAnimation,
} from "./first-run-welcome";

const ROLES: readonly ReviewRoleMapping[] = [
  {
    id: "orchestrator",
    label: "Orchestrator",
    hint: "The review seat.",
    dual: { value: { model: "opus-4.8", effort: "high" }, layer: "default" },
    claudeOnly: { value: { model: "opus-4.8", effort: "high" }, layer: "default" },
    codexOnly: { value: { model: "gpt-5.6-sol", effort: "high" }, layer: "default" },
  },
];

const PROJECT: Project = {
  id: "rennet",
  name: "rennet",
  path: "/home/rai/rennet",
  kind: "repo",
  repoCount: 1,
  branchCount: 3,
  primaryBranch: "main",
  openPath: "/home/rai/rennet",
  addedAt: "2026-08-28T00:00:00.000Z",
  source: "local",
};

const DISCOVERY: DiscoveryResult = {
  path: PROJECT.path,
  kind: "repo",
  repos: [{ name: "rennet", path: PROJECT.path, branches: 3 }],
  primaryBranch: "main",
  source: "local",
};

const HOME: FsListDirResult = {
  path: PROJECT.path,
  home: "/home/rai",
  parent: "/home/rai",
  entries: [],
};

function freshSettings(): SettingsView {
  return {
    scheme: "system",
    schemeProvenance: {
      layer: "builtin",
      contributions: [{ layer: "builtin", value: "system", effective: true }],
    },
    appearanceMalformed: false,
    projects: [],
    reviewRoles: [...ROLES],
    coachmarks: { seen: ["start-review"], skipAll: true },
  };
}

function welcomeBridge(
  overrides: MemoryBridgeHandlers = {},
  options: { access?: () => Promise<boolean> } = {},
) {
  let settings = freshSettings();
  let projects: Project[] = [];
  const handlers: MemoryBridgeHandlers = {
    "settings.get": () => settings,
    "projects.list": () => ({ projects }),
    "project.detail": () => ({ viewer: { login: "rai" }, truncated: false, locals: [], prs: [] }),
    "session.list": () => ({ sessions: [] }),
    "settings.setAppearance": ({ scheme }) => {
      settings = { ...settings, scheme: scheme ?? "system" };
      return { scheme: settings.scheme, schemeProvenance: settings.schemeProvenance };
    },
    "settings.setThemePack": ({ themePack }) => {
      settings = { ...settings, themePack };
      return { themePack };
    },
    "harness.hosts": () => ({
      hosts: [
        {
          source: "local",
          asked: true,
          detected: [
            { id: "claude", version: "2.1.0", enabled: true },
            { id: "codex", version: "0.38.0", enabled: true },
          ],
        },
      ],
    }),
    "forge.hosts": () => ({
      hosts: [
        {
          source: "local",
          asked: true,
          detected: [
            {
              id: "github",
              version: "2.76.0",
              status: "available",
              detail: "Authenticated through the gh CLI.",
            },
            {
              id: "gitlab",
              version: "1.80.0",
              status: "available",
              detail: "Authenticated with GitLab through the `glab` CLI.",
            },
          ],
        },
      ],
    }),
    "harness.setEnabled": () => ({ disabled: [] }),
    "settings.setRoleAssignment": () => ({ reviewRoles: [...ROLES] }),
    "fs.listDir": () => ({ result: HOME }),
    "repository.choose": ({ path }) => ({ path: path ?? null }),
    "project.discover": () => ({ discovery: DISCOVERY }),
    "projects.add": () => {
      projects = [PROJECT];
      return { project: PROJECT, projects };
    },
    "settings.setLastProject": ({ source, projectId }) => ({ source, projectId }),
    "settings.completeWelcome": () => {
      const completedAt = "2026-08-28T12:00:00.000Z";
      settings = { ...settings, welcome: { completedAt } };
      return { completedAt };
    },
    ...overrides,
  };
  return new MemoryBridge(handlers, {
    platform: "darwin",
    openFullDiskAccessSettings: options.access,
  });
}

async function advanceToReviewSetup(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Continue to Rennet" }));
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
  await screen.findByText("Your tools, already connected.");
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
  await screen.findByText("Choose how Rennet reviews.");
}

/** Drive the whole wizard to its Ready stage, which is where the badge lives. */
async function advanceToReady(): Promise<void> {
  await advanceToReviewSetup();
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
  const add = await screen.findByRole("button", { name: "Add" });
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(add);
  await screen.findByRole("button", { name: "Start a new chat" });
}

/** The sphere's root. happy-dom has no WebGL, so what renders is the static colour mark
 *  — but `data-liquid-sphere` and the sized box are on the root either way, which is what
 *  every assertion below reads. */
function sphere(root: ParentNode): HTMLElement {
  const found = root.querySelectorAll<HTMLElement>("[data-liquid-sphere]");
  if (found.length !== 1) throw new Error(`expected one sphere, found ${found.length}`);
  return found[0] as HTMLElement;
}

/** The wordmark SVG beside a sphere: the non-lucide svg that is NOT the sphere's own
 *  static fallback drawing (which comes first in document order and would otherwise be
 *  what a "the one non-lucide svg" helper silently measured). */
function wordmark(root: ParentNode): SVGElement {
  const svg = [...root.querySelectorAll<SVGElement>("svg:not(.lucide)")].find(
    (el) => el.closest("[data-liquid-sphere]") === null,
  );
  if (!svg) throw new Error("no wordmark");
  return svg;
}

/** The retired assembly: `RennetLockup part="mark"` draws the sphere as static artwork on
 *  the authored 126 grid, so this viewBox is the fingerprint of a mark the live sphere was
 *  supposed to replace. The sphere's own fallback is drawn on a 100 grid, so it is not
 *  matched here — which is the whole point: this finds a MISSED site, not a fallback. */
function staticMarks(root: ParentNode): readonly Element[] {
  return [...root.querySelectorAll('svg[viewBox="0 0 126 126"]')];
}

async function gitLabToolRow() {
  const heading = await screen.findByRole("heading", { name: /GitLab CLI/ });
  const article = heading.closest<HTMLElement>("article");
  if (!article) throw new Error("GitLab CLI heading is not inside a tool row");
  return within(article);
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-rn-theme");
});

describe("FirstRunWelcome", () => {
  it("starts with realistic flying code, no top bar, and stays independent of coach marks", async () => {
    const { container } = mount(
      <RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />,
    );
    expect(
      await screen.findByText("You stopped writing the code. You still have to answer for it."),
    ).toBeTruthy();
    expect(container.querySelector("header")).toBeNull();
    const fragments = [...container.querySelectorAll("[data-fragment]")];
    expect(fragments).toHaveLength(10);
    expect(new Set(fragments.map((fragment) => fragment.textContent?.length)).size).toBeGreaterThan(
      5,
    );
    expect(screen.getByText("Appearance")).toBeTruthy();
  });

  it("removes the exact visibilitychange listeners it added, on unmount", async () => {
    // The drift loops are `repeat: Infinity` and motion keeps its frame loop running in a
    // hidden window, so the welcome parks them on `document.hidden`. Observable here: the
    // listener exists while the screen is up, and every handler registered is later removed
    // BY IDENTITY (a cleanup passing a fresh closure removes nothing and leaks the loop).
    // Not observable here: that the handler actually pauses motion — see the report.
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    try {
      const { unmount } = mount(
        <RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />,
      );
      await screen.findByText("You stopped writing the code. You still have to answer for it.");
      const handlers = added.mock.calls
        .filter(([type]) => type === "visibilitychange")
        .map(([, handler]) => handler);
      expect(handlers.length).toBeGreaterThan(0);
      expect(removed.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(0);
      unmount();
      expect(
        removed.mock.calls
          .filter(([type]) => type === "visibilitychange")
          .map(([, handler]) => handler),
      ).toEqual(handlers);
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  });

  it("replaces the opening visibility listener with one for the post-click reel", async () => {
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    try {
      const { unmount } = mount(
        <RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Continue to Rennet" }));

      await waitFor(() => {
        const addedHandlers = added.mock.calls
          .filter(([type]) => type === "visibilitychange")
          .map(([, handler]) => handler);
        const removedHandlers = removed.mock.calls
          .filter(([type]) => type === "visibilitychange")
          .map(([, handler]) => handler);
        expect(addedHandlers.length).toBeGreaterThanOrEqual(2);
        expect(removedHandlers).toContain(addedHandlers[0]);
      });

      const postClickHandler = added.mock.calls
        .filter(([type]) => type === "visibilitychange")
        .map(([, handler]) => handler)
        .at(-1);
      unmount();
      expect(
        removed.mock.calls
          .filter(([type]) => type === "visibilitychange")
          .map(([, handler]) => handler),
      ).toContain(postClickHandler);
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  });

  it("keeps every repeat-forever welcome animation transform-only", () => {
    const fragments = Array.from({ length: 10 }, (_, index) =>
      welcomeFragmentIdleAnimation(index, 1_200, 800),
    );
    const particles = Array.from({ length: 38 }, (_, index) => welcomeParticleIdleAnimation(index));

    for (const animation of fragments) {
      expect(Object.keys(animation.keyframes).sort()).toEqual(["rotate", "x", "y"]);
      expect(animation.transition.repeat).toBe(Infinity);
    }
    for (const animation of particles) {
      expect(Object.keys(animation.keyframes).sort()).toEqual(["x", "y"]);
      expect(animation.transition.repeat).toBe(Infinity);
    }
  });

  it("pauses, resumes, and stops every bound idle loop", () => {
    let hidden = true;
    let listener = (): void => undefined;
    const added = vi.fn((_type: "visibilitychange", next: () => void) => {
      listener = next;
    });
    const removed = vi.fn();
    const loops = Array.from({ length: 48 }, () => ({
      pause: vi.fn(),
      play: vi.fn(),
      stop: vi.fn(),
    }));

    const cleanup = bindWelcomeIdleLoops(loops, {
      get hidden() {
        return hidden;
      },
      addEventListener: added,
      removeEventListener: removed,
    });
    expect(loops.every((loop) => loop.pause.mock.calls.length === 1)).toBe(true);
    expect(loops.every((loop) => loop.play.mock.calls.length === 0)).toBe(true);

    hidden = false;
    listener();
    expect(loops.every((loop) => loop.play.mock.calls.length === 1)).toBe(true);

    cleanup();
    expect(removed).toHaveBeenCalledWith("visibilitychange", listener);
    expect(loops.every((loop) => loop.stop.mock.calls.length === 1)).toBe(true);
  });

  it("renders each code fragment as toned spans over its full-length source", async () => {
    // What a DOM test CAN see: the token structure and which tone each token claims.
    // What it CANNOT see: the colour those tones resolve to (happy-dom has no style
    // engine, and the tones resolve through `--rn-syn-*` in index.css), nor the drift
    // and gather that move these nodes. Asserted here: structure only.
    const { container } = mount(
      <RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />,
    );
    await screen.findByText("You stopped writing the code. You still have to answer for it.");
    const first = container.querySelector("[data-fragment]");
    if (!first) throw new Error("no code fragment rendered");
    // Six lines, not the four of the truncated string version — the fragments carry the
    // prototype's whole function body, so the rain reads as real code.
    expect(first.querySelectorAll(":scope > span")).toHaveLength(6);
    expect(first.querySelector('[data-tone="keyword"]')?.textContent).toBe("export async function");
    expect(first.querySelector('[data-tone="function"]')?.textContent).toBe(" listProjectFiles");
    const tones = new Set(
      [...container.querySelectorAll("[data-fragment] [data-tone]")].map(
        (node) => node.getAttribute("data-tone") ?? "",
      ),
    );
    // Every tone in the catalogue is actually used by some fragment; a palette entry
    // nothing renders is a colour nobody sees.
    expect([...tones].sort()).toEqual([
      "add",
      "comment",
      "function",
      "hunk",
      "keyword",
      "literal",
      "remove",
      "string",
      "type",
    ]);
  });

  it("carries the whole sentence per reel row, with the first row repeated for the wrap", async () => {
    // The reel's MOTION (a `y` keyframe track held 1.55s per word) is invisible here —
    // no layout, no animation frames. What is assertable is the thing the setInterval
    // word-swap could not do: every row holds the complete sentence, so nothing reflows
    // mid-swap, and row 0 is repeated last so the loop closes without a jump.
    const { container } = mount(
      <RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />,
    );
    await screen.findByText("You stopped writing the code. You still have to answer for it.");
    const rows = [...container.querySelectorAll("[data-sentence-reel] > strong")];
    expect(rows).toHaveLength(21);
    expect(rows[0]?.textContent).toBe("Rennet makes code review digestible");
    expect(rows.at(-1)?.textContent).toBe(rows[0]?.textContent);
    for (const row of rows) expect(row.textContent).toContain("Rennet makes code review ");
  });

  it("remounts the stage on every step so its entrance animation re-fires", async () => {
    // `key={step}` is the whole mechanism: a CSS animation on a node that survives the
    // step change plays once, on first paint, and never again. Node identity is the only
    // DOM-visible proof that the remount happens.
    const { container } = mount(
      <RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />,
    );
    await screen.findByText("You stopped writing the code. You still have to answer for it.");
    const first = container.querySelector("main");
    expect(first?.className).toContain("animate-welcome-step");
    fireEvent.click(screen.getByRole("button", { name: "Continue to Rennet" }));
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
    await screen.findByText("Your tools, already connected.");
    const second = container.querySelector("main");
    expect(second).not.toBe(first);
    expect(second?.className).toContain("animate-welcome-step");
  });

  it("marks a finished step complete, not merely 'not current'", async () => {
    // Three states, and the third one is the point: after leaving Appearance its pip
    // reads `complete` with a tick, while Review setup is `active` and the rest are
    // `upcoming`. Position matters here — asserting the SET of states would pass on a
    // wizard that marked the wrong steps done.
    mount(<RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue to Rennet" }));
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
    await screen.findByText("Your tools, already connected.");
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
    await screen.findByText("Choose how Rennet reviews.");
    const nav = screen.getByRole("navigation", { name: "Welcome progress" });
    expect(
      [...nav.querySelectorAll("button")].map((pip) => pip.getAttribute("data-state")),
    ).toEqual(["complete", "complete", "active", "upcoming", "upcoming"]);
    // The done pips swap their number for a tick; the active one keeps its number.
    expect(within(nav).getByText("3")).toBeTruthy();
    expect(within(nav).queryByText("1")).toBeNull();
  });

  it("applies and persists appearance immediately inside the welcome", async () => {
    const setTheme = vi.fn((input: CommandInput<"settings.setThemePack">) => ({
      themePack: input.themePack,
    }));
    mount(
      <RennetRouterApp
        bridge={welcomeBridge({ "settings.setThemePack": setTheme })}
        history={memoryHistory("/new-chat")}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Continue to Rennet" }));
    fireEvent.click(screen.getByRole("button", { name: "Dracula" }));
    await waitFor(() => expect(document.documentElement.dataset.rnTheme).toBe("dracula"));
    expect(setTheme).toHaveBeenCalledWith({ themePack: "dracula" });
  });

  it("shows an authenticated GitLab CLI from live host detection", async () => {
    mount(<RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue to Rennet" }));
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));

    const gitlab = await gitLabToolRow();
    expect(gitlab.getByText("1.80.0")).toBeTruthy();
    expect(gitlab.getByText("Available")).toBeTruthy();
    expect(gitlab.getByText("Authenticated with GitLab through the `glab` CLI.")).toBeTruthy();
  });

  it("shows the host's detected GitLab CLI and exact auth repair command", async () => {
    mount(
      <RennetRouterApp
        bridge={welcomeBridge({
          "forge.hosts": () => ({
            hosts: [
              {
                source: "local",
                asked: true,
                detected: [
                  {
                    id: "github",
                    version: null,
                    status: "not-installed",
                    detail: "The `gh` CLI was not found on this host. Run `brew install gh`.",
                  },
                  {
                    id: "gitlab",
                    version: "1.80.0",
                    status: "not-authenticated",
                    detail:
                      "`glab` is installed but not signed in to gitlab.com. Run `glab auth login --hostname gitlab.com`.",
                  },
                ],
              },
            ],
          }),
        })}
        history={memoryHistory("/new-chat")}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Continue to Rennet" }));
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));

    const gitlab = await gitLabToolRow();
    expect(gitlab.getByText("1.80.0")).toBeTruthy();
    expect(gitlab.getByText("Not authenticated")).toBeTruthy();
    expect(
      gitlab.getByText(
        "`glab` is installed but not signed in to gitlab.com. Run `glab auth login --hostname gitlab.com`.",
      ),
    ).toBeTruthy();
    expect(
      gitlab.queryByText("GitLab merge-request integration is not part of this launch."),
    ).toBeNull();
  });

  it("shows a missing GitLab CLI with its exact install repair and no guessed version", async () => {
    mount(
      <RennetRouterApp
        bridge={welcomeBridge({
          "forge.hosts": () => ({
            hosts: [
              {
                source: "local",
                asked: true,
                detected: [
                  {
                    id: "gitlab",
                    version: null,
                    status: "not-installed",
                    detail: "The `glab` CLI was not found on this host. Run `brew install glab`.",
                  },
                ],
              },
            ],
          }),
        })}
        history={memoryHistory("/new-chat")}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Continue to Rennet" }));
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));

    const gitlab = await gitLabToolRow();
    expect(gitlab.getByText("Not installed")).toBeTruthy();
    expect(
      gitlab.getByText("The `glab` CLI was not found on this host. Run `brew install glab`."),
    ).toBeTruthy();
    expect(gitlab.queryByText("1.80.0")).toBeNull();
  });

  it("shows an unreachable GitLab CLI without calling it signed out", async () => {
    const detail =
      "`glab` could not reach or verify GitLab.com. Run `glab auth status --hostname gitlab.com`.";
    mount(
      <RennetRouterApp
        bridge={welcomeBridge({
          "forge.hosts": () => ({
            hosts: [
              {
                source: "local",
                asked: true,
                detected: [
                  {
                    id: "gitlab",
                    version: "1.80.0",
                    status: "not-authenticated",
                    authProbe: "unreachable",
                    detail,
                  },
                ],
              },
            ],
          }),
        })}
        history={memoryHistory("/new-chat")}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Continue to Rennet" }));
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));

    const gitlab = await gitLabToolRow();
    expect(gitlab.getByText("1.80.0")).toBeTruthy();
    expect(gitlab.getByText("Unreachable")).toBeTruthy();
    expect(gitlab.getByText(detail)).toBeTruthy();
    expect(gitlab.queryByText("Not authenticated")).toBeNull();
  });

  it("saves the orchestrator and default dual-harness choice before project setup", async () => {
    const enabled = vi.fn(() => ({ disabled: [] }));
    const role = vi.fn(() => ({ reviewRoles: [...ROLES] }));
    mount(
      <RennetRouterApp
        bridge={welcomeBridge({
          "harness.setEnabled": enabled,
          "settings.setRoleAssignment": role,
        })}
        history={memoryHistory("/new-chat")}
      />,
    );
    await advanceToReviewSetup();
    fireEvent.click(screen.getByRole("button", { name: /Codex Codex Existing install/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
    await screen.findByText("Add the code you’re responsible for.");
    expect(enabled).toHaveBeenCalledWith({ source: "local", harnessId: "claude", enabled: true });
    expect(enabled).toHaveBeenCalledWith({ source: "local", harnessId: "codex", enabled: true });
    expect(role).toHaveBeenCalledWith({
      roleId: "orchestrator",
      scenario: "dual",
      assignment: { model: "gpt-5.6-sol", effort: "high" },
    });
  });

  it("opens macOS Full Disk Access from the project step", async () => {
    const access = vi.fn(async () => true);
    mount(
      <RennetRouterApp
        bridge={welcomeBridge({}, { access })}
        history={memoryHistory("/new-chat")}
      />,
    );
    await advanceToReviewSetup();
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Grant Full Disk Access/ }));
    expect(access).toHaveBeenCalledOnce();
  });

  it("adds a project, reports completion failure, then opens the real New Chat", async () => {
    let failCompletion = true;
    const complete = vi.fn(() => {
      if (failCompletion) throw new Error("disk unavailable");
      return { completedAt: "2026-08-28T12:00:00.000Z" };
    });
    const history = memoryHistory("/new-chat");
    mount(
      <RennetRouterApp
        bridge={welcomeBridge({ "settings.completeWelcome": complete })}
        history={history}
      />,
    );
    await advanceToReviewSetup();
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
    const add = await screen.findByRole("button", { name: "Add" });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    fireEvent.click(await screen.findByRole("button", { name: "Start a new chat" }));
    expect(await screen.findByText(/Setup wasn’t completed: disk unavailable/)).toBeTruthy();
    failCompletion = false;
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    await waitFor(() => expect(history.history.at(-1)).toBe("/new-chat?project=rennet"));
  });

  it("mounts no shell, so adding a project mid-welcome paints no coach mark", async () => {
    // The regression control for D7. Coach marks are ARMED here (no `seen`, no
    // skipAll) — the opposite of the rest of this file — and the project is added
    // FROM the wizard, which invalidates `projects.list`. Against the old code that
    // is the exact failing shape: the shell sat mounted in a `display:none` underlay,
    // the freshly non-empty list rendered `NewChatView` inside it, its `new-chat`
    // anchor registered, the store elected "Start Here", and the coachmark — a portal
    // to `document.body`, outside the underlay and outside its `inert` — painted its
    // spotlight and card over the wizard. Unmounting the shell removes the anchor.
    const history = memoryHistory("/new-chat");
    mount(
      <RennetRouterApp
        bridge={welcomeBridge({
          "settings.get": () => ({ ...freshSettings(), coachmarks: undefined }),
        })}
        history={history}
      />,
    );
    await advanceToReviewSetup();
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
    const add = await screen.findByRole("button", { name: "Add" });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    // The wizard advances to its own last stage — it is still the only thing on screen.
    await screen.findByRole("button", { name: "Start a new chat" });
    expect(screen.queryByTestId("chat-dock-slot")).toBeNull();
    // Every coach mark paints as a Popover card; none is here, by name or by slot.
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
    expect(screen.queryByText("Start Here")).toBeNull();
    expect(screen.queryByText("Ready to Go")).toBeNull();
  });

  // Named for what the reviewer can DO, not for a restriction that holds. The title this
  // replaced — "blocks review setup with a friendly install path" — read as a courtesy and
  // pinned a first-run trap for a whole release; the name did the reviewer's thinking.
  //
  // Every clause below maps to an assertion in the body, deliberately: "discloses" to the
  // copy and the install link, "Continue still live" to the enabled check, "picks up one
  // they install" to the recheck. An earlier draft of this title said the reviewer could
  // "continue" — which this body never does, it only proves the button is there and
  // enabled. That is the same overclaim as the title being replaced, one release later.
  // The proof that Continue actually WORKS is the sibling ZERO-harnesses test, which
  // clicks through to the app; a button existing is not a button working.
  it("discloses the missing harness with Continue still live, then picks up one they install", async () => {
    // What the DAEMON would answer right now, not "answer differently on the Nth call".
    // The count of reads before the click is not the point and is not this test's business:
    // the tree the welcome mounts into re-parents on first run, and a re-mounted reader
    // re-reads by design (harness detection changes while a surface is closed — that is
    // exactly what "Check again" exists for). Keyed on installed-or-not, the assertion is
    // about the button: one click, one fresh read, and the surface moves on.
    let installed = false;
    let checks = 0;
    mount(
      <RennetRouterApp
        bridge={welcomeBridge({
          "harness.hosts": () => {
            checks += 1;
            return {
              hosts: [
                {
                  source: "local",
                  asked: true,
                  detected: installed ? [{ id: "codex", version: "0.38.0", enabled: true }] : [],
                },
              ],
            };
          },
        })}
        history={memoryHistory("/new-chat")}
      />,
    );
    await advanceToReviewSetup();
    expect(screen.getByText("Rennet couldn’t detect Claude Code or Codex.")).toBeTruthy();
    // The consequence sentence is what REPLACED the gate, so it is load-bearing and pinned
    // here. Letting someone through while silently dropping this is worse than the gate was:
    // they land in the app with no idea why review turns never run.
    expect(screen.getByText(/can’t run review turns until one is installed/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Installation guide/ }).getAttribute("href")).toContain(
      "install-a-coding-harness",
    );
    // Rule Zero: the missing harness is DISCLOSED, never enforced. Continue stays live and
    // enabled, so an empty machine is told what it is missing and then let through.
    const proceed = screen.getByRole("button", { name: /^Continue$/ });
    expect((proceed as HTMLButtonElement).disabled).toBe(false);

    // The reviewer goes and installs one, then asks Rennet to look again.
    const before = checks;
    installed = true;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("Codex will orchestrate reviews.");
    expect(checks).toBe(before + 1);
    expect(screen.getByRole("button", { name: /^Continue$/ })).toBeTruthy();
  });

  it("reaches the app on a machine with ZERO harnesses installed", async () => {
    // The harm control for the Rule Zero regression: someone installs Rennet BEFORE any
    // coding harness. `ids.length` used to decide whether a Continue button existed at all,
    // so this reviewer could not finish the welcome, could not add a project, and could not
    // reach the app — ever. This drives that exact machine to New Chat. A fixture with a
    // harness detected cannot see this bug, which is why the old test never did.
    const enabled = vi.fn(() => ({ disabled: [] }));
    const role = vi.fn(() => ({ reviewRoles: [...ROLES] }));
    const history = memoryHistory("/new-chat");
    mount(
      <RennetRouterApp
        bridge={welcomeBridge({
          "harness.hosts": () => ({ hosts: [{ source: "local", asked: true, detected: [] }] }),
          "harness.setEnabled": enabled,
          "settings.setRoleAssignment": role,
        })}
        history={history}
      />,
    );
    await advanceToReviewSetup();
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));

    await screen.findByText("Add the code you’re responsible for.");
    const add = await screen.findByRole("button", { name: "Add" });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);

    // Ready tells the truth about the empty machine instead of inventing an orchestrator.
    await screen.findByRole("button", { name: "Start a new chat" });
    expect(screen.getByText("None installed")).toBeTruthy();
    expect(screen.getByText("No harness yet")).toBeTruthy();
    expect(screen.getByText(/Rennet can’t run review turns yet/)).toBeTruthy();
    // Nothing was enabled and no role was assigned, because nothing was detected.
    expect(enabled).not.toHaveBeenCalled();
    expect(role).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    await waitFor(() => expect(history.history.at(-1)).toBe("/new-chat?project=rennet"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The mark, in the wizard. The welcome kept drawing the OLD lockup's static mark part
// long after the sidebar row and the corner slot moved to the live sphere, at the old
// artwork proportion (126:112) rather than the one Rai chose (the wordmark's height is
// HALF the mark's). Each site is pinned by its own numbers, and `staticMarks` is the
// cross-check that the retired drawing is gone rather than merely joined.
//
// What none of this can see: happy-dom has no WebGL, so every sphere here is the static
// fallback — the live canvas is untestable in this environment by construction
// (`liquid-sphere.test.tsx` says the same). And happy-dom runs no layout, so the hero
// span's `offsetWidth` is always 0 and the sphere stays on its declared fallback size:
// the responsive size is exercised by eye and in the e2e screenshots, not here — which
// is how the transformed-box measuring bug was found, not by this file.
// ─────────────────────────────────────────────────────────────────────────────
describe("FirstRunWelcome — the Rennet mark", () => {
  it("carries the live sphere in the step header, wordmark at half its height", async () => {
    const { container } = mount(
      <RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Continue to Rennet" }));
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
    await screen.findByText("Your tools, already connected.");
    const header = container.querySelector("header");
    if (!header) throw new Error("no step header");

    const orb = sphere(header);
    expect(orb.style.width).toBe("32px");
    expect(orb.style.height).toBe("32px");
    expect(orb.getAttribute("data-state")).toBe("resting");

    // The proportion, as a RELATION between the two halves rather than two numbers that
    // happen to be right: 32 over 16, and the wordmark's own authored aspect.
    const word = wordmark(header);
    const height = Number(word.getAttribute("height"));
    const width = Number(word.getAttribute("width"));
    expect(height * 2).toBe(Number.parseFloat(orb.style.width));
    expect(width / height).toBeCloseTo(480.168 / 112, 6);

    // One image called Rennet, with both halves decorative inside it.
    const assembly = orb.parentElement;
    expect(assembly?.getAttribute("role")).toBe("img");
    expect(assembly?.getAttribute("aria-label")).toBe("Rennet");
    expect(orb.getAttribute("aria-hidden")).toBe("true");
    expect(word.getAttribute("aria-hidden")).toBe("true");

    expect(staticMarks(container)).toHaveLength(0);
  });

  it("works the hero sphere through the opening and settles it when the wordmark lands", async () => {
    const { container } = mount(
      <RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />,
    );
    await screen.findByText("You stopped writing the code. You still have to answer for it.");
    const markSpan = container.querySelector<HTMLElement>("[data-logo-mark]");
    if (!markSpan) throw new Error("the hero has no mark span");

    // The opening screen is the one surface with no step header, so the hero's sphere is
    // the only one on it.
    expect(container.querySelectorAll("[data-liquid-sphere]")).toHaveLength(1);
    expect(staticMarks(container)).toHaveLength(0);

    // The motion hooks are on the SPAN — the opening's own starting state, which is also
    // what the code field's gather measures its target from. Replacing the artwork inside
    // it must not disturb either.
    expect(markSpan.style.opacity).toBe("0");
    expect(markSpan.style.filter).toBe("blur(2px)");
    const box = sphere(markSpan);
    expect(box.style.width).toBe(box.style.height);
    expect(Number.parseFloat(box.style.width)).toBeGreaterThan(0);

    // Nothing is assembling before the click, so nothing is rippling.
    expect(box.getAttribute("data-state")).toBe("resting");
    fireEvent.click(screen.getByRole("button", { name: "Continue to Rennet" }));
    expect(sphere(markSpan).getAttribute("data-state")).toBe("working");

    // …and it settles on its own, when the wordmark's wipe lands (0.94 + 0.86s on the
    // sequence's clock) — not when the test asks it to.
    // (4s, inside vitest's 5s test timeout, so a sphere that never settles reports the
    // state it was stuck in rather than an anonymous "test timed out".)
    await waitFor(() => expect(sphere(markSpan).getAttribute("data-state")).toBe("resting"), {
      timeout: 4_000,
    });
    // The sequence really drove the span it was pointed at: by now the mark's own
    // landing (0.78 + 0.72s) has run it from the 0 above to fully opaque.
    expect(markSpan.style.opacity).toBe("1");
  });

  it("puts the live sphere in the ready badge with the tick still pinned to its box", async () => {
    const { container } = mount(
      <RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />,
    );
    await advanceToReady();

    // Two spheres on the Ready screen and no more, each in its own place: the header
    // identity and the badge. Counted here because a third would mean a site was
    // duplicated rather than converted.
    expect(container.querySelectorAll("[data-liquid-sphere]")).toHaveLength(2);
    const badge = container.querySelector<HTMLElement>('main [role="img"][aria-label="Rennet"]');
    if (!badge) throw new Error("the ready stage has no badge");

    const orb = sphere(badge);
    expect(orb.style.width).toBe("72px");
    expect(orb.style.height).toBe("72px");
    expect(orb.getAttribute("data-state")).toBe("resting");

    // The tick still pins to the sphere's own corner: same wrapper, same offsets.
    const tick = badge.querySelector("i");
    expect(tick?.parentElement).toBe(badge);
    expect(tick?.className).toContain("-bottom-1");
    expect(tick?.className).toContain("right-0");
    expect(badge.className).toContain("place-items-center");

    expect(staticMarks(container)).toHaveLength(0);
  });
});
