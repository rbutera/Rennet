---
tags: [rennet, harvest, licensing, plans]
categories: [project]
status: active
created: 2026-08-06
updated: 2026-08-06
related: ["[[Rennet Master Plan]]", "[[Rennet Dependency Standard]]", "[[T3 Code Integration Research]]"]
---

# Overnight Harvest Plan

> [!IMPORTANT] ✅ The licence decision this plan was written *against* has since been MADE
> Rai decided on **2026-08-06**: **Rennet goes MIT and adopts the Anthropic Agent SDK.** The doc-side
> work is done on branch `chore/relicense-mit-fold-design-2026-08-06`. This plan is unchanged below —
> it is the assessment that informed the decision — but two of its items are now **actionable
> follow-ups against PR #1 rather than open questions**, and they are written out in §6.

What to keep, rework, and drop from the two overnight branches, judged against the direction as it
stands on **2026-08-06** — which changed after that work was written.

Read against `main` = `d9172fc`, `origin/feat/dependency-standard-nx` = `a66d84e`,
`origin/feat/local-review-mvp` = `8622e98`. Nothing was merged, committed, pushed, or checked out
to produce this document.

**What changed after the overnight agent stopped, and which it could not have known:**

1. ⚠️ **Licence flip: Rennet is going MIT, not AGPL-3.0-only.** Master Plan **R2** (SDK retirement)
   and the whole clean-room / zero-SDK / zero-compiled-artifacts stance are **reversed**. The
   Anthropic Agent SDK is now allowed and wanted.
2. **Roll-up into cohorts; decisions are NEVER capped** — grouped instead.
3. **The review→agent handoff loop**: dispositions batched → coding harness addresses them on the
   branch → new patchset → re-review of the delta only.
4. **Orchestrator harness model**: the user talks to one orchestrator that synthesises across
   harnesses.
5. **T3 Code verdict** ([[T3 Code Integration Research]]): adopt-partial — mine their checkpointing
   for the handoff loop, do not build on a T3 core, keep the dependency research.

---

## 0. Three corrections to the framing, before the tables

### 0a. ⭐ The two branches are not parallel — they are **stacked**. They cannot conflict.

`a66d84e` is the **parent commit** of `8622e98`. Verified:
`git merge-base --is-ancestor origin/feat/dependency-standard-nx origin/feat/local-review-mvp`
returns true. Both share merge-base `d9172fc`.

```
d9172fc (main) ── a66d84e (dependency-standard-nx) ── 8622e98 (local-review-mvp, PR #1)
```

So there is no merge-order question and no conflict to resolve: **merging PR #1 merges both.**
`feat/dependency-standard-nx` is a strict subset of PR #1 and needs no separate merge — its only
independent value is as a smaller, safer first merge if the MVP code needs more work. The MVP
commit already amends its parent's output in two places (`nx.json`,
`docs/Rennet Dependency Standard.md`), so the two are a single reviewable unit in practice.

The "43 files" and "104 files" in the brief are both **against `main`**, and the second number
contains the first. The MVP commit's own footprint is **70 files, +13,100** on top of `a66d84e`.

### 0b. ⭐⭐ The licence flip is far cheaper in code than expected — and the one script that looked stale is the one to keep

The premise was that `check-licenses.mjs` and `check-boundaries.mjs` encode the AGPL/Apache split.
**Neither does.** I read both in full:

- **`scripts/check-licenses.mjs` is an INBOUND dependency allowlist**, not an outbound licence
  declaration. It permits `0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, ISC, MIT`
  (`check-licenses.mjs:3-11`) and throws on anything else in `pnpm licenses list --prod`. Under MIT
  this gate is **more** relevant, not less — standing on giants is exactly when you want to know
  what you are shipping.
- **`scripts/check-boundaries.mjs` encodes the dependency-direction DAG**, not licences:
  `types ← protocol ← core ← adapters`, with `ui → {types, protocol}` only
  (`check-boundaries.mjs:6-12`). That arrow set comes from R20 (the renderer reaches the engine over
  IPC), which is architectural. **The licence flip does not touch it.**

