## Context

See proposal.md for motivation. What shapes the approach:

- Every external effect in the adapters layer is already **injected** (`DiscoveryDeps`, `CodexExecEffects`, `EditorLaunchEffectsInput`, injected `git` runners). This is the load-bearing fact: Windows and WSL support is mostly a new implementation of existing effect interfaces, not a rewrite. Unit tests for Windows/WSL branches run on macOS CI by injecting fake effects, exactly as today.
- The POSIX assumptions are concentrated, not smeared: `harness-discovery.ts` (PATH split on `":"` at line 71, mac/Linux `knownDirectories`, `/bin/zsh -ilc` harvest, bare-name match `entries.includes(CLAUDE_BINARY)`), `open-in-editor.ts` (macOS bundles), forge config (darwin makers), and hardcoded `⌘` labels in `commands.ts`. Repo-relative path handling is already `/`-normalised by convention (`finding-verification-backend.ts:175` converts via `sep`; `openspec-change-reader.ts:42` and `repo-composition.ts:33` normalise `\` to `/`), and `escape-path.ts` already escapes `\` and `:`.
- The Claude adapter goes through `@anthropic-ai/claude-agent-sdk` with `pathToClaudeCodeExecutable` (`claude-adapter.ts:582`, `orchestrator-turn.ts:304`). The SDK spawns that executable from the app's own Node process. A Windows app cannot spawn a distro-resident ELF binary directly; WSL execution has to be interposed somewhere.
- `wsl.exe` gives Windows two interop primitives: run a command inside a distro (`wsl.exe -d <distro> -e <cmd>`, stdio piped), and the `\\wsl.localhost\<distro>\` (alias `\\wsl$`) UNC filesystem view. Windows-side git against UNC paths is slow and lies about permissions/line endings, which is why the shipped git seams run in-distro.

## Goals / Non-Goals

**Goals:**
- One `locus` seam for the repo-facing operations shipped in this slice, so native Windows, macOS, and WSL use the same code path with different effect implementations; deferred joins remain named rather than implied complete.
- Windows/WSL behaviour fully unit-testable from macOS via the existing injected-effects pattern.
- lancelot (Tailscale, one Windows-native hostname + one WSL hostname, discovered at implementation time via `tailscale status`) as the manual verification bed for both modes.

**Non-Goals:**
- Windows code signing, installer polish, auto-update (own later slice, mirroring #298 for macOS).
- Windows ARM64, WSL1, Cygwin/MSYS/Git-Bash environments.
- Any capability reduction or confirmation ceremony in WSL mode (Rule Zero).

## Decisions

**1. A `Locus` value threaded through effects, not a parallel WSL codebase.**
Introduce a small locus type (`{ kind: "host" } | { kind: "wsl", distro: string }`) carried by project context. The existing effect factories become locus-parameterised: the host implementation is today's code; the WSL implementation wraps shipped commands as `wsl.exe -d <distro> --cd <cwd> -e <program> <argv>` with distro-native cwd and paths. The shipped ceiling is capture/checkpoint/submodule-probe/submit-push/handoff-write plus the enumerated discovery/detail/snapshot/settings git seams; Codex and remaining review-pipeline joins are deferred. Alternative considered: a full "remote execution" abstraction (SSH-style). Rejected: speculative generality; WSL interop is local stdio piping, and nothing else needs the abstraction today.

**2. Claude handoff in WSL spawns `wsl.exe` directly through the SDK.**
The installed SDK exposes `executableArgs`. For a WSL locus, `pathToClaudeCodeExecutable` is `wsl.exe` itself and the distro, cwd, `-e`, and distro Claude path are prepended as discrete executable arguments. The SDK then appends its own Claude argv and spawns without a shell. This removes the generated `.cmd`, `%*`, and cmd.exe quoting layers while preserving streaming stdio. Alternative considered: a generated native launcher or a Rennet helper inside the distro. Neither is needed while the SDK provides the direct executable-argument seam.

**3. Discovery per locus, reusing the same algorithm.**
`discoverClaude`/`discoverCodex` already take injected deps. Windows host deps: env PATH split on `path.delimiter`, no login-shell harvest, candidate matching against `PATHEXT` variants, curated dirs (`%LOCALAPPDATA%\Programs`, npm/bun/scoop/volta per-user dirs). WSL deps: harvest by `wsl.exe -d <distro> -- $SHELL -ilc 'printf %s "$PATH"'` (the distro is Linux, so today's POSIX logic applies verbatim inside it), list/probe by executing inside the distro. The chosen candidate records its locus so a host binary can never satisfy a WSL project (spec requirement).

**4. Path translation is a pure function pair, used only at the Windows/distro boundary.**
`toDistroPath`/`toWindowsView` between `/home/u/repo/...` and `\\wsl.localhost\<distro>\home\u\repo\...`. In-distro processes always get distro-native paths; Windows-side reads (renderer file previews, chokidar watching) use the UNC view. Repo-relative paths stay `/`-normalised everywhere, unchanged. Alternative: `wslpath` invocation per translation. Rejected: a process spawn per path; the mapping for `\\wsl.localhost` is mechanical. Keep `wslpath` as fallback for exotic mount configs if the audit finds any.

**5. Keyboard labels from one platform-aware formatter.**
`commands.ts` keybinding strings become data (`mod+K`) rendered per platform (`⌘K` / `Ctrl+K`). Handlers already accept `metaKey || ctrlKey` (`app.tsx:551`, `workspace.tsx:898`), so behaviour needs no change.

**6. Packaging: add MakerZIP for win32 now, nothing else.**
`forge.config.cjs` gains `new MakerZIP({}, ["win32"])`; the fuses hook already branches on `win32`. Icon gets a `.ico` export alongside the macOS set. Squirrel/WiX/signing deferred to the Windows-release slice.

**7. File watching in WSL mode: chokidar polling on the UNC view.**
Inotify events do not propagate reliably across the 9P/UNC boundary, so the repo watcher uses polling for WSL-locus projects. Alternative: an in-distro watcher process streaming events out. Rejected as a second deployable for a first slice; revisit if polling latency hurts.

## Risks / Trade-offs

- [SDK spawn risk: Windows Node must preserve the direct `wsl.exe` executable-argument chain] → unit tests capture the SDK's exact spawn effect including complex argv; a live Windows-side Node turn remains on the PR's manual list because the earlier lancelot proof invoked the retired batch launcher through `cmd.exe /c`.
- [UNC/9P filesystem semantics (case sensitivity, permissions, watching) differ from both NTFS and ext4] → Windows-side access is confined to reads and polling watch; everything that must be correct (git, harnesses, tests) runs in-distro by spec.
- [Windows spawning of `.cmd` shims requires shell-style launch (`cmd /c`), which has arg-quoting hazards] → Prefer resolving through a shim to the underlying `.exe`/node script where possible; where `.cmd` is unavoidable, use execa's documented Windows handling and cover quoting with unit tests (paths with spaces).
- [Polling watcher latency and CPU on large WSL repos] → Bounded by existing watcher ignore rules; acceptable for slice 1, noted for the release slice.
- [CI cannot execute real Windows/WSL paths] → All new branches live behind injected effects with unit tests; real-machine verification is a mandatory lancelot task in both modes, not a CI job, for this slice.

## Open Questions

- Which WSL-remote editor launch shape (`code --remote wsl+<distro> -g <path>:<line>`) works across Cursor/VSCodium variants — resolved during the editor task on lancelot; the spec only requires the capable-editor path plus UNC fallback.
- Whether `wsl.exe` stdout encoding (UTF-16 in some invocation modes) needs normalisation on the interop boundary — settled empirically in the Phase 1 spike.

## Spike findings (lancelot, 2026-08-16)

Verified on lancelot over Tailscale. `ssh rai@lancelot` lands **inside** the WSL2 distro (kernel `6.6.114.1-microsoft-standard-WSL2`); the native Windows side was driven from there via `/mnt/c/Windows/System32/wsl.exe` and `powershell.exe` (both are genuine native-Windows child processes, exactly what Electron's Node will spawn). `ssh rai@lancelot-win` (Windows-native sshd) was not needed and not chased — WSL interop gives native-Windows execution directly.

**Distro:** exactly one, `Ubuntu`, WSL **version 2**, STATE `Running`. In-distro toolchain all present: `git` 2.53.0 (`/home/linuxbrew/.linuxbrew/bin/git`), `gh` 2.89.0, `node` v24.16.0 (asdf shim), `claude` 2.1.193 (`/home/rai/.local/bin/claude`), `codex` 0.133.0 (asdf shim). **No Windows-side `node` or `claude`** on PATH — confirms the shim-into-distro approach is the only path, not a fallback.

**`wsl.exe --list --verbose` encoding:** output is **UTF-16LE with CRLF** line endings (`* Ubuntu Running 2`, each char NUL-interleaved, lines end `0d 00 0a 00`). Parse it by decoding UTF-16LE then stripping CR. This is the *only* invocation observed to emit UTF-16 — see below.

### 1.1 Interop primitives — ALL PASS

- **stdout of normal commands is clean UTF-8, LF-only** — *not* UTF-16. Proven byte-exact: `-e cat` of a 2-line file returned `...distro\nline two\n` (`0a`, no `0d`, no BOM); `git status` returned `## main\n`. The UTF-16 is confined to `--list`-family status output.
- **Exit codes propagate exactly:** git-in-repo → 0, git-in-non-repo → 128, `sh -c 'exit 42'` → 42.
- **stderr separates cleanly** from stdout.
- **stdin pipes through byte-exact** — `printf 'X\\$Y\n' | wsl … -e cat` returned `58 5c 24 59 0a` (`X\$Y\n`, backslash *and* dollar intact). The stdin channel is a clean binary pipe, unlike argv (below).
- **UNC reads work** via both `\\wsl.localhost\Ubuntu\...` and the `\\wsl$\Ubuntu\...` alias. `Get-Content -Raw` from native PowerShell returned the distro file byte-exact with **LF preserved (no CRLF translation)**.
- **stdin coupling gotcha (harness-level, not product):** `wsl.exe` forwards its own stdin to the distro process. A `wsl.exe` call inside a script reading from a heredoc will *drain the rest of the script*. Give non-interactive `wsl.exe` spawns `stdin: 'ignore'` (or `</dev/null`) unless you intend to pipe. For the claude turn we *do* want stdin piped — that path is proven clean.

### Argv marshalling — THE load-bearing finding (use `-e`, never `--`)

`wsl.exe -d <distro> -- <argv…>` does **NOT** pass argv verbatim. It joins the args into a command line and runs them **through the distro's default login shell** (here zsh — an apostrophe arg produced `zsh:1: unmatched '`). Consequences with the `--` form, all reproduced:

- `$HOME`, `${PATH}`, `$E` were **shell-expanded** on the distro side (command-injection-grade).
- **backslashes stripped:** `C:\Users\rai` → `C:Usersrai`.
- apostrophes group and **merge adjacent args:** `it's` `don't` → one arg `its dont`.
- (spaces inside a quoted arg, UTF-8 unicode, and empty args did survive, but the failures above make `--` unusable for dynamic args.)

**`wsl.exe -d <distro> [--cd <dir>] -e <program> <argv…>` (alias `--exec`) passes argv byte-for-byte verbatim — no shell, no `$` expansion, no backslash stripping, no quote reparse.** Same inputs through `-e`: `$HOME`→`$HOME`, `C:\a\b`→`C:\a\b`, `it's`→`it's`. `-e` resolves bare program names via the distro PATH and honours `--cd`. **Design decisions 1 and 3 must specify the `-e`/`--exec` form for every process spawn** (git/gh/claude/codex). Reserve `--`/shell only for cases that genuinely need a login shell (e.g. the discovery PATH harvest `wsl … -e bash -lc 'printf %s "$PATH"'`, where the *payload* is a fixed literal, not user data). Windows-side shim arg-forwarding (`.cmd %*` / PowerShell `$args`) has its own separate quoting hazard to cover in Phase 4/5; the wsl boundary itself is clean via `-e`.

### 1.2 Claude SDK shim — PRIMITIVE PROVEN (transport), turn blocked only on distro auth

Native-Windows → `wsl.exe -d Ubuntu --cd <repo> -e /home/rai/.local/bin/claude -p --output-format stream-json --verbose --input-format text`, prompt via stdin:

- **21606 bytes of clean stream-json on stdout.** First bytes `7b 22 74 79 70 65` (`{"type`) — **no FF FE BOM, no UTF-16 NUL-interleave, LF (`0a`) framing, no CRLF.**
- **5 lines, every one valid JSON** (`json.loads` each): `system/hook_started` → `system/hook_response` → `system/init` → auth-error event → `result`. The final line is a complete SDK result envelope: `{"type":"result","subtype":"success","is_error":true,…,"result":"Not logged in · Please run /login","total_cost_usd":0,…}`. The SDK's stream-json parser would consume this exactly as a local run.
- `claude --version` through `-e` → `2.1.193 (Claude Code)`, RC 0 (SDK version-probe path works through the shim).
- **Only failure: the distro account is logged out.** `~/.claude/.credentials.json` exists but is stale; the turn returns `error: authentication_failed` / `"Not logged in · Please run /login"` and `terminal_reason: completed`. This is an environment/auth state on lancelot, **not** a shim defect — `/login` was not run because it would mutate lancelot's `~/.claude` (out of scope). The full event round-trip (init through result envelope) completed cleanly, which is what proves the primitive.

**Historical spike verdict:** stdio transport through `wsl.exe -e` is sound, but the batch launcher itself was not proven because the spike invoked it through `cmd.exe /c`. Production now uses the SDK's direct `wsl.exe` plus `executableArgs` path described in decision 2; a live Windows-side Node proof remains manual.

**Phase 2+ may proceed on the current design**, with one binding amendment: every locus process spawn uses `wsl.exe … -e <argv>`, never `-- <argv>`.

*(Scratch left on lancelot under `/tmp/spike*.sh`, `/tmp/argdump.sh`, `/tmp/argtest*.sh`, `/tmp/claudetest.sh`, `/tmp/streamtest.sh`, `/tmp/spikerepo/`, `/tmp/so.bin`, `/tmp/se.txt` — read-only probes plus a throwaway git repo; nothing outside `/tmp` touched, nothing installed.)*

## Phase 6 verification findings (lancelot, 2026-08-16)

Headless verification of the implementation's actual generated commands, driven from
inside the WSL2 distro via native-Windows interop (`/mnt/c/Windows/System32/wsl.exe`,
`cmd.exe`, `powershell.exe`). All passed except where noted; nothing outside `/tmp`
touched, nothing installed.

- **git-in-distro (capture/checkpoint/submit):** `wsl.exe -d Ubuntu --cd <repo> -e git rev-parse --show-toplevel` returned the repo path, rc 0. The checkpoint `GIT_INDEX_FILE` cross-boundary form `... -e env GIT_INDEX_FILE=/tmp/x.index git add -A` then `git write-tree` returned a real tree OID, rc 0 — confirms the `env`-prefix design for the WSL checkpoint index.
- **Discovery:** PATH harvest `-e bash -lc 'printf %s "$PATH"'` returns the real distro PATH (`/home/rai/.local/bin`, ...). `listDir` via the `\\wsl.localhost\Ubuntu\...` UNC view from native PowerShell lists the distro `claude`. Both clean.
- **wslpath / paths:** `-e wslpath -u` translates both a `C:\...` path (to `/mnt/c/...`) and a `\\wsl.localhost\Ubuntu\home\rai\repo` UNC path (to `/home/rai/repo`), rc 0.
- **Claude SDK transport — corrected after review.** The `.cmd` launcher is retired because the SDK spawns without `shell:true`, so Windows cannot execute a batch file through `pathToClaudeCodeExecutable`; the earlier lancelot proof used `cmd.exe /c` and therefore did not prove production. The installed SDK's `executableArgs` seam now points `pathToClaudeCodeExecutable` directly at `wsl.exe` and prepends `-d <distro> --cd <distro-cwd> -e <distro-claude>` as discrete argv. Hermetic tests capture the SDK spawn effect byte-for-byte for spaces, quotes, `%`, `$`, `&`, JSON, and Unicode. A live Windows-side Node streamed turn through this exact direct spawn remains manual.
- **Bare-name resolution via `-e`:** `-e <prog>` resolves `prog` against the distro's NON-login PATH. `git` is reliably there (`/usr/bin/git`), so `execaGitFor` bare-`git` works. `gh` (linuxbrew-only) is NOT on that PATH — `-e gh` fails `execvpe(gh)`. This only affects the deferred gh-in-distro path (the submit's git push resolves fine; the REST token stays host-side), and reinforces that a WSL gh probe must use the DISCOVERED ABSOLUTE path, not the bare name.

**Remaining, genuinely un-runnable here (no Windows-side node/GUI):** a live win32 GUI dev-run and packaged-ZIP boot; the SDK's direct `wsl.exe` + `executableArgs` chain from Windows Node; a logged-in WSL handoff write/push; and live `.cmd` editor/WSL-remote line-open checks. Codex-in-WSL and remaining review-pipeline locus joins are deferred scope, not represented as manual checks that would complete this slice.
