## 1. Vendor the snapshot

- [ ] 1.1 Write `scripts/t3-upstream.mjs` with `assemble` (build the `t3-vendor` branch tree from selected subpaths of an upstream commit via `git read-tree --prefix`), `inspect`, `fold`, and `check-ledger` subcommands; add `t3:inspect`, `t3:fold`, `t3:check-ledger` root scripts
- [ ] 1.2 Create the `t3-vendor` branch at upstream aab404964 with `packages/{contracts,shared,client-runtime,effect-codex-app-server,effect-acp}`, `apps/server/src`, `apps/web/src`, their `package.json` files and upstream `LICENSE`; merge it into the working branch
- [ ] 1.3 Write `vendor/t3code/UPSTREAM.json` (repo, commit, date, paths) and an empty `vendor/t3code/PATCHES.md` with the ledger columns
- [ ] 1.4 Merge T3's catalog entries and the Effect pnpm patch into `pnpm-workspace.yaml`; add the vendored packages to the workspace; add `vp` and `tsgo` as dev dependencies; `pnpm install` clean
- [ ] 1.5 Exclude `vendor/` from Biome and ESLint; add an Nx project per vendored package with `test` (via `vp`) and, for the server, `build` (via `vp pack`) targets with declared inputs and outputs
- [ ] 1.6 Run the vendored server bundle by hand with `serve --no-browser`; confirm it starts and answers the handshake
- [ ] 1.7 Wire `t3:check-ledger` into `pnpm check`; positive control: edit a vendored file without a ledger entry and watch the gate fail
- [ ] 1.8 Run `t3:inspect` against upstream and commit the first digest; run `t3:fold` to a newer upstream commit on a throwaway branch to prove the merge path

## 2. Sidecar supervisor

- [ ] 2.1 Add `t3-sidecar.json` claim read/write/remove beside `daemon-file.ts`, with probe-before-trust and stale-claim removal
- [ ] 2.2 Implement spawn of the vendored bundle: `serve --host 127.0.0.1 --port 0 --no-browser --base-dir <dataDir>/t3 --bootstrap-fd 3`, token piped into fd 3, telemetry-off env, relay and Clerk keys stripped
- [ ] 2.3 Seed the sidecar's provider settings with the absolute `claude` and `codex` paths from Rennet's discovery before spawn
- [ ] 2.4 Exchange the bootstrap token at `/oauth/token`, store the session token owner-only; expose `chat.t3Session` that brokers a browser-session credential and the WebSocket URL to clients
- [ ] 2.5 Boot-time handshake and method check; report `ready` or `degraded` with the missing method named in `/health` and the connection bar
- [ ] 2.6 Extend `stopOwnedDaemon` and `rennet stop` with the sidecar SIGTERM step, bounded wait, claim clear, timeout logged; serialize through `chainDaemonOp`
- [ ] 2.7 Tests: claim adoption, stale claim, credential absent from argv and env, provider seeding, stop ordering, `~/.t3` untouched; each with a positive control

## 3. Daemon-side RPC module

- [ ] 3.1 Write `packages/server/src/t3/client.ts`: the single Rennet module importing `effect` and `@t3tools/*`; exposes `createThread`, `startTurn`, `subscribeThread`, `readTurnDiff` as Promises and AsyncIterables
- [ ] 3.2 Session-to-thread binding keyed on `repositoryRoot` and session id; create or resume the thread with cwd set to that repository's checkout, full-access mode
- [ ] 3.3 Test with a two-repo workspace sharing a branch name that the second repo's session binds to the second repo's checkout

## 4. Upstreamable seeds

- [ ] 4.1 Add an `outputFormat` option to the vendored Claude text generation; ledger entry marked upstreamable; open the upstream PR
- [ ] 4.2 Add an ephemeral (`persistSession: false`) flag to the same path; ledger entry; upstream PR
- [ ] 4.3 Flip the vendored telemetry default to off in the ledger only if the env flag proves insufficient in 2.2; otherwise no edit

## 5. Engine setting and disclosure

- [ ] 5.1 Add `chat.engine` per-project setting (`rennet` | `t3`), default `rennet`, to settings resolution and the protocol
- [ ] 5.2 Settings UI control with the persistence, usage and hidden-ref statements beside it
- [ ] 5.3 Health and connection-bar copy naming the sidecar as an owned process with harness-only egress

## 6. Chat slot, rung one

- [ ] 6.1 Chat slot switches on the engine setting; T3 branch hosts an Electron `<webview>` at the sidecar's thread route, authenticated via the brokered browser session
- [ ] 6.2 Drive it by hand: send a turn, trigger an approval in supervised mode, answer an agent question, view a per-turn diff; record the outcome in the spike notes
- [ ] 6.3 Observe outbound connections during a turn and confirm only the harness provider and user MCP servers are contacted

## 7. Handoff to a T3 turn

- [ ] 7.1 In the handoff loop, when the engine is `t3`, dispatch the composed work order through `startTurn` on the bound thread instead of `SessionTurnLoop`
- [ ] 7.2 On turn settle, read the turn diff from T3 and offer the existing delta re-review entry
- [ ] 7.3 E2E: hand off dispositions, observe one T3 turn, confirm the delta re-review offer appears; positive control by disabling the settle listener

## 8. Chat slot, rung two (only after 6.2 passes)

- [ ] 8.1 Vite alias for their `~/` imports into `vendor/t3code/apps/web/src`; one Tailwind build including their source; verify a single React and a single Base UI copy in the bundle
- [ ] 8.2 CSS theme bridge mapping `--background`, `--foreground` and `--app-theme-*` onto Rennet's `--rn-*` palette and fonts
- [ ] 8.3 Register the brokered environment in T3's environments store; mount atom registry provider, memory-history router with the thread route, toast and dialog hosts, and `ChatView`; wire `onDiffPanelOpen` to their `DiffPanel` in Rennet's side slot
- [ ] 8.4 Measure renderer bundle delta and confirm both WebSockets coexist; write the result to the spike notes
- [ ] 8.5 If the mount needs their `_chat` layout or route loaders, implement the fallback: T3's projected thread read model under a Rennet-themed timeline for tool groups, approvals, questions and diffs

## 9. Documentation

- [ ] 9.1 New `docs/developing/concepts/t3code-vendoring.md`: layout, vendor branch, scripts, cadence, ledger, licence
- [ ] 9.2 New `docs/developing/concepts/t3code-sidecar.md` with a mermaid diagram of daemon, sidecar and client
- [ ] 9.3 Update the egress statement in `product-and-vision.md`, the dependency standard, `harness-adapters.md`, and CLAUDE.md with the vendoring rules (never reformat `vendor/`, every edit in the ledger, extend over edit)
- [ ] 9.4 PR description states what grows: the vendored snapshot, the toolchain additions, the renderer bundle delta, and that T3 threads persist to harness history and write hidden refs
