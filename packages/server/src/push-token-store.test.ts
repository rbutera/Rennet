import { describe, expect, it } from "vitest";
import { PushTokenStore } from "./push-token-store";

const store = (): PushTokenStore => new PushTokenStore(":memory:", () => 1000);

describe("PushTokenStore (attention-notifications: push tokens register per device)", () => {
  it("sets, reads back, and replaces a device's token (one row per device)", () => {
    const s = store();
    s.set("dev-1", "tok-a", "ios");
    expect(s.get("dev-1")).toMatchObject({ deviceId: "dev-1", token: "tok-a", platform: "ios" });

    // Re-register replaces, never stacks.
    s.set("dev-1", "tok-b", "android");
    expect(s.get("dev-1")).toMatchObject({ token: "tok-b", platform: "android" });
    expect(s.list()).toHaveLength(1);
  });

  it("deletes a device's token (revoke / permission lost) so it is unregistered", () => {
    const s = store();
    s.set("dev-1", "tok-a", "ios");
    s.delete("dev-1");
    expect(s.get("dev-1")).toBeNull();
    expect(s.list()).toEqual([]);
  });

  it("lists every registered device for the planner", () => {
    const s = store();
    s.set("dev-1", "tok-1", "ios");
    s.set("dev-2", "tok-2", "android");
    expect(
      s
        .list()
        .map((r) => r.deviceId)
        .sort(),
    ).toEqual(["dev-1", "dev-2"]);
  });

  it("returns null for a device that never registered", () => {
    expect(store().get("nope")).toBeNull();
  });
});
