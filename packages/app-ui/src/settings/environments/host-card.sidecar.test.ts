import { describe, expect, it } from "vitest";
import type { SettingsHost } from "../data/projections";
import { sidecarLine } from "./host-card";

const host = (t3Sidecar: SettingsHost["daemon"]["t3Sidecar"]): SettingsHost => ({
  id: "local",
  name: "This Machine",
  kind: "local",
  os: "macos",
  daemon: { reachable: true, version: "0.6.1", ...(t3Sidecar ? { t3Sidecar } : {}) },
});

describe("the T3 sidecar line on the local host card (t3code-sidecar-chat, 5.3)", () => {
  it("says nothing until the sidecar has been asked for", () => {
    expect(sidecarLine(host(undefined))).toBeNull();
    expect(sidecarLine(host({ state: "off", upstreamCommit: "abc", telemetry: "off" }))).toBeNull();
  });

  it("names the sidecar as owned, with its state, the port when ready, and the egress fact", () => {
    const ready = sidecarLine(
      host({ state: "ready", port: 43117, upstreamCommit: "abc", telemetry: "off" }),
    );
    expect(ready).toContain("owned by this daemon");
    expect(ready).toContain("ready on 127.0.0.1:43117");
    expect(ready).toContain("telemetry off");
    expect(ready).toContain("egress only through the coding harness");
    expect(
      sidecarLine(
        host({
          state: "degraded",
          detail: "bundle missing",
          upstreamCommit: "abc",
          telemetry: "off",
        }),
      ),
    ).toContain("degraded — bundle missing");
    expect(
      sidecarLine(host({ state: "starting", upstreamCommit: "abc", telemetry: "off" })),
    ).toContain("starting");
  });
});
