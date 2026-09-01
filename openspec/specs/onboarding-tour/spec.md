# onboarding-tour Specification

## Purpose
Defines when the coach-mark tour may begin relative to the first-run welcome: the tour belongs to the app shell and must not exist, fire, or be consumed while the welcome wizard owns the window.
## Requirements
### Requirement: App shell does not mount beneath the welcome

While the first-run welcome is on screen, the app shell (sidebar, new chat view, chat dock) SHALL NOT be mounted. No coach anchor SHALL register and no coach mark SHALL elect or paint while the welcome is on screen.

#### Scenario: Adding a project mid-welcome

- **WHEN** the user adds a project during the welcome wizard
- **THEN** no spotlight, scrim, or teaching card appears over the wizard, and the wizard advances normally

#### Scenario: Welcome interactions cannot burn marks

- **WHEN** the user clicks anywhere in the welcome wizard
- **THEN** no unseen coach mark is dismissed or marked seen

### Requirement: Tour starts on the new chat view after onboarding

After the welcome completes, the app SHALL land on the new chat view for the added project, and the first coach mark SHALL elect and render there, anchored to a visible element.

#### Scenario: Completing the welcome

- **WHEN** the user finishes the welcome via "Start a new chat"
- **THEN** the new chat view renders and the first tour mark appears anchored to its on-screen element

