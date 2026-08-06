---
categories:
  - research
tags:
  - electron
  - react-native
  - tooling
created: 2026-08-04
---

# Desktop and Mobile Stack 2026

Library and tooling recommendations for [[Code Review Harness App]]: an open-source-core macOS-first Electron review app with a portable `core/`, plus a paid Expo remote-control companion.

All versions and dates below were pulled from the npm registry and the GitHub API on **2026-08-04**. Anything I could not confirm is marked **unverified** rather than asserted.

## Correction to the brief: there is no mobile Electron

Electron is Chromium plus Node.js packaged for desktop operating systems. It has no iOS or Android runtime and never has. A "mobile Electron companion" is not buildable. The companion is Expo / React Native, which is what the pairing design in the parent note already assumed (expo-secure-store, expo-camera). Nothing else in the plan changes.

---

## 1. Desktop and Electron

### Must-use

| Library | Version | Why | Health (2026-08-04) |
|---|---|---|---|
| electron | 43.2.0 | Latest stable, released 2026-06-30, EOL 2027-01-05 | 8-week major cadence; latest 3 majors supported (41, 42, 43) |
| vite | 8.2.0 | Renderer and preload build | Released 2026-07-30, very active |
| @electron-forge/cli | 7.11.2 | Official scaffold, package, publish | Published 2026-05-20; repo pushed 2026-08-04, 7.1k stars |
| electron-builder | 26.15.3 | macOS signing, notarization, DMG, update feed | Published 2026-06-09; repo pushed 2026-08-04, 14.6k stars, 81 open issues |
| electron-updater | 6.8.9 | Auto-update client | Published 2026-06-05 |
| @electron/notarize | 3.1.1 | notarytool wrapper | Published 2025-10-31, stable surface |
| @electron/osx-sign | 2.6.0 | Hardened-runtime signing incl. nested binaries | Published 2026-07-17 |
| @electron/fuses | 2.1.3 | Flip off runAsNode, NODE_OPTIONS, inspect in prod | Published 2026-06-29 |
| electron-log | 5.4.4 | Local rotating logs, no network | Published 2026-05-14 |
| zod | 4.4.3 | Validation at the IPC boundary | Published 2026-05-04; repo very active |
| (write it) typed IPC | ~200 lines | See rationale | n/a |

### Rationale

**Version cadence is a budget item, not a footnote.** Electron ships a major every 8 weeks and supports only the latest three, so the app is out of support roughly 24 weeks after any given major. That is six forced upgrades a year, each of which rebuilds every native module. It is the single strongest argument for the no-native-deps constraint: with zero compiled modules an Electron bump is a version number, with two it is an afternoon.

**Scaffolding: Forge 7, not electron-vite.** electron-vite 5.0.0 was last published 2025-12-07 and its repo was last pushed 2026-04-17, so it has gone roughly eight months without a release while Forge is pushed daily. electron-vite's own FAQ points users at Forge and says its features get ported into `@electron-forge/plugin-vite`. Caveat, stated honestly: that Forge Vite plugin has carried an "experimental" label since Forge 7.5.0. If the plugin annoys you, the fallback is plain Vite 8 with three configs (main, preload, renderer) plus electron-builder for distribution, which is what several large apps do and which keeps the toolchain surface smallest. Rejected: electron-react-boilerplate (a template, not a dependency; inherits someone else's 2019 decisions).

**Typed IPC: write it, roughly 200 lines.** electron-trpc 0.7.1 was last published 2024-12-07 and does not support tRPC 11; the community fork `trpc-electron` 0.1.2 is itself stale (2025-01-06). There is also a documented startup cost from the tRPC router initialising in both processes. More importantly, the parent note treats the IPC boundary as a public API precisely so a Tauri port stays a port. Binding that boundary to a tRPC version means porting tRPC's wire assumptions to Rust later. The thing to build instead: a single `commands.ts` in `core/` declaring a name-to-`{input, output}` zod map, a `invoke<K>()` typed helper in the renderer, one `ipcMain.handle` dispatcher that validates with zod before touching domain code, and `MessageChannelMain` for streaming (harness tokens, diff parse progress). That is a contract a Rust shell can satisfy.

**Security posture.** `contextIsolation: true` has been the default since Electron 12 and `sandbox: true` since Electron 20, so the job is not turning them on but not turning them off. Ship with: `nodeIntegration: false`, a preload that exposes only the `invoke` bridge via `contextBridge`, a strict CSP with no `unsafe-inline` (Vite can be configured to avoid inline styles), `session.setPermissionRequestHandler` denying everything by default, `webContents.setWindowOpenHandler` denying all, and `@electron/fuses` flipping `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` off and `OnlyLoadAppFromAsar` on. Validate every IPC payload with zod even though the renderer is "ours", because the renderer is the process that renders untrusted diff content.

**Heavy work goes in `utilityProcess`, not the main process and not `child_process.fork`.** Electron's `utilityProcess` gives a Node-capable child with `MessagePortMain` bidirectional channels and proper Chromium process lifecycle. Git plumbing, diff parsing, and harness supervision all belong there. The renderer keeps a worker for highlighting. Nothing that can block for more than a frame runs on the main process.

**Auto-update.** Two credible paths. `update-electron-app` 3.3.0 (published 2026-06-28) plus the free `update.electronjs.org` service works only for public GitHub repos, which the open-source core is, and costs zero infrastructure. `electron-updater` 6.8.9 is the more configurable path and works for a private or self-hosted feed, which the paid tier may eventually need. Recommendation: start on `update-electron-app`, keep `electron-updater` as the migration target. Both require a signed and notarized app; unsigned auto-update silently fails on macOS.

**Crash reporting for a privacy-respecting product.** Default to no telemetry. Write crashes and structured logs locally with `electron-log` 5.4.4, and put a "copy diagnostic bundle" button in the UI so a user can paste it into a GitHub issue on purpose. If you later want aggregate crash data, `@sentry/electron` 7.16.0 (published 2026-07-24) is the healthy option, but ship it opt-in, off by default, with `sendDefaultPii: false`, scrubbing of file paths and repo names, and a self-hosted DSN if you can be bothered. Never send diff content, repo paths, or prompts. An open-source local-first review tool that phones home by default is a positioning own-goal, not just a privacy one.

---

## 2. Git plumbing

### Must-use

