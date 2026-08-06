---
tags: [rennet, distribution, licensing, plans]
categories: [project]
status: active
created: 2026-08-04
updated: 2026-08-05
---

# Rennet Distribution and Licensing Plan

> [!CAUTION] ⛔ THE LICENSING ARCHITECTURE IN THIS DOCUMENT IS SUPERSEDED — Rai's decision, 2026-08-06
> **Rennet is MIT licensed throughout, one licence for every package.** The top-level `LICENSE` is MIT, © 2026 Rai Butera.
>
> **Almost everything below is now historical.** This plan is built end to end on an AGPL-3.0-only core with an Apache-2.0 carve-out for `packages/protocol` and `packages/types`, and that entire structure is gone. Specifically:
> - **§0.1 (the package-boundary licence split) is MOOT.** It existed to keep the interoperability surface permissive while the application was copyleft. Under MIT there is nothing to keep it permissive *from*. The packages survive; the licence rationale does not. (Master Plan R3.)
> - ⛔ **§0.2 is REVERSED. The Claude Agent SDK is ADOPTED and wanted.** Its reasoning was correct *given AGPL* and is void without it — see the note at §0.2 for why the pricing objection was never real either. (Master Plan R2.)
> - **§4 "AGPL mechanics" in its entirety — §13 source-offer obligations, the REUSE/SPDX per-package layout, `AGPL-3.0-only` vs `-or-later`, the mobile-app combined-work analysis — does not apply to an MIT project.** MIT has no §13, no copyleft reach into the mobile app, and no `-only`/`-or-later` axis. A single top-level `LICENSE` plus a `NOTICE` for vendored third-party content is the whole obligation.
> - **§4.3 dual licensing is moot as a *defence*** — MIT already permits commercial use by anyone, so there is no proprietary-licence product to protect. ⭐ **The contribution hygiene it prescribes is still worth keeping** (DCO, `CONTRIBUTORS.md`, no unattributed inbound code), now for provenance and clean copyright rather than for relicensing rights.
> - **§4.4 (vendoring MIT into AGPL) simplifies to MIT-into-MIT.** No quarantine directory or REUSE override is needed; **attribution and a NOTICE entry are still required**, and are still owed for the vendored Nx agent-skill content and for anything mined from `pingdotgg/t3code`.
> - **§6 trademark** survives unchanged — MIT grants rights in the code, not the name.
>
> **What is still live and useful here:** the dependency-licence inventory in §5 (as a *compatibility* record — under MIT the inbound question is permissiveness and attribution, not copyleft direction), the notarization/signing/distribution material, and the Apple-enrolment timing (required before first public release, not before local dogfood).
>
> Product name is **Rennet**. [[Rennet Master Plan]] overrides this plan wherever they differ. Historical Wingman artefact names below are illustrative only.

Distribution, deployment, and licensing for [[Code Review Harness App]]. The product name is **Rennet**; the filename is retained only to preserve existing Obsidian links. Personal product, sole author Rai. Not the enterprise client work.

~~Ratified inputs I am building on, not relitigating: OSS core plus desktop app, paid mobile companion later; **AGPL-3.0-only** for core and desktop with Rai as sole author retaining dual-licensing rights; mobile app proprietary.~~ ⛔ **Superseded 2026-08-06: MIT throughout.** The OSS-core-plus-desktop and paid-mobile-companion shape survives; the licence structure under it does not.

Stack facts come from [[References/Desktop and Mobile Stack 2026]]. Licence verdicts on lifted code come from [[References/Orca and Paseo Pairing]]. Everything asserted here was verified on **2026-08-04** against the primary source cited inline; anything I could not verify is labelled **unverified** rather than asserted.

---

## 0. Two findings that change the plan

Read these before anything else. Both fall out of the licence choice and both touch architecture already marked "decided".

### 0.1 The shared `core/` package contaminates the proprietary mobile app

The stack note's mobile `package.json` contains `"@app/core": "workspace:*"`, and rule 3 of the shared-core section says "the phone imports `core/protocol` and `core/types` only". That is **linking**, in one address space, with intimate data structures.

The FSF's own test, verbatim from the [GPL FAQ, "What is the difference between an aggregate and other kinds of modified versions?"](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation):

> "If the modules are included in the same executable file, they are definitely combined in one program. If modules are designed to run linked together in a shared address space, that almost surely means combining them into one program. By contrast, pipes, sockets and command-line arguments are communication mechanisms normally used between two separate programs."

A proprietary Expo app that imports an AGPL package is a single combined work. The whole thing then has to be AGPL, which the App Store business model cannot survive.

Rai can paper over this today because he is sole copyright holder and can licence his own code to himself on any terms. But it is a paper-over that depends on him never forgetting, which is exactly the failure mode the Brita filter rule exists to prevent. One accepted drive-by PR touching `core/protocol` and the mobile app is in breach of a licence Rai no longer solely controls.

⛔ **SUPERSEDED 2026-08-06 — MIT throughout; there is no split** (Master Plan R3). *The original decision, retained as the record:* **Decision: split the licence at the package boundary, not at the repo boundary.** `packages/protocol/` and `packages/types/` ship **Apache-2.0**; everything else in `core/`, plus `shell/` and `ui/`, ships **AGPL-3.0-only**. The proprietary mobile app then consumes two permissively licensed packages like any third party would, and the question stops being a question.

