// @vitest-environment happy-dom
//
// C10 §5.1 — the Agents section on a host card. Detected harnesses render in the
// SAME row shape as source control (mark, label, version, status chip, honest
// helper, enable toggle); a disconnected host shows one honest line, not fake rows;
// disabling an agent persists through the projection seam (it does not uninstall).
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
import { AgentsSection } from "./agents";

const HOST: SettingsHost = {
  id: "h1",
  name: "This Machine",
  kind: "local",
  os: "macos",
  daemon: { reachable: true, version: "1.0.1" },
};

const AGENTS: readonly DetectedTool[] = [
  {
    id: "claude",
    label: "Claude",
    version: "claude 2.14.3",
    status: "available",
    detail: "Reviews run through the `claude` CLI on your Claude subscription.",
    enabled: true,
  },
  {
    id: "codex",
    label: "Codex",
    status: "not-installed",
    detail: "Install the Codex CLI (`npm i -g @openai/codex`) and sign in with `codex login`.",
    enabled: false,
  },
];

function withProjection(overrides: Partial<SettingsProjection>) {
  return (
    <SettingsProjectionProvider value={{ ...EMPTY_SETTINGS_PROJECTION, ...overrides }}>
      <AgentsSection host={HOST} />
    </SettingsProjectionProvider>
  );
}

describe("AgentsSection", () => {
  it("renders each detected harness in the shared row shape", () => {
    const { getByText, getByRole } = mount(withProjection({ agentsByHost: { h1: AGENTS } }));
    expect(getByText("Claude")).toBeTruthy();
    expect(getByText("claude 2.14.3")).toBeTruthy();
    expect(getByText("Available")).toBeTruthy();
    expect(getByText("Not Installed")).toBeTruthy();
    // The helper renders the fix; the backticked command becomes inline code.
    expect(getByText("claude").tagName).toBe("CODE");
    // Codex has no detected version — nothing is guessed.
    expect(getByRole("switch", { name: "Use Claude on This Machine" })).toBeTruthy();
    cleanup();
  });

  it("a disconnected host shows one honest line, not fake rows", () => {
    const { getByText, queryByRole } = mount(withProjection({ agentsByHost: {} }));
    expect(getByText("Connect This Machine to detect its agents.")).toBeTruthy();
    expect(queryByRole("switch")).toBeNull();
    cleanup();
  });

  it("disabling an agent persists through the projection (does not uninstall)", async () => {
    function Stateful() {
      const [tools, setTools] = useState<readonly DetectedTool[]>(AGENTS);
      return withProjection({
        agentsByHost: { h1: tools },
        setToolEnabled: (_hostId, toolId, enabled) =>
          setTools((prev) => prev.map((t) => (t.id === toolId ? { ...t, enabled } : t))),
      });
    }
    const { getByRole, user } = mount(<Stateful />);
    const claudeToggle = getByRole("switch", { name: "Use Claude on This Machine" });
    expect(claudeToggle.getAttribute("aria-checked")).toBe("true");
    await user.click(claudeToggle);
    expect(
      within(document.body)
        .getByRole("switch", { name: "Use Claude on This Machine" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    cleanup();
  });
});
