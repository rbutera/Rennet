import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MODE,
  GATED_ACTIONS,
  gateResolution,
  PERMISSION_MODES,
  type PermissionMode,
  permissionModeSchema,
  requiresConsent,
  resolvePermissionMode,
} from "./permission-mode";

describe("permission mode — the harness-style modes (issue #103)", () => {
  it("defaults to the safe `manual` mode", () => {
    // RED: flip DEFAULT_PERMISSION_MODE to "auto"/"bypass" → this fails. The
    // default MUST be the mode that asks, never one that runs silently.
    expect(DEFAULT_PERMISSION_MODE).toBe("manual");
  });

  it("enumerates exactly manual / auto / bypass", () => {
    expect([...PERMISSION_MODES]).toEqual(["manual", "auto", "bypass"]);
  });

  describe("gateResolution — how each mode gates an action", () => {
    it("manual ASKS (the harness must not run without consent)", () => {
      // RED: make manual return "allow" → the #58 auto-run gate is defeated.
      expect(gateResolution("manual", "harness.run")).toBe("ask");
    });

    it("auto ALLOWS (runs, the action's own safety gate still applies)", () => {
      // RED: make auto return "ask" → auto stops being auto.
      expect(gateResolution("auto", "harness.run")).toBe("allow");
    });

    it("bypass BYPASSES (no gate at all)", () => {
      expect(gateResolution("bypass", "harness.run")).toBe("bypass");
    });

    it("governs every registered gated action uniformly (present + future seams)", () => {
      for (const action of GATED_ACTIONS) {
        expect(gateResolution("manual", action)).toBe("ask");
        expect(gateResolution("auto", action)).toBe("allow");
        expect(gateResolution("bypass", action)).toBe("bypass");
      }
    });

    it("names the #58/#21/#spend seams in the registry", () => {
      expect([...GATED_ACTIONS]).toEqual(["harness.run", "publish.egress", "model.spend"]);
    });
  });

  describe("requiresConsent — the boolean the #58 gate reads", () => {
    it("is true only under manual", () => {
      // RED: any of these flips → the Canvases gate opens or jams incorrectly.
      expect(requiresConsent("manual", "harness.run")).toBe(true);
      expect(requiresConsent("auto", "harness.run")).toBe(false);
      expect(requiresConsent("bypass", "harness.run")).toBe(false);
    });
  });

  describe("resolvePermissionMode — workspace default ← per-run override", () => {
    it("uses the workspace default when there is no per-run override", () => {
      expect(resolvePermissionMode({ workspace: "auto" })).toBe("auto");
    });

    it("lets a per-run override WIN over the workspace default", () => {
      // RED: swap the ?? order in the resolver → the override stops winning.
      expect(resolvePermissionMode({ workspace: "manual", run: "auto" })).toBe("auto");
      expect(resolvePermissionMode({ workspace: "bypass", run: "manual" })).toBe("manual");
    });

    it("falls back to the safe default when nothing is set", () => {
      expect(resolvePermissionMode({})).toBe("manual");
    });
  });

  describe("permissionModeSchema — the command-boundary validator", () => {
    it("accepts the three modes and rejects anything else", () => {
      for (const mode of PERMISSION_MODES) expect(permissionModeSchema.parse(mode)).toBe(mode);
      expect(permissionModeSchema.safeParse("yolo").success).toBe(false);
      expect(permissionModeSchema.safeParse(undefined).success).toBe(false);
    });
  });

  // The pure decision core is exported from `protocol` and reused by BOTH the
  // renderer and (future #21) the main process. A value that defeats the type at
  // runtime — a corrupt persisted string, a garbled per-run override, a raw value
  // from a future consumer — must NEVER open the gate. These are the second,
  // independent guard on the vital circuit (Rule 75, wrong-side).
  describe("fails SAFE on a corrupt / unrecognised mode value (never opens the gate)", () => {
    // Values that are typed PermissionMode but are invalid at runtime.
    const corrupt = ["corrupt", "bypasss", "AUTO", "", "ask"] as unknown as PermissionMode[];

    it("resolvePermissionMode coerces a corrupt workspace layer to manual", () => {
      // RED: drop the safeParse guard → the corrupt string passes straight through.
      for (const bad of corrupt) expect(resolvePermissionMode({ workspace: bad })).toBe("manual");
    });

    it("resolvePermissionMode coerces a corrupt per-run override to manual, not the workspace default", () => {
      // A garbled explicit override must not silently defer to a possibly-less-safe
      // workspace mode. RED: fall through to workspace → this returns "bypass".
      for (const bad of corrupt)
        expect(resolvePermissionMode({ run: bad, workspace: "bypass" })).toBe("manual");
    });

    it("gateResolution ASKS for a corrupt mode (never allow/bypass)", () => {
      // RED: remove the safeParse in gateResolution → modeGate falls through the
      // switch to undefined and the harness gate stops asking.
      for (const bad of corrupt)
        for (const action of GATED_ACTIONS) expect(gateResolution(bad, action)).toBe("ask");
    });

    it("requiresConsent is TRUE for a corrupt mode (the #58 gate stays closed)", () => {
      // The exact wrong-side fault this feature exists to prevent: a corrupt mode
      // must not make requiresConsent false. RED: any guard removed → this reddens.
      for (const bad of corrupt) expect(requiresConsent(bad, "harness.run")).toBe(true);
    });
  });
});
