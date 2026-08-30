// @vitest-environment happy-dom
//
// C10 §4 — Source Control detection on a host card. The four statuses render their
// chip + honest helper; an undetected version renders nothing; a disconnected host
// shows ONE honest line, not fake rows; Azure DevOps never appears; actionable enable
// toggles persist through the projection seam while GitLab's health-only row has none.
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { cleanup, mount, within } from "../../test/dom";
import {
  type DetectedTool,
  EMPTY_SETTINGS_PROJECTION,
  type SettingsHost,
  type SettingsProjection,
  SettingsProjectionProvider,
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
