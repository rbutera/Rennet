// @vitest-environment happy-dom
//
// The settings screen (wireframe #15): the config ladder over the real `~/.rennet`
// store. This mounts the real `SettingsScreen` over a recording fake `RennetBridge`
// and drives the surfaces that matter — the global scheme write, the repo-scope
// visibility write, and the read-through guidance panel — asserting the recorded
// command inputs (behavioural, not presence).
import type { RennetBridge, SettingsGuidance, SettingsView } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount, waitFor } from "../test/dom";
import { SettingsScreen } from "./settings-screen";

const view: SettingsView = {
  scheme: "system",
  schemeProvenance: {
    layer: "builtin",
    contributions: [{ layer: "builtin", value: "system", effective: true }],
  },
  projects: [
    {
      projectId: "p1",
      name: "orbital",
      openPath: "/orbital",
      visibility: "local",
      visibilityProvenance: {
        layer: "builtin",
        contributions: [{ layer: "builtin", value: "local", effective: true }],
      },
      promoted: false,
    },
  ],
};

const guidance: SettingsGuidance = {
  rules: [
    {
      convention: "Prefer table-driven tests",
      rationale: "keeps cases legible",
      severity: "medium",
    },
  ],
  reason: null,
  dropped: 0,
};

function fakeBridge(overrides: Partial<Record<string, unknown>> = {}): {
  bridge: RennetBridge;
  calls: { name: string; input: unknown }[];
} {
  const calls: { name: string; input: unknown }[] = [];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    switch (name) {
      case "settings.get":
        return (overrides["settings.get"] as SettingsView) ?? view;
      case "settings.guidance":
        return (overrides["settings.guidance"] as SettingsGuidance) ?? guidance;
      case "settings.setAppearance": {
        const scheme = (input as { scheme: SettingsView["scheme"] }).scheme;
        return {
          scheme,
          schemeProvenance: {
            layer: "global",
            contributions: [
              { layer: "builtin", value: "system", effective: false },
              { layer: "global", value: scheme, effective: true },
            ],
          },
        };
      }
      case "settings.setRepoVisibility": {
        const visibility = (input as { visibility: "local" | "git-visible" }).visibility;
        return { visibility, changed: true, gitignorePath: "/orbital/.rennet/.gitignore" };
      }
      default:
        throw new Error(`unexpected command: ${name}`);
    }
  };
  return { bridge: { invoke } as unknown as RennetBridge, calls };
}

describe("SettingsScreen", () => {
  it("shows the global scheme with builtin provenance, and writes a chosen scheme", async () => {
    const { bridge, calls } = fakeBridge();
    const onSchemeChange = vi.fn();
    const { container, getByRole } = mount(
      <SettingsScreen bridge={bridge} onBack={vi.fn()} onSchemeChange={onSchemeChange} />,
    );

    // The global tab is default; the scheme resolves to the builtin, shown as "default".
    await waitFor(() => expect(container.querySelector(".settings-seg")).not.toBeNull());
    expect(container.querySelector(".settings-prov")?.textContent).toBe("default");

    fireEvent.click(getByRole("button", { name: "Light" }));

    await waitFor(() => expect(calls.some((c) => c.name === "settings.setAppearance")).toBe(true));
    const write = calls.find((c) => c.name === "settings.setAppearance");
    expect(write?.input).toEqual({ scheme: "light" });
    // The host is told, so it can re-theme app-wide.
    await waitFor(() => expect(onSchemeChange).toHaveBeenCalledWith("light"));
    // The provenance chip now reads "set here".
    await waitFor(() => expect(container.querySelector(".settings-prov-set")).not.toBeNull());
  });

  it("on the repo tab, shows guidance rules and writes a visibility switch with a commandId", async () => {
    const { bridge, calls } = fakeBridge();
    const { container, getByRole } = mount(<SettingsScreen bridge={bridge} onBack={vi.fn()} />);

    await waitFor(() => expect(container.querySelector(".settings-tab")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Repo" }));

    // The guidance catalogue (the wireframe's central panel) is read-through.
    await waitFor(() => expect(container.querySelector(".settings-rule-k")).not.toBeNull());
    expect(container.querySelector(".settings-rule-k")?.textContent).toBe(
      "Prefer table-driven tests",
    );
    expect(calls.some((c) => c.name === "settings.guidance")).toBe(true);

    fireEvent.click(getByRole("button", { name: "Git-visible" }));

    await waitFor(() =>
      expect(calls.some((c) => c.name === "settings.setRepoVisibility")).toBe(true),
    );
    const write = calls.find((c) => c.name === "settings.setRepoVisibility");
    const input = write?.input as { commandId: string; projectId: string; visibility: string };
    expect(input.projectId).toBe("p1");
    expect(input.visibility).toBe("git-visible");
    expect(input.commandId).toMatch(/[0-9a-f-]{36}/);
    // The applied note names the real file that was written.
    await waitFor(() =>
      expect(container.querySelector(".settings-applied")?.textContent).toContain(".gitignore"),
    );
  });

  it("shows an honest empty guidance state when no catalogue exists", async () => {
    const { bridge } = fakeBridge({
      "settings.guidance": { rules: [], reason: "absent", dropped: 0 } satisfies SettingsGuidance,
    });
    const { container, getByRole } = mount(<SettingsScreen bridge={bridge} onBack={vi.fn()} />);
    await waitFor(() => expect(container.querySelector(".settings-tab")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Repo" }));
    await waitFor(() => expect(container.querySelector(".settings-guidance-empty")).not.toBeNull());
    expect(container.querySelector(".settings-guidance-empty")?.textContent).toContain(
      "built-in checklist",
    );
  });
});
