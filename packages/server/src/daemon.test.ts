import { describe, expect, it } from "vitest";
import { resolveDaemonConfig } from "./daemon";

describe("daemon argument parsing", () => {
  it("parses the daemon entry's strict options", () => {
    expect(
      resolveDaemonConfig(["--data-dir", "/tmp/rennet", "--server-version=1.2.3"], {}),
    ).toMatchObject({ dataDir: "/tmp/rennet", serverVersion: "1.2.3" });
  });

  it("rejects an unknown option", () => {
    expect(() => resolveDaemonConfig(["--unknown"], {})).toThrow(/unknown option/i);
  });

  it("rejects a missing option value", () => {
    expect(() => resolveDaemonConfig(["--data-dir"], {})).toThrow(/argument missing/i);
  });
});
