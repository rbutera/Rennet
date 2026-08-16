## 1. Spike: prove the WSL interop seam (blocks everything WSL)

- [x] 1.1 On lancelot (hostnames via `tailscale status`; one Windows-native, one WSL), hand-verify the interop primitives: `wsl.exe -d <distro> -- git status` from Windows with piped stdio, stdout encoding checked, and `\\wsl.localhost\<distro>\` reads of a repo file — PASS (see design.md spike findings; distro `Ubuntu`; stdout clean UTF-8/LF; exit codes propagate; UNC reads clean; **argv must use `-e`/`--exec`, not `--`**)
- [x] 1.2 Spike the Claude SDK shim (design decision 2): point `pathToClaudeCodeExecutable` at a `wsl.exe`-based launcher for the distro's `claude` and complete one real streamed turn end to end; record findings (encoding, version probe, arg quoting) in design.md, and if the shim fails, stop and re-open design.md for the in-distro-helper fallback — PRIMITIVE PROVEN (clean stream-json transport end to end; turn blocked only on the distro account being logged out, an env state, not a shim defect); design **not** re-opened

## 2. Locus seam and path handling

- [x] 2.1 Add the `Locus` type (`packages/types`, re-exported from `core`), auto-detected via `detectLocus` from a `\\wsl$`/`\\wsl.localhost` project root; persisted override in `ProjectConfig.locus` + `effectiveLocus`; visible AND editable in project settings via `settings.setRepoLocus` (composition + adapter + IPC + renderer control), plain setting, no ceremony
- [x] 2.2 Implemented `toDistroPath`/`toWindowsView`/`locusCommand`/`detectLocus` as pure node-free functions with unit tests (spaces, non-ASCII, drive letters, both `\\wsl$` and `\\wsl.localhost` prefixes, round-trip) — `packages/core/src/locus.ts`
- [x] 2.3 Routed the injected `git` runners through the locus: `execaGitFor(locus)` (git-range-diff), `GitCaptureAdapter` (per-path resolver), `GitCheckpointStore` (+ the `GIT_INDEX_FILE` cross-boundary fix via an in-distro `env` prefix), `repoHasSubmodules`; composition threads `locusForRepo` into capture/checkpoint/submit-push. gh probe is locus-aware (`probeGhVersion(locus)`); the ambient line stays host (machine probe) and `gh auth token` publish-auth-in-distro is the one documented WSL partial (git push already runs in-locus). Uses `-e`/`--exec` per the spike amendment. Argv unit-tested (`locus.test.ts`, `checkpoint-store.locus.test.ts`)
- [x] 2.4 Audited absolute-path handling: `escape-path.ts` already folds `\`/`:` (added `C:\` + `\\wsl.localhost` regression tests); hardened `resolveWithinRoot` with a pure, separator-injectable `isWithinRoot` (case-insensitive drive letters on win32, UNC roots) + tests. `.rennet/` project keys go through `escapePath` (covered); worktree discovery reads the same escaped keys

## 3. Discovery on Windows and in the distro

- [ ] 3.1 Windows host `DiscoveryDeps`: split PATH on `path.delimiter`, skip the POSIX login-shell harvest, match `PATHEXT` shim variants of `claude`/`codex`, add curated Windows locations (npm/bun/scoop/volta per-user dirs, `%LOCALAPPDATA%\Programs`); unit tests with fake listings
- [ ] 3.2 WSL `DiscoveryDeps`: harvest the distro PATH and probe candidates by executing inside the distro (today's POSIX logic verbatim, executed via `wsl.exe`); stamp each candidate with its locus and enforce "host binary never satisfies a WSL project" in `discoverClaude`/`discoverCodex`
- [ ] 3.3 Locus-aware health surfaced in the UI: WSL/distro/binary-missing reasons reported as plain status per the wsl-execution-mode spec (no fallback to host execution, no gate)

## 4. Harness turns in the WSL locus

- [ ] 4.1 Productionise the spike shim from 1.2: generate the launcher for the project's distro + discovered in-distro `claude`, wire it through `claude-query.ts`/`orchestrator-turn.ts`, keep full acting capability (write, run tests, push) identical to native
- [ ] 4.2 Codex in WSL: run `codex exec` inside the distro; point the session-usage reader at the distro's `~/.codex/sessions` (UNC view read is fine here); keep the honest "unmeasured" behaviour when the log is unreachable
- [ ] 4.3 Repo watcher: polling mode for WSL-locus projects (design decision 7), unchanged native behaviour elsewhere

## 5. Windows-native app surface

- [ ] 5.1 Editor resolution on Windows: extend `open-in-editor.ts` with known Windows install locations for the `EDITOR_CLIS` family (per-user `%LOCALAPPDATA%` and system installs, `.cmd` launchers); WSL-locus opens go through the editor's WSL remote with UNC fallback per spec
- [ ] 5.2 Platform-aware keybinding labels: `commands.ts` keybindings as `mod+`-style data rendered `⌘`/`Ctrl` per platform; handlers unchanged
- [ ] 5.3 Forge config: add `MakerZIP` for `win32`, add a `.ico` icon export, confirm `HARNESS_SDK_FILE_EXCLUSIONS` already covers `.exe` vendored binaries (it does — keep the test)
- [ ] 5.4 Dev-run on Windows: fix whatever `nx run rennet-desktop:start` trips over on win32 (native deps, scripts); note zsh-only steps in PACKAGING.md as macOS-scoped

## 6. Verification on lancelot and docs

- [ ] 6.1 Native mode on lancelot (Windows hostname): dev-run the app, open a `C:\` project, complete a full review (capture → lenses → canvas), open-in-editor at a line, package the win32 ZIP and boot it
- [ ] 6.2 WSL mode on lancelot (WSL hostname): open a distro-resident project, verify discovery finds the in-distro `claude`/`codex`/`git`/`gh`, complete a full review, confirm the harness can write/run/push in the distro, editor opens via WSL remote at the right line
- [ ] 6.3 Cross-checks on lancelot: host-installed claude does not mask a missing distro claude (health message names the distro); stopped distro reports honest unavailable status
- [ ] 6.4 Docs in the same change: using-rennet install/setup gains Windows + WSL sections (locus concept, requirements per mode); PACKAGING.md gains the win32 ZIP build; run `pnpm check` green before push
- [ ] 6.5 File the Windows release-engineering follow-up (signing, installer, auto-update) as its own issue mirroring #298; explicitly out of this change
