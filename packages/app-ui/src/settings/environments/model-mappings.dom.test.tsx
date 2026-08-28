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

describe("MappingsDialog — provenance chip + Reset-via-null (C16, #485)", () => {
  // A cell whose LAYER says an override won. "Changed from default" is read off this
  // provenance, never off a comparison with a copied table.
  const changed: readonly ReviewRole[] = REVIEW_ROLE_DEFAULTS.map((role) =>
    role.id === "orchestrator"
      ? // `gpt-5.5` appears in no council default, so a sighting of it is this override.
        { ...role, dual: { model: "gpt-5.5", effort: "low", layer: "override" as const } }
      : role,
  );

  it("only an overridden cell carries the provenance chip", async () => {
    const defaults = mount(
      withReview({ agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: REVIEW_ROLE_DEFAULTS }, [
        "claude",
        "codex",
      ]),
    );
    await defaults.user.click(defaults.getByRole("button", { name: "Edit Mappings" }));
    // Every cell reads the council table — no chip anywhere.
    expect(body().queryByText("Overridden")).toBeNull();
    cleanup();

    const dirty = mount(
      withReview({ agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: changed }, ["claude", "codex"]),
    );
    await dirty.user.click(dirty.getByRole("button", { name: "Edit Mappings" }));
    // Exactly the one overridden cell is chipped, and its own value is shown.
    expect(body().getAllByText("Overridden").length).toBe(1);
    expect(body().getAllByText("gpt-5.5").length).toBe(1);
    cleanup();
  });

  it("default roles show no Reset; a role with an override shows one", async () => {
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

  it("Reset CLEARS the override with null, for the overridden column only", async () => {
    const writes: {
      roleId: string;
      scenario: string;
      assignment: RoleAssignment | null;
    }[] = [];
    function Stateful() {
      const [roles, setRoles] = useState<readonly ReviewRole[]>(changed);
      const setRoleAssignment = (
        roleId: string,
        scenario: "dual" | "claudeOnly" | "codexOnly",
        assignment: RoleAssignment | null,
      ) => {
        writes.push({ roleId, scenario, assignment });
        // The backend answers with the re-resolved cell: a cleared override falls back
        // to that scenario's council-table default, carrying `default` provenance.
        const table = REVIEW_ROLE_DEFAULTS.find((r) => r.id === roleId)?.[scenario] ?? null;
        setRoles((prev) =>
          prev.map((role) =>
            role.id === roleId
              ? { ...role, [scenario]: assignment === null ? table : assignment }
              : role,
          ),
        );
      };
      return withReview(
        { agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: roles, setRoleAssignment },
        ["claude", "codex"],
      );
    }
    const { getByRole, user } = mount(<Stateful />);
    await user.click(getByRole("button", { name: "Edit Mappings" }));
    await user.click(body().getByRole("button", { name: "Reset to default" }));
    // ONE write, on the ONE overridden column, clearing rather than re-writing a copy
    // of the default (per-scenario: `claudeOnly` / `codexOnly` were never touched).
    expect(writes).toEqual([{ roleId: "orchestrator", scenario: "dual", assignment: null }]);
    // Back to the council default — the chip and the control are both gone.
    expect(body().queryByText("Reset to default")).toBeNull();
    expect(body().queryByText("Overridden")).toBeNull();
    cleanup();
  });

  it("a cell edit writes model+effort for that ONE scenario, no layer and no sibling", async () => {
    const writes: {
      roleId: string;
      scenario: string;
      assignment: RoleAssignment | null;
    }[] = [];
    const { getByRole, user } = mount(
      withReview(
        {
          agentsByHost: { h1: BOTH_AGENTS },
          reviewRoles: REVIEW_ROLE_DEFAULTS,
          setRoleAssignment: (roleId, scenario, assignment) => {
            writes.push({ roleId, scenario, assignment });
          },
        },
        ["claude"],
      ),
    );
    await user.click(getByRole("button", { name: "Edit Mappings" }));
    // Single = Claude-only, so the editable column is `claudeOnly`.
    await user.click(body().getAllByRole("button", { name: "Orchestrator model" })[0]);
    await user.click(body().getByRole("option", { name: "haiku" }));
    expect(writes).toEqual([
      {
        roleId: "orchestrator",
        scenario: "claudeOnly",
        // Provenance is the resolver's verdict, never an input (#89: no harness either).
        assignment: { model: "haiku", effort: "high" },
      },
    ]);
    cleanup();
  });
});

describe("MappingsDialog — honest-present + honest-null controls (C16 positive controls)", () => {
  // POSITIVE CONTROL (must be able to fail): the council tables are STATIC, so a
  // projection carrying NO reviewRoles still renders the eight council defaults. If the
  // dialog reverted to its old "no Model-Council is served" blank, this goes red.
  it("an absent reviewRoles still renders the council defaults, not a blank", async () => {
    const { getByRole, user } = mount(
      withReview({ agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: [] }, ["claude", "codex"]),
    );
    await user.click(getByRole("button", { name: "Edit Mappings" }));
    for (const role of REVIEW_ROLE_DEFAULTS) {
      expect(body().getAllByText(role.label).length).toBeGreaterThan(0);
    }
    // Honest-present is not honest-fabricated: nothing is chipped as an override.
    expect(body().queryByText("Overridden")).toBeNull();
    cleanup();
  });

  // POSITIVE CONTROL (must be able to fail): a `null` scenario cell renders an em dash.
  // If the surface ever filled it from a sibling column or a table guess, this goes red.
  it("a null scenario cell renders an em dash, never a model string", async () => {
    // second-seat is null in claudeOnly/codexOnly; give it a DISTINCTIVE dual value so a
    // leak from the dual column would be visible as that string.
    const roles: readonly ReviewRole[] = REVIEW_ROLE_DEFAULTS.map((role) =>
      role.id === "second-seat"
        ? { ...role, dual: { model: "gpt-5.5", effort: "xhigh" as const } }
        : role,
    );
    const { getByRole, user } = mount(
      withReview({ agentsByHost: { h1: BOTH_AGENTS }, reviewRoles: roles }, ["claude"]),
    );
    await user.click(getByRole("button", { name: "Edit Mappings" }));
    // The Claude-only column is the only editable one; the second seat is an em dash.
    expect(body().getAllByText("—").length).toBe(1);
    // Its dual value never leaks into the single-provider column (dual is rendered too,
    // locked — so exactly ONE occurrence, not two).
    expect(body().getAllByText("gpt-5.5").length).toBe(1);
    cleanup();
  });
});
