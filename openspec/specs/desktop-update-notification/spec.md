# desktop-update-notification Specification

## Purpose
Defines the packaged desktop update cadence, readiness badge, restart action, platform feeds, and no-op behavior on hosts without a working updater.
## Requirements
### Requirement: Release polling cadence

The desktop app SHALL check for a newer released version every 5 minutes while running, starting shortly after launch. The check SHALL contact only the public update endpoint backed by the project's GitHub Releases; no Rennet backend is involved.

#### Scenario: New release published while the app runs

- **WHEN** a newer release is published and up to 5 minutes elapse
- **THEN** the app has discovered and downloaded the update in the background without interrupting the user

#### Scenario: No release available

- **WHEN** a check finds no newer version
- **THEN** nothing user-visible changes and no dialog, badge, or log noise appears

### Requirement: Update readiness badge on the Rennet logo

When an update has been downloaded and is ready to apply, the Rennet logo in the app chrome SHALL carry a small notification badge on its corner. The badge SHALL be announced to assistive technology with a text label naming the available action, SHALL not rely on color alone, and SHALL persist until the update is applied or the app exits. No modal dialog SHALL appear unprompted.

#### Scenario: Update downloaded

- **WHEN** the updater reports an update is downloaded and ready
- **THEN** the chrome logo shows the corner badge and screen readers can discover that an update is ready

#### Scenario: No update pending

- **WHEN** no update is ready
- **THEN** the logo renders without an update badge or update action

### Requirement: User-invoked apply

Opening the update action from the badged logo SHALL present a prompt offering to restart into the new version or dismiss. Choosing to apply SHALL restart the app into the downloaded update. Dismissing SHALL leave the badge in place and SHALL NOT reopen the prompt on its own.

#### Scenario: User applies the update

- **WHEN** the user clicks the badged logo and confirms
- **THEN** the app restarts and comes back running the new version

#### Scenario: User dismisses the prompt

- **WHEN** the user clicks the badged logo and declines
- **THEN** the app continues uninterrupted and the badge remains available for later

### Requirement: Graceful absence on non-updating hosts

On unsigned macOS builds, Linux, development runs, and the daemon-served browser shell, the feature SHALL be a silent no-op with no badge, prompt, or user-facing error.

#### Scenario: Unsigned macOS build

- **WHEN** the platform updater rejects initialization (mandatory code signing)
- **THEN** the app behaves exactly as an app with no updater, with the failure at most logged

#### Scenario: Browser shell

- **WHEN** the UI runs in the daemon-served browser shell
- **THEN** no update affordance exists and the logo renders unmodified
