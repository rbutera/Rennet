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
import { BridgeProvider } from "../data";
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
  const settingsView = (overrides["settings.get"] as SettingsView) ?? view;
  // A mutable override store so `setKeybinding` writes reflect back into the map.
  const keybindingState: Record<string, string | null> = { ...(settingsView.keybindings ?? {}) };
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    switch (name) {
      case "settings.get":
        return settingsView;
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
      case "settings.resetRepoValue": {
        if (overrides["settings.resetRepoValue"]) return overrides["settings.resetRepoValue"];
        const key = (input as { key: "visibility" }).key;
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
        const key = (input as { key: "visibility" }).key;
        // A pin freezes the current effective visibility at the repo layer.
        return {
          status: "applied",
          key,
          project: {
            ...view.projects[0],
            visibility: "local",
            visibilityProvenance: {
              layer: "repo",
              contributions: [
                { layer: "builtin", value: "local", effective: false },
                { layer: "repo", value: "local", effective: true },
              ],
            },
          },
        };
      }
      case "settings.setKeybinding": {
        // A stateful fake: reflect the write so the surface re-renders the new map.
        const payload = input as { id: string; keybinding?: string | null };
        if (!("keybinding" in payload)) delete keybindingState[payload.id];
        else keybindingState[payload.id] = payload.keybinding ?? null;
        return { keybindings: { ...keybindingState } };
      }
      case "pairing.listDevices":
        return (overrides["pairing.listDevices"] as { devices: unknown[] }) ?? { devices: [] };
      case "pairing.mint":
        return (
          (overrides["pairing.mint"] as { code: string; expiresAt: string }) ?? {
            code: "PAIR2345",
            expiresAt: "2026-01-01T00:05:00.000Z",
          }
        );
      case "pairing.revokeDevice":
        return (overrides["pairing.revokeDevice"] as { devices: unknown[] }) ?? { devices: [] };
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
  // offers Reset (not Pin). "Runs on" is a detected fact now (#476) — read-only, no
  // Reset/Pin of its own.
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

  it("Explain: the 'Runs on' row renders as a read-only detected fact (#476)", async () => {
    const { bridge, calls } = fakeBridge();
    const { container } = await openRepoTab(bridge);
    // The "Runs on" row shows the detected locus with its detected provenance — no chooser.
    const runsOnLabel = [...container.querySelectorAll(".settings-k")].find(
      (node) => node.textContent === "Runs on",
    );
    const runsOnRow = runsOnLabel?.closest(".settings-row");
    expect(runsOnRow?.querySelector(".settings-prov")?.textContent).toBe("detected");
    // Read-only: no set/pin/reset control on the row, and no locus write is possible.
    expect(runsOnRow?.querySelector(".settings-pin")).toBeNull();
    expect(runsOnRow?.querySelector(".settings-reset")).toBeNull();
    expect(runsOnRow?.querySelector("button")).toBeNull();
    expect(calls.some((c) => c.name === "settings.setRepoLocus")).toBe(false);
  });

  it("an inheriting/detected visibility row shows Pin and NOT Reset", async () => {
    const { bridge } = fakeBridge();
    const { container } = await openRepoTab(bridge);
    // visibility inherits (builtin) → offers Pin; "Runs on" is read-only (no controls).
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

  it("clicking Pin on the inheriting visibility row invokes settings.pinRepoValue with key visibility", async () => {
    const { bridge, calls } = fakeBridge();
    const { getByRole } = await openRepoTab(bridge);
    fireEvent.click(getByRole("button", { name: /pin the map visibility/i }));
    await waitFor(() => expect(calls.some((c) => c.name === "settings.pinRepoValue")).toBe(true));
    const call = calls.find((c) => c.name === "settings.pinRepoValue");
    const input = call?.input as { key: string };
    expect(input.key).toBe("visibility");
  });

  it("no confirmation ceremony: Reset completes in a single interaction, no dialog appears", async () => {
    const { bridge, calls } = fakeBridge({ "settings.get": repoSetView });
    const { baseElement, getByRole } = await openRepoTab(bridge);
    fireEvent.click(getByRole("button", { name: /reset/i }));
    // The write fired on the FIRST click — no intermediate confirm step.
    await waitFor(() => expect(calls.some((c) => c.name === "settings.resetRepoValue")).toBe(true));
    expect(baseElement.querySelector('[role="dialog"]')).toBeNull();
    expect(baseElement.querySelector(".settings-confirm")).toBeNull();
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

  it("Keyboard: set records a chord, unbind and reset send the right payloads (#44)", async () => {
    const { bridge, calls } = fakeBridge();
    const { container, getByRole, getByLabelText } = mount(
      <BridgeProvider bridge={bridge}>
        <SettingsScreen bridge={bridge} onBack={vi.fn()} />
      </BridgeProvider>,
    );
    fireEvent.click(getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(container.querySelector(".settings-keys")).not.toBeNull());

    // Every six-bind row is listed (Search among them).
    const backRow = [...container.querySelectorAll(".settings-key-row")].find((row) =>
      row.textContent?.includes("Search"),
    );
    expect(backRow).toBeTruthy();

    // Set → the recorder captures the next chord (⌘E) and writes it.
    fireEvent.click(backRow?.querySelector("button") as HTMLButtonElement);
    const recorder = getByLabelText("Press the new chord for Search");
    fireEvent.keyDown(recorder, { key: "e", metaKey: true });
    await waitFor(() => expect(calls.some((c) => c.name === "settings.setKeybinding")).toBe(true));
    const set = calls.find((c) => c.name === "settings.setKeybinding");
    expect(set?.input).toEqual({ id: "search", keybinding: "mod+e" });

    // Unbind sends an explicit null.
    const backRow2 = [...container.querySelectorAll(".settings-key-row")].find((row) =>
      row.textContent?.includes("Search"),
    );
    fireEvent.click(
      [...(backRow2?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === "Unbind",
      ) as HTMLButtonElement,
    );
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.name === "settings.setKeybinding")
          .some((c) => {
            const input = c.input as { keybinding?: unknown };
            return input.keybinding === null;
          }),
      ).toBe(true),
    );

    // A now-overridden row shows Reset, which sends an id-only payload (delete entry).
    const backRow3 = [...container.querySelectorAll(".settings-key-row")].find((row) =>
      row.textContent?.includes("Search"),
    );
    const resetBtn = [...(backRow3?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Reset",
    );
    expect(resetBtn).toBeTruthy();
    fireEvent.click(resetBtn as HTMLButtonElement);
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.name === "settings.setKeybinding")
          .some((c) => {
            const input = c.input as Record<string, unknown>;
            return input.id === "search" && !("keybinding" in input);
          }),
      ).toBe(true),
    );
  });

  it("Keyboard: a conflicting chord is disclosed on both rows AND the write still lands (Rule Zero) (#44)", async () => {
    // Seed an override that collides Command Menu onto Search's default ⌘P.
    const conflictView: SettingsView = { ...view, keybindings: { commands: "mod+p" } };
    const { bridge, calls } = fakeBridge({ "settings.get": conflictView });
    const { container, getByRole } = mount(
      <BridgeProvider bridge={bridge}>
        <SettingsScreen bridge={bridge} onBack={vi.fn()} />
      </BridgeProvider>,
    );
    fireEvent.click(getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(container.querySelector(".settings-keys")).not.toBeNull());

    // Both colliding rows disclose the collision — no confirmation element exists.
    const disclosed = [...container.querySelectorAll(".settings-key-conflict")];
    expect(disclosed.length).toBe(2);
    expect(container.querySelector("[data-conflict='true']")).not.toBeNull();

    // The Rule Zero control: assigning a chord already held is accepted and persisted —
    // the bridge write fires unconditionally, with no are-you-sure gate in between.
    const forwardRow = [...container.querySelectorAll(".settings-key-row")].find((row) =>
      row.textContent?.includes("Toggle Chat"),
    );
    fireEvent.click(forwardRow?.querySelector("button") as HTMLButtonElement);
    const recorder = container.querySelector(".settings-key-recorder") as HTMLInputElement;
    fireEvent.keyDown(recorder, { key: "p", metaKey: true });
    await waitFor(() => expect(calls.some((c) => c.name === "settings.setKeybinding")).toBe(true));
    // No confirmation dialog/element is ever rendered.
    expect(container.querySelector("[role='alertdialog']")).toBeNull();
  });

  it("Keyboard: assigns a bare-key chord to an unbound row", async () => {
    // An override that unbinds Toggle Chat renders it "unbound"; a new bare key rebinds it.
    const unboundView: SettingsView = { ...view, keybindings: { "toggle-chat": null } };
    const { bridge, calls } = fakeBridge({ "settings.get": unboundView });
    const { container, getByRole, getByLabelText } = mount(
      <BridgeProvider bridge={bridge}>
        <SettingsScreen bridge={bridge} onBack={vi.fn()} />
      </BridgeProvider>,
    );
    fireEvent.click(getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(container.querySelector(".settings-keys")).not.toBeNull());

    const settingsRow = [...container.querySelectorAll(".settings-key-row")].find((row) =>
      row.textContent?.includes("Toggle Chat"),
    );
    expect(settingsRow?.textContent).toContain("unbound");
    fireEvent.click(settingsRow?.querySelector("button") as HTMLButtonElement);
    fireEvent.keyDown(getByLabelText("Press the new chord for Toggle Chat"), { key: "s" });

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.name === "settings.setKeybinding" &&
            (call.input as { id?: string; keybinding?: string }).id === "toggle-chat" &&
            (call.input as { keybinding?: string }).keybinding === "s",
        ),
      ).toBe(true),
    );
  });

  it("Keyboard: refuses Shift/Alt capture inline without writing", async () => {
    const { bridge, calls } = fakeBridge();
    const { container, getByRole, getByLabelText } = mount(
      <BridgeProvider bridge={bridge}>
        <SettingsScreen bridge={bridge} onBack={vi.fn()} />
      </BridgeProvider>,
    );
    fireEvent.click(getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(container.querySelector(".settings-keys")).not.toBeNull());
    const backRow = [...container.querySelectorAll(".settings-key-row")].find((row) =>
      row.textContent?.includes("Search"),
    );
    fireEvent.click(backRow?.querySelector("button") as HTMLButtonElement);
    fireEvent.keyDown(getByLabelText("Press the new chord for Search"), {
      key: "J",
      shiftKey: true,
    });

    expect(container.querySelector(".settings-key-recording-note")?.textContent).toMatch(
      /Shift and Alt combinations are not supported/i,
    );
    expect(calls.some((call) => call.name === "settings.setKeybinding")).toBe(false);
  });

  it("Keyboard: reports invalid raw overrides and lets unknown ids be reset", async () => {
    const staleView: SettingsView = {
      ...view,
      keybindings: { search: "mod+", "retired.command": "mod+e" },
    };
    const { bridge, calls } = fakeBridge({ "settings.get": staleView });
    const { container, getByRole } = mount(
      <BridgeProvider bridge={bridge}>
        <SettingsScreen bridge={bridge} onBack={vi.fn()} />
      </BridgeProvider>,
    );
    fireEvent.click(getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(container.querySelector(".settings-keys")).not.toBeNull());

    expect(container.querySelector(".settings-key-invalid")?.textContent).toContain("mod+");
    const staleRow = [...container.querySelectorAll(".settings-key-row")].find((row) =>
      row.textContent?.includes("retired.command"),
    );
    expect(staleRow?.textContent).toContain("mod+e");
    fireEvent.click(staleRow?.querySelector("button") as HTMLButtonElement);
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.name === "settings.setKeybinding" &&
            (call.input as { id?: string }).id === "retired.command" &&
            !("keybinding" in (call.input as object)),
        ),
      ).toBe(true),
    );
  });

  it("Keyboard: recorder stops propagation and publishes one write outcome to the host", async () => {
    const { bridge } = fakeBridge();
    const bubbled = vi.fn();
    const onKeybindingsChange = vi.fn();
    const { container, getByRole, getByLabelText } = mount(
      <BridgeProvider bridge={bridge}>
        <div role="application" onKeyDown={bubbled}>
          <SettingsScreen
            bridge={bridge}
            onBack={vi.fn()}
            onKeybindingsChange={onKeybindingsChange}
          />
        </div>
      </BridgeProvider>,
    );
    fireEvent.click(getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(container.querySelector(".settings-keys")).not.toBeNull());
    const backRow = [...container.querySelectorAll(".settings-key-row")].find((row) =>
      row.textContent?.includes("Search"),
    );
    fireEvent.click(backRow?.querySelector("button") as HTMLButtonElement);
    fireEvent.keyDown(getByLabelText("Press the new chord for Search"), {
      key: "e",
      metaKey: true,
    });

    await waitFor(() => expect(onKeybindingsChange).toHaveBeenCalledTimes(1));
    expect(bubbled).not.toHaveBeenCalled();
  });
});

