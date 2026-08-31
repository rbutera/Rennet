---
title: Performance audit — desktop app + daemon (2026-08-31)
description: CPU and memory audit of the Electron app and the daemon — six static sweeps, live baseline measurements, a Bun feasibility verdict, and a four-wave ranked fix plan.
status: planned
tracking: https://github.com/rbutera/Rennet/issues/719
---

Scope: `apps/desktop` (Electron 43, React 19) and the daemon (`packages/server`, entry `daemon-main.ts`, plus `adapters`/`core` it pulls in). CPU and memory, idle and under load. A Bun runtime switch for the daemon is in scope as a candidate remedy, evaluated last as an isolated A/B.

Method: static sweeps (six themed passes over the source) + live baseline measurements of the built app and standalone daemon. Every finding carries file:line and a severity. Fix ranking happens only after both halves land.

## Live baseline

_(measured on nimbus, macOS, Apple Silicon, 16 GB)_

- Rennet was not running at audit start; numbers below come from launching the freshly built worktree app.
- Measurement gotcha: this shell exports `ELECTRON_RUN_AS_NODE=1` (agent-harness artifact). Electron then boots as plain Node and crashes on `electron` API access. Unset it before launching; remember for any perf script that spawns the app.

Built artifact sizes (vite build, 2026-08-31):

| Artifact | Size | Note |
|---|---|---|
| `dist/renderer/assets/index-*.js` | 1.93 MB | single chunk, no code splitting visible |
| `dist/browser/assets/index-*.js` | 1.93 MB | near-duplicate of renderer bundle (separate browser build) |
| `dist/server/index.cjs` | 1.29 MB | daemon bundle |
| `dist/server/sdk-*.cjs` | 1.14 MB | claude-agent-sdk chunk |
| `dist/main/index.cjs` | 0.45 MB | Electron main |
Per-process footprint, app freshly launched and left untouched, 6 samples over 60 s:

| Process | RSS (range) | CPU (range) |
|---|---|---|
| main | 112–120 MB | ~0% |
| renderer helper | 134–142 MB | **11–19% sustained** |
| GPU helper | 63–70 MB | **4.6–6.1% sustained** |
| daemon (`dist/server/index.cjs`, data-dir `~/.rennet`) | 57–83 MB | ~0% |
| network utility | 36 MB | 0% |
| pnpm/electron wrapper node | 34 MB | 0% |
| **Total tree** | **~450 MB** | |

- **Idle CPU verdict: not idle.** Renderer burns 11–19% and GPU 5–6% with zero interaction. **Attributed by CDP CPU profile (15 s, `app://rennet/#/new-chat`): JS is only 0.9% busy — the samples are all motion/react's frame loop (`tick`/`transform`/`updateAndNotify`). The cost is style/paint/composite driven by `first-run-welcome.tsx:274`: ten code fragments on `repeat: Infinity` 17–26 s animations of x/y/rotate/opacity (opacity ⇒ repaint every frame), mounted via `routes/app.tsx:346` whenever welcome is unclaimed. A fresh install idles at ~25% combined CPU until the user adds a project.** Wave 1 pauses the loops while `document.hidden` and removes their opacity channels; #719 owns the required integrated re-measurement.
- Daemon at idle is clean: 0% CPU, `/healthz` answers in ~0.4 ms.
- `~/.rennet` on this machine: 78 MB, 13 744 files (nearly all under `projects/`). SQLite (`rennet.sqlite` + WAL) tiny.
- Startup timing: not measured numerically in the baseline pass. Wave 1 removed the structural serialization described in §2 H1/§6 H1; issue #719 owns integrated cold-start before/after measurement.

## Findings

Severity: **H** = measurable user-facing cost (battery, beachball, swap), **M** = real but bounded, **L** = hygiene.

### 1. Idle CPU (timers, polling, watchers)

Structural verdict at the measured baseline: **no timer in the codebase paused on `visibilitychange`, `powerMonitor`, or connection state.** Every baseline stop condition was "the work finished", never "the user isn't here". Default `backgroundThrottling` (left on) mitigated hidden-window cases but nothing else.

**H1.** `packages/app-ui/src/board/board-view.tsx:85` — `setInterval(refreshBoards, 5_000)` fires 5 loopback `board.read` WS reads every 5s until `lensReadsSettled`. The code's own comment (:76) admits a review whose Noise lens drafts nothing never settles → polls forever while the board is open. Fix: bounded attempts or the daemon push the comment already names.

