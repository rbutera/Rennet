import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultUserPathDeps,
  extractMarkedPath,
  hydrateProcessPath,
  LOGIN_SHELL_PATH_COMMAND,
  LOGIN_SHELL_TIMEOUT_MS,
  listLoginShells,
  mergePathEntries,
  readLoginShellPath,
  resolveUserPath,
  type UserPathDeps,
  type UserPathRunResult,
} from "./user-path";

const DOCK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** The exact stdout a login shell prints for our command, wrapped in whatever noise. */
function marked(path: string, before = "", after = ""): string {
  return `${before}__RENNET_PATH_START__\n${path}\n__RENNET_PATH_END__\n${after}`;
}

const ok = (stdout: string): UserPathRunResult => ({ stdout, timedOut: false, failed: false });
const timedOut: UserPathRunResult = { stdout: "", timedOut: true, failed: true };
const failed: UserPathRunResult = { stdout: "", timedOut: false, failed: true };

type Script = (file: string, args: readonly string[]) => UserPathRunResult;

function deps(script: Script, overrides: Partial<UserPathDeps> = {}) {
  const run = vi.fn<UserPathDeps["run"]>(async (file, args) => script(file, args));
  const warn = vi.fn();
  const built: UserPathDeps = {
    platform: "darwin",
    env: { SHELL: "/bin/zsh", PATH: DOCK_PATH },
    userShell: () => undefined,
    run,
    warn,
    ...overrides,
  };
  return { deps: built, run, warn };
}

