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

// The `settings.reviewRoles` rows this stage reads its assignment off. It is a FIXTURE, and
// it was the only place the `orchestrator` row existed: `REVIEW_ROLE_CATALOGUE` carried no
// such role, so the write these tests watch go out never went out in production
// (session-thread-briefing 4.4). app-ui may not import `@rennet/core`, so the row's real
// existence is pinned where the catalogue lives — `orchestrator-chat.test.ts` in server
// asserts `reviewRoleJobId("orchestrator")` resolves to the council's `orchestrator-chat`.
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
  fireEvent.click(await screen.findByRole("button", { name: "Start" }));
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
  await screen.findByText("Your tools, already connected.");
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
  await screen.findByText("Choose how Rennet reviews.");
}

/** Drive the whole wizard to its Ready stage, which is where the badge lives. */
async function advanceToReady(): Promise<void> {
  await advanceToReviewSetup();
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^Continue$/ }));
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
  it("starts with code and reveals appearance alongside the welcome on Start", async () => {
    const { container } = mount(
      <RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />,
    );
    expect(screen.queryByText("Choose your appearance")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(await screen.findByText("Choose your appearance")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Welcome to your new Review Harness." }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Continue$/ }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Dark" })).toBeTruthy();
    expect(container.querySelector("[data-slot=corner-slot]")).toBeNull();
  });

  it("remounts the stage on every step so its entrance animation re-fires", async () => {
    // `key={step}` is the whole mechanism: a CSS animation on a node that survives the
    // step change plays once, on first paint, and never again. Node identity is the only
    // DOM-visible proof that the remount happens.
    const { container } = mount(
      <RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />,
    );
    await screen.findByText("You stopped writing the code. You still have to answer for it.");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const first = container.querySelector("main");
    expect(first?.className).toContain("animate-welcome-step");
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
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    fireEvent.click(screen.getByRole("button", { name: "Dracula" }));
    await waitFor(() => expect(document.documentElement.dataset.rnTheme).toBe("dracula"));
    expect(setTheme).toHaveBeenCalledWith({ themePack: "dracula" });
  });

  it("shows an authenticated GitLab CLI from live host detection", async () => {
    mount(<RennetRouterApp bridge={welcomeBridge()} history={memoryHistory("/new-chat")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
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
    await screen.findByText("Your code, wherever it lives.");
    expect(enabled).toHaveBeenCalledWith({ source: "local", harnessId: "claude", enabled: true });
    expect(enabled).toHaveBeenCalledWith({ source: "local", harnessId: "codex", enabled: true });
    expect(role).toHaveBeenCalledWith({
      roleId: "orchestrator",
      scenario: "dual",
      assignment: { model: "gpt-5.6-sol", effort: "high" },
    });
  });

  it("opens optional macOS Full Disk Access without requiring permission", async () => {
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

  it("reports completion failure, then finishes without requiring a project", async () => {
    let failCompletion = true;
    const settings = freshSettings();
    const add = vi.fn(() => {
      throw new Error("Welcome must not add projects");
    });
    const complete = vi.fn(() => {
      if (failCompletion) throw new Error("disk unavailable");
      const completedAt = "2026-08-28T12:00:00.000Z";
      settings.welcome = { completedAt };
      return { completedAt };
    });
    const history = memoryHistory("/new-chat");
    mount(
      <RennetRouterApp
        bridge={welcomeBridge({
          "settings.completeWelcome": complete,
          "settings.get": () => settings,
          "projects.add": add,
        })}
        history={history}
      />,
    );
    await advanceToReviewSetup();
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Start a new chat" }));
    expect(await screen.findByText(/Setup wasn’t completed: disk unavailable/)).toBeTruthy();
    failCompletion = false;
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    await waitFor(() =>
      expect(document.querySelector("[data-screen=add-project-entry]")).toBeTruthy(),
    );
    expect(add).not.toHaveBeenCalled();
  });

  it("mounts no shell or coach marks while progressing through welcome", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/ }));
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
    await screen.findByText("Codex will run the review conversation.");
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

    await screen.findByText("Your code, wherever it lives.");
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/ }));

    // Ready tells the truth about the empty machine instead of inventing an orchestrator.
    await screen.findByRole("button", { name: "Start a new chat" });
    expect(screen.getByText("None installed")).toBeTruthy();
    expect(screen.getByText("No harness yet")).toBeTruthy();
    expect(screen.getByText(/Rennet can’t run review turns yet/)).toBeTruthy();
    // Nothing was enabled and no role was assigned, because nothing was detected.
    expect(enabled).not.toHaveBeenCalled();
    expect(role).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    await waitFor(() => expect(history.history.at(-1)).toBe("/new-chat"));
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
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
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
