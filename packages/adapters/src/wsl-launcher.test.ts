import { describe, expect, it } from "vitest";
import { wslClaudeLauncherScript } from "./wsl-launcher";

describe("wslClaudeLauncherScript", () => {
  it("bakes the distro repo cwd (cmd.exe cannot hold the SDK's UNC cwd — lancelot)", () => {
    const script = wslClaudeLauncherScript({
      distro: "Ubuntu",
      distroClaudePath: "/home/rai/.local/bin/claude",
      distroCwd: "/home/rai/repo",
    });
    expect(script).toContain('-d Ubuntu --cd "/home/rai/repo" -e /home/rai/.local/bin/claude %*');
    // No %CD%/wslpath — that path is broken by cmd.exe's UNC-cwd limitation.
    expect(script).not.toContain("%CD%");
    expect(script).not.toContain("wslpath");
    // Never the login-shell `--` form (argv must stay byte-verbatim).
    expect(script).not.toContain('wsl.exe" -d Ubuntu -- ');
    expect(script).toContain("\r\n");
  });

  it("omits --cd when no distroCwd is given (runs in the distro login home)", () => {
    const script = wslClaudeLauncherScript({
      distro: "Ubuntu",
      distroClaudePath: "/home/rai/.local/bin/claude",
    });
    expect(script).toContain("-d Ubuntu -e /home/rai/.local/bin/claude %*");
    expect(script).not.toContain("--cd");
  });

  it("rejects an unsafe distro name (shell metacharacters cannot reach the .cmd)", () => {
    expect(() =>
      wslClaudeLauncherScript({ distro: "Ubuntu & del", distroClaudePath: "/x" }),
    ).toThrow(/unsafe WSL distro/);
  });

  it("rejects a path with a quote or newline", () => {
    expect(() =>
      wslClaudeLauncherScript({ distro: "Ubuntu", distroClaudePath: '/x"\nrm -rf' }),
    ).toThrow(/unsafe path/);
    expect(() =>
      wslClaudeLauncherScript({
        distro: "Ubuntu",
        distroClaudePath: "/x",
        distroCwd: '/y"\nrm',
      }),
    ).toThrow(/unsafe path/);
  });
});
