import type { LensBoard } from "../../lens-data"

// change-B decisions fixture (PR #439, drafted via packages/lens-instructions, unslop-edited).
export const decisionsBoardB: LensBoard = {
  lens: "decisions",
  title: "Decisions",
  intro:
    "Judgment calls inside the daemon-in-distro WSL runtime: how the bundle reaches the distro, how the runtime decides a daemon is healthy, how it spawns the daemon, and how a project routes to its distro daemon.",
  skippedHunks: [
    {
      path: "openspec/changes/wsl-daemon-runtime/proposal.md",
      reason: "Spec artifact. The Design lane renders the proposal shape.",
    },
    {
      path: "openspec/changes/wsl-daemon-runtime/design.md",
      reason:
        "Spec design doc. The Design lane owns the artifact; the calls it records are rendered here and cite it.",
    },
    {
      path: "openspec/changes/wsl-daemon-runtime/specs/wsl-daemon-runtime/spec.md",
      reason: "Requirement deltas. The Design lane owns the SHALL text and coverage.",
    },
    {
      path: "openspec/changes/wsl-daemon-runtime/tasks.md",
      reason: "Task checklist, Design-lane task-progress material.",
    },
    {
      path: "docs/developing/concepts/wsl-daemon.md",
      reason: "Concept doc 'Built vs remaining' update — reader-facing docs, not a code decision.",
    },
    {
      path: "packages/core/src/index.ts",
      reason: "Mechanical re-export of the new WSL bundle/shell symbols, a rename-tier hunk.",
    },
    {
      path: "packages/server/src/index.ts",
      reason: "Mechanical re-export of the WSL daemon/supervisor surface, a rename-tier hunk.",
    },
    {
      path: "packages/core/src/wsl-bundle.test.ts",
      reason: "Delivery failure/skip coverage — requirement-coverage material.",
    },
    {
      path: "packages/core/src/wsl-shell.test.ts",
      reason: "Multiline-parse coverage — requirement-coverage material.",
    },
    {
      path: "packages/server/src/wsl-daemon.test.ts",
      reason: "Spawn/health/stop coverage — requirement-coverage material.",
    },
    {
      path: "packages/server/src/wsl-supervisor.test.ts",
      reason: "Orchestrator coverage — requirement-coverage material.",
    },
    {
      path: "apps/desktop/src/main/daemon-supervisor.test.ts",
      reason: "Routing/single-flight coverage — requirement-coverage material.",
    },
  ],
  sections: [
    {
      id: "delivery",
      title: "Delivery & Path Discipline",
      badge: "added",
      gist: "Where the bundle lives inside the distro, how it gets there, and how the runtime parses noisy shell output.",
      counts: "3 decisions · 2 with code tabs",
      elements: [
        {
          kind: "decision",
          statement:
            "The daemon bundle lands in the distro's native fs at `~/.rennet/server/<version>/`. It is copied once per version, only when the versioned entry is absent, always the whole server directory, and never run over 9P.",
          why: "Stated (design.md Decision 1; wsl-bundle.ts header): running the bundle across `\\\\wsl.localhost\\…` would bring back the 9P tax this change exists to delete, so it must run from native fs. The versioned path mirrors `~/.vscode-server`, and a version bump lands in a new dir, so old daemons keep their bundle. The whole-directory copy, `cp -r <dir>/.`, is a code-level call because the bundle is code-split. A single-file copy crashes the daemon at startup with a missing-module error.",
          inferred: false,
          alternatives: [
            "Run the bundle from its `\\\\wsl.localhost\\<distro>\\…` UNC path with no copy, rejected in design.md Decision 1 because it defeats the architecture and reintroduces the tax.",
            "Copy only the `index.cjs` entry, rejected in code because the code-split runtime/sdk chunks would be missing and the daemon would crash.",
          ],
          evidence: [
            { path: "packages/core/src/wsl-bundle.ts", line: 27 },
            { path: "packages/core/src/wsl-bundle.ts", line: 106 },
            { path: "packages/core/src/wsl-bundle.ts", line: 131 },
          ],
          excerpts: [
            {
              path: "packages/core/src/wsl-bundle.ts",
              startLine: 21,
              lang: "typescript",
              highlightLines: [27],
              code: `/** Absolute distro-native path the versioned daemon bundle is delivered to. */
export function wslServerDir(distroHome: string, version: string): string {
  return \`\${trimTrailingSlash(distroHome)}/.rennet/server/\${version}\`;
}

/** The distro-native path of the daemon ENTRY (\`index.cjs\`) inside the delivered dir. */
export function wslServerBundlePath(distroHome: string, version: string): string {
  return \`\${wslServerDir(distroHome, version)}/index.cjs\`;
}`,
            },
            {
              path: "packages/core/src/wsl-bundle.ts",
              startLine: 104,
              lang: "typescript",
              highlightLines: [106],
              code: `  // \`test -f\` the ENTRY: exit 0 ⇒ present, 1 ⇒ absent, anything else ⇒ the probe failed.
  const present = await run(locusCommand(locus, "test", ["-f", entry]));
  if (present.code === 0) return entry; // already delivered this version — skip the copy.
  if (present.code !== 1) {
    throw new WslBundleDeliveryError(
      \`could not probe the bundle path in "\${distro}" (test exited \${present.code})\`,
    );
  }`,
            },
            {
              path: "packages/core/src/wsl-bundle.ts",
              startLine: 126,
              lang: "typescript",
              highlightLines: [131],
              code: `  // Deliver the WHOLE server directory, not just the entry file. The bundle is
  // code-split (\`index.cjs\` plus its \`rolldown-runtime-*.cjs\` and lazy \`sdk-*.cjs\`
  // chunks), so a single-file copy makes the daemon crash at startup with a
  // missing-module error. \`<dir>/.\` copies the directory's contents (no shell glob).
  const sourceDir = source.slice(0, source.lastIndexOf("/"));
  const copied = await run(locusCommand(locus, "cp", ["-r", \`\${sourceDir}/.\`, targetDir]));
  if (copied.code !== 0) {
    throw new WslBundleDeliveryError(
      \`bundle copy failed in "\${distro}" (cp exited \${copied.code})\`,
    );
  }`,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "The parser that reads a value out of noisy WSL shell output strips ANSI and control characters but keeps line breaks before splitting. It lives in one shared `wsl-shell` module, used by both the node resolver and the bundle deliverer.",
          why: "Stated (wsl-shell.ts header; the harden commit): a prior copy stripped `\\n` before splitting on it, collapsing multi-line probe output, say a $HOME line plus a trailing warning, into a single invalid line. Moving the corrected `stripShellControl`, `shellLines` and `lastAbsolutePathLine` into one module fixed the same latent bug in the already-merged `wsl-node.ts` parser, and removed the copy-paste.",
          inferred: false,
          alternatives: [
            "Keep the control-stripping inlined per file, which is the copy-pasted form that carried the newline-collapse bug.",
            "Strip control chars including `\\n` and take the first/last token, which loses the ability to skip a warning line and pick the real absolute path.",
          ],
          evidence: [
            { path: "packages/core/src/wsl-shell.ts", line: 18 },
            { path: "packages/core/src/wsl-shell.ts", line: 31 },
          ],
          excerpts: [
            {
              path: "packages/core/src/wsl-shell.ts",
              startLine: 22,
              lang: "typescript",
              highlightLines: [24, 31],
              code: `/** The cleaned, trimmed, non-empty lines of shell output (order preserved). */
export function shellLines(raw: string): string[] {
  return stripShellControl(raw)
    .split(/\\r?\\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The LAST line that looks like an absolute path (\`/…\`), or null — skips warning noise. */
export function lastAbsolutePathLine(raw: string): string | null {
  const lines = shellLines(raw);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line?.startsWith("/")) return line;
  }
  return null;
}`,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "The WSL daemon's data dir holds its GitHub token, daemon.json and log at a distro-native path, `~/.local/share/rennet`. The existing secret store points at it, rather than a new store or a host-side token.",
          why: "Stated (design.md Decision 5; ADR 0003): the daemon already runs in-distro, so pointing its `--data-dir` at a native path keeps both egress and the token off 9P as a free win. No new store is written.",
          inferred: false,
          alternatives: [
            "Keep the GitHub token in the host-side store and hand it across the 9P boundary to the distro daemon.",
            "Write a dedicated WSL secret store, rejected in design.md Decision 5 as unnecessary.",
          ],
          evidence: [{ path: "packages/core/src/wsl-bundle.ts", line: 42 }],
        },
      ],
    },
    {
      id: "lifecycle",
      title: "Health & Spawn",
      badge: "added",
      gist: "How the runtime decides the daemon's health, launches it, and sequences a version-skew restart.",
      counts: "4 decisions · 2 with code tabs",
      elements: [
        {
          kind: "decision",
          statement:
            "Steady-state health is decided on the port. A GET to `http://localhost:<port>/healthz` must come back 200 with an identity claiming the very port probed. Health never reads the daemon's claim file across 9P; the claim file is read once, to learn the port.",
          why: "Stated (design.md Decisions 2 & 3; wsl-daemon.ts header): a WSL daemon's data dir is distro-native, so reading `daemon.json` from Windows every tick means 9P. The port path costs no 9P, and it is what the spike used. So the claim file is read once, and health thereafter goes to the loopback port.",
          inferred: false,
          alternatives: [
            "Health-check by reading `daemon.json` from the distro data dir each tick, rejected in design.md Decision 2 because it is a per-tick 9P read.",
            "Accept any 2xx from `/healthz`, rejected in code. An identity-matching 200 whose `wsPort` equals the probed port is required, or a stale forward reads as healthy.",
          ],
          evidence: [
            { path: "packages/server/src/wsl-daemon.ts", line: 91 },
            { path: "packages/server/src/wsl-daemon.ts", line: 119 },
          ],
          excerpts: [
            {
              path: "packages/server/src/wsl-daemon.ts",
              startLine: 85,
              lang: "typescript",
              highlightLines: [91],
              code: `/**
 * Learn the daemon's port with the ONE 9P read this design permits: a single
 * \`wsl.exe … -e cat <dataDir>/daemon.json\`, parsed with \`daemonInfoSchema\`. Returns
 * \`wsPort\`, or \`null\` when the file is absent (non-zero exit) or unparseable. Steady-
 * state health never reads this file again — it goes to the port (\`probeWslDaemonHealth\`).
 */
export async function readWslDaemonPort(
  location: WslDaemonLocation,
  run: WslRunner,
): Promise<number | null> {
  const command = locusCommand({ kind: "wsl", distro: location.distro }, "cat", [
    \`\${location.distroDataDir}/daemon.json\`,
  ]);
  const { stdout, code } = await run(command);
  if (code !== 0) return null;`,
            },
            {
              path: "packages/server/src/wsl-daemon.ts",
              startLine: 124,
              lang: "typescript",
              highlightLines: [125, 128, 132],
              code: `  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(\`http://localhost:\${port}/healthz\`, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) return null; // an identity-matching 200, not any 2xx.
    const parsed = daemonIdentitySchema.safeParse(await res.json());
    // The identity must claim the very port we probed — a mismatched wsPort means
    // this is not the daemon we think it is (stale forward, wrong process).
    if (!parsed.success || parsed.data.wsPort !== port) return null;
    return parsed.data;
  } catch {
    return null;
  }`,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "The shell spawns the daemon as its managed child with `windowsHide` and `unref`, deliberately not `detached`. That reverses the design and proposal's stated 'detached run'.",
          why: "Stated (wsl-daemon.ts spawn comment): a WSL daemon cannot outlive its launcher anyway. Lancelot proved WSL reaps a distro's processes when the launching interop instance ends, so the daemon is app-lifetime by nature. Node's `windowsHide` is a no-op when `detached` is set, a known Node bug, and that is why the earlier detached spawn flashed an empty `wsl.exe` console window. Dropping `detached` lets `windowsHide` hide the console. The design doc's Risks section still frames the spawn as 'detached' and `unref`'d, so the implementation made this call against the written plan.",
          inferred: false,
          alternatives: [
            "Spawn `detached` + `unref`, as design.md's Risks section frames it. Rejected in code because `windowsHide` is ignored under `detached`, flashing a console window, and detachment buys nothing WSL will honor.",
          ],
          evidence: [
            { path: "packages/server/src/wsl-daemon.ts", line: 74 },
            { path: "openspec/changes/wsl-daemon-runtime/design.md", line: 35 },
          ],
          excerpts: [
            {
              path: "packages/server/src/wsl-daemon.ts",
              startLine: 59,
              lang: "typescript",
              code: `/**
 * Spawn the WSL daemon as the shell's MANAGED CHILD — NOT detached. A WSL daemon
 * cannot outlive its launcher anyway (WSL reaps a distro's processes when the
 * launching interop instance ends — proven on lancelot: setsid/nohup/hidden-launch
 * all die once the launcher exits), so the daemon is app-lifetime by nature. Two
 * consequences drive the options:
 *   - NO \`detached\`: Node's \`windowsHide\` is a no-op when \`detached\` is set (a known
 *     Node bug), which is exactly why the old detached spawn flashed an empty
 *     \`wsl.exe\` console window. Without \`detached\`, \`windowsHide\` hides the console
 *     (it stays a hidden console, which \`wsl.exe\` needs — \`CreateNoWindow\`/no console
 *     breaks the interop, proven on lancelot), so the daemon starts with NO window.
 *   - \`unref\` so the shell can quit without waiting on the long-running child; the
 *     daemon dies with the shell (the honest WSL model — see above).
 */`,
            },
            {
              path: "packages/server/src/wsl-daemon.ts",
              startLine: 74,
              lang: "typescript",
              highlightLines: [76, 79],
              code: `export function spawnWslDaemon(launch: LocusCommand, deps: WslSpawnDeps = {}): void {
  const spawner = deps.spawn ?? ((file, args, options) => spawn(file, args as string[], options));
  const child = spawner(launch.file, launch.args, { stdio: "ignore", windowsHide: true });
  // An async spawn failure (ENOENT: no wsl.exe, EACCES) would be an UNHANDLED 'error'
  // event — a process crash. Own it here: log, never throw.
  child.on("error", (error) => {
    console.error(\`[wsl-daemon] failed to spawn \${launch.file}: \${error.message}\`);
  });
  child.unref();
}`,
            },
            {
              path: "openspec/changes/wsl-daemon-runtime/design.md",
              startLine: 32,
              lang: "markdown",
              highlightLines: [35],
              code: `## Risks / Trade-offs

- **A WSL distro with no Node** → surfaced plainly per the spec (not a hang); a shipped-Node fallback is deferred, not silently required.
- **\`wsl.exe\` process lifetime / distro auto-termination** → the detached daemon process keeps the distro instance alive while it runs; verify the daemon is \`unref\`'d and survives the spawning \`wsl.exe\` returning (the spike's detached run persisted).`,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "A version-skew daemon, healthy but on a different version, is stopped by the pid its identity carries. The shell then waits, with a bound, for that identity to disappear before respawning, and confirms the fresh daemon reports the shipped version.",
          why: "Stated (wsl-supervisor.ts comments): the wait mirrors the host supervisor's `waitForClaimGone`, so the fresh daemon's claim never races the dying one's. The post-restart version check guards against the lancelot field bug, where a stale claim handed the old daemon back and re-served the wrong version.",
          inferred: false,
          alternatives: [
            "Respawn immediately after signalling the old pid, without waiting for it to exit, risking the fresh claim racing the dying daemon's.",
            "Trust the restart succeeded without re-confirming the served version, which is how the host path let an older daemon keep serving a newer shell.",
          ],
          evidence: [
            { path: "packages/server/src/wsl-supervisor.ts", line: 125 },
            { path: "packages/server/src/wsl-supervisor.ts", line: 140 },
          ],
          excerpts: [
            {
              path: "packages/server/src/wsl-supervisor.ts",
              startLine: 119,
              lang: "typescript",
              highlightLines: [125, 126],
              code: `  if (existing) {
    // Healthy but version-skewed: stop the old daemon by the pid its identity carries, then
    // spawn the current bundle. In-flight turns fold to \`interrupted\`; reviews persist in sqlite
    // — the same no-ceremony restart the host supervisor performs (D3/D10, Rule Zero). WAIT
    // (bounded) for the old identity to actually disappear BEFORE spawning — mirroring the host
    // supervisor's \`waitForClaimGone\`, so the fresh daemon's claim never races the dying one's.
    await stopWslDaemon({ distro, pid: existing.identity.pid }, run);
    await waitForWslIdentityGone(location, existing.identity.pid, deps);
  }`,
            },
            {
              path: "packages/server/src/wsl-supervisor.ts",
              startLine: 137,
              lang: "typescript",
              highlightLines: [140],
              code: `  // A skew restart that somehow handed the OLD daemon back (stale claim, lost race) would
  // silently re-serve the wrong version — the exact lancelot field bug for the host path.
  // Confirm the identity we resolved is the version this shell ships.
  if (handle.identity.version !== serverVersion) {
    throw new Error(
      \`WSL daemon in "\${distro}" reports version \${handle.identity.version} after restart, expected \${serverVersion}.\`,
    );
  }
  return handle;`,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "The startup acquisition loop re-reads `daemon.json` for the port on every poll, even though steady-state health learns the port only once.",
          why: "Stated (waitForWslDaemon comment): the 'learn the port once' discipline is for steady state. During acquisition a version-skew restart brings the daemon back on a new ephemeral port, so a port cached from the dying daemon gets polled to no effect until the deadline. One 9P read per interval is cheap, and it only happens while starting up.",
          inferred: false,
          alternatives: [
            "Read the port once and reuse it across the whole acquisition poll, which strands the loop on the dead daemon's port after a skew restart.",
          ],
          evidence: [{ path: "packages/server/src/wsl-daemon.ts", line: 169 }],
        },
      ],
    },
    {
      id: "composition",
      title: "Routing & Composition",
      badge: "added",
      gist: "How the WSL runtime reuses the host supervisor shape, routes a project to its distro daemon, and stays effect-injected.",
      counts: "4 decisions · 2 with code tabs",
      elements: [
        {
          kind: "decision",
          statement:
            "The WSL runtime composes the existing supervisor parts behind an effect-injected orchestrator, `ensureWslDaemon`. The desktop main is a thin locus-select over it, so the host-locus path stays byte-identical and no WSL code runs for a host project.",
          why: "Stated (design.md Decision 3; wsl-supervisor.ts header; PR body 'add a WSL variant, don't fork the world'): reusing the supervisor's verify/restart/stop shape keeps the new code minimal. Injecting every effect (spawn, run, fetch, clock) makes the whole path unit-testable off-box, while the live wiring waits on the lancelot field proof.",
          inferred: false,
          alternatives: [
            "Special-case WSL inside the host supervisor, which would put WSL branches on the host path and break its byte-identical guarantee.",
            "Fork a separate WSL supervisor that re-implements verify/restart/stop, rejected in design.md Decision 3 as forking the world.",
          ],
          evidence: [
            { path: "packages/server/src/wsl-supervisor.ts", line: 112 },
            { path: "apps/desktop/src/main/daemon-supervisor.ts", line: 322 },
          ],
          excerpts: [
            {
              path: "packages/server/src/wsl-supervisor.ts",
              startLine: 108,
              lang: "typescript",
              highlightLines: [112, 113],
              code: `  // A healthy daemon on our exact version needs nothing further — skip Node resolution and
  // delivery entirely (both cost interactive wsl.exe execs). Version skew falls through to
  // a stop-then-respawn below; absent / dead falls through to a plain spawn.
  const existing = await currentHealth(location, deps);
  if (existing && existing.identity.version === serverVersion) return existing;

  const nodePath = await resolveWslNode(distro, runString); // throws WslNodeNotFoundError
  const bundlePath = await ensureWslBundleDelivered(
    { distro, distroHome, version: serverVersion, hostBundlePath: deps.hostBundlePath },
    run,
  ); // throws WslBundleDeliveryError`,
            },
            {
              path: "apps/desktop/src/main/daemon-supervisor.ts",
              startLine: 321,
              lang: "typescript",
              highlightLines: [322],
              code: `  const locus = detectLocus(projectPath);
  if (locus.kind === "host") return deps.ensureHostDaemon(hostDataDir);
  const { distro } = locus;
  // Single-flight per distro: a concurrent open joins the running ensure; once it settles the
  // entry is dropped so the next open re-ensures against \`ensureWslDaemon\`'s own short-circuit.
  const pending = deps.inFlight.get(distro);
  if (pending) return pending;
  const promise = deps.ensureWslDaemon(distro, deps.wslDeps(distro)).then(({ port }) => port);
  deps.inFlight.set(distro, promise);
  try {
    return await promise;
  } finally {
    deps.inFlight.delete(distro);
  }`,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "One daemon runs per distro, spawned lazily on the first project for that distro and routed by execution locus. Concurrent opens on the same distro fold into one in-flight ensure, and the map entry is dropped once settled, so no port cache persists.",
          why: "Stated (design.md Decision 4; the in-flight map docstring): the locus routing key already exists, and lazy spawn avoids starting daemons for distros never used. Dropping the entry on settle, rather than caching the port, means a later open re-ensures against `ensureWslDaemon`'s own healthy-same-version short-circuit. There is no stale port cache to go wrong, and the path heals itself.",
          inferred: false,
          alternatives: [
            "Cache the resolved port per distro across opens, which goes stale when a version-skew restart moves the daemon to a new port.",
            "Run one global daemon for all distros, rejected because a distro daemon must run where its files are.",
          ],
          evidence: [
            { path: "apps/desktop/src/main/daemon-supervisor.ts", line: 277 },
            { path: "apps/desktop/src/main/daemon-supervisor.ts", line: 326 },
          ],
          excerpts: [
            {
              path: "apps/desktop/src/main/daemon-supervisor.ts",
              startLine: 271,
              lang: "typescript",
              highlightLines: [277],
              code: `/**
 * distro → the IN-FLIGHT ensure promise for that distro, so two concurrent project-opens on
 * the same distro fold into ONE \`ensureWslDaemon\` call. The entry is removed once settled, so a
 * later open re-ensures — no stale port cache (\`ensureWslDaemon\` self-short-circuits when a
 * healthy same-version daemon already runs, so re-ensuring is cheap and self-healing).
 */
const wslInFlight = new Map<string, Promise<number>>();`,
            },
            {
              path: "apps/desktop/src/main/daemon-supervisor.ts",
              startLine: 325,
              lang: "typescript",
              highlightLines: [326, 327, 333],
              code: `  // Single-flight per distro: a concurrent open joins the running ensure; once it settles the
  // entry is dropped so the next open re-ensures against \`ensureWslDaemon\`'s own short-circuit.
  const pending = deps.inFlight.get(distro);
  if (pending) return pending;
  const promise = deps.ensureWslDaemon(distro, deps.wslDeps(distro)).then(({ port }) => port);
  deps.inFlight.set(distro, promise);
  try {
    return await promise;
  } finally {
    deps.inFlight.delete(distro);
  }`,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "The orchestrator trusts a runner's stdout only on a clean run, exit 0. Any nonzero or timed-out run maps to an empty string before anything parses a $HOME or Node path.",
          why: "Stated (ensureWslDaemon `runString` comment): a nonzero or timed-out run may have flushed partial stdout that must never be parsed as a valid path and fed to a spawn. An empty string parses to null and a clear error, never a half-read path.",
          inferred: false,
          alternatives: [
            "Parse whatever stdout the runner returned regardless of exit code, which lets a partial read from a failed probe become a bogus $HOME or Node path.",
          ],
          evidence: [{ path: "packages/server/src/wsl-supervisor.ts", line: 92 }],
        },
        {
          kind: "decision",
          statement:
            "The desktop's WSL runner uses the built-in `child_process.execFile` with its own per-call timeout, not the `execa` dependency the codebase already carries elsewhere.",
          why: "Stated (createWslRunner docstring): the built-in with a `timeout` is enough. The runner must carry its own timeout, because the health-wait loop only bounds the interval between polls, so a wedged distro call could otherwise stall it. A failed or non-zero exec resolves a non-zero `code` rather than throwing, matching how delivery and health branch on the code.",
          inferred: false,
          alternatives: [
            "Wrap `execa` for the runner, rejected in the docstring as an unnecessary dependency when the built-in with a timeout suffices.",
          ],
          evidence: [{ path: "apps/desktop/src/main/daemon-supervisor.ts", line: 237 }],
        },
      ],
    },
  ],
}
