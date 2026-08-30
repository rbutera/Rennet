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
    expect(container.querySelector(".rn-welcome-header")).toBeNull();
    const fragments = [...container.querySelectorAll("[data-fragment]")];
    expect(fragments).toHaveLength(10);
    expect(new Set(fragments.map((fragment) => fragment.textContent?.length)).size).toBeGreaterThan(
      5,
    );
    expect(screen.getByText("Appearance")).toBeTruthy();
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
