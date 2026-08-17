# Tasks — wsl-remainder

## 1. Codex-in-WSL: locus-aware transport and executor

- [x] 1.1 Add optional `locus` to `createCodexTurnTransport` deps and route `realSpawn` through `locusCommand(locus, bin, args, cwd)` (verbatim argv), mirroring `checkpoint-store.ts`; host path byte-identical when locus absent/host.
- [x] 1.2 Same for `createCodexExecutor` (`codex-exec.ts`): locus param, `locusCommand`-wrapped spawn.
- [x] 1.3 Distro-side scratch: for a WSL locus mint the turn scratch dir inside the distro (`mktemp -d` via `locusCommand`), pass distro-native `-o`/`--output-schema` paths, translate `-C` cwd with `toDistroPath`, and read results back through `toWindowsView` UNC; hermetic tests cover host-unchanged and wsl-composed argv/paths (fake spawn, no real wsl.exe).
- [x] 1.4 Thread locus from desktop composition into the codex harness and utility executor (peer of `getClaudeHarness(locus, distroCwd)`), memoized per locus.

## 2. canvasOps reachability from the distro

- [x] 2.1 Add a distro-reachability resolution to `canvas-ops-external.ts` session establishment: probe shared-localhost first, else discover the WSL-facing host address from inside the distro and bind the listener to that address (never 0.0.0.0); hand the session the URL that passed the probe.
- [x] 2.2 When no route probe succeeds, settle the codex turn failed with a plain reason naming the unreachable canvas surface; assert no silent host-codex substitute runs. Hermetic tests fake the probe outcomes.

## 3. Read-pipeline locus threading

- [x] 3.1 Adopt `locusForRepo(<repoRoot>)` + distro cwd at every host-defaulting `getClaudeHarness()` site in `apps/desktop/src/main/index.ts` (canvas lenses 664, flagged 1135, spec-delta 1435, noise 1517, proactive knowledge 1718, symbol lookup 2044, refine 2108, draft PR body 2144, delta digest 2174, compose bundle) and the paired codex executor closures.
- [x] 3.2 Give `resolveKnowledgePort` a `repoRoot` parameter (orchestrator wiring at 1854, `live-review-backend.ts` type) so the orchestrator's knowledge port resolves locus per call.
- [x] 3.3 Add an owned check that no bare host-default harness construction remains in MAIN (grep-grade test that reddens on a new `getClaudeHarness()` with no locus argument).

## 4. Docs

- [x] 4.1 Rewrite the "Current ceiling" section of `using/guide/windows-and-wsl.md` to the new truth (dual-harness WSL, full-context reads); keep any still-unproven claim out until task 5 proves it.
- [x] 4.2 Update `developing/concepts/harness-adapters.md` locus notes ("Host locus only; WSL codex is a later seam" is no longer true) and the delivery-order page for #334.

## 5. Live win32 verification on lancelot

- [ ] 5.1 GUI dev-run on lancelot-win (native win32 dev session boots and renders). — NOT PROVEN: ssh session 0 cannot render a window; needs a human at the machine.
- [x] 5.2 Packaged win32 ZIP boot (unsigned ZIP from the maker starts and opens a project). — ZIP built (`Rennet-win32-x64-0.0.0.zip`, 147,659,563 bytes) and process-level boot proven over ssh (~68 MB working set, stable past 12 s). Residual: visible render + project open await a human double-click at the machine.
- [ ] 5.3 Full WSL review end to end: dual-harness (distro claude + distro codex), knowledge enrichment in-distro, write/push from the logged-in distro account. — Codex leg PROVEN live: gated `codex-wsl-live.real.test.ts` green on lancelot at 351fdcb (paired-node discovery, `wsl.exe -e` verbatim argv, distro-native scratch/`-C`/`-o`, UNC read-back, real completed turn; run also surfaced and fixed a real paired-runtime discovery bug). Full dual-harness review with enrichment and distro push not exercised live.
- [ ] 5.4 `;`-PATH `.cmd` shim resolution and WSL-remote editor open at a line. — Shim leg PROVEN: cmd.exe `/d /s /c` launcher green through the full native win32 gate (architecture/licenses targets). Editor open-at-line unproven.
- [x] 5.5 Record the pass/fail matrix as non-secret evidence in the PR; reconcile docs from 4.1 with what actually passed. — Matrix recorded in the PR body; docs hold pending tense for unproven items.

## 6. Gate

- [x] 6.1 Run `pnpm check` (full gate, positive control included); fix findings; verify clean; push and verify remote ref.
