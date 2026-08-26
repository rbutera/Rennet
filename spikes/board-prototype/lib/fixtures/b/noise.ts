import type { LensBoard } from "@/lib/lens-data"

/**
 * change-B noise fixture (PR #439, drafted via packages/lens-instructions,
 * unslop-edited).
 */
export const noiseBoardB: LensBoard = {
  lens: "noise",
  title: "Noise · daemon-in-distro runtime (#439)",
  intro: "3 hunks set aside, nothing dropped. Every group reopens into the full diff.",
  skippedHunks: [
    {
      path: "apps/desktop/src/main/daemon-supervisor.ts",
      reason:
        "The ensureDaemonForProject seam: locus-selected routing (host path byte-identical, WSL path to the distro daemon), single-flight per distro with no stale port cache, and the bounded createWslRunner. The wiring the reviewer must weigh.",
    },
    {
      path: "apps/desktop/src/main/daemon-supervisor.test.ts",
      reason:
        "The routing behavior tests: host-locus stays on today's path, a Windows drive path is host-locus, WSL opens re-ensure per open, concurrent same-distro opens fold to one ensure, and the real runner maps exit codes without throwing. Signal.",
    },
    {
      path: "docs/developing/concepts/wsl-daemon.md",
      reason:
        "The Built-vs-remaining rewrite: what this change lands (delivery, lifecycle, routing, distro-native secret store) versus the deferred renderer wiring and the live lancelot field proof. The reading walk, another lane.",
    },
    {
      path: "openspec/changes/wsl-daemon-runtime/proposal.md",
      reason:
        "Normative change intent — run the daemon where the files are to delete the 9P/EISDIR bug class. Spec artifact.",
    },
    {
      path: "openspec/changes/wsl-daemon-runtime/design.md",
      reason:
        "The five decisions (copy-once delivery, port-first health, reuse ensureDaemon's shape, one daemon per distro routed by locus, distro-native secret store) and their rejected alternatives. Spec artifact.",
    },
    {
      path: "openspec/changes/wsl-daemon-runtime/specs/wsl-daemon-runtime/spec.md",
      reason:
        "The added requirements and scenarios for delivery, lifecycle, routing, and the distro-native token. Spec artifact and requirement coverage.",
    },
    {
      path: "openspec/changes/wsl-daemon-runtime/tasks.md",
      reason:
        "The change's task checklist, all boxes marked except the deferred lancelot field proof (Wave 6). Spec artifact.",
    },
    {
      path: "packages/core/src/wsl-bundle.ts",
      reason:
        "Copy-once-per-version bundle delivery into the distro's native fs, exit-code-checked so a failed copy throws rather than reporting delivered. The judgment the reviewer must weigh.",
    },
    {
      path: "packages/core/src/wsl-bundle.test.ts",
      reason:
        "The delivery test bodies: idempotent copy when the versioned path exists, a nonzero copy exit throwing, and the home/bundle probe argv. Signal.",
    },
    {
      path: "packages/core/src/wsl-shell.ts",
      reason:
        "The new shared control-safe, newline-correct shell-output parser (stripShellControl, shellLines) extracted for reuse. Signal — the parser this change centralizes.",
    },
    {
      path: "packages/core/src/wsl-shell.test.ts",
      reason:
        "The parser test bodies: CSI/control stripping and correct line splitting that the older inline regex collapsed. Signal.",
    },
    {
      path: "packages/core/src/wsl-node.ts",
      reason:
        "Not a clean extraction: it drops the inline CONTROL_RE for the shared shellLines/stripShellControl, fixing a latent newline-collapse parse bug in the same move. The behavior change is the point, not the moved lines. Signal.",
    },
    {
      path: "packages/server/src/wsl-daemon.ts",
      reason:
        "The lifecycle primitives: detached+unref spawn owning its async error, port-first health on localhost:<port>/healthz (not the claim file over 9P), and stop-by-pid that fails loud on a nonzero kill. The judgment the reviewer must weigh.",
    },
    {
      path: "packages/server/src/wsl-daemon.test.ts",
      reason:
        "The lifecycle test bodies: spawn detach, exact-200 + wsPort health match, stop-fails-loud, and the port read. Signal.",
    },
    {
      path: "packages/server/src/wsl-supervisor.ts",
      reason:
        "The ensureWslDaemon orchestrator: resolve home, short-circuit a healthy same-version daemon, resolve Node, deliver, launch, wait-healthy, and version-skew stop-then-respawn-and-confirm. Signal.",
    },
    {
      path: "packages/server/src/wsl-supervisor.test.ts",
      reason:
        "The orchestrator test bodies: reuse on a healthy same-version daemon, deliver+spawn otherwise, and version-skew restart that waits for the old daemon to exit. Signal.",
    },
  ],
  sections: [
    {
      id: "mechanical",
      title: "Mechanical & generated churn",
      gist: "The package barrels grow to re-export the new WSL modules, plus the generated scaffold stamp.",
      counts: "2 groups · 3 hunks · judged by rule",
      elements: [
        {
          kind: "prose",
          text: "This change is almost all new runtime, its tests, and its specification. What is left over:\n\n- Two barrels grow to expose the WSL modules the change adds.\n- A two-line scaffold stamp, written when the change directory was created.\n- No dependency added, so no lockfile churn.\n- No formatter-only reflow.",
        },
        {
          kind: "noise-group",
          label: "The core and server barrels gain the new WSL modules",
          judgedBy: "rule",
          reason:
            "Both hunks only re-export modules this change introduces. core/index.ts adds two `export *` lines for the new wsl-bundle and wsl-shell files. server/index.ts adds a named block re-exporting the new wsl-daemon and wsl-supervisor symbols. No statement changed; the public exports grew to match the new source.",
          hunks: [
            {
              path: "packages/core/src/index.ts",
              summary:
                "adds `export * from \"./wsl-bundle\"` and `export * from \"./wsl-shell\"` to the core barrel",
            },
            {
              path: "packages/server/src/index.ts",
              summary:
                "adds a named export block re-exporting the wsl-daemon and wsl-supervisor public symbols",
            },
          ],
        },
        {
          kind: "noise-group",
          label: "Generated openspec scaffold stamp",
          judgedBy: "rule",
          reason:
            "The openspec tool writes this two-line file when it creates a change directory: a schema tag and a creation date. No requirement text, no behavior. The substantive spec files sit alongside it in the same directory.",
          hunks: [
            {
              path: "openspec/changes/wsl-daemon-runtime/.openspec.yaml",
              summary: "new file: `schema: spec-driven` and a `created: 2026-08-20` stamp",
            },
          ],
        },
      ],
    },
  ],
}