And the split was never encoded in the manifests at all. Every workspace package
(`types, protocol, core, adapters, ui, desktop`) has **no `license` field whatsoever**; the root
`package.json` says `"license": "UNLICENSED"`. There are **no SPDX headers and no
`LICENSE`/`NOTICE`/`COPYING`/`REUSE` file at any path** in the tree (control: `docs/README.md`
resolves, so the reader works).

**So the licence work is additive, not subtractive: set MIT, add a LICENSE file, and fix the
allowlist. There is no AGPL machinery to tear out of the code.** The debt is entirely in prose —
see §3.

### 0c. ⛔ MEASURED: the licence gate will reject the Anthropic SDK on its first run — and the obvious fix would silently gut the gate

This is the single most actionable finding, and I measured it rather than reasoning about it.
In an isolated scratch directory I installed `@anthropic-ai/claude-agent-sdk@^0.3.170` plus a `zod`
control and ran the exact query `check-licenses.mjs` runs:

```
licence keys reported: ['BSD-2-Clause','BSD-3-Clause','ISC','MIT','Unknown','Unlicense']
BLOCKED by the allowlist -> ['Unknown', 'Unlicense']
   @anthropic-ai/claude-agent-sdk
   @anthropic-ai/claude-agent-sdk-darwin-arm64
   fast-sha256
VERDICT: check-licenses.mjs WOULD THROW
control (zod present under MIT): True
```

⭐ **My own prediction was wrong in a way that changes the remedy.** I expected pnpm to report the
SDK under its literal npm field, `"SEE LICENSE IN README.md"` — in which case the fix would be to
add that one string to the allowlist. **pnpm normalises it to the bucket `Unknown`.** Allowlisting
`Unknown` would whitelist *every future dependency with an unreadable licence*, which is precisely
the class the gate exists to catch. It would leave the check green and blind.

