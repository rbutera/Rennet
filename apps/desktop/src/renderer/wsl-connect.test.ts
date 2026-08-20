import { describe, expect, it, vi } from "vitest";
import { resolveDaemonTarget, toDistroPath, type WslConnectDeps, wslDistroOf } from "./wsl-connect";

/** A deps double: a resolver spy + a captured log, so each test asserts the decision AND its trace. */
function deps(resolve: WslConnectDeps["resolveDaemonForPath"]): {
  deps: WslConnectDeps;
  logs: Array<{ event: string; path?: string; detail?: Record<string, unknown> }>;
} {
  const logs: Array<{ event: string; path?: string; detail?: Record<string, unknown> }> = [];
  return {
    logs,
    deps: { resolveDaemonForPath: resolve, logWslConnect: (entry) => logs.push(entry) },
  };
}

describe("wslDistroOf / toDistroPath", () => {
  it("reads the distro from both UNC forms and leaves host paths alone", () => {
    expect(wslDistroOf("\\\\wsl.localhost\\Ubuntu\\home\\rai\\proj")).toBe("Ubuntu");
    expect(wslDistroOf("\\\\wsl$\\Debian\\srv\\app")).toBe("Debian");
    expect(wslDistroOf("C:\\Users\\rai\\proj")).toBeNull();
    expect(wslDistroOf("/home/rai/proj")).toBeNull();
  });

  it("translates a UNC path to its distro-native form", () => {
    expect(toDistroPath("\\\\wsl.localhost\\Ubuntu\\home\\rai\\proj")).toBe("/home/rai/proj");
    expect(toDistroPath("/home/rai/proj")).toBe("/home/rai/proj");
    expect(toDistroPath("C:\\Users\\rai")).toBeNull();
  });
});

describe("resolveDaemonTarget", () => {
  it("a WSL path resolves + switches to that distro's tokenless local target", async () => {
    const { deps: d, logs } = deps(vi.fn(async () => 51234));
    const result = await resolveDaemonTarget("\\\\wsl.localhost\\Ubuntu\\home\\rai\\proj", d);

    expect(result).toEqual({
      switched: true,
      target: { id: "wsl:Ubuntu", label: "WSL · Ubuntu", host: "127.0.0.1", port: 51234 },
      repoPath: "/home/rai/proj",
    });
    expect(d.resolveDaemonForPath).toHaveBeenCalledWith(
      "\\\\wsl.localhost\\Ubuntu\\home\\rai\\proj",
    );
    // A tokenless LOCAL target: never a device token (it is on THIS machine).
    expect(result.target?.deviceToken).toBeUndefined();
    expect(logs.map((l) => l.event)).toEqual(["detect", "switch"]);
  });

  it("a host path never switches and never touches the resolver", async () => {
    const { deps: d, logs } = deps(vi.fn(async () => 51234));
    const result = await resolveDaemonTarget("C:\\Users\\rai\\proj", d);

    expect(result).toEqual({ switched: false });
    expect(d.resolveDaemonForPath).not.toHaveBeenCalled();
    expect(logs.map((l) => l.event)).toEqual(["detect"]);
  });

  it("a MAIN rejection (no Node in the distro) becomes an inline error, not a switch", async () => {
    const message = "Rennet needs Node in the Ubuntu distro to run there.";
    const { deps: d, logs } = deps(vi.fn(async () => Promise.reject(new Error(message))));
    const result = await resolveDaemonTarget("\\\\wsl.localhost\\Ubuntu\\home\\rai\\proj", d);

    expect(result).toEqual({ switched: false, error: message });
    expect(logs.map((l) => l.event)).toEqual(["detect", "error"]);
  });

  it("an untrusted/unavailable null resolves to an error rather than switching to a bad port", async () => {
    const { deps: d } = deps(vi.fn(async () => null));
    const result = await resolveDaemonTarget("\\\\wsl.localhost\\Ubuntu\\home\\rai\\proj", d);

    expect(result.switched).toBe(false);
    expect(result.error).toMatch(/could not resolve/i);
  });
});
