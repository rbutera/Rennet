import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter as hostDelimiter, posix as posixPath } from "node:path";
import { execa } from "execa";
import type { SourceControlToolId } from "./git-failure";

/**
 * Install a missing source-control tool when the person asks (source-control-tooling
 * spec, design decision 3: "Install for me").
 *
 * Two halves. `resolveInstallPlan` decides what would run: on macOS with Homebrew on the
 * resolved PATH, the Homebrew commands; anywhere else, the manual command and a link.
 * `runInstallPlan` runs a Homebrew plan step by step, streams every chunk of output to the
 * caller as it arrives, stops at the first failing step, and re-probes the tool afterwards
 * so the result carries the tool's real state rather than the installer's opinion of it.
 *
 * No confirmation step lives here (Rule Zero): pressing the button is the request. Homebrew
 * installs as the user, so nothing is elevated.
 */

/** One process an install plan runs. `file` is absolute, or a name resolved on the PATH
 *  the runner gives it. */
export interface InstallStep {
  readonly file: string;
  readonly args: readonly string[];
}

export type InstallPlan =
  | {
      readonly plan: "brew";
      readonly tool: SourceControlToolId;
      readonly steps: readonly InstallStep[];
      /** What runs, as one line a person can read and copy. */
      readonly command: string;
      /** Homebrew's own bin directory, put first on the PATH for every step so a later
       *  step (`git lfs install`) finds what an earlier one installed. */
      readonly pathPrefix: string;
    }
  | {
      readonly plan: "manual";
      readonly tool: SourceControlToolId;
      /** The command to run by hand on this platform. */
      readonly command: string;
      readonly docsUrl: string;
    };

export interface InstallPlanDeps {
  readonly platform?: NodeJS.Platform;
  /** The PATH to look for `brew` on. Default: this process's (the daemon's resolved) PATH. */
  readonly envPath?: string;
  /** Where Homebrew installs itself, checked even when not on the PATH. */
  readonly brewDirectories?: readonly string[];
  isExecutable?(path: string): Promise<boolean>;
}

export const TOOL_DOCS_URL: Readonly<Record<SourceControlToolId, string>> = {
  git: "https://git-scm.com/downloads",
  "git-lfs": "https://git-lfs.com",
};

const TOOL_LABEL: Readonly<Record<SourceControlToolId, string>> = {
  git: "Git",
  "git-lfs": "Git LFS",
};

const DEFAULT_BREW_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin"] as const;

async function defaultIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function manualCommand(tool: SourceControlToolId, platform: NodeJS.Platform): string {
  if (tool === "git") {
    if (platform === "darwin") return "xcode-select --install";
    if (platform === "win32") return "winget install --id Git.Git";
    return "sudo apt-get install git";
  }
  if (platform === "darwin") return "brew install git-lfs && git lfs install";
  if (platform === "win32") return "winget install --id GitHub.GitLFS && git lfs install";
  return "sudo apt-get install git-lfs && git lfs install";
}

