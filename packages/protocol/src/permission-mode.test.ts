import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MODE,
  GATED_ACTIONS,
  gateResolution,
  PERMISSION_MODES,
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
});
