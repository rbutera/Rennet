## Why

Rennet today is developed and packaged exclusively for macOS (`forge.config.cjs` makers are `darwin`-only; `PACKAGING.md` opens with "Rennet ships as a macOS `.dmg`"), and the runtime code bakes in POSIX assumptions: harness discovery splits `PATH` on `":"` and probes mac/Linux directories, the login-shell harvest defaults to `/bin/zsh -ilc`, and binary lookup matches the bare name `claude`/`codex` (never `claude.cmd`/`.exe`). A Windows user cannot run Rennet at all — and a large class of Windows developers keep their projects and toolchains inside WSL, where the `claude` binary, `git`, `gh`, and the repo itself all live inside a Linux distro that the Windows Electron app cannot spawn into directly. Supporting Windows means supporting both shapes as first-class: native Windows, and Windows-app-driving-WSL.

## What Changes

- Rennet's desktop app runs on native Windows: harness discovery (`claude`, `codex`, `gh`) understands Windows `PATH` semantics (`;` delimiter, `PATHEXT`, `.cmd`/`.exe`/`.ps1` shims), Windows install locations, and probes without a POSIX login shell.
- A new **execution locus** concept: every repo-facing process (git, gh, claude, codex) and repo-facing filesystem access runs either on the host OS or inside a named WSL distro, chosen per project. WSL is a first-class mode, not a fallback: the app runs on Windows, the project, git, and harness binaries live in the distro, and Rennet drives them there (via `wsl.exe -d <distro>` execution and `\\wsl$\<distro>` UNC paths where read-only file access suffices).
- The Claude adapter's `pathToClaudeCodeExecutable` contract extends to the WSL locus, where the SDK cannot spawn a distro-resident binary from Windows Node directly.
- Editor open (`open-in-editor.ts`) resolves Windows editor installs, and in WSL mode opens VS Code-family editors with their WSL remote so `path:line` still lands.
- Command palette / shortcut *labels* become platform-aware (`⌘K` → `Ctrl+K` on Windows); the handlers already accept `metaKey || ctrlKey`.
- Path-separator audit: repo-relative paths stay `/`-normalized (the existing convention in `finding-verification-backend.ts:175`, `openspec-change-reader.ts:42`); absolute-path handling (`escape-path.ts`, `.rennet/` project keys, worktree discovery) is verified against drive letters and UNC paths.
- Dev-run packaging on Windows: `nx run rennet-desktop:start` and an unsigned ZIP package work on `win32`. The forge fuses hook already handles `win32`; a maker is added. **Windows release engineering (code signing, installer, auto-updater) is explicitly out of scope** — it is its own later slice, mirroring how issue #298 owns macOS releases.

Non-goals: no consent gates, no capability restrictions in WSL mode (Rule Zero — the WSL agent writes and pushes exactly like the native one), no Windows code signing, no ARM64-Windows validation.

## Capabilities

### New Capabilities

- `windows-native-runtime`: Rennet desktop running natively on Windows — Windows-aware binary/PATH semantics, no POSIX shell dependence, platform-aware shortcut labels, path handling that survives drive letters and backslashes, dev-run and unsigned packaging on win32.
- `wsl-execution-mode`: the per-project execution locus — selecting a WSL distro, running all repo-facing processes (git, gh, harnesses) inside it, translating paths between Windows and distro views, and surfacing locus health honestly in the UI.

### Modified Capabilities

- `harness-discovery`: discovery must find harness binaries on Windows (extension shims, Windows install locations, `;`-delimited PATH, no `$SHELL`) and inside a WSL distro (harvest the distro's PATH and probe by executing through `wsl.exe`), and report which locus each candidate belongs to.
- `packaged-editor-resolution`: editor resolution gains Windows install locations (`%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd` family) and, in WSL mode, launches the editor with its WSL remote target so line-targeted open still works on a distro-resident file.

## Impact

- **Code**: `packages/adapters/src/harness-discovery.ts` (PATH split `:` at line 71, `knownDirectories` mac/Linux list at 58–67, `/bin/zsh -ilc` harvest at 162–165, bare-name binary match), `codex-exec.ts` (`CODEX_EXEC_BIN = "codex"`, `~/.codex/sessions` usage reader), `claude-adapter.ts`/`claude-query.ts`/`orchestrator-turn.ts` (`pathToClaudeCodeExecutable`), bare `execa("git", …)` sites (`git-capture.ts`, `git-range-diff.ts`, `checkpoint-store.ts`), `execFileAsync("gh", …)` in `apps/desktop/src/main/index.ts:302,336`, `apps/desktop/src/main/open-in-editor.ts`, `packages/ui/src/command/commands.ts` (hardcoded `⌘` labels), `apps/desktop/forge.config.cjs` + `PACKAGING.md`.
- **New dependency surface**: none expected beyond what is installed; WSL interop is `wsl.exe` spawning, not a library. Any addition goes through the Dependency Standard.
- **Docs**: using-rennet install/setup pages and developing-rennet packaging pages gain Windows + WSL sections in the same change (docsite definition of done).
- **Testing**: verification on the `lancelot` machine over Tailscale in both modes (hostnames discovered at implementation time via `tailscale status`); unit tests keep every effect injected so Windows/WSL branches are testable from macOS CI.
