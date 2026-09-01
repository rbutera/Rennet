## Context

See `proposal.md` for motivation. Today bare `/new-chat` branches into a route-local project-list front door, theme packs are session-only React state, and client settings already persist viewer-owned appearance, coach-mark, keybinding, and routing preferences in `client-settings.json`. Project addition already has one source-aware browser and one discovery/write path. Harness and forge detection already feed Settings, while Electron preload exposes the small set of native actions that cannot travel over the daemon bridge.

The welcome crosses protocol, persistence, server dispatch, renderer routing, Electron IPC, documentation, and animation. It must remain separate from the coach-mark provider and must never infer "first run" from an empty project store alone.

## Goals / Non-Goals

**Goals:**

- Make one persisted client state determine whether the full-window welcome is eligible.
- Reuse the live Settings probes, harness rulings, Model Council assignment, and Add Project flow rather than adding welcome-only configuration.
- Make theme selection and last-project routing durable viewer preferences.
- Keep the native Full Disk Access action narrow, optional, and desktop-only.
- Preserve one real New Chat surface with an in-place project switcher.

**Non-Goals:**

- Replacing, skipping, or resequencing contextual coach marks.
- Adding GitLab or Bitbucket review integrations. The tools page reports only facts current probes can establish and labels unsupported integrations honestly.
- Requesting or verifying Full Disk Access, sandboxing repositories, or adding a Rennet consent ceremony.
- Persisting code-theme selection in this change; the welcome chooses the UI pack and scheme only.
- Reworking indexing semantics or creating a second project-add implementation.

## Decisions

### Store welcome, theme, and navigation in the existing client document

`clientSettingsSchema` gains additive optional `appearance.themePack`, `welcome.completedAt`, and `navigation.lastProjectBySource`. Named settings commands mutate these slices through `FileConfigStore.update`, preserving the existing atomic-write and malformed-file refusal behavior. `settings.get` projects the values needed by the renderer.

The source-keyed project map avoids treating an id from one daemon as meaningful on another. The resolver validates every remembered id against the authoritative `projects.list` response before routing. We considered browser local storage, but it would split durable viewer state across stores and would not share the existing malformed-write behavior.

### Gate the application shell above `AppLayout`

A startup resolver inside the existing bridge, theme, router, and live-settings providers loads `settings.get` and `projects.list`. It renders the welcome instead of `AppLayout` only when the welcome marker is absent and the active source has no projects. This prevents sidebar and coach-mark registration while the welcome owns the window without coupling welcome state to coach-mark state.

Completed clients with no projects render a focused Add Project entry inside the normal shell. We considered a dedicated `/welcome` route, but route presence is not the source of truth and would allow stale deep links to resurrect first run.

### Use Motion for the authored transition

`motion` provides a scoped sequence timeline, SVG/DOM animation, teardown, and `useReducedMotion` under the repository's accepted MIT license. The sequence renders real syntax fragments from a fixed deterministic catalogue, flies them through the viewport, converges them on the authored lockup, then introduces the appearance panel. Reduced motion switches directly between the same semantic states and disables continuous word cycling.

GSAP was considered for timeline ergonomics, but its custom license does not fit the current dependency allow-list without a product-level exception. Hand-written timers and CSS keyframes were rejected because coordinated cancellation, staged convergence, and reduced-motion behavior would be more fragile.

### Persist appearance through the app-global provider

`ThemePrefProvider` initializes from `settings.get`, applies the pack attribute to the document root, and writes a selected pack through the named client-settings command. The existing appearance screen and welcome use the same provider, so clicking a preview changes the complete window immediately and the setting survives restart. Scheme continues through `settings.setAppearance` and `AppearanceSync`.

### Apply review choices through current production controls

The welcome reads `harness.hosts` for the active source. Dual mode writes both detected harnesses enabled; single mode enables only the selected orchestrator. The orchestrator choice writes the `orchestrator` role's `dual` Model Council cell using the selected provider's existing single-provider assignment. These are the same persisted inputs the review pipeline already consumes.

The tools page reuses the Settings status vocabulary. GitHub authentication comes from `forge.hosts`; Claude Code and Codex come from `harness.hosts`. Git and any additional CLI facts added here are produced by server-side probes, never by renderer assumptions. An unsupported integration is identified as unsupported rather than shown as installed or absent.

### Extract the existing project-add body

The current dialog's browser/discovery/add state machine becomes a reusable component with completion and cancellation callbacks. The dialog keeps its current navigation behavior; the welcome supplies a completion callback that records the added project and advances to Ready. This keeps path validation, source selection, discovery, and persistence in one implementation.

### Keep Full Disk Access as an optional native action

`RennetBridge` gains an optional native method composed by the desktop renderer from a sender-validated preload IPC call. The main process opens the macOS Full Disk Access preference URL and reports whether the open call succeeded. Browser and mobile bridges omit the capability; the welcome only renders the action when the capability exists and the platform is macOS.

The action does not claim access was granted and does not block project selection. We considered probing the home directory or presenting a fake permission checklist, but macOS has no generic Files & Folders request API and such a probe does not establish Full Disk Access.

### Resolve bare New Chat before rendering its project view

The bare route loads projects and the source-keyed remembered id. A live remembered id wins; otherwise the first authoritative project wins and replaces stale memory. The route then redirects to the canonical query-bearing `newChatPath(projectId)`, so the existing project switcher and view remain the only project-scoped New Chat implementation. Project-scoped route entry records the project after validation.

## Risks / Trade-offs

- [Native System Settings URLs are undocumented and can change between macOS releases] → Keep the bridge result honest, use the current Full Disk Access URL, and document the manual fallback without treating the deep link as proof of permission.
- [An unavailable daemon can delay startup resolution] → Reuse the connection host's existing offline/failure surface; never invent a local project fallback while another source is active.
- [A project can be added before welcome completion and the app can close] → On restart the resolver sees the project, restores the in-progress welcome at Project/Ready, and permits completion rather than bypassing setup.
- [Writing multiple harness settings can partially succeed] → Keep the user on Review Setup on any failed write, refetch live rulings, and show the real resulting state.
- [Continuous animation can distract or cost resources] → Stop fragment motion after convergence, use a restrained word interval, pause timers when the frame unmounts, and disable cycling under reduced motion.

## Migration Plan

The client-settings additions are optional, so existing version-1 documents require no rewrite on read. The first successful preference write adds only the relevant slice. Existing clients with projects skip the welcome and gain bare-New-Chat resolution; fresh clients with no projects see the welcome. Rollback ignores the additive fields and restores the previous front door without corrupting the settings file.
