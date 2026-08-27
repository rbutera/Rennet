// @vitest-environment happy-dom
//
// C10 §5.2–5.4 — the Review section + Model Mappings dialog. Review is absent with
// no agents; Edit Mappings is inert until an agent is enabled; the column headers
// ARE the mode switch (aria-pressed is the tick); Dual is locked until both agents
// (its hint names the missing one); losing the second agent forces Single; a role
// that does not run in a mode shows an em dash; a changed role gains "Reset to
// default" and resetting flows through the setRoleAssignment seam.
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { cleanup, mount, within } from "../../test/dom";
import { REVIEW_ROLE_DEFAULTS } from "../assets/model-council";
import {
  type DetectedTool,
  EMPTY_SETTINGS_PROJECTION,
  type ReviewRole,
  type RoleAssignment,
  type SettingsHost,
  type SettingsProjection,
  SettingsProjectionProvider,
} from "../data";
import { ReviewSettings } from "./model-mappings";

const HOST: SettingsHost = {
  id: "h1",
  name: "This Machine",
  kind: "local",
  os: "macos",
  daemon: { reachable: true, version: "1.0.1" },
};

const BOTH_AGENTS: readonly DetectedTool[] = [
  { id: "claude", label: "Claude", status: "available", detail: "Claude CLI.", enabled: true },
  { id: "codex", label: "Codex", status: "available", detail: "Codex server.", enabled: true },
];

function withReview(overrides: Partial<SettingsProjection>, enabledIds: readonly string[]) {
  return (
    <SettingsProjectionProvider value={{ ...EMPTY_SETTINGS_PROJECTION, ...overrides }}>
      <ReviewSettings host={HOST} enabledIds={enabledIds} />
    </SettingsProjectionProvider>
  );
}

const body = () => within(document.body);

describe("ReviewSettings — the Review block", () => {
  it("is absent entirely when no agent was detected", () => {
    const { queryByText } = mount(withReview({ agentsByHost: {} }, []));
    expect(queryByText("Model Mappings")).toBeNull();
    cleanup();
  });

  it("Edit Mappings is inert until an agent is enabled, and says so", () => {
    const { getByRole, getByText } = mount(
      withReview({ agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: REVIEW_ROLE_DEFAULTS }, []),
    );
    const button = getByRole("button", { name: "Edit Mappings" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(getByText("enable an agent above to map models")).toBeTruthy();
    cleanup();
  });

  it("Edit Mappings becomes active once an agent is enabled", () => {
    const { getByRole } = mount(
      withReview({ agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: REVIEW_ROLE_DEFAULTS }, [
        "claude",
      ]),
    );
    expect(getByRole("button", { name: "Edit Mappings" }).hasAttribute("disabled")).toBe(false);
    cleanup();
  });
});

describe("MappingsDialog — the mode switch built into the headers", () => {
  it("both agents enabled: Dual carries the tick (aria-pressed), Single does not", async () => {
    const { getByRole, user } = mount(
      withReview({ agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: REVIEW_ROLE_DEFAULTS }, [
        "claude",
        "codex",
      ]),
    );
    await user.click(getByRole("button", { name: "Edit Mappings" }));
    expect(
      body()
        .getByRole("button", { name: /Dual Harness/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      body()
        .getByRole("button", { name: /Single Harness/ })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    cleanup();
  });

  it("one agent only: Dual is locked and its hint names the missing agent; Single is selected", async () => {
    const { getByRole, user } = mount(
      withReview({ agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: REVIEW_ROLE_DEFAULTS }, [
        "claude",
      ]),
    );
    await user.click(getByRole("button", { name: "Edit Mappings" }));
    const dual = body().getByRole("button", { name: /Dual Harness/ });
    expect(dual.hasAttribute("disabled")).toBe(true);
    expect(dual.getAttribute("aria-pressed")).toBe("false");
    expect(
      body()
        .getByRole("button", { name: /Single Harness/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // Hovering anywhere in the locked Dual column says what unlocks it (Claude on ⇒ Codex missing).
    expect(
      body().getAllByText("Enable Codex to turn on Dual Harness (Recommended)").length,
    ).toBeGreaterThan(0);
    cleanup();
  });

  it("losing the second agent settles Single, whatever header was clicked", async () => {
    const seed = { agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: REVIEW_ROLE_DEFAULTS };
    const { getByRole, user, rerender } = mount(withReview(seed, ["claude", "codex"]));
    await user.click(getByRole("button", { name: "Edit Mappings" }));
    // Dual is selected while both agents are enabled.
    expect(
      body()
        .getByRole("button", { name: /Dual Harness/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // The second agent goes away (its detection toggled off) — the dialog stays open.
    rerender(withReview(seed, ["claude"]));
    // Dual now locks and Single takes the tick, without touching the mode header.
    expect(
      body()
        .getByRole("button", { name: /Dual Harness/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      body()
        .getByRole("button", { name: /Single Harness/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    cleanup();
  });

  it("a role that does not run in a mode renders an em dash, not a fake assignment", async () => {
    const { getByRole, user } = mount(
      withReview({ agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: REVIEW_ROLE_DEFAULTS }, [
        "claude",
      ]),
    );
    await user.click(getByRole("button", { name: "Edit Mappings" }));
    // Single = Claude-only. The Flagged Second Seat has no Claude-only assignment.
    expect(body().getAllByText("—").length).toBe(1);
    cleanup();
  });
});

describe("MappingsDialog — Reset to default flows through the seam", () => {
  const changed: readonly ReviewRole[] = REVIEW_ROLE_DEFAULTS.map((role) =>
    role.id === "orchestrator" ? { ...role, dual: { model: "haiku", effort: "low" } } : role,
  );

  it("default roles show no Reset; a changed role shows one", async () => {
    const defaults = mount(
      withReview({ agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: REVIEW_ROLE_DEFAULTS }, [
        "claude",
        "codex",
      ]),
    );
    await defaults.user.click(defaults.getByRole("button", { name: "Edit Mappings" }));
    expect(body().queryByText("Reset to default")).toBeNull();
    cleanup();

    const dirty = mount(
      withReview({ agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: changed }, ["claude", "codex"]),
    );
    await dirty.user.click(dirty.getByRole("button", { name: "Edit Mappings" }));
    expect(body().getAllByText("Reset to default").length).toBe(1);
    cleanup();
  });

  it("clicking Reset restores the default through setRoleAssignment", async () => {
    function Stateful() {
      const [roles, setRoles] = useState<readonly ReviewRole[]>(changed);
      const setRoleAssignment = (
        roleId: string,
        scenario: "dual" | "claudeOnly" | "codexOnly",
        assignment: RoleAssignment | null,
      ) =>
        setRoles((prev) =>
          prev.map((role) => (role.id === roleId ? { ...role, [scenario]: assignment } : role)),
        );
      return withReview(
        { agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: roles, setRoleAssignment },
        ["claude", "codex"],
      );
    }
    const { getByRole, user } = mount(<Stateful />);
    await user.click(getByRole("button", { name: "Edit Mappings" }));
    expect(body().getAllByText("Reset to default").length).toBe(1);
    await user.click(body().getByRole("button", { name: "Reset to default" }));
    // Back to the council default — the control is gone.
    expect(body().queryByText("Reset to default")).toBeNull();
    cleanup();
  });
});
