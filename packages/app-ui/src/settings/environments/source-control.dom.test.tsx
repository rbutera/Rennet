// @vitest-environment happy-dom
//
// C10 §4 — Source Control detection on a host card. The four statuses render their
// chip + honest helper; an undetected version renders nothing; a disconnected host
// shows ONE honest line, not fake rows; Azure DevOps never appears; actionable enable
// toggles persist through the projection seam while GitLab's health-only row has none.
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../../data";
import { cleanup, mount, waitFor, within } from "../../test/dom";
import { MemoryBridge } from "../../test/memory-bridge";
import {
  type DetectedTool,
  EMPTY_SETTINGS_PROJECTION,
  type SettingsHost,
  type SettingsProjection,
  SettingsProjectionProvider,
  type SourceControlTool,
} from "../data";
import { SourceControlSection } from "./source-control";

const HOST: SettingsHost = {
  id: "h1",
  name: "This Machine",
  kind: "local",
  os: "macos",
  daemon: { reachable: true, version: "1.0.1" },
};

const FOUR_STATUSES: readonly DetectedTool[] = [
  {
    id: "git",
    label: "Git",
    version: "git version 2.51.0",
    status: "available",
    detail: "Diffs run through this git.",
    enabled: true,
  },
  {
    id: "gh",
    label: "GitHub",
    version: "gh version 2.76.0",
    status: "not-authenticated",
    detail: "Run `gh auth login`.",
    enabled: true,
  },
  {
    id: "glab",
    label: "GitLab",
    status: "not-installed",
    detail: "Install with `brew install glab`.",
    enabled: false,
  },
  {
    id: "bitbucket",
    label: "Bitbucket",
    status: "unreachable",
    detail: "Set a Bitbucket API token.",
    enabled: false,
  },
];

function withProjection(overrides: Partial<SettingsProjection>) {
  return (
    <SettingsProjectionProvider value={{ ...EMPTY_SETTINGS_PROJECTION, ...overrides }}>
      <SourceControlSection host={HOST} />
    </SettingsProjectionProvider>
  );
}