/** The first executable `brew` on the PATH or in Homebrew's own directories. */
async function findBrew(deps: InstallPlanDeps): Promise<string | null> {
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const directories = [
    ...(deps.envPath ?? process.env.PATH ?? "").split(hostDelimiter),
    ...(deps.brewDirectories ?? DEFAULT_BREW_DIRECTORIES),
  ].filter((directory, index, all) => directory.length > 0 && all.indexOf(directory) === index);
  for (const directory of directories) {
    const candidate = posixPath.join(directory, "brew");
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * What installing `tool` would run here. Homebrew on macOS only: Windows, WSL and Linux
 * get the manual command and the docs link (design non-goal: no installers there).
 */
export async function resolveInstallPlan(
  tool: SourceControlToolId,
  deps: InstallPlanDeps = {},
): Promise<InstallPlan> {
  const platform = deps.platform ?? process.platform;
  const brew = platform === "darwin" ? await findBrew(deps) : null;
  if (brew === null) {
    return {
      plan: "manual",
      tool,
      command: manualCommand(tool, platform),
      docsUrl: TOOL_DOCS_URL[tool],
    };
  }
  const pathPrefix = posixPath.dirname(brew);
  if (tool === "git") {
    return {
      plan: "brew",
      tool,
      steps: [{ file: brew, args: ["install", "git"] }],
      command: "brew install git",
      pathPrefix,
    };
  }
  return {
    plan: "brew",
    tool,
    steps: [
      { file: brew, args: ["install", "git-lfs"] },
      { file: "git", args: ["lfs", "install"] },
    ],
    command: "brew install git-lfs && git lfs install",
    pathPrefix,
  };
}

export type InstallOutputStream = "stdout" | "stderr";

export interface RunInstallOptions<P> {
  /** Every chunk of output, as it arrives. */
  readonly onOutput?: (chunk: string, stream: InstallOutputStream) => void;
  /** Asked once the plan has run (or not run), whatever happened. */
  readonly reprobe: () => Promise<P>;
  /** Cancels the running step and everything it started, and runs no later step. A
   *  cancelled install is reported as failed. */
  readonly signal?: AbortSignal;
  /** Extra environment layered over the inherited one. Its PATH, when given, replaces the
   *  inherited PATH after the plan's prefix. */
  readonly env?: Readonly<Record<string, string>>;
}

export type InstallRunResult<P> =
  | {
      readonly status: "installed";
      readonly plan: InstallPlan;
      readonly output: string;
      readonly probe: P;
    }
  | {
      readonly status: "failed";
      readonly plan: InstallPlan;
      /** One plain sentence; the output is the detail. */
      readonly message: string;
      /** The step that failed, as a person would type it. */
      readonly failedCommand: string;
      readonly exitCode: number | null;
      /** Present when the install stopped because `signal` was aborted. */
      readonly cancelled?: true;
      readonly output: string;
      readonly probe: P;
    }
  | {
      readonly status: "manual";
      readonly plan: InstallPlan;
      readonly probe: P;
    };

/** How much installer output the result keeps. The tail, because the verdict is last. */
export const INSTALL_OUTPUT_CAP = 64_000;

/** How long a cancelled step's process group gets after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** How often a cancelled step's process group is checked for being gone. */
const GROUP_POLL_MS = 50;

/** How long the output pipes stay open after a step exits. A descendant that left the
 *  step's process group (a daemon that called `setsid`) can hold them open forever, and
 *  execa would wait for it; by now the step's own output has long been read. */
const PIPE_DRAIN_MS = 500;

/**
 * The installer's output, kept to its tail, counting honestly what it let go of. The
 * running buffer is trimmed whenever it doubles the cap, so the omitted count is a
 * running total, not a guess made from what is left.
 */
class OutputTail {
  private text = "";
  private discarded = 0;

  append(chunk: string): void {
    this.text += chunk;
    if (this.text.length > INSTALL_OUTPUT_CAP * 2) this.drop(this.text.length - INSTALL_OUTPUT_CAP);
  }

  /** The kept tail, behind a marker naming every character dropped along the way. */
  value(): string {
    if (this.text.length > INSTALL_OUTPUT_CAP) this.drop(this.text.length - INSTALL_OUTPUT_CAP);
    if (this.discarded === 0) return this.text;
    return `… ${this.discarded} characters of earlier output omitted …\n${this.text}`;
  }

  private drop(count: number): void {
    let cut = count;
    // Never split a surrogate pair: its second half alone is not a character.
    const next = this.text.charCodeAt(cut);
    if (next >= 0xdc00 && next <= 0xdfff) cut += 1;
    this.discarded += cut;
    this.text = this.text.slice(cut);
  }
}

/** Signal every process in group `pgid`. A group that is already gone is no error. */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Whether any process is left in group `pgid`. One we may not signal is still there. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Cancellation for one step's process group (POSIX), on the clock alone.
 *
 * execa's own `forceKillAfterDelay` is not enough: its SIGKILL is dropped the moment execa
 * settles, and execa settles once the step has exited and its pipes have closed. A
 * descendant that ignores SIGTERM outlives both. So on abort the group gets SIGTERM, and
 * KILL_GRACE_MS later SIGKILL, whatever the step or its pipes did in between. `settled()`
 * holds the run's result until that SIGKILL has gone out or the group is empty.
 */
function escalateOnAbort(
  pgid: number | undefined,
  signal: AbortSignal | undefined,
): { settled(): Promise<void> } {
  if (pgid === undefined || signal === undefined || process.platform === "win32") {
    return { settled: () => Promise.resolve() };
  }
  let escalation: Promise<void> | undefined;
  const escalate = () => {
    signalGroup(pgid, "SIGTERM");
    escalation = new Promise((resolve) => {
      const poll = setInterval(() => {
        if (groupAlive(pgid)) return;
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }, GROUP_POLL_MS);
      const deadline = setTimeout(() => {
        clearInterval(poll);
        signalGroup(pgid, "SIGKILL");
        resolve();
      }, KILL_GRACE_MS);
    });
  };
  if (signal.aborted) escalate();
  else signal.addEventListener("abort", escalate, { once: true });
  return {
    settled: () => {
      // A step that finished before any abort leaves its group alone: once the group is
      // empty, its id can be reused.
      signal.removeEventListener("abort", escalate);
      return escalation ?? Promise.resolve();
    },
  };
}

function displayStep(step: InstallStep): string {
  const name = posixPath.basename(step.file);
  return [name, ...step.args].join(" ");
}

/**
 * Run `plan`, streaming output through `options.onOutput`, then re-probe. A manual plan
 * runs nothing and still re-probes, since the person may have installed it by hand.
 */
export async function runInstallPlan<P>(
  plan: InstallPlan,
  options: RunInstallOptions<P>,
): Promise<InstallRunResult<P>> {
  if (plan.plan === "manual") return { status: "manual", plan, probe: await options.reprobe() };

  const inheritedPath = options.env?.PATH ?? process.env.PATH ?? "";
  const env = {
    ...options.env,
    PATH: [plan.pathPrefix, inheritedPath].filter((part) => part.length > 0).join(hostDelimiter),
  };
  const output = new OutputTail();
  const record = (stream: InstallOutputStream) => (text: string) => {
    output.append(text);
    options.onOutput?.(text, stream);
  };

  for (const step of plan.steps) {
    const line = `$ ${displayStep(step)}\n`;
    record("stdout")(line);
    let exitCode: number | null = null;
    let failed = false;
    let cancelled = options.signal?.aborted === true;
    if (cancelled) {
      failed = true;
      record("stderr")("Install cancelled before this step started.\n");
    } else {
      try {
        // `killDescendants` runs the step in its own process group and, when execa
        // terminates it (cancellation), signals the whole group: Homebrew's own children
        // (curl, tar, the post-install scripts) go with it. On POSIX `escalateOnAbort`
        // follows up with SIGKILL for anything that ignores SIGTERM; on Windows execa's own
        // `forceKillAfterDelay` does.
        const child = execa(step.file, [...step.args], {
          env,
          reject: false,
          shell: false,
          stdin: "ignore",
          buffer: false,
          killDescendants: true,
          forceKillAfterDelay: KILL_GRACE_MS,
          ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
        });
        // Decode as text in the stream, so a multi-byte character split across two chunks
        // arrives whole instead of as two replacement characters.
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", record("stdout"));
        child.stderr?.on("data", record("stderr"));
        // execa 10 hands back the spawned process itself as `nodeChildProcess`: a plain
        // ChildProcess, present even when the spawn failed (then it never exits).
        const spawned = child.nodeChildProcess;
        const releasePipes = () =>
          setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
          }, PIPE_DRAIN_MS).unref();
        if (spawned.exitCode !== null || spawned.signalCode !== null) releasePipes();
        else spawned.once("exit", releasePipes);
        const escalation = escalateOnAbort(spawned.pid, options.signal);
        const result = await child.finally(() => escalation.settled());
        exitCode = result.exitCode ?? null;
        failed = result.failed || exitCode !== 0;
        cancelled = result.isCanceled;
        if (cancelled) record("stderr")("Install cancelled.\n");
        // No exit code means the step never ran or was stopped (not found, cancelled): say why.
        if (result.failed && exitCode === null) record("stderr")(`${result.shortMessage}\n`);
      } catch (error) {
        failed = true;
        record("stderr")(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (failed) {
      return {
        status: "failed",
        plan,
        message: `${TOOL_LABEL[plan.tool]} couldn't be installed.`,
        failedCommand: displayStep(step),
        exitCode,
        ...(cancelled ? { cancelled: true as const } : {}),
        output: output.value(),
        probe: await options.reprobe(),
      };
    }
  }
  return { status: "installed", plan, output: output.value(), probe: await options.reprobe() };
}
