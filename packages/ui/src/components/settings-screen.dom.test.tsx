// @vitest-environment happy-dom
//
// The settings screen (wireframe #15): the config ladder over the real `~/.rennet`
// store. This mounts the real `SettingsScreen` over a recording fake `RennetBridge`
// and drives the surfaces that matter — the global scheme write, the repo-scope
// visibility write (addressed by repoPath), the read-through guidance panel, and
// the honest handling of a malformed config and an unresolved write — asserting the
// recorded command inputs (behavioural, not presence).
import type {
  RennetBridge,
  SetRepoVisibilityOutcome,
  SettingsGuidance,
  SettingsView,
} from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount, waitFor } from "../test/dom";
import { SettingsScreen } from "./settings-screen";

const view: SettingsView = {
  scheme: "system",
  schemeProvenance: {
    layer: "builtin",
    contributions: [{ layer: "builtin", value: "system", effective: true }],
  },
  appearanceMalformed: false,
  projects: [
    {
      projectId: "p1",
      name: "orbital",
      repoPath: "/orbital",
      visibility: "local",
      visibilityProvenance: {
        layer: "builtin",
        contributions: [{ layer: "builtin", value: "local", effective: true }],
      },
      promoted: false,
      promotedProvenance: {
        layer: "builtin",
        contributions: [{ layer: "builtin", value: "false", effective: true }],
      },
      configMalformed: false,
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
        if (overrides["settings.setRepoVisibility"]) {
          return overrides["settings.setRepoVisibility"] as SetRepoVisibilityOutcome;
        }
        const visibility = (input as { visibility: "local" | "git-visible" }).visibility;
        return {
          status: "applied",
          visibility,
          changed: true,
          gitignorePath: "/orbital/.rennet/.gitignore",
        } satisfies SetRepoVisibilityOutcome;
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

  it("on the repo tab, shows guidance + promotion provenance and writes a visibility switch keyed by repoPath", async () => {
    const { bridge, calls } = fakeBridge();
    const { container, getByRole } = mount(<SettingsScreen bridge={bridge} onBack={vi.fn()} />);

    await waitFor(() => expect(container.querySelector(".settings-tab")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Repo" }));

    // The guidance catalogue (the wireframe's central panel) is read-through, and the
    // read reaches for the repo by its path.
    await waitFor(() => expect(container.querySelector(".settings-rule-k")).not.toBeNull());
    expect(container.querySelector(".settings-rule-k")?.textContent).toBe(
      "Prefer table-driven tests",
    );
    const guidanceCall = calls.find((c) => c.name === "settings.guidance");
    expect(guidanceCall?.input).toEqual({ projectId: "p1", repoPath: "/orbital" });
    // Promotion carries provenance (not a fixed "read-through" badge) — builtin false.
    const provChips = [...container.querySelectorAll(".settings-prov")].map((n) => n.textContent);
    expect(provChips).toContain("default");

    fireEvent.click(getByRole("button", { name: "Git-visible" }));

    await waitFor(() =>
      expect(calls.some((c) => c.name === "settings.setRepoVisibility")).toBe(true),
    );
    const write = calls.find((c) => c.name === "settings.setRepoVisibility");
    const input = write?.input as {
      commandId: string;
      projectId: string;
      repoPath: string;
      visibility: string;
    };
    expect(input.projectId).toBe("p1");
    expect(input.repoPath).toBe("/orbital");
    expect(input.visibility).toBe("git-visible");
    expect(input.commandId).toMatch(/[0-9a-f-]{36}/);
    await waitFor(() =>
      expect(container.querySelector(".settings-applied")?.textContent).toContain(".gitignore"),
    );
  });

  it("does NOT report success when the write is unresolved (P2 #4)", async () => {
    const { bridge } = fakeBridge({
      "settings.setRepoVisibility": {
        status: "unresolved",
        visibility: "git-visible",
        changed: false,
        gitignorePath: "",
      } satisfies SetRepoVisibilityOutcome,
    });
    const { container, getByRole } = mount(<SettingsScreen bridge={bridge} onBack={vi.fn()} />);
    await waitFor(() => expect(container.querySelector(".settings-tab")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Repo" }));
    await waitFor(() => expect(container.querySelector(".settings-seg")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: "Git-visible" }));
    // The error is shown, and NO "applied" note claims a write happened.
    await waitFor(() =>
      expect(container.querySelector(".settings-error-inline")?.textContent).toContain(
        "could not be resolved",
      ),
    );
    expect(container.querySelector(".settings-applied")).toBeNull();
  });

  it("disables editing and explains when a repo config is malformed (Rule 75)", async () => {
    const malformedView: SettingsView = {
      ...view,
      projects: view.projects.map((project) => ({ ...project, configMalformed: true })),
    };
    const { bridge, calls } = fakeBridge({ "settings.get": malformedView });
    const { container, getByRole } = mount(<SettingsScreen bridge={bridge} onBack={vi.fn()} />);
    await waitFor(() => expect(container.querySelector(".settings-tab")).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Repo" }));
    await waitFor(() => expect(container.querySelector(".settings-malformed")).not.toBeNull());
    const gitVisible = getByRole("button", { name: "Git-visible" }) as HTMLButtonElement;
    expect(gitVisible.disabled).toBe(true);
    // A disabled control never fires the write.
    fireEvent.click(gitVisible);
    expect(calls.some((c) => c.name === "settings.setRepoVisibility")).toBe(false);
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