⛔ **So the fix must be a named package-level exception, not a licence-level one** — an explicit
allow for `@anthropic-ai/claude-agent-sdk*` (a deliberate, reviewed, commented decision to ship a
proprietary-licensed dependency under Anthropic's Commercial Terms), plus adding `Unlicense` to the
licence allowlist for the transitive `fast-sha256`, which is genuinely public-domain-equivalent.
Keep `Unknown` blocked.

---

## 1. `feat/dependency-standard-nx` (`a66d84e`) — 43 files, +4,598

| File / area | Verdict | Why |
|---|---|---|
| `docs/Rennet Dependency Standard.md` (233 lines) | **REWORK** | Toolchain content is strong and unaffected — per-package verdicts, exact pins, primary-source citations, a cache contract, a real blocker list. But `:31` states the *"planned public split is Apache-2.0 for `packages/types` and `packages/protocol`, AGPL-3.0-only for the open application packages"* and `:33` forbids protocol importing *"an AGPL package"*. Rewrite §2 for MIT. **CLAUDE.md:13 gives this doc authority over "package licensing", so it is the most authoritative wrong statement in the repo.** |
| `nx.json` | **REWORK** | Adds `"plugins": []` — empty. `package.json` pins `@nx/vite`, `@nx/vitest`, `@nx/playwright`, `@nx/react`, `@nx/js` and **none is registered**, while every `project.json` declares raw `"command"` targets. This contradicts the standard's own §3 instruction to use the matching inference plugin. Either wire them or drop them; do not pay for them in the graph and bypass them. Unrelated to the licence flip. |
| `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.tool-versions`, `.nxignore`, `.gitignore` | **KEEP** | Ordinary workspace plumbing. Root `license: "UNLICENSED"` → `"MIT"` (see §3). |
| `.agents/skills/*` (17 files: nx-workspace, nx-generate, nx-import, nx-plugins, nx-run-tasks, monitor-ci, link-workspace-packages) | **REWORK** | First-party Nx agent-skill content (Nx's own tooling wrote the `<!-- nx configuration start -->` block into `CLAUDE.md` in the same commit). Nx is MIT, so shipping it is fine — but **no file carries a copyright header and there is no NOTICE anywhere**. Cheap to fix, and it matters *more* now: an MIT repo going for certification gets its supply-chain hygiene read. Add one NOTICE entry. |
| `.codex/config.toml`, `.codex/agents/ci-monitor-subagent.toml` | **KEEP AS-IS** | Registers `nx-mcp`, enables multi-agent, defines a narrowly-scoped one-shot CI subagent that is explicitly forbidden from polling or deciding. Clean, no licence surface. |
| Doc cross-reference edits (`Master Plan`, `Navi Handoff`, `Code Review Harness App`, `Repo Bootstrap`, `docs/README.md`, `Desktop and Mobile Stack 2026`) | **REWORK** | Mechanically fine; carry stale AGPL/SDK prose. See §3. |
| `prototypes/moodboard/project.json`, `spikes/event-store-publish-failure/project.json` | **KEEP** | Brings the existing mockup and spike under Nx targets without moving them. Correct and small. |

---

## 2. `feat/local-review-mvp` (`8622e98`) — 70 files on top of its parent, +13,100

**Overall:** this is honest, well-tested work that is **narrower than the brief implies and does not
contradict the new direction — it simply has not reached it.** `proposal.md` states up front that
harness execution, semantic angle generation, GitHub mutation, signing, updates, and telemetry are
all out of scope, and `docs/Rennet Local Review MVP.md` says plainly *"This slice has no
model/harness invocation."* That is the correct call for a first slice, and it means **almost
nothing here needs deleting.**

**19 tests total** (18 unit/integration + 1 Playwright E2E). Verified by counting `it(` blocks, not
by trusting prose.

### Keep as-is — good scaffolding, survives the direction change untouched

| File / area | Verdict | Why |
|---|---|---|
| `packages/types/src/index.ts` | **KEEP** | Pure inert shapes (`Patchset`, `Review`, `PatchFile`, `CommandResult<T>`). Will gain fields for cohorts; nothing to rewrite. |
| `packages/protocol/*` | **KEEP** | Zod schemas + a typed `commandDefinitions` map + `parseCommandInput/Output`. The transport mechanism is generic; new cohort commands are additions. 2 real tests (a malformed UUID throws; a valid payload round-trips). |
| `packages/adapters/src/git-capture.ts` | **KEEP — best file in the change** | Shells to `git` via `execa` (`shell:false`), resolves a base ref through a sensible fallback chain, captures committed + staged + unstaged + non-ignored untracked as one **content-addressed** patchset. **6 integration tests against real temp git repos**, including identity stability across identical captures and identity change on content change. None would survive stubbing. |
| `apps/desktop/src/main/index.ts` | **KEEP** | Genuinely good security posture: custom `app://rennet` protocol, sender-frame origin pinning, zod validation in **both** directions, a capability-gated `allowedRoots` set, all permission requests denied, `window.open` denied. Generic — extend the `dispatch()` switch, do not rework the shell. |
| `apps/desktop/e2e/local-review.spec.ts` | **KEEP** | The highest-value test in the repo. Launches real Electron, and **asserts the sandbox actually holds** (`window.rennet` exposes only `invoke`; `globalThis.process` is `"undefined"`) rather than merely that it was configured. Then drives capture → external file mutation → invalidation banner → regenerate, asserting the old diff stays visible and the new one replaces it. |
| `apps/desktop/forge.config.cjs`, `vite.{main,preload,renderer}.config.ts`, `preload/index.ts`, `renderer/index.tsx` | **KEEP** | Standard hardened Forge config (`flipFuses` disabling `RunAsNode`/`NODE_OPTIONS`/CLI-inspect, ASAR integrity, cookie encryption) and three narrow Vite configs. Survives any product pivot. |
| `scripts/check-boundaries.mjs` | **KEEP** | ⭐ Encodes the package DAG, **not** licences, so the flip does not touch it. And it **ships its own positive control**: it writes a forbidden `import "@rennet/core"` into `packages/ui`, asserts eslint fails with `@nx/enforce-module-boundaries`, and cleans up in `finally` (`:30-43`). That is "a check that cannot fail has not passed", implemented. Exactly the standard to hold. |
| `scripts/smoke-packaged-app.mjs` | **KEEP** | Covers the packaged artifact, which nothing else does. |
| `biome.json` + `eslint.config.mjs` | **KEEP — not the contradiction it looks like** | The dependency research chose Biome-only, so shipping both looks wrong. It is not: `eslint.config.mjs` does exactly one job — `@nx/eslint-plugin`'s `flat/base` + `flat/typescript` and `@nx/enforce-module-boundaries`, which is an ESLint plugin and has no Biome equivalent. The Dependency Standard already sanctions this: *"Only Nx module boundaries… ESLint never owns style."* Biome owns formatting. |
| `openspec/changes/build-local-review-mvp/*` | **KEEP** | Proposal/design/specs are internally consistent and conservative (explicit invalidation, no auto-regenerate, honest incomplete-capture states) and scope out exactly the areas the new decisions touch. ⚠️ One caveat: `tasks.md` is **18 of 18 boxes checked, 0 unchecked** — a completion claim no read-only pass can verify. Treat as unverified until the suite is run. |

### Rework — encodes a superseded product decision

| File / area | Verdict | Why |
|---|---|---|
| `packages/core/src/index.ts` — `foldReview` | ⛔ **REWORK — this is where the direction change actually lands** | `readPaths: []` is reset unconditionally on **both** `PatchsetActivated` and `ReviewInvalidated` (`:40`, `:55`), so **all read state is wiped on every re-capture**. That is the direct blocker for *"re-review only the delta"*: it is the opposite behaviour. A flat `readPaths: string[]` of booleans also has nowhere to put a **disposition**, which the handoff loop must batch. This reducer needs replacing, not extending. The event-sourcing shape around it (`payloadDigest` idempotency, fail-closed `exhaustive()` on unknown events) is good and should survive. |
| `packages/adapters/src/sqlite-review-store.ts` | **REWORK** | Solid mechanics — append-only `events` + `commands` receipt table, one `BEGIN IMMEDIATE` transaction, a schema-version gate that throws on mismatch. But `latestReview()` reads only *the single most recent review that ever had a `ReviewCreated`*, so there is **no multi-review support and no per-repository keying in the schema**. Cohorts and dispositions need somewhere to live. Keep the idempotency/event machinery; replace the read model. |
| `packages/ui/src/app.tsx` — `ReviewWorkspace` | **REWORK** | Three-column file-list + diff-pane + read-dot is the shape for a flat file list, not for rolled-up cohorts. The rework is a UI redesign, not a bug fix. |
| `packages/ui/src/app.tsx` — the Angles panel | **DROP (cosmetic)** | `:5` hardcodes `["Logic","Security","Tests","Performance","Maintainability","Product"]` and `:122` renders every one as the literal string `"Not run"`. It is wired to nothing. ⚠️ Note it is **not even the ratified angle set** (lens set v4 is spec / sequence / decisions / claims-and-evidence / blast-radius / noise), so leaving it invites someone to build against the wrong six. Delete it, or make it the real hook point for harness output. Costs nothing either way. |
| `packages/ui/src/styles.css` (389 lines) | **KEEP, expect churn** | Fine as-is; will move with the cohort redesign. |
| `packages/core/src/index.test.ts` | **REWORK (tests)** | Only 3 tests here, and **`ReviewService` — capture / setFileRead / checkFreshness / regenerate, all the idempotency logic — has none of them.** It is genuinely covered, but from `packages/adapters/src/sqlite-review-store.test.ts:88-124`, so a reader of the core suite alone would wrongly conclude the service is untested. Move or mirror the coverage. |
| `packages/ui/src/app.test.tsx` | **REWORK (tests)** | 2 `renderToStaticMarkup` substring checks against the presentational component only. **`RennetApp` — bootstrap, the 1500ms freshness poll, and all three async IPC handlers — has zero unit coverage**; only the E2E test exercises it. A handler wired to the wrong callback would pass. Add component tests with a fake `RennetBridge`. |
| `packages/adapters/src/repo-watcher.ts` | **REWORK (tests)** | Chokidar wrapper, 250ms debounce, fires a bare "maybe dirty" hint. Correct design (main re-runs a real capture to decide) but **no test file exists**; the debounce and ignore-globs are proven only transitively. Cheap gap to close. |
| `scripts/check-licenses.mjs` | ⛔ **REWORK — blocking for the SDK** | Keep the script; it is the right gate and more useful under MIT. But as measured in §0c it **throws on the Anthropic SDK today**. Add a named package exception for `@anthropic-ai/claude-agent-sdk*` with a comment recording the deliberate choice, and add `Unlicense` to the allowlist. **Do not add `Unknown`.** |

### Not a cap — worth stating explicitly

There is **no item-count cap anywhere**: no `maxItems`, no `slice(0, N)`, no SQL `LIMIT`. The only
bounding is **byte-size truncation of diff text** — `FILE_VISIBLE_BYTE_LIMIT = 256 KB` and
`DEFAULT_VISIBLE_BYTE_LIMIT = 2 MB` (`git-capture.ts:20-21`) — and it is surfaced as an explicit
`truncated` flag (`:238`), never a silent drop. The spec is aligned with the new direction already:
*"The system SHALL show every captured changed file."* **Nothing here needs undoing for
cohorts-not-caps**; the byte bound is an orthogonal concern that should survive.

Likewise there is **no harness integration of any kind** to unpick — the only child processes in the
tree are `execa("git", …)` and test/gate helpers. The MVP is local git + SQLite + UI, deliberately.

---

## 3. The licence flip: the actual work order

The code cost is small. **The prose cost is the real one**, and it is bigger than one file. Measured
at `8622e98`:

- **12 files mention AGPL**: `Rennet Master Plan.md`, `Rennet Navi Handoff.md`,
  `Rennet Dependency Standard.md`, `Code Review Harness App.md`, `Wingman Architecture Plan.md`,
  `Wingman Distribution and Licensing Plan.md`, `Wingman LSP Integration Plan.md`,
  `Wingman Repo Bootstrap Plan.md`, `Wingman Surfacing DSL and Model Routing Plan.md`,
  `References/Orca and Paseo Pairing.md`, and both `docs/reviews/` critiques.
- **10 files ban the SDK**, including **`CLAUDE.md:19`**: *"Never import or bundle the Claude Agent
  SDK. Harness adapters wrap user-installed tools through verified public process protocols."*

⚠️ **And the overnight branch actively reinforced both rules while touching the exact sentences.**
The two added authority banners:

- `Wingman Distribution and Licensing Plan.md:12` — *"The live licence boundary is Apache-2.0 for
  `packages/types` and `packages/protocol`, and `AGPL-3.0-only` for core, adapters, instructions,
  UI, and desktop. **Never import or bundle the proprietary Claude Agent SDK.**"*
- `Wingman Architecture Plan.md:12` — *"…**licence open packages as `AGPL-3.0-only`; never link the
  Claude Agent SDK**…"*

Both had the opportunity to correct these clauses and instead restated them with fresh authority.
That is not the agent's fault — it did not know — but it means the stale rules now appear in the
*newest* prose, which is exactly where the next reader looks first.

**Ordered work:**

1. ⛔ **`CLAUDE.md:19` first.** It is the file every agent reads before touching anything, and it
   states the ban as a fixed boundary. Until it changes, every future agent will refuse to add the
   SDK and may "helpfully" revert it.
2. **Master Plan**: rewrite **R2** (SDK retirement), **R3** (the Apache/AGPL package split), and
   **R5** (`AGPL-3.0-only` over `-or-later`) — R5 becomes moot entirely. Fix the §1 opening line
   *"Rennet (rennet.dev) is an AGPL-3.0-only, local-first Electron desktop app."*
3. **`Rennet Navi Handoff.md:24` and `:52`** — the handoff brief an autonomous agent builds from.
4. **`Rennet Dependency Standard.md` §2** (`:31`, `:33`) — it holds licensing authority per
   `CLAUDE.md:13`.
5. **The two Wingman banners above**, which are the freshest and therefore the most misleading.
6. **Add a `LICENSE` file** (there is none at any path) + `"license": "MIT"` on the root and on all
   six workspace packages, replacing the root's `"UNLICENSED"`.
7. **`check-licenses.mjs`**: named exception for the SDK + allow `Unlicense`; keep `Unknown` blocked
   (§0c).
8. **Add a NOTICE** for the vendored Nx agent-skill content.
9. The remaining `Wingman *` plans and `docs/reviews/*` are already labelled historical/evidence —
   a one-line banner correction is enough; they do not need rewriting.

⭐ **What the flip does NOT cost:** no SPDX headers to strip, no REUSE config to unpick, no
per-file vendoring quarantine, no AGPL/Apache package-split enforcement in code, and no change to
`check-boundaries.mjs`. The split was only ever prose. **And the flip retires an entire planned
workstream** — the clean-room Claude adapter, which [[T3 Code Integration Research]] identified as
the largest single build cost on the old path, can now be an SDK integration instead.

---

## 4. Merge mechanics

- **The branches cannot conflict** (§0a). Merging PR #1 brings both.
- **Neither branch conflicts with `main`**: `main` is still `d9172fc`, both share it as merge-base,
  and both fast-forward.
- ⚠️ **The one live conflict risk is this document plus [[T3 Code Integration Research]]**, which
  are untracked files in `docs/` on the working tree. Neither branch touches either path, so a
  merge is clean, but they should be committed deliberately rather than swept in.
- **Recommended sequencing:** do not merge PR #1 as-is. Land the `CLAUDE.md` + Master Plan licence
  corrections **first, on `main`**, so the MVP branch is rebased onto a tree that no longer bans the
  SDK. Otherwise the merge writes ten files' worth of superseded rules into `main` with today's
  date on them, and the next agent inherits them as current.

## 5. Bottom line

**Keep almost all of it.** Nothing in this work is wasted and very little is wrong. The MVP is
honestly scoped, genuinely tested (19 tests, including a sandbox-proving E2E and a boundary gate
that ships its own positive control), and its own docs already say the parts that would clash are
out of scope.

**Three things actually need rework, and only one is urgent:**

- ⛔ **`check-licenses.mjs` will block the SDK on day one** — measured, and the obvious one-line fix
  would silently gut the gate. Fix it as a named package exception before anyone tries to add the
  SDK and concludes the toolchain is broken.
- ⛔ **`foldReview` wipes read state on every re-capture** (`core/index.ts:40,55`) — the exact
  inverse of delta-only re-review. This reducer plus the sqlite read model is the one place the new
  direction demands a replacement rather than an extension.
- ⚠️ **The licence prose is the bulk of the work** — 12 files, 10 SDK bans, `CLAUDE.md` first. The
  code carries almost none of it.

**Drop exactly one thing:** the decorative Angles panel, which is unwired *and* lists the wrong six
angles.

---

## 6. Follow-ups that must be applied to PR #1, not to `main`

⚠️ **Why these could not be done on the relicence branch.** The relicence work was done on a branch off
`main`, and **`main` does not contain the files these changes target** — `scripts/check-licenses.mjs`
and the six workspace `package.json` files exist only on `feat/local-review-mvp` (`8622e98`).
Creating them on the relicence branch would have manufactured a merge conflict with PR #1, which is
exactly what we are trying to avoid. So they are written out here, ready to apply.

### 6.1 ⛔ `scripts/check-licenses.mjs` — will reject the SDK on its first run

The gate currently allows `0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, ISC, MIT`
(`check-licenses.mjs:3-11`). **Measured** against a real install of `@anthropic-ai/claude-agent-sdk`:

```
licence keys reported: ['BSD-2-Clause','BSD-3-Clause','ISC','MIT','Unknown','Unlicense']
BLOCKED -> ['Unknown', 'Unlicense']
   @anthropic-ai/claude-agent-sdk
   @anthropic-ai/claude-agent-sdk-darwin-arm64
   fast-sha256
VERDICT: check-licenses.mjs WOULD THROW
```

⛔ **Do NOT fix this by adding `Unknown` to the allowlist.** `Unknown` is the bucket pnpm assigns to
*every* dependency whose licence it cannot read, so allowlisting it silently disables the gate for all
future unreadable-licence packages — the exact class it exists to catch. The gate would stay green and
be blind.

**Fix as a named package exception plus one genuine licence addition:**

```js
const allowed = new Set([
  "0BSD", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause",
  "BlueOak-1.0.0", "ISC", "MIT",
  "Unlicense",           // public-domain equivalent; transitive via fast-sha256
]);

// Deliberate exception, Rai's decision 2026-08-06 (Master Plan R2).
// The Claude Agent SDK is proprietary (Anthropic Commercial Terms) and pnpm
// reports it in the "Unknown" bucket. We ship it knowingly. Allow it BY NAME:
// allowlisting the "Unknown" bucket itself would disable this gate for every
// future package with an unreadable licence.
const allowedUnknownPackages = new Set([
  "@anthropic-ai/claude-agent-sdk",
  // plus the per-platform binaries, which are stripped at packaging anyway
]);
```

…and filter the `Unknown` bucket's *members* against `allowedUnknownPackages` rather than dropping the
bucket check. ⭐ **Keep a positive control**: the gate must still throw for a fabricated package placed
in the `Unknown` bucket, or it has not been proven able to fail.

### 6.2 Licence fields on the six workspace packages

None of `packages/{types,protocol,core,adapters,ui}` or `apps/desktop` declares a `license` field at
all. Set `"license": "MIT"` on each. (The root `package.json` was already flipped from `UNLICENSED` to
`MIT` on the relicence branch.) No SPDX headers and no REUSE config are needed under MIT-throughout.

### 6.3 Drop the Angles panel

`packages/ui/src/app.tsx:5` hardcodes `["Logic","Security","Tests","Performance","Maintainability","Product"]`
and `:122` renders each as the literal string `"Not run"`, wired to nothing. ⚠️ It is **not the ratified
angle set** (lens set v4 is spec / sequence / decisions / claims-and-evidence / blast-radius / noise),
so leaving it invites someone to build against the wrong six. Delete it, or make it the real hook point
for harness output.

### 6.4 ⛔ `foldReview` must be replaced, not extended — CODE follow-up, deliberately not done here

`packages/core/src/index.ts:40,55` resets `readPaths: []` unconditionally on both `PatchsetActivated`
and `ReviewInvalidated`, so **all read state is wiped on every re-capture**. That is the exact inverse
of the delta-only re-review the handoff loop now depends on (Master Plan §2.1), and a flat
`readPaths: string[]` of booleans has nowhere to store a **disposition**
`{anchor, type, body}` — which is the loop's one data model.

⛔ **This is a code change and is out of scope for the documentation branch. It is recorded, not
implemented.** The event-sourcing machinery around it (`payloadDigest` idempotency, the fail-closed
`exhaustive()` on unknown events, the single-transaction commit) is good and should survive the
replacement. `packages/adapters/src/sqlite-review-store.ts` needs the matching change: `latestReview()`
currently supports only one global review with no per-repository keying.

### 6.5 Still true from §0a — the branches are stacked

`a66d84e` is the parent of `8622e98`. Merging PR #1 merges both; there is no conflict to resolve and
no merge-order question.
