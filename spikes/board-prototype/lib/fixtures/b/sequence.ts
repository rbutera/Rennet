/**
 * change-B sequence fixture (PR #439, drafted via packages/lens-instructions,
 * unslop-edited).
 */

import type { LensBoard } from "@/lib/lens-data"

export const sequenceBoardB: LensBoard = {
  lens: "sequence",
  title: "Run the daemon inside the distro, off 9P",
  intro:
    "A Windows daemon reaching across \\\\wsl.localhost\\… pays the 9P tax on every file touch, and its watcher has no inotify, so it polls, storms, hits EISDIR, and starves the thread pool until GitHub connections time out. This change moves the daemon to where the files are, inside the distro. The order runs bottom-up, starting with the one operation everything else needs, lifting a value out of a noisy WSL shell. Getting the daemon's code into the distro's native filesystem comes next, then its lifecycle, decided on a loopback port instead of a claim file across 9P. Those pieces feed the orchestrator that composes them into one ensure-a-healthy-daemon call, and above that sits the layer that picks host or distro by where the project lives. Each earlier piece exists for a reason the next one makes plain.",
  skippedHunks: [
    { path: "openspec/changes/wsl-daemon-runtime/.openspec.yaml", reason: "generated scaffold stamp — noise" },
    { path: "openspec/changes/wsl-daemon-runtime/proposal.md", reason: "spec artifact — Design lens" },
    { path: "openspec/changes/wsl-daemon-runtime/design.md", reason: "spec artifact — Design lens" },
    {
      path: "openspec/changes/wsl-daemon-runtime/specs/wsl-daemon-runtime/spec.md",
      reason: "spec artifact — Design lens",
    },
    { path: "openspec/changes/wsl-daemon-runtime/tasks.md", reason: "spec artifact — Design lens" },
    {
      path: "docs/developing/concepts/wsl-daemon.md",
      reason: "prose flip of the 'Built vs remaining' list — documentation lane, not part of the reading order",
    },
    {
      path: "packages/core/src/index.ts",
      reason: "mechanical barrel re-export of wsl-bundle and wsl-shell; both modules are taught at earlier stops",
    },
    {
      path: "packages/server/src/index.ts",
      reason: "mechanical barrel re-export of the WSL daemon-runtime symbols; every symbol is taught at an earlier stop",
    },
  ],
  sections: [
    {
      id: "shell-parser",
      title: "Lift a value out of a noisy WSL shell",
      gist: "One shared parser strips shell control noise while keeping newlines, so every distro read that follows can trust a path lifted from multi-line output.",
      counts: "1 prose · 2 code · 1 annotation",
      elements: [
        {
          kind: "prose",
          text: "Everything downstream talks to the distro by running a command over wsl.exe and reading text back, so this text-reading step comes first. An interactive or login shell prepends prompt and cursor escapes and can interleave warning lines, so a value like a path has to be lifted out of noisy multi-line output. Three functions do the lifting:\n\n- stripShellControl removes ANSI escapes and control characters but keeps newlines, so a later split still sees line boundaries.\n- shellLines returns the cleaned, trimmed, non-empty lines in order.\n- lastAbsolutePathLine walks those lines from the end and returns the last one that looks like an absolute path.\n\nThis is the one operation the rest of the change builds on: read one command's output, get one trustworthy value.",
        },
        {
          kind: "code-ref",
          path: "packages/core/src/wsl-shell.ts",
          startLine: 12,
          endLine: 38,
          highlightLines: [15],
        },
        {
          kind: "annotation",
          anchor: { path: "packages/core/src/wsl-shell.ts", line: 15 },
          text: "The character class excludes \\n and \\r on purpose. A prior copy of this logic stripped newlines before splitting on them, collapsing \"/home/rai\\nwarning\" into the single invalid line \"/home/raiwarning\". Extracting the parser into one place fixed that class of bug everywhere it was copied.",
        },
        {
          kind: "prose",
          text: "The parser lives in a shared module rather than a local helper because of the second file. wsl-node.ts already resolved the distro's login shell and Node binary from probe output, and it carried its own control-stripping regex, the buggy one. It now imports shellLines and stripShellControl instead, so parseLoginShell and parseWslNodePath read through the corrected parser. That migration is the reason for the extraction: one correct parser with two callers cannot drift.",
        },
        {
          kind: "code-ref",
          path: "packages/core/src/wsl-node.ts",
          startLine: 19,
          endLine: 56,
          highlightLines: [20, 32, 51],
        },
        {
          kind: "code-ref",
          path: "packages/core/src/wsl-shell.test.ts",
          startLine: 6,
          endLine: 12,
          highlightLines: [8],
        },
      ],
    },
    {
      id: "bundle-delivery",
      title: "Deliver the bundle into the distro's native filesystem",
      gist: "The daemon code is copied once per version into ~/.rennet/server/<version>/ inside the distro, verified present, and never run over 9P.",
      counts: "1 prose · 2 code · 1 callout",
      elements: [
        {
          kind: "prose",
          text: "Now that a distro value can be read safely, the first real job is getting the daemon's code where it must run. The daemon runs from the distro's native filesystem, never over the 9P view, because executing the bundle across \\\\wsl.localhost\\… would bring back the exact tax this change deletes. So the paths are distro-native and absolute:\n\n- wslServerDir and wslServerBundlePath place the versioned bundle under ~/.rennet/server/<version>/.\n- wslDaemonDataDir names the data dir the daemon owns.\n- buildWslHomeProbe with parseWslHome resolves $HOME, so those paths sit in the real home and not a guess.",
        },
        {
          kind: "code-ref",
          path: "packages/core/src/wsl-bundle.ts",
          startLine: 21,
          endLine: 54,
          highlightLines: [27, 42, 47],
        },
        {
          kind: "prose",
          text: "ensureWslBundleDelivered is the copy-once-per-version step. It tests for the entry file: present means skip the copy and return, absent means make the directory, translate the host path with wslpath, then copy. The copy is recursive over the whole server directory, not a single file, because the bundle is code-split. The entry pulls in runtime and lazy chunks, so a single-file copy would crash the daemon at startup with a missing module. It checks every command's exit code, and after the copy a second test confirms the entry landed. A failure at any step throws a WslBundleDeliveryError rather than reporting delivered, so a later spawn can never run a bundle that was never placed.",
        },
        {
          kind: "code-ref",
          path: "packages/core/src/wsl-bundle.ts",
          startLine: 90,
          endLine: 143,
          highlightLines: [106, 131, 138],
        },
        {
          kind: "callout",
          tone: "warn",
          text: "Delivery fails loud by design. A silent failure, reporting success on a copy that did not happen, would push the error onto a spawn of a nonexistent bundle, far from its cause. So the versioned skip, the recursive directory copy, and the post-copy verify each guard a distinct way delivery can go wrong, and each raises WslBundleDeliveryError at the boundary. The recursive copy exists because an earlier single-file copy left the daemon unable to resolve its own split chunks.",
        },
      ],
    },
    {
      id: "port-first-lifecycle",
      title: "Decide lifecycle on the port, never across 9P",
      gist: "The daemon spawns as a managed hidden child, one claim-file read learns its port, health comes from localhost/healthz, and stopping signals the pid inside the distro.",
      counts: "1 prose · 3 code · 1 annotation",
      elements: [
        {
          kind: "prose",
          text: "With the bundle deliverable, the daemon's lifecycle runs over wsl.exe, and this is where avoiding 9P becomes concrete. Four functions carry it:\n\n- spawnWslDaemon launches the daemon as the shell's managed child with stdio ignored, so the daemon writes its own log inside the distro, and it owns the async spawn error so a failed launch logs instead of crashing the host.\n- readWslDaemonPort performs the single 9P read this design permits, one cat of the claim file to learn the port. From then on the port decides health.\n- probeWslDaemonHealth reaches localhost/healthz and accepts only an exactly-200 whose identity claims the very port probed, so it rejects a stale forward or the wrong process.\n- stopWslDaemon signals the pid inside the distro and throws on a nonzero kill, so a failed stop is never mistaken for success.",
        },
        {
          kind: "code-ref",
          path: "packages/server/src/wsl-daemon.ts",
          startLine: 74,
          endLine: 83,
          highlightLines: [76],
        },
        {
          kind: "annotation",
          anchor: { path: "packages/server/src/wsl-daemon.ts", line: 76 },
          text: "The spawn is a managed child, not detached. A WSL distro reaps its processes when the launching interop instance ends, so a detached daemon dies anyway; worse, Node's windowsHide is a no-op under detached, which flashed an empty wsl.exe console window. Dropping detached lets windowsHide hide the console the interop still needs, and unref lets the shell quit without waiting on the child.",
        },
        {
          kind: "code-ref",
          path: "packages/server/src/wsl-daemon.ts",
          startLine: 91,
          endLine: 137,
          highlightLines: [95, 128, 132],
        },
        {
          kind: "code-ref",
          path: "packages/server/src/wsl-daemon.ts",
          startLine: 193,
          endLine: 205,
          highlightLines: [200],
        },
        {
          kind: "code-ref",
          path: "packages/server/src/wsl-daemon.test.ts",
          startLine: 132,
          endLine: 166,
          highlightLines: [145, 150],
        },
      ],
    },
    {
      id: "ensure-orchestrator",
      title: "Compose the pieces into one ensure-a-healthy-daemon call",
      gist: "ensureWslDaemon resolves $HOME, returns a healthy same-version daemon as-is, and otherwise resolves Node, delivers, and launches; on version skew it stops the old daemon, waits for it to exit, respawns, and confirms the new version.",
      counts: "1 prose · 1 code · 1 callout",
      elements: [
        {
          kind: "prose",
          text: "Those three pieces come together here into one call. ensureWslDaemon takes a distro and a bounded runner and returns a healthy port. It resolves $HOME so every path is distro-native, then probes for an already-running daemon. A healthy daemon on the shell's own version comes back as-is, skipping Node resolution and delivery, both of which cost interactive wsl.exe execs. Otherwise it resolves the distro's Node, delivers the bundle, and builds the launch. For a healthy but version-skewed daemon it stops the pid the daemon's identity carries, then waits for that pid to disappear before spawning, so the fresh claim never races the dying one. After the wait-for-healthy it confirms the resolved identity is the version this shell ships, so a lost restart race can never re-serve the old version.",
        },
        {
          kind: "code-ref",
          path: "packages/server/src/wsl-supervisor.ts",
          startLine: 83,
          endLine: 146,
          highlightLines: [110, 119, 140],
        },
        {
          kind: "callout",
          tone: "info",
          text: "This orchestrator is why the layer above it needs no port cache. Because ensureWslDaemon short-circuits on a healthy same-version daemon, calling it again is cheap and self-healing. No stored port can go stale, and the skew branch handles a version bump in-band.",
        },
      ],
    },
    {
      id: "locus-seam",
      title: "Select host or distro by where the project lives",
      gist: "ensureDaemonForProject routes host-locus projects through today's path byte-identically and WSL-locus projects to ensureWslDaemon, folding concurrent opens on the same distro into one ensure.",
      counts: "1 prose · 2 code · 1 annotation",
      elements: [
        {
          kind: "prose",
          text: "This is the top of the change, the layer that plugs the whole runtime into the existing shell. ensureDaemonForProject resolves the port that serves a project, and detectLocus picks the branch:\n\n- A host-locus project takes exactly today's ensureDaemon path, unchanged.\n- A WSL-locus project routes to ensureWslDaemon for its distro.\n\nConcurrent opens on the same distro fold into one in-flight ensure through a distro-keyed map, and the entry drops once settled, so a later open re-ensures against the orchestrator's own short-circuit rather than trusting a cached port. The bounded runner the whole path depends on is createWslRunner, one execFile over wsl.exe with its own timeout, so a hung distro call can never stall the health-wait loop. A spawn failure resolves a nonzero code instead of throwing.",
        },
        {
          kind: "code-ref",
          path: "apps/desktop/src/main/daemon-supervisor.ts",
          startLine: 309,
          endLine: 335,
          highlightLines: [322, 326, 328],
        },
        {
          kind: "annotation",
          anchor: { path: "apps/desktop/src/main/daemon-supervisor.ts", line: 322 },
          text: "The host branch is a straight delegation to today's ensureDaemon. No WSL code runs for a host project, so host-locus behavior is byte-identical. A Windows drive path counts as host-locus too. This is the guarantee the regression tests pin.",
        },
        {
          kind: "code-ref",
          path: "apps/desktop/src/main/daemon-supervisor.ts",
          startLine: 237,
          endLine: 260,
          highlightLines: [244],
        },
      ],
    },
    {
      id: "guarantees-pinned",
      title: "The guarantees the tests make machine-checkable",
      gist: "Tests pin the promises that carry the change: copy once and verify, an exactly-200 health check with a matching identity, a skew restart that stops before it spawns, and host routing that folds concurrent opens yet stays byte-identical.",
      counts: "1 prose · 3 code",
      elements: [
        {
          kind: "prose",
          text: "Because every step takes its effects as injected arguments, each promise from an earlier step has a test that fails when the promise breaks.\n\n- A recorder pins delivery by asserting the exact command sequence: a no-op when the entry exists, and test, mkdir, wslpath, recursive copy, then a verify when absent. It throws on any unscripted call, so a dropped guard runs one command too many and fails.\n- The supervisor test proves a version-skew restart issues the stop strictly before the spawn, so the fresh daemon never races the dying one.\n- The routing tests prove a host project delegates untouched, a Windows drive path stays host, and two concurrent opens on one distro fold into a single ensure whose in-flight entry clears once settled.",
        },
        {
          kind: "code-ref",
          path: "packages/core/src/wsl-bundle.test.ts",
          startLine: 87,
          endLine: 115,
          highlightLines: [96, 102],
        },
        {
          kind: "code-ref",
          path: "packages/server/src/wsl-supervisor.test.ts",
          startLine: 172,
          endLine: 192,
          highlightLines: [172],
        },
        {
          kind: "code-ref",
          path: "apps/desktop/src/main/daemon-supervisor.test.ts",
          startLine: 379,
          endLine: 460,
          highlightLines: [379, 414, 440],
        },
      ],
    },
  ],
}