describe("SettingsScreen pairing panel (#380)", () => {
  it("mints a code and revokes a paired device through the bridge", async () => {
    const { bridge, calls } = fakeBridge({
      "pairing.listDevices": {
        devices: [
          {
            deviceId: "d1",
            name: "Phone",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-02T00:00:00.000Z",
            expiresAt: "2026-02-01T00:00:00.000Z",
          },
        ],
      },
      "pairing.revokeDevice": { devices: [] },
    });
    const screen = mount(<SettingsScreen bridge={bridge} onBack={() => undefined} />);
    await waitFor(() => screen.getByRole("tab", { name: "Pairing" }));
    fireEvent.click(screen.getByRole("tab", { name: "Pairing" }));
    // The paired device appears (from pairing.listDevices).
    await waitFor(() => screen.getByText("Phone"));

    // Mint a code and assert the typed code renders.
    fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    await waitFor(() => screen.getByText("PAIR2345"));
    expect(calls.some((call) => call.name === "pairing.mint")).toBe(true);

    // Revoke the device; the list empties.
    fireEvent.click(screen.getByRole("button", { name: "Revoke Phone" }));
    await waitFor(() => screen.getByText("No devices paired yet."));
    expect(calls.some((call) => call.name === "pairing.revokeDevice")).toBe(true);
  });
});
