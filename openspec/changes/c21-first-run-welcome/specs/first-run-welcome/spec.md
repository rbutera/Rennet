## Purpose

Defines the one-time desktop welcome that introduces Rennet, configures the viewer and review environment, adds the first project, and hands the user into New Chat without replacing contextual coach marks.

## ADDED Requirements

### Requirement: A new client receives a full-window welcome

When no project exists and the first-run welcome has not been completed, Rennet SHALL replace the ordinary application shell with the full-window welcome. The welcome SHALL be a client-level state independent from the coach-mark onboarding tour. Removing every project after completion SHALL NOT make the welcome recur automatically.

#### Scenario: First launch with no projects
- **WHEN** the client has no completion marker and the active host reports no projects
- **THEN** the welcome fills the window before the sidebar, New Chat, or coach marks appear

#### Scenario: Coach marks remain independent
- **WHEN** the user completes the welcome
- **THEN** no coach mark is marked seen, skipped, or replayed by that completion

#### Scenario: Projects later become empty
- **WHEN** the welcome was completed and the user later removes every project
- **THEN** Rennet shows the project-add entry state without replaying the welcome automatically

### Requirement: The opening animation explains Rennet

The first welcome frame SHALL begin with varied, syntax-highlighted code fragments moving across the full window and the line “You stopped writing the code. You still have to answer for it.” After the user activates the arrow action, the fragments SHALL converge into the authored Rennet logo, the line SHALL become “Rennet makes code review <word>”, and the final word SHALL continue cycling through twenty single-word descriptions while the frame remains active. The appearance controls SHALL enter after the logo resolves. Motion SHALL honor `prefers-reduced-motion` by showing the same states without spatial flight or continuous cycling.

#### Scenario: User starts the logo sequence
- **WHEN** the user activates the opening arrow
- **THEN** the fragments converge on the rendered logo position, the authored logo appears, the centered review line begins cycling, and the appearance controls follow

#### Scenario: Reduced motion
- **WHEN** the operating system requests reduced motion
- **THEN** the welcome presents the logo, final review line, and appearance controls without fragment flight or an infinite word animation

### Requirement: Appearance changes apply immediately and persist

The appearance stage SHALL offer Light, Dark, and System schemes and the bundled theme packs. Selecting either SHALL update the entire welcome immediately. The selected scheme and theme pack SHALL persist as client settings and continue to apply after the welcome and after restart.

#### Scenario: Theme preview is live
- **WHEN** the user selects a different scheme or theme pack
- **THEN** the complete welcome adopts it in the same interaction without reload

#### Scenario: Theme survives restart
- **WHEN** the user restarts Rennet after choosing an appearance
- **THEN** the chosen scheme and theme pack are restored before ordinary app surfaces render

### Requirement: The welcome reports real environment tools

The tools stage SHALL render the local source's detected coding harnesses and source-control tools from the same probes used by Settings. It SHALL distinguish available, unauthenticated, absent, and unaskable states without inventing a version, account, or installed tool. The stage SHALL explain that each added source is detected separately.

#### Scenario: Detected tools appear with their proven versions
- **WHEN** the local host probes return installed tools
- **THEN** the tools stage names those tools and shows only the versions and authentication states the probes returned

#### Scenario: Missing tool stays honest
- **WHEN** a known tool is absent or its probe did not complete
- **THEN** the stage does not present that tool as available or fabricate a version

### Requirement: Review setup configures real harness behavior

The review-setup stage SHALL list only detected Claude Code and Codex harnesses. The user SHALL choose the orchestrator harness from those available and SHALL be offered Dual Harness when both are available, enabled by default. Dual Harness copy SHALL explain that the providers read independently and disagreement tells the reviewer where to look. The chosen orchestrator and single/dual mode SHALL be written through the existing per-source harness rulings and Model Council assignment so subsequent reviews use the choice.

#### Scenario: Both harnesses are available
- **WHEN** Claude Code and Codex are detected and enabled on the local source
- **THEN** both orchestrator choices are available and Dual Harness starts enabled

#### Scenario: One harness is available
- **WHEN** exactly one supported harness is detected
- **THEN** it is selected as orchestrator, Dual Harness is unavailable, and setup can continue in single-harness mode

#### Scenario: No supported harness is detected
- **WHEN** neither Claude Code nor Codex is detected
- **THEN** the stage shows a prominent error, links to the coding-harness installation guide, offers a fresh detection attempt, and does not continue to project setup

### Requirement: Project setup uses the existing Add Project browser

The project stage SHALL open the existing source-aware Add Project browser rather than introducing another filesystem picker. On macOS it SHALL state that Rennet reads the folders the user adds and SHALL offer **Grant Full Disk Access**, which opens the Full Disk Access page in System Settings. Full Disk Access SHALL remain optional and SHALL NOT block adding a project or continuing through an already accessible path.

#### Scenario: User adds the first project
- **WHEN** the user chooses a source and adds a repository or workspace through the existing browser
- **THEN** the project is persisted through the normal discovery/add flow and the welcome advances with that project selected

#### Scenario: User opens Full Disk Access settings
- **WHEN** the desktop client is on macOS and the user activates **Grant Full Disk Access**
- **THEN** Rennet opens the operating-system Full Disk Access settings page without showing a Rennet confirmation or approval dialog

#### Scenario: Non-macOS client
- **WHEN** the welcome runs on a non-macOS client
- **THEN** no Full Disk Access action is shown

### Requirement: Completion hands the user directly to New Chat

After the first project is added, the welcome SHALL show a ready summary naming the project, selected orchestrator, and review mode. Activating the final primary action SHALL persist welcome completion and open the real New Chat screen for the added project.

#### Scenario: Start a new chat
- **WHEN** the user activates the ready action
- **THEN** completion is persisted and New Chat opens with the newly added project selected

#### Scenario: Completion write fails
- **WHEN** the client-settings write is refused or fails
- **THEN** the welcome remains visible and states the failure instead of claiming setup is complete