**H2.** `packages/adapters/src/repo-watcher.ts:88` — chokidar `usePolling: true, interval: 500` for WSL/UNC roots: stats the whole repo tree 2×/s for the daemon's life (started per review load, never stopped). HIGH on WSL, LOW on host (native events there).

**H3.** `packages/app-ui/src/coach/coachmark.tsx:44` — unconditional rAF loop calling `getBoundingClientRect()` + `getComputedStyle()` every frame (120Hz on ProMotion) while a coachmark is elected. Forced layout at display rate. Fix: ~250ms key-compare interval or bail on `document.hidden`.

**M4.** `apps/desktop/src/main/auto-update.ts:337` — two forever 5-min main-process timers (staged-update fs poll + update-electron-app network check). Never pauses on idle/battery.

**M5.** `apps/desktop/src/main/tray.ts:245` — 20s tray ownership refresh = `/healthz` HTTP probe + daemon wake, 3 round-trips/min forever, including window-less residency.

**M6.** `packages/app-ui/src/routes/app.tsx:213` — 400ms `session.list` poll (2.5 Hz) gated on prep status; a prep stuck mid-capture polls indefinitely.

**M7.** `packages/client/src/connection-supervisor.ts:268` + `packages/client/src/ws-bridge.ts:355` — double-layer reconnect capped at 8s forever when daemon is down; no give-up, no blur pause. Compounds with **M8** `packages/app-ui/src/components/connection-host.tsx:496`, a 1 Hz re-render driving the outage clock in exactly that state.

**L**: device-flow poll (well guarded), 1s running-review counter, first-run word carousel (1.9s, reduce-motion aware), pr-worktree-status 2s recursive timeout (same stuck-state shape as M6), baseline ref `fs.watch` (event-driven, fine).

