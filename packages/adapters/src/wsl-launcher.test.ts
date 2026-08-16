import { describe, expect, it } from "vitest";
import { wslClaudeLauncherScript } from "./wsl-launcher";

describe("wslClaudeLauncherScript", () => {
  it("builds a .cmd that execs the distro claude via wsl.exe -e, cwd-translated", () => {
    const script = wslClaudeLauncherScript({
      distro: "Ubuntu",
      distroClaudePath: "/home/rai/.local/bin/claude",
    });
    // Translates the SDK-set cwd with wslpath, then runs claude with --cd inside the distro.
    expect(script).toContain("-e wslpath -u");
    expect(script).toContain('-d Ubuntu --cd "%RENNET_WSL_CD%" -e /home/rai/.local/bin/claude %*');
    // Never the login-shell `--` form (argv must stay byte-verbatim).
    expect(script).not.toContain('wsl.exe" -d Ubuntu -- ');
    // CRLF line endings for a Windows batch file.
    expect(script).toContain("\r\n");
  });

  it("rejects an unsafe distro name (shell metacharacters cannot reach the .cmd)", () => {
    expect(() =>
      wslClaudeLauncherScript({ distro: "Ubuntu & del", distroClaudePath: "/x" }),
    ).toThrow(/unsafe WSL distro/);
  });

  it("rejects a claude path with a quote or newline", () => {
    expect(() =>
      wslClaudeLauncherScript({ distro: "Ubuntu", distroClaudePath: '/x"\nrm -rf' }),
    ).toThrow(/unsafe claude path/);
  });
});
