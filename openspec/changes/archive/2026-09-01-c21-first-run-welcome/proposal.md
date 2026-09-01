## Why

Rennet currently opens a sparse project picker on first launch and leaves the user to discover filesystem access, installed tools, review-harness choices, and project setup piecemeal. The approved first-run experience should introduce the product, configure the real environment, add the first project, and then land directly in New Chat without replacing the contextual coach-mark tour.

## What Changes

- Replace the zero-project `/new-chat` front door with a full-window, animated first-run welcome using the authored Rennet identity and the selected Affineur visual direction.
- Add five setup stages: appearance, detected tools, review setup, first project, and ready. Appearance changes apply immediately; detected state comes from the existing host probes; Claude Code and Codex are the launch harnesses.
- Persist first-run completion separately from coach marks, persist the selected theme pack, and use the existing per-host harness rulings plus Model Council role assignment to make Dual Harness and orchestrator choices real.
- Add a macOS **Grant Full Disk Access** action that opens the relevant System Settings page. Access remains optional and project selection continues through the existing source-aware Add Project browser.
- Show an actionable missing-harness state with a direct link to a new installation guide.
- Replace the ordinary bare `/new-chat` front door with the real New Chat view resolved to the last-used surviving project. A stale remembered project falls back to another current project; zero projects returns to the welcome only when setup cannot continue.
- Keep the coach-mark onboarding tour independent: completing or revisiting the first-run welcome neither skips nor resets coach marks.

## Capabilities

### New Capabilities

- `first-run-welcome`: Eligibility, staged setup, animation, appearance, environment detection, review-harness choices, system-access action, first-project handoff, completion, re-entry, and coach-mark independence.
- `new-chat-entry`: Bare New Chat project resolution, last-used project persistence, stale-project fallback, and zero-project behavior.

### Modified Capabilities

- `settings-resolution`: Client settings additionally persist the first-run completion marker, theme pack, and last-used project without entering the repository settings ladder.

## Impact

- `packages/protocol`: additive client-settings and bridge capabilities plus settings commands.
- `packages/server` and `packages/adapters`: persistence composition for the new client preferences.
- `packages/app-ui`: welcome route, Motion animation, live settings/detection bindings, Add Project embedding, and New Chat resolution.
- `apps/desktop`: a narrowly exposed, sender-validated macOS System Settings opener.
- Dependency graph: add the MIT-licensed `motion` React package to `@rennet/app-ui` under the dependency standard.
- Documentation: first-run, onboarding-tour distinction, harness installation, getting started, settings reference, glossary, docs inventory, and docs-site navigation.
