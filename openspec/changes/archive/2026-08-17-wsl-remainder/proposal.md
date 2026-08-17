# Windows/WSL remainder: codex-in-WSL, read-pipeline locus threading, live win32 verification

## Why

`add-windows-support` (#332) shipped the locus seam to a stated ceiling: WSL reviews degrade to a single Claude seat because the codex executor bakes host-side scratch and argv paths a distro codex cannot read, and parts of the read pipeline (knowledge enrichment among ~10 sites) still construct host-locus Claude harnesses, thinning context for WSL projects. Issue #334 owns the expansion to the full dual-harness, full-context WSL review — and its live win32 verification, now unblocked (lancelot-win sshd restored 2026-08-17).

## What Changes

- **Codex-in-WSL**: both codex spawn sites (the agentic turn transport and the utility executor) accept the project's locus and route through the existing `locusCommand` wrapper; scratch directories are created distro-side for a WSL locus; every argv path (`-C` cwd, `-o` output, `--output-schema`) is translated to the distro-native view; the canvasOps loopback URL resolves to an address the distro can actually reach (mirrored-networking localhost or the WSL-facing host address), with an honest turn failure — never a silent host fallback — when no route exists. Desktop composition threads the locus into the codex harness exactly as it does for Claude.
- **Read-pipeline locus threading**: every remaining host-defaulting Claude-harness site in desktop MAIN (canvas lens producers, flagged/noise lenses, spec-delta mapping, knowledge enrichment both proactive and orchestrator-resolved, symbol lookup, refine, draft-PR-body, delta digest, compose) resolves the review's locus through the existing `locusForRepo` pattern. The orchestrator's knowledge-port resolver gains a repo-root parameter so locus resolves per call instead of at wiring time.
- **Live win32 verification** on lancelot: GUI dev-run, packaged win32 ZIP boot, a full WSL review with write/push from a logged-in distro account, `;`-PATH `.cmd` shim resolution, and WSL-remote editor open at a line. Results recorded; the using-docs WSL ceiling text updated to the new truth.
- Docs: `using/guide/windows-and-wsl.md` current-ceiling section and `developing/concepts/harness-adapters.md` locus notes updated in the same change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wsl-execution-mode`: the deferred-scope carve-outs close — review-pipeline model turns SHALL execute inside the project's locus (not just capture/checkpoint/handoff), and the "Deferred Codex utility turn is not claimed" degradation is replaced by a real WSL codex seat.
- `codex-harness-adapter`: the composition root SHALL compose locus-aware invocations (distro-side scratch, distro-native argv paths, distro-reachable canvasOps URL) for WSL-locus projects, with honest failure when the distro cannot reach the loopback surface.

## Impact

- `packages/adapters/src/codex-turn-transport.ts`, `codex-exec.ts`, `codex-adapter.ts`, `canvas-ops-external.ts` — locus param, scratch/argv translation, reachable URL resolution.
- `packages/core/src/locus.ts` — reused as-is (`locusCommand`, `toDistroPath`); possible small helper for distro-side scratch.
- `apps/desktop/src/main/index.ts` (~10 harness sites), `live-review-backend.ts`/`orchestrator.ts` (knowledge-port resolver signature).
- `docs/src/content/docs/using/guide/windows-and-wsl.md`, `developing/concepts/harness-adapters.md`.
- No new dependency; no protocol change beyond the resolver signature (internal).