describe("SourceControlSection — detection rows", () => {
  it("renders the four statuses' chips and helpers", () => {
    const { getByText } = mount(withProjection({ sourceControlByHost: { h1: FOUR_STATUSES } }));
    for (const label of ["Available", "Not Authenticated", "Not Installed", "Unreachable"]) {
      expect(getByText(label)).toBeTruthy();
    }
    // The helper renders the fix; the backticked command becomes inline code.
    expect(getByText("gh auth login").tagName).toBe("CODE");
    expect(getByText("brew install glab").tagName).toBe("CODE");
    cleanup();
  });

  it("shows a detected version and shows none when undetected", () => {
    const { getByText, queryByText } = mount(
      withProjection({ sourceControlByHost: { h1: FOUR_STATUSES } }),
    );
    expect(getByText("git version 2.51.0")).toBeTruthy();
    // glab is Not Installed with no version — nothing is guessed.
    expect(queryByText(/glab version/)).toBeNull();
    cleanup();
  });

  it("a disconnected host shows one honest line, not fake rows", () => {
    const { getByText, queryByRole } = mount(withProjection({ sourceControlByHost: {} }));
    expect(getByText("Connect This Machine to detect its tooling.")).toBeTruthy();
    expect(queryByRole("switch")).toBeNull();
    cleanup();
  });

  it("Azure DevOps never appears", () => {
    const { queryByText } = mount(withProjection({ sourceControlByHost: { h1: FOUR_STATUSES } }));
    expect(queryByText(/Azure/i)).toBeNull();
    cleanup();
  });

  it("keeps normal source-control toggles but gives the health-only GitLab row none", () => {
    const { getByRole, queryByRole } = mount(
      withProjection({ sourceControlByHost: { h1: FOUR_STATUSES } }),
    );
    expect(getByRole("switch", { name: "Use Git on This Machine" })).toBeTruthy();
    expect(getByRole("switch", { name: "Use GitHub on This Machine" })).toBeTruthy();
    expect(queryByRole("switch", { name: "Use GitLab on This Machine" })).toBeNull();
    cleanup();
  });

  it("the enable toggle persists through the projection", async () => {
    function Stateful() {
      const [tools, setTools] = useState<readonly DetectedTool[]>(FOUR_STATUSES);
      return withProjection({
        sourceControlByHost: { h1: tools },
        setToolEnabled: (_hostId, toolId, enabled) =>
          setTools((prev) => prev.map((t) => (t.id === toolId ? { ...t, enabled } : t))),
      });
    }
    const { getByRole, user } = mount(<Stateful />);
    const githubToggle = getByRole("switch", { name: "Use GitHub on This Machine" });
    expect(githubToggle.getAttribute("aria-checked")).toBe("true");
    await user.click(githubToggle);
    expect(
      within(document.body)
        .getByRole("switch", { name: "Use GitHub on This Machine" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    cleanup();
  });
});

// source-control-tooling: `git` and `git-lfs` as the daemon probed them, each in the same row
// shape, with Install for me where one is missing. The bridge RECORDS the install a click
// starts, so "offers Install for me" is the install it dispatched, at this host's locus.
describe("SourceControlSection — Git and Git LFS", () => {
  const GIT_TOOLS: readonly SourceControlTool[] = [
    { id: "git", label: "Git", version: "2.51.0", status: "available", detail: "Git 2.51.0" },
    {
      id: "git-lfs",
      label: "Git LFS",
      status: "not-installed",
      detail: "Git LFS isn't installed. Install it with `brew install git-lfs`.",
      required: true,
    },
  ];

  function withGitTools(host: SettingsHost) {
    const installs: unknown[] = [];
    const bridge = new MemoryBridge({
      "tools.install": (input) => {
        installs.push(input);
        return {
          result: {
            status: "manual",
            command: "brew install git-lfs && git lfs install",
            docsUrl: "https://git-lfs.com",
            probe: { id: "git-lfs", version: null, status: "not-installed", detail: "" },
          },
        };
      },
    });
    const view = mount(
      <BridgeProvider bridge={bridge}>
        <SettingsProjectionProvider
          value={{
            ...EMPTY_SETTINGS_PROJECTION,
            gitToolsByHost: { [host.id]: GIT_TOOLS },
            sourceControlByHost: { [host.id]: [] },
          }}
        >
          <SourceControlSection host={host} />
        </SettingsProjectionProvider>
      </BridgeProvider>,
    );
    return { ...view, installs };
  }

  const row = (tool: string) =>
    document.querySelector<HTMLElement>(`[data-slot="git-tool-row"][data-tool="${tool}"]`);

  it("shows both rows with the probe's own version and state", () => {
    withGitTools({ ...HOST, id: "local" });
    expect(row("git")?.textContent).toContain("2.51.0");
    expect(row("git")?.getAttribute("data-status")).toBe("available");
    expect(row("git-lfs")?.getAttribute("data-status")).toBe("not-installed");
    expect(within(row("git-lfs") as HTMLElement).getByText("Not Installed")).toBeTruthy();
    // An available tool offers nothing to do; a missing one offers the install.
    expect(within(row("git") as HTMLElement).queryByRole("button")).toBeNull();
    // Git's rows are not forge rulings: no toggle claims to switch Git off.
    expect(document.querySelector('[role="switch"]')).toBeNull();
    cleanup();
  });

  it("installs a missing Git LFS on this machine from its row", async () => {
    const { user, installs } = withGitTools({ ...HOST, id: "local" });
    await user.click(
      within(row("git-lfs") as HTMLElement).getByRole("button", { name: "Install for me" }),
    );
    await waitFor(() => expect(installs).toHaveLength(1));
    expect(installs[0]).toMatchObject({ tool: "git-lfs", locus: { kind: "host" } });
    // No installer here: the manual command replaces the button.
    await waitFor(() =>
      expect(row("git-lfs")?.querySelector('[data-slot="install-command"]')?.textContent).toBe(
        "brew install git-lfs && git lfs install",
      ),
    );
    cleanup();
  });

  it("installs into the WSL distro the card is for", async () => {
    const { user, installs } = withGitTools({
      ...HOST,
      id: "wsl:Ubuntu",
      name: "Ubuntu",
      kind: "remote",
    });
    await user.click(
      within(row("git-lfs") as HTMLElement).getByRole("button", { name: "Install for me" }),
    );
    await waitFor(() => expect(installs).toHaveLength(1));
    expect(installs[0]).toMatchObject({ locus: { kind: "wsl", distro: "Ubuntu" } });
    cleanup();
  });

  it("offers no install on a paired remote device, which has its own settings", () => {
    withGitTools({ ...HOST, id: "remote:desk-7", name: "Desk", kind: "remote" });
    expect(within(row("git-lfs") as HTMLElement).queryByRole("button")).toBeNull();
    // The state and the fix are still there to read.
    expect(row("git-lfs")?.textContent).toContain("brew install git-lfs");
    cleanup();
  });
});