Second-order benefit, and it is a real one: a permissively licensed wire protocol invites third-party clients (a Neovim plugin, a CLI, someone's Raycast extension) without any of them having to open-source their work. That is a positioning asset, not a concession. It is also the honest shape: a protocol that nobody else may implement is not a protocol, it is an internal calling convention.

### 0.2 `@anthropic-ai/claude-agent-sdk` is proprietary and must not be linked into an AGPL binary

> [!CAUTION] ⛔ **REVERSED 2026-08-06 — the SDK is ADOPTED.** (Master Plan R2.)
> **The licence half of this section is void because its premise is gone**: there is no AGPL binary to link into. MIT places no restriction on combining with a proprietary dependency, so the "textbook GPL-incompatible-library problem" described below simply does not arise. The facts it establishes about the SDK's licence remain **accurate and worth keeping** — the npm field really does read `SEE LICENSE IN README.md`, there is no `LICENSE` file in the repo, and use is governed by Anthropic's Commercial Terms of Service. Under MIT that is a dependency-hygiene note, not a blocker.
>
> ⭐ **And the unstated second objection — that the SDK might mean metered API billing — was measured and is false.** `query()` **spawns the user's own installed `claude` binary**: the SDK's own types document `pathToClaudeCodeExecutable` as *"Path to the Claude Code executable. Uses the built-in executable if not specified"*, and *"the subprocess inherits `process.env`"*. It ships eight per-platform bundled Claude Code executables precisely because it is a process wrapper, and `ApiKeySource` includes `'oauth'` as a first-class value reported back per turn. So the SDK authenticates on the user's **Claude subscription**, exactly as the clean-room wrapper below would, and **per-token cost is identical between the two options**.
>
> ⭐ **The clean-room wrapper described below is therefore no longer required — but the discipline around it survives**: pass the user's installed binary explicitly rather than relying on the bundled one, **strip the SDK's bundled per-platform executables at packaging** (`pingdotgg/t3code`'s `DESKTOP_FILE_EXCLUSIONS` is the worked precedent), never bundle a harness binary of our own, and **never read a credential**. The adapter can assert `apiKeySource === 'oauth'` and warn if a metered key ever takes over — a guarantee the clean-room path would not have given for free.

The stack note treats this package purely as a packaging problem (asarUnpack, notarize the nested binary, "budget a day"). It is also a licence problem, and the licence problem is the bigger one.

Verbatim, the entire contents of `LICENSE.md` in `@anthropic-ai/claude-agent-sdk@0.3.221`, fetched from unpkg 2026-08-04:

> "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance."

The npm `license` field reads `SEE LICENSE IN README.md`. This is not an OSI licence and it is not AGPL-compatible. `@anthropic-ai/claude-code@2.1.221` carries the same field.

If Rennet `import`s that SDK and calls its functions in-process, Rai is conveying a combined work containing an AGPL part and a proprietary part he has no right to relicense. He cannot satisfy AGPL §5/§6 for the combination. This is the textbook GPL-incompatible-library problem and no amount of sole authorship fixes it, because the part he does not own is Anthropic's.

**Decision: never link a proprietary harness SDK. Spawn the user's own harness binary as a child process and speak a normalised protocol over stdio.**

Same FSF test, other direction. From [GPL FAQ, "When is a program and its plug-ins considered a single combined program?"](https://www.gnu.org/licenses/gpl-faq.html#GPLPlugins):

> "A main program that uses simple fork and exec to invoke plug-ins and does not establish intimate communication between them results in the plug-ins being a separate program."

The mechanism already exists and I verified it locally: `claude -p --output-format stream-json --input-format stream-json` is a documented headless mode on the installed CLI (`claude --help`, 2026-08-04). The adapter reads JSONL off stdout, which is the 40-line reader the stack note already budgeted. Write it clean-room against the CLI's observable output; do not import the SDK even for its `.d.ts`.

This decision pays four times over:

1. Licence problem gone.
2. **The notarization nested-binary trap disappears entirely.** No bundled Anthropic binary means no `asarUnpack` entry, no separate hardened-runtime signature on a third-party Mach-O, no notarization of code Rai did not build. The "budget a day" line item deletes itself.
3. It *is* the ratified zero-config North Star ("the tool finds what's already on your machine"), now with a licence-compliance reason on top of the UX reason.
4. Redistribution question never arises: Rai is not shipping Anthropic's binary, the user installed it.

Cost, stated honestly: a user with no harness installed gets a first-run screen telling them to install one, rather than a working app out of the box. That is the correct trade for a BYOK product and it matches Critiq's posture anyway.

`@openai/codex-sdk@0.146.0` and `@openai/codex@0.146.0` are **Apache-2.0** (npm registry, 2026-08-04) and *may* be linked and bundled: Apache-2.0 is one-way compatible into AGPLv3. `@anthropic-ai/sdk@0.115.0` is **MIT** and is fine for the tier-two single-shot utility calls. So the two-tier LLM design survives intact; only the agentic Claude path changes shape, and it changes to the shape the product wanted anyway.

---

## 1. macOS pipeline: signing and notarization

### Decisions

| Question | Decision | Confidence |
|---|---|---|
| Certificate | **Developer ID Application** (Apple Developer Program, £79/$99 a year) | High |
| Signing tool | **electron-builder 26.x**, not Forge's makers | Medium-high, see rationale |
| Hardened runtime | **On**, mandatory for notarization | Certain |
| Entitlements | `com.apple.security.cs.allow-jit` only, plus inherit file for helpers. Nothing else unless a build failure proves it necessary | Medium, needs the spike |
| Architecture | **Universal (`--universal`) from day one** | High, see the runner-retirement argument |
| Formats | **DMG for humans, ZIP for the updater.** Both, always | Certain |
| Notarization auth | **App Store Connect API key** (`.p8`), never Apple ID + app-specific password | High |
| Stapling | Staple the `.app`, then build the DMG, then staple the DMG. Never try to staple the ZIP | Certain |

### Rationale

**electron-builder over Forge, reluctantly.** The stack note recommends Forge 7 for scaffolding and electron-builder for distribution, and the split is right, but it is worth being explicit about why the distribution half lands where it does. electron-builder documents `mac.notarize: true` with `hardenedRuntime`, `entitlements`, `entitlementsInherit`, `signIgnore`, and the three credential strategies as first-class config keys ([electron-builder notarization docs](https://www.electron.build/docs/features/code-signing/notarization/)), and it is the only path that produces `latest-mac.yml`, which is a hard requirement for `electron-updater` (§2). Forge's `osxSign: {}` / `osxNotarize` is genuinely simpler ([Forge macOS signing guide](https://www.electronforge.io/guides/code-signing/code-signing-macos)) and its `optionsForFile` callback is the cleaner mechanism for per-file entitlements, but Forge's Squirrel.Mac path does not give the update-feed control §2 needs. Use Forge for `dev`, electron-builder for `make`. This is what the stack note's package.json sketch already does; I am ratifying it rather than changing it.

**Entitlements: start minimal, add only under evidence.** `@electron/notarize`'s own README states the app "may need to be signed with `hardenedRuntime: true`, with the `com.apple.security.cs.allow-jit` entitlement", and that the extra Electron 11-and-below entitlement should be omitted on 12+. Everything else people copy-paste from Stack Overflow (`allow-unsigned-executable-memory`, `disable-library-validation`) is there to work around bundled native code we deliberately do not have. Apple flags both as restricted under hardened runtime in [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues). **The zero-native-deps constraint from the stack note buys us the minimal entitlement set; do not spend it before we have to.** If the build fails without one, that is a signal that a dependency snuck in a compiled artefact, and the right response is to look at the dependency.

Also from that page: `com.apple.security.get-task-allow` must not be present in a notarized release build. Add a CI assertion for its absence (see §3), because it is the entitlement that silently arrives from a debug build config.

**Universal, and the reason is a runner deadline, not aesthetics.** GitHub is migrating `macos-latest` to macOS 26 (migration began 15 June 2026, 30 days) and has stated that **x86_64 macOS runners go away after the macOS 15 image retires in Fall 2027** ([GitHub Actions image migrations changelog, 2026-05-14](https://github.blog/changelog/2026-05-14-github-actions-upcoming-image-migrations/)). Cross-compiling an Electron app for x64 from an arm64 runner is only painless when there is nothing to compile, which is precisely our situation: electron-builder downloads the prebuilt x64 Electron and packages our pure-JS bundle around it. So build universal now, while both paths are trivially available, rather than discovering the constraint in 2027. `@electron/universal` merges the two asars and errors loudly on files that exist in one arch and not the other, controllable via `singleArchFiles` / `x64ArchFiles` / `infoPlistsToIgnore` ([electron/universal README](https://github.com/electron/universal)). With no native deps there should be nothing to exclude; if the merge errors, something arch-specific got in and we want to know.

Cost: roughly double the download. Acceptable for a tool whose users are engineers on fast connections, and it removes an entire class of "I downloaded the wrong one" support.

**DMG plus ZIP is not a choice.** electron-builder's own auto-update docs are unambiguous: the **"zip target for macOS is required for Squirrel.Mac, otherwise `latest-mac.yml` cannot be created"** ([electron-builder auto-update](https://www.electron.build/docs/features/auto-update/)). The default mac target is already DMG+ZIP. The DMG is what a human downloads and drags; the ZIP is what the updater consumes and what nobody should ever click.

**Stapling: the ZIP asymmetry catches people.** You may submit a ZIP for notarization, but you cannot staple a ticket to a ZIP; the documented remedy is to staple each item you put in the archive. Apple's supported staple targets are the app bundle, disk image, and flat installer package. So the order is: sign → notarize → staple the `.app` → build the DMG from the stapled `.app` → notarize and staple the DMG → zip the stapled `.app`. Ticket inside both artefacts, offline first launch works, no Gatekeeper round trip to Apple.

**Gatekeeper first run, current behaviour.** macOS Sequoia removed the Control-click bypass; an app that fails Gatekeeper now requires the user to visit System Settings → Privacy & Security → Open Anyway, within an hour of the first refusal, and authenticate. macOS 26 keeps that flow. For a correctly signed, notarized, **stapled** build none of this fires: the user gets the ordinary "downloaded from the internet" confirmation and the app opens. This is the entire reason notarization is non-negotiable even though nothing forces it technically: the alternative is walking every user through System Settings, which is a product failure, not a security posture.

### Runbook sketch

Not a script yet. This is the shape the script has to have; §3 turns it into CI.

**One-time setup (Rai, manual, roughly 40 minutes)**

1. Enrol in the Apple Developer Program as an **individual**. Team ID becomes `APPLE_TEAM_ID`. (See §7 for the entity question.)
2. Create a **Developer ID Application** certificate. Export to `.p12` with a strong password. `base64 -i cert.p12 | pbcopy` → `CSC_LINK`; password → `CSC_KEY_PASSWORD`.
3. App Store Connect → Users and Access → Integrations → create an **App Store Connect API key** with the *Developer* role. Download `AuthKey_XXXXXXXXXX.p8` **once** (Apple will not let you download it twice). Record the key ID from the filename and the issuer UUID from the page.
4. Store all five values in 1Password. Nothing lands in a dotfile.

**Per release (the pipeline)**

```
1  pnpm build                       # tsdown core/, vite renderer, tsc --noEmit gate
2  electron-builder --mac --universal --publish never
   ├─ @electron/universal merges x64 + arm64 asars
   ├─ @electron/osx-sign signs every Mach-O inside the bundle,
   │    hardened runtime, --timestamp, entitlements + entitlementsInherit
   ├─ @electron/fuses flips RunAsNode / NodeOptions / NodeCliInspect off,
   │    OnlyLoadAppFromAsar on   ← must run BEFORE signing (afterPack, not afterSign)
   └─ @electron/notarize submits via notarytool, waits, staples
3  assert:  codesign --verify --deep --strict --verbose=2 Rennet.app
4  assert:  codesign -d --entitlements - Rennet.app | grep -c get-task-allow  == 0
5  assert:  spctl -a -vvv -t install Rennet.app         → "accepted, source=Notarized Developer ID"
6  assert:  stapler validate Rennet.app  AND  stapler validate Rennet.dmg
7  gh release create / upload: Rennet-<ver>-universal.dmg, -universal.zip,
                               latest-mac.yml, *.blockmap
```

Step 2's fuses ordering is the one sequencing trap that survives after dropping the bundled harness binary: flipping a fuse rewrites the Electron binary, so it must happen before the signature is computed or the signature is invalid. electron-builder's `afterPack` hook is the right place.

Steps 3 to 6 are the calibration. **A signing step that cannot fail has not passed** — each of those four assertions must be proven to fail on purpose once, on a deliberately broken build, before the pipeline is trusted. Cheapest positive control: build once with `hardenedRuntime: false` and confirm notarization rejects it.

### Alternatives rejected

- **Ad-hoc signing / no notarization.** Forces every user through System Settings → Open Anyway and silently breaks auto-update (Squirrel.Mac requires a valid signature). Not viable for a product Rai wants strangers to install.
- **Per-arch builds instead of universal.** Halves download size, doubles release assets, adds an arch-detection burden to the update feed (`update.electronjs.org` defaults an untagged mac asset to `-x64`, which is exactly the footgun), and walks into the 2027 x86_64 runner retirement. Revisit only if bundle size becomes a real complaint.
- **PKG installer.** Needs a second certificate (Developer ID Installer), gives a worse experience for a drag-to-Applications app, and buys nothing without a system-level component.
- **Homebrew cask as the primary channel.** Good as a *secondary* channel later; it still needs the signed, notarized artefact, so it is additive rather than an alternative.

---

## 2. Auto-update

### Decisions

| Question | Decision |
|---|---|
| Client | **`electron-updater` 6.8.9**, not `update-electron-app` |
| Feed | **GitHub Releases**, `publish: { provider: "github" }` |
| Channels | **`dogfood` first, then `latest`.** Rai's daily driver runs `dogfood` |
| Delta updates | **Not available on macOS. Plan for full downloads** |
| Downgrade | `allowDowngrade: false` in normal operation; **roll forward, never back** |
| Store safety | **Schema version gate in the event store, checked on boot, before any migration** |

### Rationale

**`electron-updater` over `update-electron-app`, reversing the stack note's provisional call.** The stack note recommends starting on `update-electron-app` because it is free and zero-infrastructure. That recommendation was made before the channel requirement existed. `update.electronjs.org`'s [documented requirements](https://github.com/electron/update.electronjs.org) are a public GitHub repo, builds published to GitHub Releases, and code signing on macOS — all of which we satisfy — but it is a single-feed service with **no channel concept**. Since v1 is explicitly Rai's daily driver and needs a dogfood channel that ships ahead of everyone else, that is disqualifying on the first requirement rather than a later one. `electron-updater` publishes to the same GitHub Releases at the same zero cost, so nothing is being bought here except configurability.

Its channel model is version-tag driven: a `package.json` version of `1.2.3-dogfood` builds to the `dogfood` channel, and `generateUpdatesFilesForAllChannels: true` emits `latest-mac.yml` alongside `dogfood-mac.yml` so both feeds stay coherent ([electron-builder release-using-channels](https://www.electron.build/docs/tutorials/release-using-channels/)). Note `allowPrerelease` is GitHub-provider-only and defaults to true when the running app's own version carries a prerelease component, which means **a dogfood build stays on dogfood by default and a stable build never accidentally jumps onto it.** That default is the behaviour we want, which is a pleasant surprise; do not override it.

**GitHub Releases is a legitimate CDN for this.** Per [GitHub's release documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases): each release asset must be under 2 GiB, up to 1000 assets per release, and there is **no limit on total release size or bandwidth**. A universal Electron build is roughly 200-300 MB, so the only real constraint is the general acceptable-use prohibition on placing undue burden on GitHub's servers, which a desktop app polling for updates does not do.

**Delta updates: do not plan for them.** electron-builder's differential download is **NSIS only**; macOS has never had it ([electron-builder issue #7547](https://github.com/electron-userland/electron-builder/issues/7547), still open in 2026). Squirrel.Mac downloads the whole ZIP. With a universal build that is a 200-300 MB download per update, which argues directly for **not** shipping daily builds to the `latest` channel. Ship dogfood daily if you want, ship stable on a cadence.

**Downgrade safety with the event-sourced SQLite store.** This is where an update system stops being packaging and becomes data integrity, and it is the part most likely to eat a weekend.

The event store is append-only with derived projections and a snapshot per review session. Roll-forward migrations on that shape are easy; **roll-back is not, because a newer build can write events an older build cannot interpret**, and the older build's projection rebuild will either crash or, far worse, silently produce a wrong review state. A review tool that quietly forgets which hunks you read has destroyed the only thing it is for.

Rules, in the order the boot path must apply them:

1. **A `schema_version` row in the SQLite store, read before any other query.** Not derived, not inferred from table presence: a single integer written by the migration that created the current shape.
2. **On boot, compare against the binary's `SUPPORTED_SCHEMA_VERSION`.** Store version *lower* → run forward migrations inside one transaction. Store version *higher* → **refuse to open the store**, show a clear "this review database was written by a newer version of Rennet" screen with a download link. Never open it read-only and never guess.
3. **Every event carries its own `type` and a `v` field.** Unknown event types are preserved verbatim, then projection and publishing stop with an explicit upgrade-required error. Never skip-and-continue: that can construct a plausible but false review state.
4. **Back the store up before every forward migration**, to `store.sqlite.pre-<n>.bak`, keep the last three. Cheap, and it is the only thing that turns a bad migration from an incident into an inconvenience.
5. **`allowDowngrade: false`** in the updater. If a release is bad, the fix is to publish a *higher* version containing the revert. electron-builder's own staged-rollout guidance says the same thing for the same reason: users who already took the bad build will otherwise sit on it forever.
6. **`stagingPercentage` in `latest-mac.yml` as the blast-radius control.** Ship a stable release at 10%, watch, raise it. It is a hand-edit of a YAML file in a GitHub Release, so it costs one commit and no infrastructure.

**Channel strategy, concretely.**

- `dogfood` — every merge to `main` that passes CI. Audience: Rai, and later a handful of invited people. Version `X.Y.Z-dogfood.N`.
- `latest` — tagged, deliberate, `stagingPercentage` ramped. Audience: everyone.
- No `beta` channel until there is a population to put in it. Two channels is the smallest set that supports "Rai is the first user", and adding a third before anyone asks is ceremony, which is the product's declared villain.

---

## 3. CI/CD

### Decisions

- **GitHub Actions**, `macos-latest` pinned by explicit label, not the floating alias.
- **Secrets as repository secrets in a public repo**, with the release job gated on a **protected environment** so a fork PR can never reach them.
- **Two workflows**: `ci.yml` (every push and PR, no secrets, no signing) and `release.yml` (tag-triggered, signs, notarizes, publishes).
- **Notarization wait is inline**, not a background poll. Budget 20 minutes of wall clock and set the job timeout to 45.

### Rationale

**Pin the runner label.** `macos-latest` moved to macOS 26 during a 30-day migration starting 15 June 2026, and `macos-15` remains targetable ([GitHub changelog](https://github.blog/changelog/2026-05-14-github-actions-upcoming-image-migrations/)). Signing and notarization behaviour is Xcode-version-sensitive, so a floating label means a release can break on a day nobody touched the repo. Pin to a specific image, bump it deliberately, and let that bump be its own PR that produces a test release.

**The secrets question is the one that actually matters in a public repo.** Five secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (base64 `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, plus `APPLE_TEAM_ID` which is not really a secret. electron-builder's docs state the obvious rule plainly: never commit certificates or passwords, always inject via CI secrets. The non-obvious part for an **OSS** repo:

- Secrets are **not** exposed to workflows triggered by `pull_request` from a fork. That is GitHub's default and it is the load-bearing protection.
- **Never use `pull_request_target`** in this repo. It runs with the base repo's secrets against the fork's code, which is a credential-exfiltration primitive handed to any stranger who opens a PR. This is the single highest-severity thing to get wrong here and it is a one-line mistake.
- Put the release job in a **protected GitHub Environment** with a required reviewer (Rai). Then even a compromised workflow file on a branch cannot mint a signed build without a human clicking approve.
- Prefer the **App Store Connect API key** over Apple ID plus app-specific password. electron-builder's own docs give the reason: "API keys don't expire and don't require two-factor authentication, making them ideal for CI." An app-specific password rots and takes a release with it.
- The `.p8` must be written to disk for `notarytool`; write it to the runner's temp dir, never the workspace, and let the ephemeral runner be the cleanup.

**Reproducibility: be honest about what is achievable.** A signed, notarized macOS app is **not** byte-reproducible. The signature embeds a secure timestamp from Apple's TSA, the notarization ticket is stapled after the fact, and both change every build by design. Anyone claiming a reproducible signed `.app` is claiming something Apple's own requirements forbid. What *is* achievable and worth doing, because for an AGPL local-first review tool "can I verify this binary came from that source" is a positioning claim as much as a security one:

1. **Reproducible pre-signing artefact.** `pnpm install --frozen-lockfile`, pinned Node and pnpm versions, `SOURCE_DATE_EPOCH` set from the commit timestamp, and publish the **SHA-256 of the unsigned `app.asar`** in the release notes. That hash *is* deterministic given the lockfile, and it is the part that contains our code.
2. **Publish the exact build inputs**: commit SHA, runner image label, Node version, pnpm version, Electron version. Four lines in the release body.
3. **Ship `THIRD-PARTY-NOTICES.md` as a release asset and inside the bundle** (§4.4). It is an MIT obligation, not a nicety.
4. Defer SLSA provenance / `actions/attest-build-provenance` to a later pass. It is cheap to add and it is not what makes the difference at one user.

**Workflow shape.**

```yaml
# ci.yml     on: [push, pull_request]        runner: macos-latest-pinned
#   typecheck (tsc --noEmit, TS 7)  ·  biome check  ·  vitest run
#   electron-builder --dir  (package, do NOT sign)   ← proves packaging on every PR
#   playwright _electron smoke test

# release.yml  on: push tags 'v*'            runner: macos-latest-pinned
#   environment: release            ← protected, requires Rai's approval
#   timeout-minutes: 45
#   steps: build → electron-builder --mac --universal --publish always
#          → the four assertions from §1's runbook
#          → gh release edit --draft=false
```

The `--dir` package step in `ci.yml` is the cheap insurance: it catches "the build is broken" on the PR rather than at tag time, without needing a single secret.

---

## 4. AGPL mechanics

### 4.1 Repo layout: one public repo plus one private repo

**Recommendation: single public monorepo for everything open, a separate private repo for mobile.**

Not "single repo with a proprietary `mobile/` directory". Git visibility is per-repository, so a public monorepo containing proprietary mobile source publishes the mobile source. There is no partial-visibility mechanism that works.

```
github.com/<rai>/rennet                      PUBLIC
├── LICENSE                                  full AGPL-3.0 text (repo default)
├── LICENSES/
│   ├── AGPL-3.0-only.txt
│   ├── Apache-2.0.txt
│   └── MIT.txt                              for lifted third-party files
├── REUSE.toml                               root: default AGPL-3.0-only, © Rai Butera
├── COPYRIGHT.md                             ownership + dual-licensing statement
├── CONTRIBUTING.md                          §4.5
├── THIRD-PARTY-NOTICES.md                   generated, shipped in the bundle
├── packages/
│   ├── protocol/    Apache-2.0   REUSE.toml  ← wire protocol, zod schemas
│   ├── types/       Apache-2.0   REUSE.toml  ← domain types only, no logic
│   └── core/        AGPL-3.0-only            ← decomposition, anchoring, event store
├── apps/
│   └── desktop/     AGPL-3.0-only            ← shell/ + ui/
└── docs/            CC-BY-SA-4.0 or AGPL, pick one and say so

github.com/<rai>/rennet-mobile               PRIVATE, proprietary
└── consumes @rennet/protocol + @rennet/types from npm (Apache-2.0)
```

**Why per-package licences in one repo rather than two open repos.** Splitting `core/` and `desktop/` into separate repos to keep licences tidy buys nothing (they are the same licence) and costs atomic cross-cutting commits, which for a project at this stage is the expensive thing. Per-package licensing inside one repo is a solved, tooled problem: [REUSE 3.3](https://reuse.software/spec-3.3/) exists for exactly this, `REUSE.toml` nests, and `fsfe/reuse-tool` (actively maintained, pushed 2026-07-24) lints it in CI. One `reuse lint` step and the layout cannot silently drift.

**Why mobile is a separate repo and consumes protocol from npm.** Publishing `@rennet/protocol` and `@rennet/types` to npm under Apache-2.0 and having the mobile app depend on them *as a published package* is the discipline that makes 0.1 true rather than merely intended. If mobile ever imports across a workspace path into an AGPL package, the build breaks; if it depends on a published Apache-2.0 package, it cannot. The constraint enforces itself, which is the Brita filter test.

Cost: protocol changes stop being one atomic commit and become a publish plus a bump. That is a real friction and it is the right one, because the protocol is versioned from v1 anyway (ratified in [[References/Orca and Paseo Pairing]]), so cross-repo drift is a versioning problem, which is what it should have been all along.

**SPDX identifier: `AGPL-3.0-only`, not `AGPL-3.0`.** Plain `AGPL-3.0` is a **deprecated** SPDX identifier ([SPDX license list](https://spdx.org/licenses/AGPL-3.0-only)); the current identifiers are `AGPL-3.0-only` and `AGPL-3.0-or-later`. Use `-only`. `-or-later` hands the FSF a unilateral right to change Rai's licensing terms in a future AGPLv4, which is a strange thing to give away when you are also selling commercial licences against those terms.

Every source file gets a two-line header. This is what makes the licence machine-checkable rather than aspirational:

```ts
// SPDX-FileCopyrightText: 2026 Rai Butera
// SPDX-License-Identifier: AGPL-3.0-only
```

### 4.2 What AGPL §13 actually means for a desktop app

The precise answer, because the imprecise answer is the one that causes trouble later.

§13 verbatim, first paragraph ([SPDX AGPL-3.0-only](https://spdx.org/licenses/AGPL-3.0-only), [OSI](https://opensource.org/license/agpl-v3)):

> "Notwithstanding any other provision of this License, **if you modify the Program**, your modified version must prominently offer all users interacting with it remotely through a computer network (if your version supports such interaction) an opportunity to receive the Corresponding Source of your version by providing access to the Corresponding Source from a network server at no charge, through some standard or customary means of facilitating copying of software."

Three conditions, all of which must hold before anything is owed:

1. **You modified the Program.** An unmodified AGPL program run as a server triggers nothing.
2. **Users interact with it remotely over a network.** §0 is explicit that "Mere interaction with a user through a computer network, with no transfer of a copy, is not conveying" — network interaction is not distribution, it is only the §13 trigger.
3. **Your version supports such interaction.**

**For v1 desktop-only: §13 is inert.** A person double-clicking an app on their own Mac is not interacting with it remotely over a network. Nothing in the local-first architecture (git on disk, SQLite on disk, harness as a child process, GitHub API calls *outbound*) constitutes anyone interacting with Rennet remotely. Being an HTTP *client* is not being a server.

**And here is the part the brief's premise gets wrong, so state it plainly: §13 stops being inert the moment the mobile pairing server ships.** The ratified mobile architecture is "desktop is the server, mobile the client", with a WebSocket listener the phone connects to. That is a person interacting with the Program remotely through a computer network. It is the exact fact pattern §13 was written for.

What that actually costs, though, is close to nothing, and for a good structural reason:

- **Rai owes nothing new.** He publishes the source already; §13's requirement is satisfied by a link in the app's About screen pointing at the public repo tag matching the running build. Add that link on the day pairing ships, not later.
- **An unmodified downstream user owes nothing.** Condition 1 fails for them: they did not modify anything.
- **A modified downstream fork that runs paired remote access owes its users source.** That is not a bug. That is precisely the moat AGPL was chosen for, and it is the reason AGPL rather than GPL was the right pick given that a mobile-companion product exists.
- **The proprietary mobile app is not affected**, because it is a *separate program* speaking a versioned wire protocol over a socket (FSF: "pipes, sockets and command-line arguments are communication mechanisms normally used between two separate programs"), and because after §0.1 it does not link any AGPL code at all.

One live caveat worth writing down rather than discovering: the FSF's own [AGPLv3ServerAsUser FAQ](https://www.gnu.org/licenses/gpl-faq.html#AGPLv3ServerAsUser) says "It doesn't matter if you call the program a 'client' or a 'server', the question you need to ask is whether or not there is a reasonable expectation that a person will be interacting with the program remotely over a network." Once pairing ships, the honest answer for Rennet desktop is yes.

**Concrete requirement, one line: when pairing ships, add "About → Source code" linking to the exact tag, and make the release pipeline assert the tag exists.** Do not defer this to a compliance pass; put it in the pairing PR.

### 4.3 Dual licensing as sole author: the discipline

Dual licensing works on exactly one thing: **Rai owns 100% of the copyright in the AGPL code.** The instant he does not, he cannot offer a commercial licence covering the whole work, because that requires permission from every copyright holder. There is no partial version of this; a fifteen-line PR from a stranger, merged without a grant, is enough to make the commercial licence unofferable over that file forever.

**The trap the brief names is real and it is the default outcome, not an edge case.** The failure mode is not malice. It is a friendly stranger opening a typo-fix PR on day three, Rai merging it in ten seconds because it is obviously fine, and the policy not existing yet. There is no clean unwind: you must either get a retroactive grant from someone who may not answer, or revert and rewrite the change independently, which is awkward when the change is a typo fix and impossible when it is a feature.

**So the policy must exist before the repo is public. Not before v1, not before the first PR: before `gh repo create --public`.**

**Recommendation: DCO for provenance plus an explicit inbound licence grant, with the repo set to accept issues but not code, until Rai deliberately opens it.**

Why not the obvious CLA-bot route: the tooling has decayed. `cla-assistant/cla-assistant` was last pushed **2024-06-06**, and `contributor-assistant/github-action` (CLA Assistant Lite) is **archived** as of 2026-03-23 (GitHub API, checked 2026-08-04). The [Harmony Agreements](https://www.harmonyagreements.org/) templates are still the best-drafted texts available but the selector tool has not been touched since 2020. Building the contribution policy on infrastructure that is already archived is a check that will quietly stop failing.

What is alive: `dcoapp/app` (the DCO GitHub App, ISC, pushed 2026-08-04) enforces `Signed-off-by` on every commit. But **DCO alone is not sufficient for dual licensing** — it certifies provenance and that the contributor had the right to submit under the project's licence. It does not grant Rai the right to relicense their code commercially. That has to be an explicit additional grant.

**Concrete mechanism, three parts, no third-party service:**

1. **`dcoapp/app` installed**, requiring `Signed-off-by` on every commit. Provenance, automatic, maintained.
2. **`CONTRIBUTORS.md` in the repo.** A contributor's *first* PR must add their own line to it. That line is the grant, and it is in the diff, signed off, in git history, timestamped, with their GitHub identity attached. No external service holds the evidence.
3. **A twelve-line GitHub Action** that fails the PR when the author's GitHub handle is absent from `CONTRIBUTORS.md`. Rai writes it; it depends on nothing that can be archived.

For a contribution large enough that the stakes justify it (anything beyond, say, 50 lines, or anything in `packages/core`), fall back to a signed **[Apache ICLA](https://www.apache.org/licenses/contributor-agreements.html)**-derived text by email. Its §2 grants a copyright licence including the right to **sublicense**, which is the operative word: sublicensing rights are what make commercial relicensing lawful. Do not invent CLA text.

**Until that machinery exists: `.github/PULL_REQUEST_TEMPLATE.md` states that code PRs are not currently accepted and points at issues and discussions.** Issues, bug reports, and design discussion are welcome from day one and cost nothing. The policy is about copyright in *code*, and saying so plainly is more respectful of people's time than silently sitting on their PR.

### 4.4 Attributing lifted MIT code (Orca) inside an AGPL project

Per [[References/Orca and Paseo Pairing]], Orca's `mobile/src/transport/*` is **MIT (Lovecast Inc.)** and liftable; Paseo is AGPL and is patterns-only.

MIT's condition is short and absolute: the copyright notice and permission notice must be included in **"all copies or substantial portions of the Software"**. A shipped `.app` bundle is a copy. So the notice has to travel into the binary, not just sit in the repo. Mechanically:

1. **Quarantine lifted code in a marked directory.** `packages/pairing/src/vendor/orca/`. Never scatter lifted files among original ones; the boundary must be visible in a file path, because in six months nobody will remember which file came from where.
2. **Per-file SPDX headers preserving the original copyright.** Do not overwrite it with Rai's:
   ```ts
   // SPDX-FileCopyrightText: 2025 Lovecast Inc.
   // SPDX-License-Identifier: MIT
   // Vendored from stablyai/orca @ <commit-sha>, <path>. Modifications © 2026 Rai Butera, MIT.
   ```
   The commit SHA is what makes this auditable rather than decorative.
3. **`packages/pairing/src/vendor/orca/REUSE.toml`** declaring MIT for that path, overriding the repo default.
4. **`LICENSES/MIT.txt`** with the full text.
5. **`THIRD-PARTY-NOTICES.md`**, generated at build time from the dependency tree plus vendored files, **copied into `Resources/` in the app bundle** and surfaced at About → Open Source Licences.
6. **Do not relicense those files to AGPL.** The combined *work* is AGPL; the vendored *files* stay MIT and remain extractable under MIT by anyone. Both statements are true at once and this confuses people, so say it in `COPYRIGHT.md` explicitly.
7. **MIT-into-AGPL is uncontroversially fine** — MIT is a lax permissive licence with no terms AGPL cannot satisfy. Attribution is the only obligation and step 5 discharges it.

Verified 2026-08-04: `@pierre/diffs@1.3.2`, `@atlaskit/pragmatic-drag-and-drop@2.0.1`, and `@openai/codex-sdk@0.146.0` ship a `LICENSE`/`LICENSE.md` but **no `NOTICE` file** (probed both; the LICENSE hits are the positive control proving the probe reaches). So Apache-2.0 §4(d) NOTICE propagation is not currently triggered by any of them. Re-check on major upgrades, since a NOTICE file can appear at any release.

### 4.5 CONTRIBUTING.md, draft

Draft, not final. Legal wording in the grant paragraph should get a human read before the repo goes public (see the final message).

```markdown
# Contributing

Thanks for reading this before opening a PR. That already puts you ahead.

## Right now

Rennet is a solo project and is not yet accepting code contributions.
Issues, bug reports, feature discussion, and design argument are very welcome
and are the most useful thing you can send.

If you have already written a patch, please open an issue describing it rather
than a PR. I will tell you honestly whether I want it.

## Why the friction

Rennet's core and desktop app are AGPL-3.0-only. The mobile companion is
proprietary, and I offer commercial licences for the core. That is only
possible while I hold copyright in all of the AGPL code. Merging a contribution
without an explicit licence grant would make part of the project impossible to
licence commercially, permanently and irreversibly. So the grant has to come
first, and the mechanism for collecting it has to exist before the first PR,
not after.

## When code contributions open

Two things will be required.

**1. Sign off every commit (DCO).**

    git commit -s -m "your message"

This adds `Signed-off-by: Your Name <you@example.com>` and certifies the
[Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the contribution, or have the right to submit it.

**2. Add yourself to CONTRIBUTORS.md in your first PR.**

Adding your line means:

> I grant Rai Butera a perpetual, worldwide, non-exclusive, royalty-free,
> irrevocable copyright licence to reproduce, prepare derivative works of,
> publicly display and perform, sublicense, and distribute my contributions
> and derivative works thereof, under any licence terms, including proprietary
> terms. I retain all other rights, including the right to use my own
> contributions for any purpose. I confirm I am legally entitled to grant this,
> and that if my employer has rights to the work, I have permission to make
> this grant.

Contributions of more than ~50 lines, or any contribution to `packages/core`,
additionally require a signed contributor licence agreement by email.

## Licence of contributions

Contributions to `packages/protocol` and `packages/types` are Apache-2.0. [⛔ SUPERSEDED 2026-08-06 — everything is MIT. **Do not copy this draft into `CONTRIBUTING.md` as written**; rewrite the licence sentences for MIT first.]
Everything else is AGPL-3.0-only. Add the SPDX header matching the package your
file lives in; `reuse lint` runs in CI and will tell you if you got it wrong.
```

---

## 5. Dependency licence audit

Every licence below read from the npm registry `latest` metadata on **2026-08-04**, not from memory.

### Verdict

**The stack is AGPL-compatible with exactly one exception, and that exception is `@anthropic-ai/claude-agent-sdk`.** See §0.2. One additional item is resolved-not-flagged and one is a downstream-only consideration.

### Desktop, linked and distributed

| Package | Version | Licence | AGPL-3.0-only compatible? |
|---|---|---|---|
| **@anthropic-ai/claude-agent-sdk** | 0.3.221 | **`SEE LICENSE IN README.md`** → governed by Anthropic's Commercial Terms of Service; no `LICENSE` file in the repo | ⛔ **Row superseded 2026-08-06: PERMITTED and adopted.** The AGPL objection died with the licence flip; MIT places no restriction on combining with a proprietary dependency. Ship it, pass the user's installed `claude` binary, and strip the bundled per-platform executables at packaging. ⚠️ **It will still fail a naive dependency-licence gate**, because `pnpm licenses list` buckets it as `Unknown` — allow it by **package name**, never by allowlisting the `Unknown` bucket. |
| @anthropic-ai/sdk | 0.115.0 | MIT | Yes |
| @openai/codex-sdk / @openai/codex | 0.146.0 | Apache-2.0 | Yes, one-way in |
| **@pierre/diffs** | 1.3.2 | Apache-2.0 | Yes, one-way in |
| @pierre/theme / @pierre/theming | 2.0.0 / 1.0.0 | Apache-2.0 | Yes |
| electron | 43.3.0 | MIT | Yes |
| electron-updater / electron-log | 6.8.9 / 5.4.4 | MIT | Yes |
| shiki | 4.4.1 | MIT | Yes |
| web-tree-sitter | 0.26.11 | MIT | Yes |
| node-sqlite3-wasm | 0.8.60 | MIT | Yes |
| kysely | 0.29.4 | MIT | Yes |
| @tanstack/react-virtual | 3.14.9 | MIT | Yes |
| **@atlaskit/pragmatic-drag-and-drop** | 2.0.1 | **Apache-2.0** | Yes. **Resolves the stack note's NOASSERTION unverified item** |
| cmdk | 1.1.1 | MIT | Yes |
| **diff** (jsdiff) | 9.0.0 | **BSD-3-Clause** | Yes |
| parse-diff | 0.12.0 | MIT | Yes |
| isomorphic-git | 1.40.0 | MIT | Yes |
| @codemirror/view / @codemirror/state | 6.43.7 / 6.7.1 | MIT | Yes |
| react / react-dom | 19.2.8 | MIT | Yes |
| zustand / xstate / immer / tinykeys | — | MIT | Yes |
| zod | 4.4.3 | MIT | Yes |
| @octokit/graphql / @octokit/rest | 9.0.4 / 22.0.1 | MIT | Yes |
| tailwindcss | 4.3.3 | MIT | Yes |
| @modelcontextprotocol/sdk | 1.30.0 | MIT | Yes |

### Build and dev only (not distributed, so compatibility is moot; recorded for completeness)

electron-builder 26.15.3 MIT · @electron-forge/cli 7.11.2 MIT · @electron/notarize 3.1.1 MIT · **@electron/osx-sign 2.6.0 BSD-2-Clause** · @electron/universal 3.0.6 MIT · update-electron-app 3.3.0 MIT · **typescript 7.0.2 Apache-2.0** · **@biomejs/biome 2.5.7 MIT OR Apache-2.0** · turbo 2.10.8 MIT · tsdown 0.22.14 MIT · vitest 4.1.10 MIT · **@playwright/test 1.62.1 Apache-2.0**

### Mobile (proprietary; needs *permissive*, and gets it)

expo 57.0.10 MIT · react-native 0.86.2 MIT · @shopify/flash-list 2.3.2 MIT · @noble/curves 2.2.0 MIT · @noble/ciphers 2.2.0 MIT · nativewind 4.2.6 MIT · zod MIT · zustand MIT.

All MIT, so nothing blocks a closed-source mobile app. Obligation: MIT attribution must ship **inside the iOS app** too — an Acknowledgements screen, same requirement as §4.4, and App Review has been known to ask.

### Notes

**Apache-2.0 → AGPLv3 is one-way and that direction is ours.** The Apache Software Foundation states it directly: Apache-2.0 software can be included in GPLv3 (and therefore AGPLv3) works, but GPLv3 software cannot be included in Apache projects ([Apache GPL-compatibility](https://www.apache.org/licenses/GPL-compatibility.html)); the FSF concurs and calls Apache-2.0 its recommended permissive licence. `@pierre/diffs` and the `@pierre/*` styling chain are licence-compatible dependencies. `@openai/codex-sdk` is also licence-compatible but architecturally retired in favour of `codex app-server`; do not add it merely because licensing permits it.

**The one live consequence of that one-way-ness:** anyone who forks Rennet cannot relicense it permissively, and anyone building on Rennet's AGPL core must go AGPL. That is the intended effect. It also means **`packages/protocol` and `packages/types` must genuinely contain no AGPL-derived code**, or the Apache-2.0 label on them is false. Enforce with `reuse lint` plus a dependency-direction rule in CI: those two packages may depend on nothing inside the repo.

**`diff` is BSD-3-Clause, not MIT** as one might assume. Immaterial to compatibility, material to `THIRD-PARTY-NOTICES.md`, which must carry BSD-3's three clauses including the no-endorsement clause. Generate that file, never hand-maintain it.

**difftastic stays external and unbundled**, per the stack note. Detect-on-PATH and shell out. It is GPL-family in places and there is no reason to inherit the question.

**Chromium and Electron.** Electron itself is MIT, but the shipped binary embeds Chromium, which carries a large mixed-licence stack including LGPL components. Every Electron app has this and it is handled the same way by all of them: ship Electron's own `LICENSES.chromium.html`, which electron-builder already places in the packaged app. Verify it is present in the built bundle; do not delete it to save space.

---

## 6. Trademark and brand

Brief, because at one user this is a cheap decision that should not consume a day.

**What "registering nothing" gets you.** In the UK, unregistered rights in a name accrue automatically through use and are enforceable via **passing off** — but passing off requires proving goodwill, misrepresentation, and damage, which is expensive, evidence-heavy, and unavailable before you have goodwill to prove. At one user there is essentially nothing to enforce. In the US, common-law rights attach on use in commerce but are geographically limited.

**What a registered wordmark gets you.** From 1 April 2026 the UKIPO charges **£205** for an online application in the first class, and **£245** to renew at ten years ([UKIPO fees](https://www.ipo.gov.uk/tm3-servicesfees)). Software is Class 9 and SaaS is Class 42; a desktop app plus a paid mobile app plausibly wants both, which roughly doubles it. Registration gives a presumption of validity, a basis to act without proving goodwill, and, practically, **the paperwork the App Store, npm, and GitHub trademark-dispute processes actually respond to.**

**Recommendation: register nothing now. Do three cheap things instead, and set one trigger.**

1. **Take the assets on the day the name is ratified.** `.dev` and `.app` domains, GitHub org, npm scope. Rennet is verified clear on all of these ([[Code Review App Branding Questions]] Finalist Diligence). Squatting costs about $25 a year; recovering a name someone else took costs a rename.
2. **Write a short `TRADEMARK.md`.** Two paragraphs: the AGPL grants rights in the *code*, not in the *name* or the *logo*; forks are welcome and must be renamed; unmodified redistribution may use the name. This is what Rust, Docker, and Mozilla all do, and it is enforceable-ish as a stated policy while costing one file. Without it, an AGPL fork calling itself Rennet is genuinely awkward to object to, because the licence they are complying with does not mention the name.
3. **Use ™ in the wordmark**, not ®. ™ needs no registration. ® without registration is a criminal offence in the UK, so this is worth getting right.

**Trigger for registering: the first paid mobile sale, or the first time anyone else uses the name for a dev tool, whichever comes first.** Register in the UK first (Rai's jurisdiction), Class 9 and 42, and consider a US application only if there is US revenue. Before filing, run a proper clearance search rather than the RDAP/npm availability check already done — availability of a domain is not absence of a trademark, and those are different questions that get conflated constantly.

**One thing to do at zero cost regardless:** the Digestif diligence already found a live USPTO Class 5 mark for DIGESTIF cleared to Notice of Allowance in April 2026. Rennet's diligence found no mark in any class anywhere. **If the name flips back to Digestif at the last minute, the trademark analysis flips with it and this section stops being brief.** Worth flagging to whoever makes the final call.

---

## Open questions / refinement hooks

1. **Apple Developer Program: individual or Ltd?** Enrolling as an individual publishes Rai's legal name as the seller on the App Store and in the certificate common name. A UK limited company hides it behind a company name and separates liability from the paid mobile product, but costs incorporation, a D-U-N-S number, and Apple's slower company verification. Mobile is the forcing function; if a paid app is genuinely coming, enrol the entity now, because **migrating an existing app's team is painful and migrating a certificate is impossible.** Needs a decision before the first signed build, not before the first sale.

2. **Does `@pierre/diffs` have a public source repo?** Still unverified (stack note flagged it). Apache-2.0 grants the right to fork, but you cannot fork what you cannot find. If the answer stays no, that is a single-vendor dependency on the most load-bearing rendering layer in the product. Mitigation is not a different licence, it is a **spike-2 exit plan**: know what the fallback renderer is before committing.

3. **Does the mobile app ever need to see a diff *body*, or only tokens?** The stack note says the desktop ships pre-tokenised lines. If that holds, `@rennet/types` need never contain diff-domain types at all, and the Apache-2.0 surface shrinks to almost nothing, which is the safest possible version of §0.1. Worth confirming during the pairing spike.

4. **Where does the commercial licence live before anyone asks for one?** Recommendation is a one-line "commercial licensing available, email X" in the README and **no drafted contract until someone actually asks**, because a bad self-drafted contract is worse than none. But this needs a named trigger or it becomes indefinite.

5. **Homebrew cask: yes, when?** Post-v1. Needs the notarized artefact and a stable release cadence. Cheap once both exist. Do not do it before `latest` channel exists.

6. **Windows and Linux signing.** Deliberately out of scope here. Note only that Windows code signing changed materially in 2023 (EV / hardware-token or Azure Trusted Signing) and is a separate cost and process; the cross-platform promise in the parent note has a bill attached that has not been costed.

7. **`stagingPercentage` needs a human to advance it.** That is a manual recurring step, which is a Brita-filter violation waiting to happen. Either automate the ramp (a scheduled Action that edits the YAML on a timer if no issues are open with a `bad-release` label) or accept that stable releases go out at 100% and rely on roll-forward. Decide deliberately; do not end up doing it by hand three times.

8. **Reproducible-`app.asar` claim needs proving before it is published.** Two builds of the same commit on two runners, compare hashes. If they differ, find out why before putting the hash in release notes. A published hash that does not reproduce is worse than no hash.

---

## Bead candidates

| # | Title | Description | Priority | Depends on |
|---|---|---|---|---|
| B1 | ⛔ **DROPPED 2026-08-06 — do not action.** MIT throughout means there is no boundary to split and no REUSE/SPDX machinery to build (Master Plan R3). ⭐ **One line survives and should be kept as its own task:** the CI rule that `protocol`/`types` import nothing in-repo, now an architectural boundary. *Original row:* Split the licence boundary: Apache-2.0 protocol+types, AGPL everything else | Restructure the planned monorepo so `packages/protocol` and `packages/types` are Apache-2.0 and everything else AGPL-3.0-only. Add `REUSE.toml` at root and per-package, `LICENSES/`, SPDX headers, `reuse lint` in CI, plus a CI rule that protocol/types may not import from any in-repo package. Blocks the mobile app from ever contaminating. See §0.1, §4.1. | **P0** | — |
| B2 | Never link `@anthropic-ai/claude-agent-sdk`; write the stdio harness adapter | The SDK is "© Anthropic PBC. All rights reserved." and is AGPL-incompatible. Build the Claude adapter as a clean-room child-process wrapper over `claude -p --output-format stream-json --input-format stream-json`, auto-detected on PATH, never bundled. Deletes the asarUnpack/notarize-nested-binary work item entirely. See §0.2. | **P0** | — |
| B3 | Contribution policy live before the repo goes public | `CONTRIBUTING.md` (§4.5 draft), `CONTRIBUTORS.md`, `COPYRIGHT.md`, `.github/PULL_REQUEST_TEMPLATE.md` stating code PRs are not yet accepted, `dcoapp/app` installed, and the ~12-line Action asserting the author is in `CONTRIBUTORS.md`. **Must land in the same commit that makes the repo public.** One merged PR without this permanently damages dual licensing. See §4.3. | **P0** | — |
| B4 | Apple Developer Program enrolment: decide individual vs Ltd, then enrol | RAI-ONLY before the first public release, not local dogfood. Decide before enrolling because migration is painful-to-impossible. Produces Team ID, Developer ID Application cert, App Store Connect API key. | **P2** | public-release phase |
| B5 | Signing + notarization spike, end to end, on a hello-world Electron build | Prove the whole §1 runbook on a throwaway app before the real one exists: universal build, hardened runtime, minimal entitlements, notarytool, staple `.app` and DMG, all four assertions. **Include the deliberate-failure calibration** (build once with `hardenedRuntime: false` and confirm rejection). Was stack-note prototype #3; now much cheaper because there is no nested binary. | **P1** | B4 |
| B6 | Event-store schema versioning and downgrade refusal | `schema_version` row read before any other query; refuse to open a store written by a newer build with a clear UI; per-event `v` field with unknown-type preservation; pre-migration backup keeping three. Design it into the first event-store commit; unretrofittable afterwards. See §2. | **P1** | — |
| B7 | Release pipeline: `ci.yml` + protected-environment `release.yml` | Pinned runner label, secrets only in the protected release environment, **`pull_request_target` banned in this repo**, App Store Connect API key auth, the four post-build assertions, `gh release` upload of DMG + ZIP + `latest-mac.yml`. See §3. | **P1** | B5 |
| B8 | `electron-updater` on GitHub Releases with a `dogfood` channel | `publish: github`, `generateUpdatesFilesForAllChannels: true`, `allowDowngrade: false`, dogfood as `X.Y.Z-dogfood.N`. Verify the update actually applies on a real signed build; an updater that silently no-ops is the canonical unfalsifiable check. See §2. | **P1** | B7 |
| B9 | `THIRD-PARTY-NOTICES.md` generated at build and shipped in the bundle | Generated from the dependency tree plus vendored files, copied into `Resources/`, surfaced at About → Open Source Licences. MIT and BSD-3 obligations attach to the binary, not just the repo. Verify Electron's `LICENSES.chromium.html` survives packaging. See §4.4, §5. | **P2** | B1 |
| B10 | `TRADEMARK.md` and asset registration on name ratification | Buy `.dev` + `.app`, claim GitHub org and npm scope, write the two-paragraph trademark policy, use ™ not ®. Do not register a mark yet. **If the name lands on Digestif rather than Rennet, reopen the trademark analysis** (live USPTO Class 5 mark). See §6. | **P2** | name decision |
| B11 | AGPL §13 source link in About, shipped with the pairing feature | When the mobile pairing server lands, the desktop must offer users interacting remotely a link to the Corresponding Source for the exact running build. Put it in the pairing PR, not a later compliance pass. CI asserts the tag exists. See §4.2. | **P2** | pairing impl |
| B12 | Prove the reproducible `app.asar` hash before publishing it | Build the same commit twice on two runners, diff the unsigned asar hashes. Only publish the hash in release notes once it demonstrably reproduces. See open question 8. | **P3** | B7 |
| B13 | Cost and scope Windows + Linux signing | Windows changed to EV / hardware-token / Azure Trusted Signing; Linux has its own story. The cross-platform promise has an uncosted bill. Research, do not implement. | **P3** | — |

---

## Verification log

Primary sources, all read 2026-08-04. Anything not on this list is reasoning, not fact.

- npm registry metadata for 50 packages (licence + version), queried directly against `registry.npmjs.org`.
- `@anthropic-ai/claude-agent-sdk@0.3.221` `LICENSE.md`, fetched verbatim from unpkg.
- `claude --help` on this machine, confirming `-p --output-format stream-json --input-format stream-json`.
- NOTICE-file probe against `@pierre/diffs@1.3.2`, `@atlaskit/pragmatic-drag-and-drop@2.0.1`, `@openai/codex-sdk@0.146.0` — none present; LICENSE files present in all three as the positive control.
- GitHub API repo status: `cla-assistant/cla-assistant` (pushed 2024-06-06), `contributor-assistant/github-action` (**archived** 2026-03-23), `dcoapp/app` (pushed 2026-08-04), `electron/notarize`, `electron/update.electronjs.org`, `fsfe/reuse-tool`.
- [AGPL-3.0-only §13, §0 "convey", §1 "Corresponding Source"](https://spdx.org/licenses/AGPL-3.0-only) and [OSI](https://opensource.org/license/agpl-v3).
- [FSF GPL FAQ #MereAggregation, #GPLPlugins, #NFUseGPLPlugins, #AGPLv3ServerAsUser](https://www.gnu.org/licenses/gpl-faq.html) — full page fetched and quoted verbatim.
- [Apache Software Foundation, Apache License v2.0 and GPL Compatibility](https://www.apache.org/licenses/GPL-compatibility.html).
- [SPDX license list, AGPL-3.0-only](https://spdx.org/licenses/AGPL-3.0-only) (deprecation of plain `AGPL-3.0`).
- [REUSE Specification 3.3](https://reuse.software/spec-3.3/).
- [electron-builder: code signing](https://www.electron.build/docs/features/code-signing/), [notarization](https://www.electron.build/docs/features/code-signing/notarization/), [auto-update](https://www.electron.build/docs/features/auto-update/), [release using channels](https://www.electron.build/docs/tutorials/release-using-channels/).
- [Electron Forge macOS signing guide](https://www.electronforge.io/guides/code-signing/code-signing-macos), [Electron code signing tutorial](https://www.electronjs.org/docs/latest/tutorial/code-signing).
- [electron/notarize README](https://github.com/electron/notarize), [electron/universal README](https://github.com/electron/universal), [electron/update.electronjs.org README](https://github.com/electron/update.electronjs.org).
- [electron-builder issue #7547, differential updates NSIS-only](https://github.com/electron-userland/electron-builder/issues/7547).
- [Apple: resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues).
- [GitHub Actions upcoming image migrations, 2026-05-14](https://github.blog/changelog/2026-05-14-github-actions-upcoming-image-migrations/) (macos-latest → macOS 26; x86_64 retirement Fall 2027).
- [GitHub: about releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) (2 GiB per asset, 1000 assets, no bandwidth cap).
- [UKIPO application services and fees](https://www.ipo.gov.uk/tm3-servicesfees) (£205 first class from 2026-04-01).
- [Apache Software Foundation contributor agreements](https://www.apache.org/licenses/contributor-agreements.html), [Developer Certificate of Origin 1.1](https://developercertificate.org/), [Harmony Agreements](https://www.harmonyagreements.org/).

> [!warning] Not legal advice
> This is an engineer's reading of licence texts and FSF guidance, not a lawyer's. The AGPL analysis in §0.1, §0.2, and §4.2 drives architecture, so it is worth a real read by someone qualified before the repo goes public. Flagged items needing a human are listed in the handoff.