| Library | Version | Why | Health (2026-08-04) |
|---|---|---|---|
| **system `git` via `spawn`** | user's git | Primary. Perfect worktree support, zero deps, correct credentials and config | n/a |
| (write it) git wrapper | ~250 lines | Plumbing-shaped, streaming, cancellable | n/a |
| isomorphic-git | 1.40.0 | Fallback object reader where git is absent | Published 2026-07-23, repo pushed 2026-08-02, 8.3k stars, 313 open issues |

### Rejected

| Candidate | Verdict |
|---|---|
| nodegit | **Dead.** Last publish 0.27.0 on 2020-07-28. Native libgit2 build. Never. |
| @napi-rs/simple-git 1.1.0 | Viable on the native constraint (prebuilt N-API for 12 targets, vendored libgit2, no node-gyp) but only 190 stars, effectively one maintainer, and the generated `index.d.ts` exposes no worktree API. Not primary. |
| gitoxide / gix | The Rust project is in outstanding health (11.8k stars, 18 open issues, pushed 2026-08-04) but I found **no official Node N-API binding** (Python bindings exist). Marked unverified rather than absent, but do not plan on it. |
| libgit2 via WASM (wasm-git) | Stale and unverified. No. |
| simple-git 3.36.0 | Alive (published 2026-04-12, repo pushed 2026-08-02) but its API is porcelain-shaped. See below. |

### Rationale

**Shell out to the user's git.** This is the boring answer and it is correct for this product specifically. The workspace model in the parent note keys repo identity on the git common dir, discovers worktrees anywhere on disk, and must handle a repo nested inside another repo. Every one of those is a single plumbing call that git answers authoritatively: `git rev-parse --path-format=absolute --git-common-dir`, `git worktree list --porcelain`, `git rev-parse --show-toplevel`. No library reimplements worktrees as well as git does, because worktrees are a git feature with a file format that libraries lag on. Shelling out also inherits the user's credential helper, SSH agent, `.gitattributes`, `.gitconfig`, hooks, and any corporate proxy setup, for free. For a zero-config North Star that is not a minor point, it is most of the point.

