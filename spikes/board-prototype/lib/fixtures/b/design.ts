/**
 * change-B design fixture (PR #439, drafted via packages/lens-instructions,
 * unslop-edited).
 */

import type { LensBoard } from "@/lib/lens-data"

export const designBoardB: LensBoard = {
  lens: "design",
  title: "The WSL daemon, run inside the distro",
  wide: true,
  skippedHunks: [
    {
      path: "openspec/changes/wsl-daemon-runtime/.openspec.yaml",
      reason: "Generated OpenSpec scaffold stamp (schema/created), not a spec artifact — never rendered.",
    },
    {
      path: "docs/developing/concepts/wsl-daemon.md",
      reason: "Docs 'Built vs remaining' update — records the same deferred renderer wiring the routing requirement already carries, not a normative obligation.",
    },
  ],
  sections: [
    {
      id: "change",
      title: "The Change",
      gist: "wsl-daemon-runtime · 1 new capability · 5 requirements · tasks 13/15.",
      elements: [
        {
          kind: "spec-header",
          change: "wsl-daemon-runtime",
          source: "openspec/changes/wsl-daemon-runtime",
          format: "OpenSpec",
          counts: { added: 1, modified: 0 },
          tasks: { done: 13, total: 15 },
          why: "PR #437 built the launch descriptor but never invoked it. Nothing delivered the daemon bundle into a WSL distro, managed its lifecycle over wsl.exe, or routed a WSL-locus project away from the host daemon reaching across 9P.\n\nThis change closes all three, so the EISDIR, poll and threadpool-starvation failures disappear where the files actually live:\n\n- Delivers the bundle into the distro once per version.\n- Spawns, health-checks and stops the daemon inside the distro.\n- Runs one daemon per distro, routed by locus.\n\nThe runtime lands behind an injectable seam with unit tests. The live renderer wiring and the lancelot field proof are deferred.",
          artifacts: [
            { label: "proposal.md", sectionId: "proposal" },
            { label: "design.md · 5 decisions", sectionId: "design" },
            { label: "specs · 5 requirements", sectionId: "req-delivery" },
            { label: "tasks.md", sectionId: "tasks" },
          ],
        },
        {
          kind: "capability-grid",
          capabilities: [
            {
              slug: "wsl-daemon-runtime",
              state: "added",
              requirements: 5,
              scenarios: 9,
              sectionId: "req-delivery",
            },
          ],
        },
        {
          kind: "callout",
          tone: "info",
          text: "No existing spec owns daemon spawn or lifecycle for WSL, and the host supervisor is code without a dedicated spec, so the WSL runtime lands alongside it without changing host behavior.",
        },
      ],
    },
    {
      id: "proposal",
      title: "Proposal",
      source: "proposal.md",
      gist: "PR #437 built the launch descriptor but never invoked it. Deliver, spawn/health/stop, and route by locus so WSL projects leave 9P.",
      elements: [
        {
          kind: "prose",
          text: "The WSL-daemon spike proved the architecture end to end, and PR #437 landed the load-bearing piece. It resolved the distro's Node and built the byte-verbatim `wsl.exe … -e <node> <bundle> serve` descriptor. Nothing invoked that descriptor yet. Until this change lands, a WSL project still runs on the Windows daemon over `\\\\wsl.localhost\\…`. It pays the 9P tax that the spike showed vanishes once the daemon runs inside the distro.",
        },
        {
          kind: "what-changes",
          rows: [
            {
              tag: "bundle-delivery",
              text: "Copy the daemon bundle into the distro's native fs once per version and run it from there, never back over the 9P view. Skip the copy when the versioned copy already exists.",
            },
            {
              tag: "lifecycle",
              text: "- Spawn via wsl.exe using the distro's Node.\n- Poll health on the port's /healthz over localhost, not the claim file across 9P.\n- Restart on version skew.\n- Stop by pid inside the distro.",
            },
            {
              tag: "routing",
              text: "The shell runs the host daemon plus one daemon per WSL distro, and routes each project to the daemon for its execution locus. Boundary paths cross via toDistroPath / toWindowsView.",
            },
            {
              tag: "secret-store",
              text: "A WSL daemon's GitHub credential lives in its own distro-native data dir, so egress and the token both sit natively in the distro.",
            },
          ],
          impact:
            "- packages/core: pure path/argv helpers and delivery.\n- packages/server: spawn/health/stop and the orchestrator.\n- apps/desktop: the locus-selected routing seam.\n\nNo consent gate, no read-only posture. The daemon writes and pushes exactly as the host daemon does (Rule Zero). Depends on #437.\n\nDeferred: wiring the seam into the renderer (index.ts still dials one host port) and the lancelot field proof.",
        },
      ],
    },
    {
      id: "design",
      title: "Design",
      source: "design.md",
      gist: "Copy-once-per-version into native fs; port-first health; reuse the supervisor shape with a locus-selected launch; one daemon per distro; the existing store pointed at the distro dir.",
      counts: "5 decisions",
      elements: [
        {
          kind: "decision",
          statement: "Delivery is copy-once-per-version into the distro's native fs",
          why: "Running the bundle over 9P would reintroduce exactly the tax this change exists to delete. A versioned dir (~/.rennet/server/<version>/) mirrors ~/.vscode-server, and lets old daemons keep their bundle across a version bump.",
          inferred: false,
          alternatives: ["Run the bundle from its \\\\wsl.localhost path (rejected, defeats the architecture)"],
          evidence: [{ path: "packages/core/src/wsl-bundle.ts", line: 90 }],
        },
        {
          kind: "decision",
          statement: "Health is port-first, not claim-file-first",
          why: "Reading a WSL daemon's daemon.json from Windows means 9P. The shell instead learns the port once, then checks http://localhost:<port>/healthz, the 9P-free path the spike used. The claim file stays the daemon's own liveness record inside the distro.",
          inferred: false,
          alternatives: ["Read daemon.json across 9P on every health tick"],
          evidence: [{ path: "packages/server/src/wsl-daemon.ts", line: 119 }],
        },
        {
          kind: "decision",
          statement: "Reuse ensureDaemon's shape with a locus-selected launch",
          why: "The supervisor's verify/restart/stop logic carries over unchanged. Only the launch (execPath becomes wsl.exe, args from buildWslDaemonLaunch) and the health transport differ. The desktop main stays thin, and the composed logic lives in an injectable-effect orchestrator.",
          inferred: false,
          alternatives: ["Fork a separate WSL supervisor duplicating the host lifecycle"],
          evidence: [{ path: "packages/server/src/wsl-supervisor.ts", line: 83 }],
        },
        {
          kind: "decision",
          statement: "One daemon per distro, routed by locus; the shell holds a map",
          why: "detectLocus already yields {kind:'wsl',distro}. The shell keeps a distro → in-flight-ensure map and spawns a distro's daemon lazily, on the first project for it, so a distro nobody opens never starts a daemon. Concurrent opens on the same distro fold into one ensure.",
          inferred: false,
          alternatives: ["Eagerly spawn a daemon for every installed distro at startup"],
          evidence: [{ path: "apps/desktop/src/main/daemon-supervisor.ts", line: 309 }],
        },
        {
          kind: "decision",
          statement: "The WSL secret store is the existing store pointed at the distro data dir",
          why: "createGitHubTokenStore is unchanged. It writes under the distro-native --data-dir the WSL daemon owns, so egress and token both stay native at no extra cost. No new store.",
          inferred: false,
          alternatives: ["A dedicated cross-OS credential store reaching from Windows"],
          evidence: [
            { path: "packages/core/src/wsl-bundle.ts", line: 42 },
            { path: "packages/server/src/wsl-supervisor.ts", line: 117 },
          ],
        },
      ],
    },
    {
      id: "req-delivery",
      title: "wsl-daemon-runtime: Bundle Delivery",
      badge: "added",
      source: "specs/wsl-daemon-runtime/spec.md",
      gist: "Deliver the versioned bundle into the distro's native fs once, run it from there, never over 9P.",
      counts: "1 requirement · covered",
      elements: [
        {
          kind: "requirement",
          name: "The daemon bundle is delivered into the distro once per version",
          delta: "added",
          text: "For a WSL-locus project, the shell SHALL ensure the daemon bundle exists in the distro's native filesystem at a versioned path (`~/.rennet/server/<version>/rennet.cjs`) before spawning, copying it there when absent and skipping the copy when the versioned copy already exists. The daemon SHALL be run from that distro-native path, never from the `\\\\wsl.localhost\\…` view.",
          status: "covered",
          coverage: { hunks: 2, tests: 10 },
          refs: ["wsl-bundle.test.ts"],
          scenarios: [
            "WHEN a WSL-locus project is opened and no versioned bundle exists in the distro THEN the shell copies the bundle to that path and spawns the daemon from it.",
            "WHEN the versioned bundle already exists in the distro THEN the shell does not re-copy it and spawns the daemon from the existing path.",
          ],
        },
        {
          kind: "code-ref",
          path: "packages/core/src/wsl-bundle.ts",
          startLine: 90,
          endLine: 143,
          highlightLines: [105, 106, 131, 138],
        },
        {
          kind: "annotation",
          anchor: { path: "packages/core/src/wsl-bundle.ts", line: 131 },
          text: "The delivered path drifted from the spec's literal `rennet.cjs`. The current tree copies the whole server directory (`cp -r <dir>/.`) because the bundle is code-split (`index.cjs` plus its runtime and lazy sdk chunks), then verifies the entry landed. The 'copy once, run from native fs' obligation holds; the filename does not.",
        },
      ],
    },
    {
      id: "req-spawn",
      title: "wsl-daemon-runtime: Spawn via wsl.exe",
      badge: "added",
      source: "specs/wsl-daemon-runtime/spec.md",
      gist: "Resolve the distro's Node, spawn the byte-verbatim launch descriptor, surface a no-Node distro plainly.",
      counts: "1 requirement · covered",
      elements: [
        {
          kind: "requirement",
          name: "A WSL daemon is spawned via wsl.exe using the distro's Node",
          delta: "added",
          text: "The shell SHALL resolve the distro's Node binary and spawn the daemon with the byte-verbatim `wsl.exe … -e <node> <bundle> serve --data-dir <distro-data-dir>` descriptor, detached, with the daemon owning its own log in a distro-native data dir. When the distro has no usable Node, the shell SHALL surface that plainly (not a silent failure) so the user can install Node or Rennet can ship one.",
          status: "covered",
          coverage: { hunks: 3, tests: 9 },
          refs: ["wsl-daemon.test.ts", "wsl-supervisor.test.ts", "wsl-shell.test.ts"],
          scenarios: [
            "WHEN the distro has Node and the bundle is delivered THEN the daemon starts, binds a loopback port, publishes its daemon.json, and answers /healthz.",
            "WHEN node resolution finds no usable Node THEN the shell reports the missing-Node condition for that distro and does not hang.",
          ],
        },
        {
          kind: "code-ref",
          path: "packages/server/src/wsl-daemon.ts",
          startLine: 74,
          endLine: 83,
          highlightLines: [76, 79, 82],
        },
        {
          kind: "annotation",
          anchor: { path: "packages/server/src/wsl-daemon.ts", line: 76 },
          text: "The spawn diverged from the spec's stated 'detached'. What ships is a windowsHide-managed, unref'd child with `stdio: 'ignore'`. WSL reaps a distro's processes when the launcher exits, so the daemon already lasts exactly as long as the app, and `detached` only brought back a flashing console window (a Node bug where windowsHide is ignored under detached). The obligation is still met, and the daemon owns its own log, with no host-side log fd.",
        },
        {
          kind: "code-ref",
          path: "packages/core/src/wsl-shell.ts",
          startLine: 18,
          endLine: 38,
          highlightLines: [23, 31],
        },
        {
          kind: "annotation",
          anchor: { path: "packages/core/src/wsl-shell.ts", line: 15 },
          text: "The shared shell-output parser now preserves newlines through control stripping before splitting, so a warning line can no longer collapse a $HOME/Node path. wsl-node.ts moved onto it, fixing a latent newline-collapse bug in the merged parser.",
        },
      ],
    },
    {
      id: "req-lifecycle",
      title: "wsl-daemon-runtime: Port-First Health and Lifecycle",
      badge: "added",
      source: "specs/wsl-daemon-runtime/spec.md",
      gist: "Health on the port over localhost; version-skew restart; stop by pid inside the distro.",
      counts: "1 requirement · covered",
      elements: [
        {
          kind: "requirement",
          name: "WSL daemon health is checked on the port, not across 9P",
          delta: "added",
          text: "The shell SHALL determine a WSL daemon's health by reaching its `/healthz` over `localhost` on the published port, not by reading its claim file across the 9P view. A version-skew healthy daemon (its version differs from the shell's) SHALL be restarted; a daemon SHALL be stopped by signalling its pid inside the distro.",
          status: "covered",
          coverage: { hunks: 2, tests: 16 },
          refs: ["wsl-daemon.test.ts", "wsl-supervisor.test.ts"],
          scenarios: [
            "WHEN the shell checks a WSL daemon THEN it probes http://localhost:<port>/healthz and treats an identity-matching 200 as healthy.",
            "WHEN a healthy WSL daemon reports a version different from the shell's THEN the shell stops it (by pid, inside the distro) and spawns the current bundle.",
          ],
        },
        {
          kind: "code-ref",
          path: "packages/server/src/wsl-daemon.ts",
          startLine: 119,
          endLine: 137,
          highlightLines: [125, 128, 132],
        },
        {
          kind: "code-ref",
          path: "packages/server/src/wsl-supervisor.ts",
          startLine: 119,
          endLine: 145,
          highlightLines: [125, 126, 140],
        },
        {
          kind: "annotation",
          anchor: { path: "packages/server/src/wsl-supervisor.ts", line: 140 },
          text: "The version-skew restart stops the old daemon by pid, waits (bounded) for its identity to disappear before spawning, then re-confirms the fresh identity is the shell's version. This guards the stale-claim race that would otherwise hand back the old daemon.",
        },
      ],
    },
    {
      id: "req-routing",
      title: "wsl-daemon-runtime: Locus Routing",
      badge: "added",
      startFolded: true,
      source: "specs/wsl-daemon-runtime/spec.md",
      gist: "The routing seam is built and tested; the production wire into the renderer is deferred.",
      counts: "1 requirement · partial",
      elements: [
        {
          kind: "callout",
          tone: "warn",
          text: "The routing logic exists and is tested behind the ensureDaemonForProject seam, but the live wire is deferred. apps/desktop/src/main/index.ts still connects the renderer to one host daemon port. This is the last production step, alongside the lancelot field proof.",
        },
        {
          kind: "requirement",
          name: "Projects route to the daemon for their execution locus",
          delta: "added",
          text: "The shell SHALL run the host daemon plus one daemon per WSL distro in use, and route each project's commands to the daemon for that project's execution locus. Host-locus behavior SHALL be unchanged. Paths crossing the boundary SHALL be translated with the existing `toDistroPath` / `toWindowsView` helpers.",
          status: "partial",
          coverage: { hunks: 1, tests: 7 },
          refs: ["daemon-supervisor.test.ts"],
          scenarios: [
            "WHEN a project whose locus is wsl (distro D) issues a command THEN the command is served by distro D's daemon over its loopback port, and repo paths are distro-native. The seam resolves the port; the renderer bridge is not yet wired to dial it.",
            "WHEN a host-locus project issues a command THEN it is served by the host daemon exactly as before — a Windows drive path and a POSIX host path both stay on today's ensureDaemon path (regression-guarded).",
          ],
        },
        {
          kind: "code-ref",
          path: "apps/desktop/src/main/daemon-supervisor.ts",
          startLine: 309,
          endLine: 335,
          highlightLines: [321, 322, 326, 328],
        },
        {
          kind: "code-ref",
          path: "apps/desktop/src/main/daemon-supervisor.ts",
          startLine: 237,
          endLine: 260,
          highlightLines: [244, 245, 250],
        },
      ],
    },
    {
      id: "req-secret",
      title: "wsl-daemon-runtime: Distro-Native Credential Store",
      badge: "added",
      startFolded: true,
      source: "specs/wsl-daemon-runtime/spec.md",
      gist: "The WSL daemon's --data-dir is distro-native, so its token store lives inside the distro, never host-side or on 9P.",
      counts: "1 requirement · covered",
      elements: [
        {
          kind: "requirement",
          name: "A WSL daemon's credential store is distro-native",
          delta: "added",
          text: "A WSL daemon's GitHub credential SHALL live in its own distro-native data dir, so GitHub egress and the stored token both sit inside the distro. The host daemon's credential store SHALL be unaffected.",
          status: "covered",
          coverage: { hunks: 1, tests: 2 },
          refs: ["wsl-supervisor.test.ts"],
          scenarios: [
            "WHEN a WSL daemon stores or refreshes a GitHub credential THEN the credential file is written under the distro-native data dir (~/.local/share/rennet), not the host data dir or a 9P path.",
          ],
        },
        {
          kind: "code-ref",
          path: "packages/core/src/wsl-bundle.ts",
          startLine: 42,
          endLine: 44,
        },
        {
          kind: "annotation",
          anchor: { path: "packages/server/src/wsl-supervisor.ts", line: 117 },
          text: "wslDaemonDataDir(distroHome) feeds the launch descriptor's --data-dir, so the daemon's own createGitHubTokenStore writes github-token inside the distro. The Group-4 test asserts the argument is distro-native and carries no wsl.localhost / wsl$ 9P marker.",
        },
      ],
    },
    {
      id: "tasks",
      title: "Tasks",
      source: "tasks.md",
      gist: "13 of 15 done. The two open tasks are the full-gate rerun and the deferred lancelot field proof.",
      elements: [
        {
          kind: "task-progress",
          source: "tasks.md",
          groups: [
            { label: "1 · Distro paths and bundle delivery", done: 3, total: 3 },
            { label: "2 · WSL spawn + port-first health", done: 4, total: 4 },
            { label: "3 · Locus routing in the supervisor", done: 4, total: 4 },
            { label: "4 · Distro-native secret store", done: 2, total: 2 },
            { label: "5 · Gate", done: 0, total: 1 },
            { label: "6 · Field proof (lancelot, deferred)", done: 0, total: 1 },
          ],
        },
      ],
    },
  ],
}