Clean (checked, don't re-audit): no WS ping/keepalive at all (half-open sockets only found on next send — availability note, not a perf cost), no git/gh on any timer, CSS infinite animations all state-gated, live-activity 50ms timer is a coalescing one-shot.

### 2. Electron process model + main-process hygiene

Inventory is clean: exactly one BrowserWindow, no hidden windows, no transparency/vibrancy, sandbox + contextIsolation + webSecurity on, renderer has no Node heap, fuses sensible (`RunAsNode` deliberately on — daemon reuses the Electron binary as Node). The cost is concentrated in the startup path and daemon supervision:

**H1.** `apps/desktop/src/main/index.ts:351` — `await ensureDaemon(dataDir)` fully gates `new BrowserWindow`. Cold start = spawn + health poll (10s budget); version-skew adds SIGTERM + 5s claim-wait *before* spawn → up to ~15s black screen. The window only needs the port as an argv string; create window first, deliver port late.

**H2.** `apps/desktop/src/main/auto-update.ts:138` — synchronous `codesign --verify --deep --strict` + `spawnSync codesign --display` on the whole .app bundle, on the main thread, during renderer boot (packaged builds). Hashes every framework binary; multi-second stall starving IPC and the `app://` protocol handler. Never cached.

**H3.** `apps/desktop/src/main/daemon-supervisor.ts:325` — host branch of `ensureDaemonForProject` has no single-flight (WSL branch has one) and the skew path SIGTERMs + respawns with no backoff or attempt cap → double-spawn race and restart-storm risk.

**M4.** `apps/desktop/src/main/index.ts:184` — `protocol.handle("app")` puts a main-process JS hop + `net.fetch(file://)` on every renderer asset request, no cache headers; compounds with H2 on first paint.

**M5.** `vite.main.config.ts:26` — main bundle inlines `@rennet/core` + `@rennet/server` barrels (no `sideEffects: false` anywhere), pulled in for `defaultDataDir` alone; 453KB main bundle parsed before first window. Deep import + sideEffects flag fixes it.

**M6.** `apps/desktop/src/main/index.ts:142` — renderer-driven `appendFileSync` per WSL log line, unthrottled, unbounded file. **M7.** `packages/server/src/supervise.ts:92` — daemon.log has no rotation/cap (disk only; stdio is an fd, not a pipe — no memory leak).

**L**: win32 5-min `readdirSync` poll, tray icon re-read from disk per rebuild, 100ms sync claim-poll loops on quit path, `prune: false` in forge config ships full dep tree in asar (launch page-in + disk).

Live confirmation (unpackaged worktree build, macOS): renderer helper at **13% CPU** and main at 5% with the app freshly opened and idle — see baseline table.

### 3. IPC + WebSocket traffic shape

Wire mechanics are sound: renderer↔daemon is all loopback WS (Electron IPC is 6 small low-frequency channels — nothing to fix), broadcasts serialize once per connection class, seq-based replay rejection correct. The cost sits in three shapes:

**H1. Whole-file read-modify-write storage per interaction.** `packages/adapters/src/ask-log-store.ts:90-155` + `dispatch/ask.ts:47` — every ask write = 3 full-log reads + 3 zod parses + pretty-printed full rewrite (`JSON.stringify(…, null, 2)`) + 2 fsyncs. O(n) per write → **O(n²) per session**; 200 staged comments = 600 full-log parses. Same family: `boards/file-board-store.ts:181` — `getEvents(afterSeq)` parses the entire log then filters (incremental read is O(total)); `append` re-reads the log for schema per batch. Fix: keep parsed log/projection in memory, append-only.

**H2. Transcript re-derived per streamed token.** `packages/app-ui/src/chat/chat-data.ts:816` — `foldAskStream` yields a fresh identity per `ask-delta`, so `reattachToRows` re-walks every thread/message, re-splitting paragraphs, on every token; inner loop is O(threads × inFlight). **Second O(n²)**, the one users will report as "long sessions melt".

**H3. Full-state where a delta would do.**
- `dispatch/review.ts:346` — `ask-state` rebuilds ALL rows from ALL harnessEvents and broadcasts the whole array; 50ms-throttled for text deltas but **unthrottled** on every tool.started/output/denied → O(n²) bytes over a tool-heavy turn.
- `ws-listener.ts:819` — `askProjection` full-state fanned to every client per ask write, no delta encoding.
- `protocol/src/wire.ts:184` — `review.load` ships **every patchset ever captured** with full diff text (O(diff × recapture count)); aggressively invalidated by **M-family-invalidation** below, so refetched often.

**M4.** `app-ui/src/data/dispatch.ts:28` — `useInvoke` invalidates the whole command family: one `ask.*` write triggers ≈3 refetches + the projection push; any `review.*` invoke stales `review.load` (H3c). **M5.** Per-keystroke WS command + disk write + full settings refetch from Settings text inputs (`settings/data/live-projection.tsx:417`, `worktrees.tsx:53`). **M6.** Renderer full-zod-parse of every inbound frame (`client/src/ws-bridge.ts:405`) — push channels validate full row arrays at up to 20 Hz while `response.output` is `z.unknown()` — backwards vs the hot path. **M7.** Server zod-validates the largest outputs right before stringify (`parseCommandOutput`, ~90 dispatch sites) — pure cost, client doesn't re-check. **M8.** `store/review.ts:257` wholesale slice replace per projection push. **M9.** `patchset.readSpan` re-parses whole file patch per citation (`core/src/index.ts:280`) + sqlite store re-`JSON.parse`s whole patchset per lookup. **M10.** Projected (remote) connections deep-clone + regex-scrub every frame (`server/src/projection.ts:163`) — remote-only. **M11.** `ask-delta` unbatched: one frame per token chunk (`dispatch/review.ts:199`), 20 renders/s compounding H2.

**L**: non-discriminated `z.union` on the highest-frequency progress frame, `z.lazy` wrappers, JSON.stringify-equality dedups, no cross-frame notify coalescing in `data/cache.ts:116`.

Fixing H1 + H2 removes both quadratics; below M10 is noise.

### 4. Daemon CPU + memory

Shape of the whole package: **no cache anywhere, sync fs everywhere, whole-file rewrite per mutation** — all of it on the event loop (no worker threads; `UV_THREADPOOL_SIZE=16` doesn't help sync calls). Clean elsewhere: no execSync/spawnSync at all, no zlib, watchers debounced, EventEmitter hygiene correct, SQLite stores fine.

**H1. `packages/adapters/src/project-context-reader.ts:80` — `loadFresh` re-reads + re-sha256s the entire project snapshot per `context.*` request.** `verifySnapshotIntegrity` walks every shard (readFileSync + sha256 each), then `materializeSnapshot` re-invokes the same unmemoized `load` per shard again + JSON.parse. ≈2×N_files sync reads per call; callers are per-request/per-slice (context.map/file/symbols, knowledge-swarm per prior snapshot). Likely the single largest daemon CPU item on a big repo. Fix: memoize `load`/manifest keyed on (repoKey, baseOid).

**H2. Live turn is quadratic twice over** (same finding as §3 H3a, daemon side): `dispatch/review.ts:193` accumulates every HarnessEvent with its raw SDK frame (`native` — full tool_result payloads; memory ≈2× raw stream per in-flight turn); `harnessEventsToRows` re-folds the full array per 50ms tick and per tool event; broadcast is the whole rows array, deep-scrubbed per projected socket.

**H3. `create-server.ts:4650` `projectionContext()` rebuilt from disk per projected frame** — projects.json readFileSync + zod per project + N realpathSync, called inside every fan-out including **per ask-stream token when a phone is paired** (`ws-listener.ts:920`). Trivially memoizable, invalidate on project mutation.

**H4. The JSON-store family — four stores, one bug, O(n²) each:** ask log (§3 H1), thread store (`file-thread-store.ts:158` — whole conversation re-parsed + rewritten 4× per turn, final message embeds the entire activity projection into the file), transcript store (`transcript-store.ts:137` — full rewrite + 2 fsyncs per append), board log (`file-board-store.ts:181` — full replay per read, `afterSeq` saves nothing). Wants append-only log + in-memory projection, once, as a shared pattern.

**H5. `session-store.ts:107` `list()`** — readdir + read + zod per session, sessions only ever grow (soft-delete), and sidebar adds a second read per session (`create-server.ts:2578`): 2N sync reads + 2N zod parses per sidebar render, called per mint/resolve too.

**M**: forge detection spawns an interactive login shell + version/auth probes per settings read, sequentially per host, deliberately uncached (`create-server.ts:1314`, `settings.ts:913` — TTL-cache + parallelize); execa full-buffering of whole diffs (100MB default maxBuffer, `git-range-diff.ts:64` — big PR diff held whole twice); checkpoint capture spawns ~8 git processes incl. `git add -A` (recovery path today — confirm not per-round); ~6 unbounded process-lifetime Maps (round-progress logs, rounds ledger, askSeqByReview, sessionTurnLoops, boardsRuntimes — individually small, collectively a daemon that never returns memory); per-finding/per-manifest sync reads on turn assembly; `project-scout.ts:104` reads whole file then slices to cap; lens prompt reader re-reads prompt files per lens per round (never change at runtime — memoize); broadcasts stringify raw payload even when only projected sockets exist.

**Fix ratio, best first:** (a) memoize snapshot `load` (kills H1); (b) incremental activity snapshot (kills H2/§3-H3a); (c) cache projectionContext (kills H3); then the shared append-only-store rewrite for H4.

### 5. Renderer render + memory

Architecture is sound: one zustand store with selector subscriptions, `useSyncExternalStore`-per-key data cache (`packages/app-ui/src/data/cache.ts`), listener/interval cleanup correct across all 23 sites checked, no blob retention, diff surfaces have hand-rolled windowing. The damage comes from two compounding facts:

**H1. Zero memoization.** No `React.memo`/`memo(` anywhere in 239 `.tsx` files across `app-ui` + `ui`. Single highest-leverage fix; every finding below compounds off it.

**H2. `Collapse` never unmounts children** (`packages/ui/src/components/collapse.tsx:20`) — and `board/section.tsx:170` renders both the fold-line Collapse *and* the body Collapse at once. A ~700-claim board keeps every element in the DOM regardless of fold; fold-all saves zero nodes. #1 memory/node-count driver. Fix: unmount-when-closed (or `mount="lazy"` variant).

**H3. Re-render blast radius:** `board/quote-highlight.tsx:201` — every prose element/finding/title subscribes to `review.quoteThreads` and rescans all threads (flatMap + regex locate) per render, unmemoized. One quote thread opened → ~700 elements rescan. Compounds with **H4** `review/rich-text.tsx:183` — full markdown/citation segmentation in the render body, once per board element. Net: one store write = 700× full re-parse.

**H5. `components/code-view.tsx:262-300`** — `buildRowRegistry` (walks whole diff), `placeMarks`, anchor resolution all unmemoized in render body; `onScroll` (:350) sets state per scroll event → entire diff re-parsed every scroll frame, defeating the windowing. **H6.** Shiki tokenization uncached (`code-view.tsx:395`, `diff-view.tsx:639`) — viewport re-tokenized per render/scroll. Cheap fix: `Map<text+lang, tokens>`.

**H7.** `review/diff-view.tsx:415` — `DiffFileCard` unmemoized and subscribed to `stagedAsks`: staging one ask re-renders + re-tokenizes every mounted card. **H8.** `chat/conversation-pane.tsx:52` — transcript unwindowed; every ws delta rebuilds the rows array (`chat-data.ts:817`) → every Turn re-renders per streamed token. **H9.** `chat/streaming-prose.tsx:62` — 2 DOM nodes per word, re-split per delta; `word-in` animation (`index.css:1171`) leaves `filter: blur(0)` on every word span forever → permanent stacking contexts/compositing for the whole transcript.

**M**: coachmark rAF layout loop (also idle-CPU H3); `CommandCache` never evicts (whole diffs/transcripts retained for bridge lifetime — the real "keeps diffs forever" retention; bound it or drop data on last-unsubscribe); board 5s poll (idle-CPU H1); 400ms session poll; `diff-view.tsx:175` totals reduce + quadratic `byDir` build per render; element-index Maps rebuilt in render (`board-view.tsx:227`, `design-structure.tsx:128`); sidebar session lists always mounted under Collapse.

**L**: processing-orb masked-gradient infinite spin (state-gated), busy-bar/caret (state-gated), `backdrop-blur` on fixed chrome (`corner-slot.tsx:90`, `top-bar.tsx:195`), inset glow box-shadow in scroll container, 10 `will-change` layers on welcome screen.

Four moves if only four: (a) Collapse unmounts when closed; (b) `memo()` Section/FindingElement/BoardElement/Turn/DiffFileCard + `useMemo` RichText/useRangedThreads; (c) memoize CodeView registry + shiki token cache; (d) bound CommandCache.

### 6. Startup + module graph

**Daemon graph is already in decent shape**: bundled twice (Vite → `dist/server/index.cjs` 1.2 MB for desktop; esbuild → `packages/server/dist/rennet.cjs` 3.1 MB for CLI), claude-agent-sdk lazy behind `await import()` (`packages/adapters/src/claude-query.ts:65`), harness discovery lazy + memoized, no boot-time network/git. Boot does run SQLite `migrate()` synchronously (fine, tiny DB). `create-server.ts` does import the full `adapters` (705-line) and `core` (1076-line) barrels eagerly — execa, chokidar, octokit, graphology, wboard all parsed at boot.

**H1.** Same as §2 H1: window creation serialised behind daemon health (`main/index.ts:351`) — 500ms probe timeout → spawn → 100ms-poll up to 10s before any pixels.

**H2. Renderer is one unsplit 1.8 MB chunk.** No `manualChunks`, zero `React.lazy`/dynamic import anywhere in app-ui/client/renderer; wouter routes all eager. Shiki + 9 grammars sync-imported at module scope (`app-ui/src/syntax/shiki.ts:23`, deliberately sync for tokenization); `motion/react` eager for one welcome screen; react-markdown eager. And `sourcemap: true` in prod → **6.8 MB `.js.map` ships in the packaged app**.

**M3.** `dist/browser` is a byte-identical second copy of the renderer bundle (build cost + package size, not runtime).

**L4. Dead dep**: `@modelcontextprotocol/sdk` in `packages/adapters/package.json`, zero imports. Delete.

## Bun migration assessment

Verdict: **feasible, surface unusually small — but the dominant cost is packaging, not code, and today's Node runtime is free.**

Compat surface (server + adapters + core + protocol + prompts, prod code):
- Builtins used: path/fs/os/child_process/crypto/url/stream/http + `node:sqlite`. **Zero** worker_threads, cluster, async_hooks, vm, http2, tls, dgram. All imports `node:`-prefixed.
- **Blocker 1: `node:sqlite`** (`sqlite-review-store.ts:3`, `round-operation-store.ts:4`, `push-token-store.ts:14`). Bun has `bun:sqlite`, near-API but not identical → thin shim + rerun store suites.
- **Blocker 2: NAPI-8 addon** `rennet-rooted-landing` (loaded `round-source-landing-native-host.ts:138`). Bun's N-API has gaps; there is a kill-switch gate (`round-source-landing-native.ts:110`). The other native target is a spawned executable — Bun-safe.
- **Silent-loss risk (the one that bites in the field):** `daemon-main.ts:1,5,20` — `dns.setDefaultResultOrder("ipv4first")`, `net.setDefaultAutoSelectFamily*` (the lancelot dead-IPv6-route fix for GitHub hangs), and `UV_THREADPOOL_SIZE=16` (WSL-9P fs-starves-DNS mitigation). Bun no-ops all three **without erroring**.
- SDK: only-dynamic import, spawns the user's `claude` binary — fine under Bun; the `import.meta.url` CJS define workaround in both vite configs becomes unnecessary/harmful.
- Node-24-only API usage otherwise: none that Bun lacks (`AbortSignal.any`, `findLast`, `toReversed` all fine).

Structural cost: the desktop daemon today runs as **the Electron binary with `ELECTRON_RUN_AS_NODE=1`** (RunAsNode fuse deliberately on) — the Node runtime ships for free. Bun means shipping a ~50–90 MB Bun binary as extraResource, re-signing/notarizing it, and losing the RunAsNode trick. The CLI (`bin.rennet`) is trivially pointable at Bun (or `bun build --compile`).

Where Bun would actually pay: daemon cold-start (relevant because startup H1 serialises window on daemon boot — though fixing H1 removes most of that), spawn-heavy paths (git/gh/harness spawns), and baseline RSS. Where it wouldn't: the daemon idles at 0% CPU already; hot cost is in the renderer, which Bun never touches.

Recommendation: **not first**. Wave 1 is implemented; defer the Bun A/B until #719 remeasures it and Wave 2 lands. Then test `bun run` on the CLI daemon form with the sqlite shim behind a flag — measured, reversible, no packaging commitment until numbers justify signing a second binary.

## Fix plan (ranked)

Ranking rule: measured user-facing cost first, then structural O(n²)s that grow with real usage, then hygiene. Each wave is independently landable and measurable with the baseline harness above.

**Wave 1 — the measured burns (days, not weeks): implemented on `perf/electron-daemon` (2026-08-31), all four items, dual-reviewed with fix rounds.** Window/daemon unserialisation includes port-over-IPC handoff and per-data-dir start/stop serialization. Idle and startup re-measurement against the integrated build is still owed.
1. Welcome-screen infinite animations: pause while the document is hidden and drop their opacity channels (§1 attribution). Intended to remove the measured fresh-install repaint burn; post-change measurement is pending.
2. Un-serialise window creation from daemon health (`main/index.ts:351`): create and load the window, then deliver the port late. Cold-start measurement is pending.
3. Coachmark rAF loop → 250ms key compare (`coachmark.tsx:44`); board 5s forever-poll → pause while hidden and fall back to 60s after ten quiet minutes (`board-view.tsx:85`).
4. Async-ify/cache the `codesign --deep` check (`auto-update.ts:138`); single-flight + cap host `ensureDaemon` (`daemon-supervisor.ts:325`).

**Wave 2 — the quadratics (the "long session melts" class):**
5. Ask-log store: in-memory projection + append-only writes (§3 H1 / §4 H4) — same pattern then applied to thread, transcript, board stores.
6. Incremental activity snapshot instead of full re-fold + full rebroadcast per tool event (§3 H3a / §4 H2); batch `ask-delta` frames (~50ms window).
7. Transcript derivation memoized per-thread instead of per-token full rebuild (`chat-data.ts:816`).
8. Memoize snapshot `load` in `project-context-reader.ts:80`; cache `projectionContext()`.

**Wave 3 — renderer scale (700-claim boards):**
9. `Collapse` unmounts when closed; `memo()` on Section/FindingElement/Turn/DiffFileCard; `useMemo` RichText/useRangedThreads.
10. CodeView registry memoization + shiki token cache; scroll state out of React render path.
11. Bound `CommandCache`; session-list caching daemon-side (§4 H5).

**Wave 4 — startup + size:**
12. Split renderer bundle (lazy welcome/motion, lazy shiki grammars); drop prod sourcemaps from the package; dedupe `dist/browser`.
13. Drop dead `@modelcontextprotocol/sdk`; `sideEffects: false` + deep imports for the main bundle.

**Deliberately not in plan:** Bun switch (see assessment — revisit after Wave 2 with A/B numbers on the CLI daemon form); WS keepalive (availability, not perf); anything below §3 M10 noise line.