describe("extractMarkedPath", () => {
  it("reads only the value between the markers, ignoring banner and motd noise", () => {
    const output = marked(
      "/opt/homebrew/bin:/usr/bin",
      "Welcome to acme-box!\nzsh: can't set tty pgrp\n/usr/local/bin:/should/not/leak\n",
      "logout\n",
    );
    expect(extractMarkedPath(output)).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("is undefined when a marker is missing or the value is blank", () => {
    expect(extractMarkedPath("/usr/bin:/bin")).toBeUndefined();
    expect(extractMarkedPath("__RENNET_PATH_START__\n/usr/bin\n")).toBeUndefined();
    expect(extractMarkedPath(marked("   "))).toBeUndefined();
  });
});

describe("mergePathEntries", () => {
  it("keeps first-seen order and drops repeats and blanks across every list", () => {
    expect(
      mergePathEntries(
        ["/opt/homebrew/bin:/usr/bin::/bin", "/usr/bin:/custom", undefined, "/bin:/usr/local/bin"],
        ":",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin:/bin:/custom:/usr/local/bin");
  });
});

describe("listLoginShells", () => {
  it("tries $SHELL, then the account shell, then the platform default, each once", () => {
    expect(listLoginShells("darwin", "/opt/homebrew/bin/fish", "/bin/zsh")).toEqual([
      "/opt/homebrew/bin/fish",
      "/bin/zsh",
    ]);
    expect(listLoginShells("linux", undefined, undefined)).toEqual(["/bin/sh"]);
  });
});

describe("resolveUserPath", () => {
  it("puts the login shell's PATH first, then the inherited PATH, then the curated directories", async () => {
    const { deps: d, run } = deps(() =>
      ok(marked("/Users/acme/.cargo/bin:/opt/homebrew/bin:/usr/bin:/bin", "Last login: today\n")),
    );

    expect(await resolveUserPath(d)).toBe(
      [
        "/Users/acme/.cargo/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
      ].join(":"),
    );
    // One login shell, run with the marker command and the 5 s budget, and no launchctl.
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", LOGIN_SHELL_PATH_COMMAND],
      LOGIN_SHELL_TIMEOUT_MS,
    );
  });

  it("falls back to launchctl when the login shell times out, without trying another shell", async () => {
    const {
      deps: d,
      run,
      warn,
    } = deps(
      (file) => (file === "/bin/launchctl" ? ok("/opt/homebrew/bin:/usr/bin:/bin\n") : timedOut),
      { userShell: () => "/bin/bash" },
    );

    expect(await resolveUserPath(d)).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/sbin:/usr/local/bin",
    );
    // The hung shell ends the search: /bin/bash is never paid for a second 5 s.
    expect(run.mock.calls.map(([file]) => file)).toEqual(["/bin/zsh", "/bin/launchctl"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("did not answer"));
  });

  it("falls back to launchctl when the shell prints only noise, after trying every candidate", async () => {
    const { deps: d, run } = deps(
      (file) =>
        file === "/bin/launchctl" ? ok("/usr/bin:/bin:/usr/local/share/acme/bin") : ok("banner\n"),
      { userShell: () => "/bin/bash" },
    );

    expect(await resolveUserPath(d)).toBe(
      "/usr/bin:/bin:/usr/local/share/acme/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin",
    );
    expect(run.mock.calls.map(([file]) => file)).toEqual([
      "/bin/zsh",
      "/bin/bash",
      "/bin/launchctl",
    ]);
  });

  it("still yields the inherited PATH plus the curated directories when every step fails", async () => {
    const { deps: d } = deps(() => failed);

    const path = await resolveUserPath(d);

    expect(path).toBe(`${DOCK_PATH}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin`);
    // The spec's Dock scenario: the daemon's PATH reaches Homebrew even with nothing to read.
    expect(path.split(":")).toContain("/opt/homebrew/bin");
  });

  it("does not ask launchctl off macOS", async () => {
    const { deps: d, run } = deps(() => failed, { platform: "linux" });

    expect(await resolveUserPath(d)).toBe(`${DOCK_PATH}:/usr/local/bin`);
    expect(run.mock.calls.map(([file]) => file)).toEqual(["/bin/zsh", "/bin/sh"]);
  });

  it("is a no-op on Windows: the inherited PATH, untouched, and no child spawned", async () => {
    const { deps: d, run } = deps(() => ok(marked("/never")), {
      platform: "win32",
      env: { PATH: "C:\\Windows;C:\\Tools;C:\\Windows" },
    });

    expect(await resolveUserPath(d)).toBe("C:\\Windows;C:\\Tools;C:\\Windows");
    expect(await readLoginShellPath(d)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("hydrateProcessPath", () => {
  it("assigns the resolved PATH to the env it was handed", async () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
    const { deps: d } = deps(() => failed);

    const resolved = await hydrateProcessPath(env, { platform: "darwin", run: d.run });

    expect(env.PATH).toBe(resolved);
    expect(env.PATH).toBe("/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin");
  });
});

// The real effects, against a stub login shell: a real child, a real marker read, a real timeout.
describe.skipIf(process.platform === "win32")("readLoginShellPath with a real shell", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function stubShell(body: string): string {
    dir = mkdtempSync(join(tmpdir(), "rennet-user-path-"));
    const shell = join(dir, "acme-shell");
    writeFileSync(shell, `#!/bin/sh\n${body}\n`);
    chmodSync(shell, 0o755);
    return shell;
  }

  it("runs the marker command through the login shell and ignores its banner", async () => {
    // A login shell that greets the user, then runs `-c <cmd>` with its own PATH.
    const shell = stubShell(
      'echo "Welcome to acme-box"\necho "/decoy/bin"\nPATH=/from/login/shell:/usr/bin:/bin exec /bin/sh -c "$2"',
    );

    const path = await readLoginShellPath({
      ...defaultUserPathDeps({ SHELL: shell, PATH: DOCK_PATH }),
      userShell: () => undefined,
    });

    expect(path).toBe("/from/login/shell:/usr/bin:/bin");
  });

  it("gives up on a shell that never answers", async () => {
    const shell = stubShell("exec sleep 30");
    const deps = defaultUserPathDeps({ SHELL: shell, PATH: DOCK_PATH });
    const warn = vi.fn();

    const path = await readLoginShellPath({
      ...deps,
      userShell: () => undefined,
      // The real runner with a short budget, so the test proves the kill without waiting 5 s.
      run: (file, args) => deps.run(file, args, 200),
      warn,
    });

    expect(path).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("did not answer"));
  });
});
