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
      locus: { kind: "host" },
      locusOverridden: false,
      locusProvenance: {
        layer: "detected",
        contributions: [
          { layer: "builtin", value: "host", effective: false },
          { layer: "detected", value: "host", effective: true },
        ],
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
      case "settings.setRepoLocus": {
        if (overrides["settings.setRepoLocus"]) {
          return overrides["settings.setRepoLocus"];
        }
        const locus = (
          input as { locus: { kind: "host" } | { kind: "wsl"; distro: string } | null }
        ).locus;
        return {
          status: "applied",
          locus: locus ?? { kind: "host" },
          locusOverridden: locus !== null,
        };
      }
      case "settings.resetRepoValue": {
        if (overrides["settings.resetRepoValue"]) return overrides["settings.resetRepoValue"];
        const key = (input as { key: "visibility" | "locus" }).key;
        // A reset re-resolves the row to its inherited value (builtin/detected).
        return {
          status: "applied",
          key,
          project: {
            ...view.projects[0],
            visibility: "local",
            visibilityProvenance: {
              layer: "builtin",
              contributions: [{ layer: "builtin", value: "local", effective: true }],
            },
          },
        };
      }
      case "settings.pinRepoValue": {
        if (overrides["settings.pinRepoValue"]) return overrides["settings.pinRepoValue"];
        const key = (input as { key: "visibility" | "locus" }).key;
        // A pin freezes the current effective value at the repo layer.
        return {
          status: "applied",
          key,
          project: {
            ...view.projects[0],
            locus: { kind: "host" },
            locusOverridden: true,
            locusProvenance: {
              layer: "repo",
              contributions: [
                { layer: "builtin", value: "host", effective: false },
                { layer: "detected", value: "host", effective: false },
                { layer: "repo", value: "host", effective: true },
              ],
            },
          },
        };
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

describe("SettingsScreen — Explain / Reset / Pin (#28)", () => {
  // A repo-set variant: visibility explicitly set at the repo layer, so its row
  // offers Reset (not Pin). Locus stays detected, so ITS row offers Pin.
  const repoSetView: SettingsView = {
    ...view,
    projects: view.projects.map((p) => ({
      ...p,
      visibility: "git-visible",
      visibilityProvenance: {
        layer: "repo",
        contributions: [
          { layer: "builtin", value: "local", effective: false },
          { layer: "repo", value: "git-visible", effective: true },
        ],
      },
    })),
  };

  async function openRepoTab(bridge: RennetBridge) {
    const mounted = mount(<SettingsScreen bridge={bridge} onBack={vi.fn()} />);
    await waitFor(() => expect(mounted.container.querySelector(".settings-tab")).not.toBeNull());
    fireEvent.click(mounted.getByRole("tab", { name: "Repo" }));
    await waitFor(() => expect(mounted.container.querySelector(".settings-seg")).not.toBeNull());
    return mounted;
  }

  it("Explain: the locus row renders its resolver contributions", async () => {
    const { bridge } = fakeBridge();
    const { container } = await openRepoTab(bridge);
    // The locus row's provenance lists the ladder contributions (builtin + detected).
    const items = [...container.querySelectorAll(".settings-prov-item")].map((n) => n.textContent);
    expect(items.some((t) => t?.includes("detected"))).toBe(true);
    expect(items.some((t) => t?.includes("builtin"))).toBe(true);
  });

  it("an inheriting/detected row shows Pin and NOT Reset", async () => {
    const { bridge } = fakeBridge();
    const { container } = await openRepoTab(bridge);
    // visibility inherits (builtin) and locus is detected → both offer Pin, none Reset.
    expect(container.querySelector(".settings-pin")).not.toBeNull();
    expect(container.querySelector(".settings-reset")).toBeNull();
  });

  it("a repo-set row shows Reset and NOT Pin for that value", async () => {
    const { bridge } = fakeBridge({ "settings.get": repoSetView });
    const { container } = await openRepoTab(bridge);
    // The visibility row is repo-set → it offers Reset.
    expect(container.querySelector(".settings-reset")).not.toBeNull();
  });

  it("clicking Reset invokes settings.resetRepoValue and re-renders from the returned row", async () => {
    const { bridge, calls } = fakeBridge({ "settings.get": repoSetView });
    const { container, getByRole } = await openRepoTab(bridge);
    fireEvent.click(getByRole("button", { name: /reset/i }));
    await waitFor(() => expect(calls.some((c) => c.name === "settings.resetRepoValue")).toBe(true));
    const call = calls.find((c) => c.name === "settings.resetRepoValue");
    const input = call?.input as { key: string };
    expect(input.key).toBe("visibility");
    // The row re-renders from the outcome: visibility now inherits (Pin reappears).
    await waitFor(() => expect(container.querySelector(".settings-pin")).not.toBeNull());
  });

  it("clicking Pin on a detected locus invokes settings.pinRepoValue with key locus", async () => {
    const { bridge, calls } = fakeBridge();
    const { getByRole } = await openRepoTab(bridge);
    // The locus row's Pin (there are two Pins — visibility + locus; pick locus by title).
    fireEvent.click(getByRole("button", { name: /pin the execution locus/i }));
    await waitFor(() => expect(calls.some((c) => c.name === "settings.pinRepoValue")).toBe(true));
    const call = calls.find((c) => c.name === "settings.pinRepoValue");
    const input = call?.input as { key: string };
    expect(input.key).toBe("locus");
  });

  it("no confirmation ceremony: Reset completes in a single interaction, no dialog appears", async () => {
    const { bridge, calls } = fakeBridge({ "settings.get": repoSetView });
    const { container, getByRole } = await openRepoTab(bridge);
    fireEvent.click(getByRole("button", { name: /reset/i }));
    // The write fired on the FIRST click — no intermediate confirm step.
    await waitFor(() => expect(calls.some((c) => c.name === "settings.resetRepoValue")).toBe(true));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector(".settings-confirm")).toBeNull();
  });

  it("a malformed repo row disables Reset/Pin and never invokes them", async () => {
    const malformedView: SettingsView = {
      ...repoSetView,
      projects: repoSetView.projects.map((p) => ({ ...p, configMalformed: true })),
    };
    const { bridge, calls } = fakeBridge({ "settings.get": malformedView });
    const { container } = await openRepoTab(bridge);
    const control = container.querySelector<HTMLButtonElement>(".settings-reset, .settings-pin");
    expect(control?.disabled).toBe(true);
    if (control) fireEvent.click(control);
    expect(calls.some((c) => c.name === "settings.resetRepoValue")).toBe(false);
    expect(calls.some((c) => c.name === "settings.pinRepoValue")).toBe(false);
  });

  it("the global appearance offers a reset when it is set, clearing back to the builtin", async () => {
    const globalSetView: SettingsView = {
      ...view,
      scheme: "light",
      schemeProvenance: {
        layer: "global",
        contributions: [
          { layer: "builtin", value: "system", effective: false },
          { layer: "global", value: "light", effective: true },
        ],
      },
    };
    const { bridge, calls } = fakeBridge({ "settings.get": globalSetView });
    const { container, getByRole } = mount(<SettingsScreen bridge={bridge} onBack={vi.fn()} />);
    await waitFor(() => expect(container.querySelector(".settings-seg")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /reset appearance/i }));
    await waitFor(() => expect(calls.some((c) => c.name === "settings.setAppearance")).toBe(true));
    const call = calls.find((c) => c.name === "settings.setAppearance");
    const input = call?.input as { scheme: unknown };
    expect(input.scheme).toBeNull();
  });
});