**But not simple-git.** Write the wrapper. simple-git is a porcelain convenience layer; we want plumbing (`diff --raw -z`, `diff --numstat`, `cat-file --batch`, `for-each-ref`, `merge-base`), streaming stdout rather than buffered strings (Hunk's issue #247 is exactly the whole-stream-buffering failure we are positioning against), and per-call `AbortSignal` cancellation when the user switches PRs mid-parse. That is about 250 lines of `spawn` plus a NUL-delimited parser, and it belongs in `core/` behind a `GitPort` interface so the Tauri shell can implement it with `std::process::Command` and the mobile client never sees it at all.

**isomorphic-git as fallback only.** Pure JS, actively maintained, and the only option that could ever run in a browser or on the phone. Use it for read-only object access if `git` is genuinely missing. Its 313 open issues are typical for a project of its age rather than alarming. **Worktree support: I could not verify any `git worktree` API in isomorphic-git and believe it is absent.** Treat the fallback as degraded mode, not parity.

**Native-dep risk: zero.** This is the only category where we get to spend nothing on the constraint budget.

---

## 3. Diff engine

### Must-use

| Library | Version | Why | Health (2026-08-04) |
|---|---|---|---|
| `git diff` itself | user's git | Do not compute diffs in JS. Git already did it in C | n/a |
| parse-diff | 0.12.0 | Tiny pure-JS unified diff parser to bootstrap | Published 2026-04-17 |
| diff (jsdiff) | 9.0.0 | Intraline and word-level refinement inside a hunk | Published 2026-04-13, ESM-first |
| web-tree-sitter | 0.26.11 | WASM AST for structure, symbol ranges, moved blocks | Published 2026-07-12; tree-sitter core pushed 2026-08-04, 26.5k stars |
| (write it) anchoring engine | the product | Hunk identity across patchsets | n/a |
| difftastic | external binary, optional | Structural diff when the user has it | Repo pushed 2026-08-03, 25.7k stars, very healthy |

### Rejected

- **gitdiff-parser 0.3.1**, last published 2023-03-14. Stale. No.
- **Computing file diffs with jsdiff.** Myers over a 5,000-line file in JS on the main thread is not compatible with an 8.3ms frame budget. Git's C implementation with `--histogram` is faster and matches what the user sees in their terminal.
- **difftastic as a dependency.** There is no npm package. It is a Rust binary.

### Rationale

**Layering.** Get hunks from `git diff -U<n> --histogram` streamed line by line. Parse with parse-diff to start, but plan to own the parser: parse-diff is roughly 200 lines and does not carry the metadata the product needs (byte offsets, per-line original and new numbers usable as anchors, rename and mode detection surfaced structurally, binary and submodule cases). The anchoring engine, which is the actual product thesis, has to survive a force-push, so hunk identity must be content-derived, something like `hash(normalized_hunk_body + enclosing_symbol_path)` rather than line numbers. Nothing on npm does this. Build it.

**Intraline diff with jsdiff v9.** Once you have a hunk you only need word-level diff across a few dozen lines, which is cheap enough to do in the worker per visible hunk. `diffWordsWithSpace` and `diffChars` are what you want. Do it lazily on visible hunks, not eagerly over the whole changeset.

**tree-sitter for structure, not for diffing.** `web-tree-sitter` (WASM, so no native dep) gives you the enclosing function or class for a hunk, which feeds the sequence lens ordering, the blast-radius fan-in signal, and the anchoring hash above. Do not try to build an AST diff algorithm; that is a research project and difftastic already spent five years on it.

**difftastic as an optional external process.** It is a binary, MIT-ish licensed, exceptionally healthy, and can emit JSON (`difft --display json`). If the user has it on PATH, offer a structural view. Do not bundle it and do not depend on it. Detect-and-use is the same zero-config pattern as harness auto-detection.

**How the fast tools render.** In a DOM the ceiling is node count, not diff algorithm. Pierre's renderer (below) uses CSS Grid plus Shadow DOM specifically to cut node count, and pre-renders highlighted tokens as HTML rather than as React element trees. Zed and Warp sidestep the question with GPU shaders, which is not available to us in Electron and is the honest reason a native port would be faster. Our answer is: fewer nodes, tokens computed off-thread, and only visible lines mounted.

---

## 4. Code rendering

### Must-use

| Library | Version | Why | Health (2026-08-04) |
|---|---|---|---|
| **@pierre/diffs** | 1.3.2 | The Pierre diff renderer, as a React library, Apache-2.0 | Published **2026-08-04**, 95 releases since 2025-12-10 |
| shiki | 4.4.1 | VS Code-identical highlighting, JS regex engine, worker-friendly | Published 2026-07-31, repo pushed 2026-07-31, 13.7k stars |
| @tanstack/react-virtual | 3.14.9 | Dynamic-height virtualization with sticky file headers | Published 2026-07-28, repo pushed 2026-08-03, 7k stars |
| @codemirror/view + @codemirror/state | 6.43.7 / 6.7.1 | Editable surfaces only (comment composer, inline edit) | Published 2026-07-27 / 2026-07-05. **See the GitHub note below** |

### The headline finding

**The Pierre diff rendering layer shipped as an npm package.** `@pierre/diffs` 1.3.2 is Apache-2.0, published 2026-08-04, with 95 releases since 2025-12-10. It peer-depends on React 18.3 or 19, depends on `shiki` ^3 || ^4 and `diff` 9.0.0, and provides `File` / `FileDiff` components with split and stacked layouts, line selection, token hover callbacks, custom hunk separators and headers, an `EditProvider`, merge-conflict UI, and **annotations for comments and code-review workflows**. Public docs at diffs.com describe CSS Grid plus Shadow DOM for fewer DOM nodes.

This answers the parent note's open "Pierre rendering layer evaluation" spike far better than PierreDiffsSwift would have. PierreDiffsSwift is a macOS Swift wrapper and would have fought the portable-core constraint directly. A React library on npm under Apache-2.0 does not; it lives entirely in `ui/` and is the one layer a Tauri port would keep unchanged.

Caveats to carry into the spike, stated plainly:
- **Virtualization is not documented.** The docs do not mention it. The critical unknown is whether `FileDiff` can render a windowed subset of lines or insists on the whole file. If it insists, it composes at file granularity (virtualize the file list, render whole files) which still works for most PRs but does not obviously hit 120Hz on a single 5,000-line file. **Unverified. Prototype this first, before any other engineering.**
- It pulls `@pierre/theme` 2.0.0 and `@pierre/theming` 1.0.0, so there is vendor coupling in the styling layer.
- **I could not find a public source repository.** The npm package declares apache-2.0 with an empty `repository` field, and the obvious GitHub org guesses 404. Treat the licence as good and the ability to fork as unverified.

### Rationale for the rest

**Shiki over tree-sitter for colour.** Shiki 4.4.1 uses the same TextMate grammars as VS Code, which is the fidelity bar people actually judge against, and it now ships a JavaScript regex engine (`@shikijs/engine-javascript`, a first-class dependency of core) so you can skip the Oniguruma WASM download entirely. Run it in a Web Worker and transfer tokens, not HTML strings, back to the renderer. tree-sitter would need a per-language WASM grammar plus highlight query files that you then maintain forever, and its long-tail language coverage is worse. Use tree-sitter for structure (section 3), Shiki for colour. They are not competing.

**CodeMirror 6: alive, but it moved off GitHub.** This surprised me and is worth knowing. `codemirror/dev`, `codemirror/view`, `codemirror/basic-setup` and the rest were **archived on 2026-04-15** and are now read-only. This is not abandonment: npm publishing continues (`@codemirror/view` 6.43.7 on 2026-07-27) and codemirror.net states development happens on `code.haverbeke.berlin`, a self-hosted forge. The practical consequences are real though: no GitHub issues, no GitHub PRs, no dependency-graph or security-advisory signal from GitHub, and a contribution path most contributors will not take. Use CM6 for the comment composer and any inline editing, where it is unmatched, and do not put it under the diff surface where `@pierre/diffs` is the better fit anyway.

**Monaco rejected.** Monaco 0.56.0 is healthy (published 2026-07-20) but it is an entire editor: its own model, worker, and language-service architecture, a large bundle, and a diff editor tuned for two-file comparison rather than an ordered stream of hunks across dozens of files. It is the wrong shape for read-mostly review.

**Canvas or WebGL rendering rejected for v1.** You lose text selection, accessibility, find-in-page, native scroll physics, and IME. Those are not nice-to-haves in a tool whose entire value is careful reading. If DOM genuinely cannot hit the bar, that is the argument for the native port, not for a canvas renderer inside Electron.

**Hitting 120Hz on 5,000 lines: the mechanics that matter more than the library choice.**
- 8.3ms per frame means nothing may allocate per frame. Precompute everything.
- Highlight in a worker. Transfer token data as typed arrays or flat objects, never HTML strings crossing `postMessage` for the whole file.
- Virtualize at two levels: files, then lines within the expanded file.
- `content-visibility: auto` plus `contain-intrinsic-size` on collapsed file blocks so the browser skips their layout entirely.
- Never mount a React element per token. Tokens become a single innerHTML string per line, or a Shadow DOM subtree, computed once.
- Keep hunk metadata in flat structures with numeric IDs. No object churn in the scroll path.
- Measure with the Chrome DevTools performance panel against a real 5,000-line diff on day one, not at the end.

---

## 5. UI layer

### Must-use

| Library | Version | Why | Health (2026-08-04) |
|---|---|---|---|
| react / react-dom | 19.2.8 | Still the default; Pierre's renderer requires it | Published 2026-07-21 |
| tailwindcss | 4.3.3 | Oxide engine, CSS-first config | Published 2026-07-16 |
| shadcn (CLI) | 4.16.1 | Copy-in components you own and can compress | Published 2026-07-31 |
| cmdk | 1.1.1 | Command palette primitive (also shadcn's `<Command>`) | Published 2025-03-14; repo pushed 2025-10-29, 12.9k stars, 72 open. **Slowing** |
| @atlaskit/pragmatic-drag-and-drop | 2.0.1 | Hunk regrouping; works with virtualized lists | Published 2026-06-17; repo pushed 2026-08-04, 12.7k stars |
| tinykeys | 4.0.0 | Key-sequence matching primitive only | Published 2026-05-20 |
| (write it) command registry | ~300 lines | Named remappable commands | n/a |

### Rationale

**React 19 is still the right call, without enthusiasm.** 19.2.8 shipped 2026-07-21 and the ecosystem is settled there. More decisively, `@pierre/diffs` peer-depends on React, so choosing anything else means giving up the single best rendering asset available. Solid and Svelte would both be defensible in the abstract; they are not defensible against that.

**Tailwind v4 with an immediately compressed scale.** v4's CSS-first `@theme` config makes it easy to define a dense type and spacing scale up front. Do that in the first commit. shadcn's defaults are web-marketing-spacious and a review tool needs to be closer to Sublime Merge density than to a landing page. You own the copied components, so compress them once rather than fighting them forever.

**cmdk, with an honest flag.** Last npm publish 2025-03-14, repo last pushed 2025-10-29, 72 open issues. That is slowing, not dead, and it is small, stable, unstyled, and already what shadcn's Command component wraps, so the swap cost if it does die is low. **kbar rejected:** still at `0.1.0-beta.48` after years, last pushed 2025-07-29. A permanent beta is not a dependency.

**Drag and drop: pragmatic-drag-and-drop, not dnd-kit.** This flipped since 2024. `@dnd-kit/core` is frozen at 6.3.1 from 2024-12-05; the successor line `@dnd-kit/react` is at 0.5.0 with only beta releases through 2026-07-13, so the library is mid-rewrite with no stable target. Atlassian's `@atlaskit/pragmatic-drag-and-drop` 2.0.1 (2026-06-17, repo pushed 2026-08-04) is framework-agnostic, built on native HTML5 drag and drop with a very small core, and explicitly supports virtualized lists, which matters because hunk regrouping happens inside the virtualized diff surface. Note its GitHub licence is reported as NOASSERTION by the API; it is Apache-2.0 per Atlassian's docs, but **verify the licence text before shipping**.

**Keyboard shortcuts: write the registry.** This is a genuine "no library" case. The requirement is every shortcut being a named remappable command with a user keymap file, which is a command registry, not a hotkey hook. Roughly 300 lines: a `Command` record (`id`, `title`, `category`, `when` clause, `run`), a keymap resolver handling chords and platform differences, conflict detection, and JSON serialisation of user overrides. That registry then feeds the command palette and the menu bar from one source, which is exactly the parity the parent note asks for. Use `tinykeys` 4.0.0 as the low-level sequence matcher inside it. **react-hotkeys-hook 5.3.3 rejected as the primary abstraction:** it is healthy but hook-scoped and component-local, which is the opposite of a global remappable registry.

---

## 6. State and data

### Must-use

| Library | Version | Why | Health (2026-08-04) |
|---|---|---|---|
| node-sqlite3-wasm | 0.8.60 | SQLite with real fs access, **zero native code** | Published 2026-07-28 |
| kysely | 0.29.4 | Type-safe query builder, no codegen, dialect-swappable | Published 2026-07-17 |
| zustand | 5.0.14 | UI state | Published 2026-05-28; 58.5k stars, **5 open issues** |
| xstate | 5.32.5 | Only for pairing handshake and harness session lifecycle | Published 2026-07-14 |
| immer | 11.1.15 | Reducer ergonomics over the event log | Published 2026-07-16 |
| Electron `safeStorage` | built in | OS keychain for the pairing key. Zero deps | n/a |
| (write it) event store | ~400 lines | Versioned review state | n/a |

### Rejected

| Candidate | Verdict |
|---|---|
| better-sqlite3 13.0.2 | **Native-dep risk, high.** node-gyp plus node-addon-api, needs `@electron/rebuild` against every Electron major. With an 8-week major cadence that is a scheduled breakage every 8 weeks. Fast and excellent, but it is the exact dependency class the constraint exists to exclude. |
| keytar 7.9.0 | Dead: last published 2022-02-17, archived by the Atom org. Use Electron's `safeStorage`, or `@napi-rs/keyring` 1.3.0 (prebuilt N-API) if you need more. |
| drizzle-orm 0.45.2 | Fine, but last published 2026-03-27 versus Kysely's 2026-07-17, and its ORM surface buys little over an append-only event table. |
| @tanstack/react-query | **Skip for local state.** It is a server-cache library. Against a local IPC surface it adds a cache you must invalidate over a source of truth you already own. Use it **only** for the GitHub API layer, where it is genuinely correct. |
| yjs / CRDTs | Not needed. Mobile is a remote control, so there is exactly one writer. Adding a CRDT would be solving a problem the architecture already prevents. |

### Rationale

**SQLite without native code.** `node-sqlite3-wasm` 0.8.60 is a WASM build of SQLite with Node filesystem access and no dependencies, actively released (2026-07-28). The workload here is small: review state, hunk read-flags, obligations, snapshots. The git object store is the real database and it is on disk already. WASM SQLite will not be the bottleneck, and the thing it buys is that Electron majors stop being events.

**Check `node:sqlite` on day one.** Node.js ships a built-in `node:sqlite` module, and Electron exposes Node core modules to the main process. If Electron 43's bundled Node includes it, that is zero dependencies and strictly better than everything above. **I could not verify Electron 43's exact bundled Node version or whether `node:sqlite` is exposed there. Test `require('node:sqlite')` in the first spike.** If it works, delete this whole subsection.

**Kysely over Drizzle.** A type-safe query builder with no codegen step, no decorators, no runtime schema, and swappable dialects, which matters if the store ever moves (say to `node:sqlite` per the paragraph above, or to a Rust-side store in a Tauri port). Drizzle is a good library solving a slightly different problem.

**Zustand's health is worth naming.** 58,519 stars and **5 open issues**. That ratio is close to unheard of and is a strong signal for a dependency you will touch every day. Use it for UI state. Jotai 2.20.2 is equally healthy and equally fine; pick one, do not run both.

**XState narrowly.** Use it where the state genuinely is a machine: the QR pairing handshake (offer, scan, key exchange, allowlist, expiry, revoke) and the harness session lifecycle (idle, starting, streaming, awaiting-approval, failed, cancelled). Do not make it the app store. The 2026 alternative `@xstate/store` 4.2.2 exists but Zustand already covers that slot.

**Event sourcing: write it, no framework.** Roughly 400 lines. An append-only `events` table (`id`, `changeset_id`, `ts`, `type`, `payload` JSON), derived projection tables rebuilt from it, and a snapshot row per review session. The critical design decision is not the library, it is that **hunk identity is content-derived, not positional**, so a force-push produces a new patchset whose hunks match by hash and whose read-state and obligations carry forward, with unmatched hunks flagged as needing re-read. That is the Gerrit patchset model and it is the thing no npm package will give you. Every JS event-sourcing framework on the registry is either abandoned or built for distributed server systems with an outbox and a message bus, neither of which exists here.

---

## 7. LLM and harness

### Must-use

| Library | Version | Why | Health (2026-08-04) |
|---|---|---|---|
| @anthropic-ai/claude-agent-sdk | 0.3.221 | Claude harness adapter | Published 2026-08-03, releasing daily; repo 1.7k stars, 175 open |
| @openai/codex-sdk | 0.146.0 | Official TS client for codex app-server | Published 2026-07-29 |
| zod | 4.4.3 | Schema validation on every harness output | Published 2026-05-04 |
| @anthropic-ai/sdk | 0.115.0 | Tier-two single-shot structured calls | Published 2026-07-24 |
| (write it) adapter layer | ~800 lines | The normalized event protocol | n/a |
| (write it) JSONL reader | ~40 lines | Line-buffered transform over child stdout | n/a |

### Rationale

⭐ **NOTE 2026-08-06: this section is USEFUL AGAIN, not moot.** It was written before the later 2026-08-04/05 planning docs banned the Claude Agent SDK; that ban is now itself superseded — the SDK is adopted (Master Plan R2) — so the packaging research below is directly applicable. One mitigation worth adding on top of it: the SDK's `optionalDependencies` ship one prebuilt binary per platform, and at package time only the current build target's platform binary needs to survive pruning/`asarUnpack` — excluding the other seven from the shipped artifact keeps the notarization surface (and app size) down to one binary per release, not eight.

**Claude Agent SDK packaging, and the macOS trap in it.** `@anthropic-ai/claude-agent-sdk` 0.3.221 has **no runtime dependencies** and instead ships eight platform-specific prebuilt binaries as `optionalDependencies` (`darwin-arm64`, `darwin-x64`, linux gnu and musl, win32). That satisfies the native constraint: prebuilt N-API-style binaries, no node-gyp. But it creates a packaging obligation people get wrong: the binary must be in `asarUnpack`, must be included by electron-builder's `files` glob, and **must itself be signed with the hardened runtime and included in the notarization**, or macOS Gatekeeper kills it at first launch with an unhelpful error. Budget a day for this. Also: version 0.3.x releasing daily means pin the exact version and let the adapter interface absorb churn.

**Codex: use the official SDK.** `@openai/codex-sdk` 0.146.0 (2026-07-29) exists and depends on `@openai/codex` at the same version, so it tracks the CLI. Use it rather than hand-rolling a JSON-RPC client. The app-server protocol gained WebSocket transport, bearer auth, and health endpoints in March 2026, and is organised around Threads (durable, resumable by ID, forkable) and Turns, which maps cleanly onto our per-thread diff-chat memory requirement. Flag: the protocol carries explicit stability warnings, the WebSocket transport is experimental, and some methods need `experimentalApi` opt-in. **oh-my-pi: unverified**, I gathered no registry or repo data on it; treat it as a third adapter implementation behind the same interface.

**Multi-agent orchestration frameworks: do not adopt one. Write the thin adapter.** Honest answer as requested. We are not orchestrating an agent graph; we are supervising two or three external processes and normalising their event streams. The Vercel AI SDK (`ai` 7.0.51, published 2026-08-04, very active) is excellent at model calls and streaming UI state, but it does not drive external agent CLIs, which is what a harness adapter has to do. Graph frameworks solve routing and tool-loop problems that the harnesses solve internally. Adopting one would couple the core to someone else's 0.x release train in exchange for nothing. The adapter is an interface plus three implementations: roughly 800 lines total, and the parent note already has prawn's `AgentAdapter` shape as the starting point. The normalized event protocol (`session.started`, `text.delta`, `tool.call`, `tool.result`, `finding`, `session.ended`, `error`) is the actual asset and it must be ours, because harness plurality is a positioning claim.

**Streaming JSONL: 40 lines, not a dependency.** A `Transform` that buffers partial lines and emits parsed objects on `\n`. `stream-json` 3.5.0 (2026-07-07) is maintained but aimed at huge single JSON documents. `ndjson` 2.0.0 was last published 2020-08-15; skip it. If you ever need to render partially-received JSON objects mid-stream, `best-effort-json-parser` 1.5.1 (2026-06-26) is maintained, unlike `partial-json` 0.1.7 (2024-05-14). Usually JSONL framing means you do not need either.

**zod v4 everywhere there is a trust boundary.** 4.4.3 is the current line and the repo is very active (43.4k stars, pushed 2026-07-30). Validate: IPC payloads, every harness JSON output before it reaches domain code, the pairing protocol messages, workspace config files, and the finding-rubric JSON. Use `zod/mini` on any path where bundle size in the renderer matters. Harness output is untrusted input; it is a model's guess at a schema, not a contract.

**@modelcontextprotocol/sdk 1.30.0** (2026-07-27) is worth noting as a cheap future option: exposing review state as an MCP server would let a user's own agent read what they have reviewed. Not v1, but the event-store design should not preclude it.

---

## 8. GitHub interop

### Must-use

| Library | Version | Why | Health (2026-08-04) |
|---|---|---|---|
| `gh auth token` (shell) | user's gh | Primary auth. No OAuth app, no secret in an OSS binary | n/a |
| @octokit/graphql | 9.0.4 | Review threads, resolution, batched review submission | Published 2026-08-01, actively released |
| @octokit/rest | 22.0.1 | The handful of things REST does more simply | Published 2025-10-31; maintained but slower |

### Rationale

**Reuse `gh`, and the decisive reason is not convenience.** An open-source desktop app cannot ship an OAuth client secret; anything in the binary is public. GitHub Apps and OAuth apps both push you toward either a hosted callback (a cloud backend, which the architecture explicitly refuses) or device flow. `gh auth token` sidesteps all of it: the user already authenticated, already granted scopes, already completed SSO authorization for their org. Read the token, use it, never store a copy. This is also precisely the zero-config North Star: "the tool finds what's already on your machine", applied to GitHub the same way it is applied to harnesses.

Fallback when `gh` is absent: OAuth device flow with a public client ID and no secret, which is the one flow designed for exactly this situation. Second path, not first.

**GraphQL is not optional for this product.** Review threads are a GraphQL-first concept. `resolveReviewThread` and `unresolveReviewThread` have **no REST equivalent at all**, and the parent note's own workflow depends on thread resolution. Pending reviews with batched comments (`addPullRequestReview` with a `comments` array, then `submitPullRequestReview`) are how you land a whole decomposed review as one review event rather than as a spray of notifications, which matters enormously for the "reviews land as normal PR reviews" requirement. GraphQL also lets you fetch a PR, its files, its threads, its comments, and its check runs in one round trip instead of six.

Use `@octokit/graphql` 9.0.4 as a thin typed client rather than the `octokit` metapackage (5.0.5, last published 2025-10-31), which pulls plugins we will not use. Add `@octokit/rest` only where REST is genuinely simpler, mostly listing PRs and downloading raw patches. Note both REST packages last published 2025-10-31 while the graphql client shipped 2026-08-01, which reinforces the split.

---

## 9. Mobile companion (Expo / React Native)

### Must-use

| Library | Version | Why | Health (2026-08-04) |
|---|---|---|---|
| expo | 57.0.10 | SDK 57, released 2026-06-30 | Published 2026-08-04; repo 51.3k stars, pushed daily |
| react-native | 0.86.2 | The SDK 57 runtime | Published 2026-07-27 |
| expo-router | 57.0.10 | File-based navigation, same release train | Published 2026-08-04 |
| expo-secure-store | 57.0.1 | Pairing key in the iOS Keychain | Published 2026-07-15 |
| expo-camera | 57.0.3 | QR pairing scan | Published 2026-07-16 |
| @shopify/flash-list | 2.3.2 | Code line virtualization | Published 2026-06-10; repo pushed 2026-08-04, 7.2k stars |
| @noble/curves + @noble/ciphers | 2.2.0 / 2.2.0 | X25519 and XSalsa20-Poly1305, pure JS, Hermes-safe | Published 2026-04-12 / 2026-04-11 |
| expo-crypto | SDK 57 | CSPRNG. **noble throws without one on Hermes** | ships with SDK |
| expo-updates | 57.0.12 | OTA | Published 2026-08-04 |

### Rationale

**Expo is still the default in 2026, more so than in 2024.** SDK 57 shipped 2026-06-30 on React Native 0.86, and the New Architecture has been mandatory with no opt-out since SDK 55. The cadence tightened noticeably: 57 landed roughly a month after 56, framed as a small focused release, which is a good sign for upgrade cost. Bare React Native buys nothing here; every native capability the companion needs (camera, keychain, updates) is a first-party Expo module on the same version train.

**WebSocket: use the RN global, not `ws`.** React Native provides a `WebSocket` global. `ws` is a Node package and belongs only on the desktop server side. One real flag: RN's WebSocket does not let you easily customise TLS trust, which would be a problem for direct-LAN connections with a self-signed cert. It is not a problem for us, because the pairing design already puts end-to-end encryption **above** the transport with X25519 plus XSalsa20-Poly1305. Plain `ws://` on the LAN with our own crypto on top is correct and simpler. This is one of the places the existing design pays off.

**Crypto on device: the gotcha.** `@noble/curves` and `@noble/ciphers` are pure JS and run fine in Hermes, but they require a cryptographically secure random source and will **throw at runtime** if one is not installed. Install `expo-crypto` (or `react-native-get-random-values`) and wire `globalThis.crypto.getRandomValues` before any noble call. This is the single most common way this exact stack fails in production. The parent note's "~400-600 lines, no library" verdict on pairing crypto stands; this is a five-line addendum to it.

**List virtualization, and a better idea than virtualizing.** `@shopify/flash-list` 2.3.2 is a v2 rewrite for the New Architecture (no more `estimatedItemSize`) and is actively developed. `@legendapp/list` 3.3.3 (2026-07-16, 3.3k stars) is a credible alternative that often wins on variable-height content. But the stronger move for code display is architectural: **the desktop is the server, so highlight on the desktop and ship pre-tokenized lines over the wire.** Shiki never runs on the phone, the phone renders styled `<Text>` runs from a token array, and the mobile bundle drops a lot of weight. Use FlashList over that.

**EAS Update with a paid App Store app: fine, with two caveats.** Apple permits JS-only over-the-air updates for interpreted code as long as they do not change the app's primary purpose, and this has been settled practice for years; being a paid app changes nothing about that. The two real constraints are that OTA **cannot** update native modules (an SDK bump is a store submission), and that EAS Update is a **hosted Expo service**, meaning update manifests and bundles transit Expo's infrastructure. That matters only for marketing honesty: an app positioned on "no cloud backend" must scope that claim to review data, since `expo-updates` supports a custom self-hosted update server if the claim needs to be absolute. SDK 55 added Hermes bytecode diffing, percentage rollouts, and republish-as-rollback, so the hosted service is genuinely good. Third-party alternatives exist and are unnecessary complexity here.

**Push notifications: the caveat is confirmed, and the honest answer is "do not ship push in v1".** I checked the alternatives and none of them removes the third party.
- `expo-notifications` 57.0.8 with Expo's push service relays through Expo's servers.
- Firebase Cloud Messaging moves the relay from Expo to Google. Same category of claim, different logo.
- Talking to APNs directly requires an always-on process holding an APNs auth key. The desktop app is not always on and shipping the key in an open-source client is a non-starter. This is not a workaround, it is the reason the relay exists.

So: there is no push architecture compatible with "no cloud backend" other than not having push. The v1 answer is a live WebSocket while the app is foregrounded, plus local notifications the device schedules for itself. If push is later judged essential, name the relay in the privacy copy at the same moment you add it. The parent note's rule about never claiming "nothing leaves your machine" while a relay is reachable applies here exactly.

---

## 10. Shared core, monorepo, and toolchain

### Must-use

| Tool | Version | Why | Health (2026-08-04) |
|---|---|---|---|
| pnpm workspaces | pnpm 10.x | Strict node_modules, fast, no hoisting surprises | Standard in 2026 |
| turbo | 2.10.8 | Task graph and caching, minimal ceremony | Published 2026-07-31 |
| typescript | 7.0.2 | Go-native compiler, 8-12x faster. **Read the blocker** | Published 2026-07-08 |
| tsdown | 0.22.14 | Rolldown-based library builds for `core/` | Published 2026-07-23 |
| vite | 8.2.0 | Renderer build | Published 2026-07-30 |
| vitest | 4.1.10 | Unit and integration tests | Published 2026-07-06 |
| @playwright/test | 1.62.1 | E2E via `_electron` | Published 2026-07-30 |
| @biomejs/biome | 2.5.6 | Lint plus format, one tool, stable | Published 2026-07-28; 25.5k stars |

### Rationale

**TypeScript 7 has one blocker you must plan around.** TS 7.0 reached GA on 2026-07-08. The Go-native compiler is now the default `tsc` inside the `typescript` package (the name `tsgo` now refers only to the nightly channel), and it is typically 8-12x faster on full builds. The catch: **TS 7.0 ships no stable programmatic API**, so `typescript-eslint`, `ts-morph`, `ts-jest`, and framework template checkers cannot run against it. That API is targeted for 7.1, described as several months out. Practical plan: use TS 7 for `tsc --noEmit` typechecking and editor performance, and if you want type-aware lint rules either keep a TS 6 devDependency alongside for `typescript-eslint` only, or skip type-aware linting entirely. Given that the codebase is greenfield and small, skipping it is defensible.

**Lint and format: Biome, with oxc as the aggressive alternative.** Honest split. `@biomejs/biome` 2.5.6 (2026-07-28, 25.5k stars) is one stable tool doing both jobs, with a mature formatter, and it does not need the TypeScript programmatic API, which sidesteps the TS 7 blocker entirely. `oxlint` 1.77.0 (2026-08-03, releasing constantly) is roughly 2x faster at linting and `oxfmt` 0.62.0 (2026-08-03) is roughly 3x faster at formatting with strong Prettier compatibility, but **oxfmt has only been in beta since February 2026**. Recommendation: Biome 2.5 now, reassess oxfmt at 1.0. Either way, drop ESLint 10 plus Prettier; there is no longer a reason to run either on a new project.

**Build: tsdown, not tsup.** `tsup` 8.5.1 was last published 2025-11-12 and is effectively in maintenance with `tsdown` (Rolldown-based, from the Vite team's orbit) as its designated successor, released 2026-07-23. Use tsdown for `core/`'s multi-condition output, Vite 8 for the renderer.

**Test: Vitest 4 plus Playwright, with a flag.** Vitest 4.1.10 for `core/` and for renderer component tests. Playwright's Electron support (`_electron`) is **still officially labelled experimental in 2026** and there is an open issue from 2026-03-01 asking for clarity on production readiness. In practice it is what VS Code uses to test itself, has had no breaking changes, and is the only credible option. Use it. One real limitation to design around: **Playwright cannot intercept native Electron dialogs** (`showOpenDialog`, `showSaveDialog`, `showMessageBox`) because those calls go straight to OS APIs from the main process. Put every dialog behind an injectable port in `shell/` so tests can stub it. That is good architecture anyway and the Tauri port needs the same seam.

**Monorepo: pnpm plus turbo.** Turbo 2.10.8 is the most active and the least ceremonious for a four-package repo. Nx 23.1.1 is healthy but its plugin and generator model is a lot of machinery for this size. moon (`@moonrepo/cli` 2.4.6, 2026-07-28) is genuinely good and worth a look if turbo's caching disappoints, but has a smaller ecosystem. Note `moonrepo` on npm is a security placeholder, not the package; the real one is `@moonrepo/cli`.

**Sharing `core/` between Electron and React Native.** The mechanism is `exports` conditions, but the mechanism is the easy part. The discipline is what makes it work.

```jsonc
// packages/core/package.json
{
  "type": "module",
  "exports": {
    ".":          { "types": "./dist/index.d.ts", "react-native": "./dist/index.native.js", "node": "./dist/index.node.js", "default": "./dist/index.js" },
    "./protocol": { "types": "./dist/protocol.d.ts", "default": "./dist/protocol.js" },
    "./types":    { "types": "./dist/types.d.ts", "default": "./dist/types.js" }
  }
}
```

Condition order matters: `react-native` must come before `node` and `default`, because Metro takes the first match. Metro respects `exports` under `unstable_enablePackageExports`, which is on by default in recent React Native. Rules:

1. **`core/` imports nothing from `node:*` at module scope.** Not `fs`, not `child_process`, not `crypto`. Every platform capability enters through a port interface declared in `core/` and implemented in `shell/` (Node) or in the mobile app. `GitPort`, `FsPort`, `RandomPort`, `StorePort`, `HarnessPort`. This is the same seam that makes the Tauri port a port, so it costs nothing extra.
2. **Ship compiled ESM plus `.d.ts`, never raw TypeScript into Metro.** tsdown handles this.
3. **The phone imports `core/protocol` and `core/types` only.** The git engine, diff engine, and review-state store never reach mobile, because the desktop is the server. This is what makes the whole shared-core constraint cheap rather than expensive: the shared surface is the wire protocol and the domain types, which is maybe 15% of `core/`.
4. **Target ES2022, no Node globals, no `Intl` edge cases.** Hermes is good in 2026 but not identical to V8. Run `core/`'s test suite under Hermes in CI if the shared surface grows.

---

## 11. Native-dependency risk register

Every compiled dependency, ranked, per the hard constraint.

| Dependency | Class | Risk | Verdict |
|---|---|---|---|
| better-sqlite3 13.0.2 | node-gyp + node-addon-api, compiled at install | **High.** ABI-locked to Electron's Node. `@electron/rebuild` required every Electron major, which is every 8 weeks | **Avoid.** Use node-sqlite3-wasm |
| nodegit 0.27.0 | native libgit2, node-gyp | **Fatal.** Unmaintained since 2020-07-28 | **Never** |
| keytar 7.9.0 | native, node-gyp | **Fatal.** Last published 2022-02-17, org archived | **Never.** Use Electron `safeStorage` |
| tree-sitter 0.25.1 (node bindings) | native, node-gyp | Medium | **Avoid.** Use `web-tree-sitter` (WASM) |
| @napi-rs/simple-git 1.1.0 | prebuilt N-API, 12 targets, vendored libgit2 | Low technically; **Medium on bus factor** (190 stars, effectively one maintainer, no worktree API) | Acceptable if ever needed, not primary |
| @anthropic-ai/claude-agent-sdk 0.3.221 | prebuilt platform binaries as optionalDependencies | Low, but **packaging trap**: needs asarUnpack plus hardened-runtime signing plus notarization of the nested binary | **Accept**, budget a day |
| @napi-rs/keyring 1.3.0 | prebuilt N-API | Low | Acceptable if `safeStorage` proves insufficient |
| shiki oniguruma WASM | WASM | None | Fine, but prefer the JS engine anyway |
| web-tree-sitter 0.26.11 | WASM | None | **Preferred** |
| node-sqlite3-wasm 0.8.60 | WASM | None | **Preferred** |
| Mobile: expo-secure-store, expo-camera, expo-crypto | native, but built by EAS | None in practice; Expo prebuild owns the toolchain | Fine |

Net: **the recommended desktop stack contains exactly one compiled artifact**, the Claude Agent SDK's prebuilt binary, and that one is prebuilt rather than compiled at install. That is about as clean as an Electron app that embeds an agent harness can be.

---

## 12. Recommended starting package.json sketches

Versions are what was current on 2026-08-04. Pin exactly for anything on a 0.x line.

### Desktop

```jsonc
// apps/desktop/package.json
{
  "name": "@app/desktop",
  "private": true,
  "type": "module",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-forge start",
    "build": "tsc --noEmit && vite build",
    "package": "electron-forge package",
    "make": "electron-builder --mac --publish never",
    "test": "vitest run",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.3.221",
    "@anthropic-ai/sdk": "^0.115.0",
    "@openai/codex-sdk": "0.146.0",
    "@octokit/graphql": "^9.0.4",
    "@octokit/rest": "^22.0.1",
    "@pierre/diffs": "^1.3.2",
    "@tanstack/react-virtual": "^3.14.9",
    "@atlaskit/pragmatic-drag-and-drop": "^2.0.1",
    "@codemirror/state": "^6.7.1",
    "@codemirror/view": "^6.43.7",
    "cmdk": "^1.1.1",
    "diff": "^9.0.0",
    "electron-log": "^5.4.4",
    "electron-updater": "^6.8.9",
    "immer": "^11.1.15",
    "isomorphic-git": "^1.40.0",
    "kysely": "^0.29.4",
    "node-sqlite3-wasm": "^0.8.60",
    "parse-diff": "^0.12.0",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "shiki": "^4.4.1",
    "tinykeys": "^4.0.0",
    "web-tree-sitter": "^0.26.11",
    "xstate": "^5.32.5",
    "zod": "^4.4.3",
    "zustand": "^5.0.14",
    "@app/core": "workspace:*"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.6",
    "@electron-forge/cli": "^7.11.2",
    "@electron-forge/plugin-vite": "^7.11.2",
    "@electron/fuses": "^2.1.3",
    "@electron/notarize": "^3.1.1",
    "@electron/osx-sign": "^2.6.0",
    "@playwright/test": "^1.62.1",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "latest",
    "electron": "^43.2.0",
    "electron-builder": "^26.15.3",
    "tailwindcss": "^4.3.3",
    "typescript": "^7.0.2",
    "vite": "^8.2.0",
    "vitest": "^4.1.10"
  }
}
```

Non-obvious build config to get right on day one: `asarUnpack` for the agent SDK binary, `@electron/fuses` in the Forge/builder afterPack hook, `notarize` with notarytool credentials in the env, and `hardenedRuntime: true` with entitlements allowing the child process to run.

### Mobile

```jsonc
// apps/mobile/package.json
{
  "name": "@app/mobile",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "start": "expo start",
    "ios": "expo run:ios",
    "build": "eas build --platform ios",
    "update": "eas update"
  },
  "dependencies": {
    "expo": "~57.0.10",
    "expo-router": "~57.0.10",
    "expo-secure-store": "~57.0.1",
    "expo-camera": "~57.0.3",
    "expo-crypto": "~57.0.0",
    "expo-updates": "~57.0.12",
    "react": "19.2.8",
    "react-native": "0.86.2",
    "react-native-reanimated": "~4.5.3",
    "@shopify/flash-list": "^2.3.2",
    "@noble/curves": "^2.2.0",
    "@noble/ciphers": "^2.2.0",
    "nativewind": "^4.2.6",
    "zustand": "^5.0.14",
    "zod": "^4.4.3",
    "@app/core": "workspace:*"
  },
  "devDependencies": {
    "@types/react": "^19",
    "typescript": "^7.0.2"
  }
}
```

Deliberately absent from mobile: no `ws` (use the RN global), no `shiki` (the desktop ships tokens), no SQLite (the cached snapshot is a JSON file in the app sandbox), no `expo-notifications` in v1, no crypto polyfill beyond `expo-crypto`'s `getRandomValues`. Every one of those absences is a decision, not an oversight.

### Root

```jsonc
{
  "name": "review-harness",
  "private": true,
  "packageManager": "pnpm@10",
  "devDependencies": {
    "@biomejs/biome": "^2.5.6",
    "tsdown": "^0.22.14",
    "turbo": "^2.10.8",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

---

## 13. What to prototype first, in order

Ranked by how much of the plan each one can invalidate.

1. **`@pierre/diffs` against a real 5,000-line diff, measured.** If it virtualizes or composes with a virtualizer, a large chunk of the hardest work is already written by someone else under Apache-2.0. If it does not, the rendering plan changes and you find out in week one instead of month four. Highest information value in the whole list.
2. **`require('node:sqlite')` in Electron 43.** Thirty seconds, potentially deletes a dependency.
3. **Sign, notarize, and launch a build with the Claude Agent SDK binary embedded.** The macOS packaging trap is the most likely thing to eat a day unexpectedly, and it eats it later if you do not do it now.
4. **`git worktree list --porcelain` plus `rev-parse --git-common-dir` across Rai's own setup** (`/workspace` as a repo, `product-repo` nested inside it, worktrees at `/workspace/wt/*`). The workspace data model is a hard requirement and this is the cheapest possible test of it.
5. **Shiki in a worker, tokens over `postMessage`, measured against the frame budget.**

---

## Unverified items

Collected honestly rather than scattered.

- `@pierre/diffs` virtualization behaviour and whether it can render a windowed subset of a file. Not documented.
- `@pierre/diffs` public source repository location. npm declares apache-2.0 with an empty repository field; the obvious GitHub org guesses return 404.
- Whether Electron 43 exposes `node:sqlite`. Could not confirm Electron 43's exact bundled Node version.
- Whether isomorphic-git has any `git worktree` support. I believe it does not, but found no explicit statement either way.
- Any official Node N-API binding for gitoxide / gix. Python bindings exist; I found no Node equivalent.
- `@atlaskit/pragmatic-drag-and-drop` licence. GitHub API reports NOASSERTION; Atlassian docs say Apache-2.0. Verify the LICENSE file before shipping.
- oh-my-pi. No registry or repository data gathered.
