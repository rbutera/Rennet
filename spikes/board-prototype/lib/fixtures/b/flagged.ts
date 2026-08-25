/**
 * change-B flagged fixture (PR #439, dual-seat drafted via
 * packages/lens-instructions, adversarially verified, reconciled,
 * unslop-edited).
 */

import type { LensBoard } from "@/lib/lens-data"

export const flaggedBoardB: LensBoard = {
  lens: "flagged",
  title: "Flagged",
  intro:
    "Three findings. Two mediums land on the daemon identity lifecycle, and neither is pinned by a test that would catch it. One low sits on an error-honesty edge in bundle probing.",
  sections: [
    {
      id: "b-flagged-findings",
      title: "Findings",
      gist: "Two mediums on daemon identity (recycled port, kill race) and a low on probe-error honesty.",
      counts: "3 findings · 2 medium · 1 low",
      elements: [
        {
          kind: "finding",
          id: "f1",
          title: "A recycled port can route a distro's reviews to the wrong daemon",
          severity: "medium",
          agreement: { claude: false, codex: true },
          body: "daemon.json carries the claiming daemon's pid, but the reuse path throws it away. `readWslDaemonPort` returns only the port (packages/server/src/wsl-daemon.ts:102), and `probeWslDaemonHealth` accepts any identity-matching 200 whose reported `wsPort` equals the probed port (packages/server/src/wsl-daemon.ts:132). The live `/healthz` identity comes from whoever actually bound the port (packages/server/src/ws-listener.ts:379), so a port check cannot tell the claimant from a squatter.",
          details: [
            {
              heading: "The failure path in today's code",
              body: "A distro's daemon writes daemon.json and crashes with the file left behind; the freed loopback port is later bound by another same-version Rennet daemon. `ensureWslDaemon` reads the stale claim, probes the port, gets a 200 whose `wsPort` and version both match, and reuses it (packages/server/src/wsl-supervisor.ts:109), reporting the dead distro healthy and routing its reviews to the wrong daemon. The pid mismatch that would expose this is unobservable because the claim pid was discarded.",
            },
            {
              heading: "Untested, and the test fakes can't express it",
              body: "The port-claim check is pinned (packages/server/src/wsl-daemon.test.ts:150), but no test matches the claim pid against the health identity, and the supervisor fake models a single daemon keyed by port (packages/server/src/wsl-supervisor.test.ts:84), which structurally cannot express two daemons on one recycled port.",
            },
          ],
          fix: "Preserve the parsed daemon.json claim and require the live health identity to match its pid as well as its port, as the host supervisor does.",
          anchor: { path: "packages/server/src/wsl-daemon.ts", line: 102 },
        },
        {
          kind: "finding",
          id: "f2",
          title: "A daemon exiting between the health probe and `kill` aborts an otherwise safe restart",
          severity: "medium",
          agreement: { claude: false, codex: true },
          body: "The version-skew path probes the old daemon, then stops it by pid with a bare `await` (packages/server/src/wsl-supervisor.ts:125). If the daemon exits in that window, `kill` returns nonzero and `stopWslDaemon` throws (packages/server/src/wsl-daemon.ts:200). The throw propagates out of `ensureWslDaemon` and the replacement never spawns, even though the old daemon is already gone. The next attempt succeeds, so the cost is a spurious open-project failure on a benign race.",
          details: [
            {
              heading: "The throw is deliberate, the race is not covered",
              body: "A unit test locks in that a failed stop must not resolve as success (packages/server/src/wsl-daemon.test.ts:239). Right for a live daemon, wrong for one that just exited. The supervisor tests never exercise a nonzero `kill` (the fake always returns 0, packages/server/src/wsl-supervisor.test.ts:71), so the abort path is uncovered.",
            },
          ],
          fix: "After a failed signal, re-probe the old identity and continue the restart when it has disappeared; keep the failure only when that pid still answers health.",
          anchor: { path: "packages/server/src/wsl-supervisor.ts", line: 125 },
        },
        {
          kind: "finding",
          id: "f3",
          title:
            "A timed-out or unspawnable `test -f` probe is read as 'bundle absent', not as a failed probe",
          severity: "low",
          agreement: { claude: true, codex: false },
          body: "The desktop runner collapses a spawn failure and a per-call timeout to the same exit code 1 that `test -f` returns for a genuinely missing file. Bundle delivery gives exit 1 a positive meaning, 'absent, proceed to copy', so a probe that never ran against the distro is indistinguishable from a real missing bundle. On a wedged distro the delivery re-copies or fails blaming the wrong step, and the probe timeout never surfaces as itself.",
          details: [
            {
              heading: "The runner flattens three outcomes into code 1",
              body: "`createWslRunner` passes a numeric process exit code straight through, but a spawn error (ENOENT when `wsl.exe` is missing) carries a string `code` and a timeout kill carries `code: null` with a SIGTERM signal. Both miss the `typeof … === \"number\"` guard and fall into the `error ? 1 : 0` branch, resolving `{ code: 1 }`, the same value a real `test -f` returns for an absent file. See apps/desktop/src/main/daemon-supervisor.ts:250.",
            },
            {
              heading: "Delivery assigns exit 1 the meaning 'absent, proceed'",
              body: "`ensureWslBundleDelivered` treats the `test -f` probe's exit 0 as present, exactly exit 1 as absent (fall through to mkdir/wslpath/cp), and only any OTHER code as a failed probe. A spawn failure or timeout arrives as 1, so it routes into the copy path instead of the failed-probe path. See packages/core/src/wsl-bundle.ts:105.",
            },
            {
              heading: "Wrong outcome on a hung distro",
              body: "Given a distro that hangs past the runner's 15s timeout, the `test -f` probe resolves code 1; delivery proceeds to `mkdir -p`, which also times out to code 1 and throws `could not create <dir>`. The surfaced error blames directory creation, not an unresponsive distro. If the hang is transient the copy re-runs (`cp -r` overwrites). Either way the probe timeout is never reported as a timeout, the opposite of this module's stated 'fails loudly at this boundary' contract. See packages/core/src/wsl-bundle.ts:113.",
            },
          ],
          fix: "Have the runner distinguish a real process exit from a spawn failure or timeout, by resolving a sentinel (e.g. a negative code) or carrying `timedOut`/`signal` alongside `code`. Then have `ensureWslBundleDelivered` treat only a genuine `test` exit 1 as 'absent', surfacing anything else (including a non-run probe) as a delivery error.",
          anchor: { path: "packages/core/src/wsl-bundle.ts", line: 105 },
        },
        {
          kind: "code-ref",
          path: "apps/desktop/src/main/daemon-supervisor.ts",
          startLine: 249,
          endLine: 256,
          highlightLines: [250, 251, 252, 253, 254, 255],
        },
        {
          kind: "code-ref",
          path: "packages/core/src/wsl-bundle.ts",
          startLine: 104,
          endLine: 111,
          highlightLines: [105, 106, 107],
        },
      ],
    },
    {
      id: "b-flagged-cleared",
      title: "Checked and cleared",
      startFolded: true,
      gist: "Three bugs from earlier revisions, all fixed in the current tree, plus five concerns verified safe.",
      counts: "8 entries",
      elements: [
        {
          kind: "prose",
          text: "**Three bugs from earlier revisions, all fixed in the current tree.** (1) The bundle delivery once copied only the entry file, which could not start the code-split server. It now copies the whole server directory and verifies the entry after the copy (packages/core/src/wsl-bundle.ts:90). (2) The daemon launch once passed a positional the daemon entry rejects. The current launch descriptor carries none. (3) The spawn was once detached, which let WSL reap the daemon when the launcher exits. It is now a window-hidden managed child that stays unref'd (packages/server/src/wsl-daemon.ts:74).",
        },
        {
          kind: "prose",
          text: "**Host-path routing stays byte-identical.** For a host or Windows-drive path, `ensureDaemonForProject` returns `ensureHostDaemon(hostDataDir)` before any WSL effect runs, gated on `detectLocus`; no distro code executes for a host project (apps/desktop/src/main/daemon-supervisor.ts:269).",
        },
        {
          kind: "prose",
          text: "**The per-distro single-flight cannot leak a rejected ensure or cache a stale port.** The in-flight entry is deleted in a `finally` regardless of outcome (apps/desktop/src/main/daemon-supervisor.ts:278), and a concurrent open returns the same awaited promise, so a failed `ensureWslDaemon` rejects every joined caller and the next open re-ensures against the orchestrator's own healthy-daemon short-circuit.",
        },
        {
          kind: "prose",
          text: "**The version-skew restart waits for the old daemon to disappear before spawning.** `ensureWslDaemon` stops the old daemon by the pid its identity carries, then `waitForWslIdentityGone` polls until no healthy daemon reports that pid (packages/server/src/wsl-supervisor.ts:125), and a final version check rejects a restart that somehow handed back the old version (packages/server/src/wsl-supervisor.ts:140).",
        },
        {
          kind: "prose",
          text: "**Health cannot bind to the wrong process.** `probeWslDaemonHealth` accepts only an identity-matching 200 whose reported `wsPort` equals the port actually probed, so a stale port forward or a different process on that port is rejected rather than trusted (packages/server/src/wsl-daemon.ts:132).",
        },
        {
          kind: "prose",
          text: "**Stop signals the correct process namespace.** The daemon publishes its own in-distro `process.pid` in the `/healthz` identity (packages/server/src/ws-listener.ts:379), and `stopWslDaemon` runs `kill <pid>` inside the distro over `wsl.exe` (packages/server/src/wsl-daemon.ts:193), so the pid and the kill share the Linux namespace. No host-vs-distro pid confusion.",
        },
      ],
    },
  ],
}
