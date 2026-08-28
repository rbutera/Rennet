## Purpose

Defines how the bare New Chat entry resolves a useful project and reaches the real target picker instead of presenting a separate project-list front door.

## ADDED Requirements

### Requirement: Bare New Chat resolves the last-used surviving project

Opening `/new-chat` without a project query SHALL resolve the viewer's remembered project for the active source and render the real New Chat target picker for that project. Entering a project-scoped New Chat, session, map, or indexing route SHALL remember that project. A remembered id SHALL be validated against the active source's current project list before use.

#### Scenario: Remembered project still exists
- **WHEN** bare New Chat opens and the remembered project is present in the active source's project list
- **THEN** the real New Chat view opens for that project without showing a project-list front door

#### Scenario: Remembered project was removed
- **WHEN** bare New Chat opens and the remembered project is absent but another project exists
- **THEN** Rennet opens the real New Chat view for the first surviving project and replaces the stale memory

#### Scenario: No remembered project
- **WHEN** bare New Chat opens with projects available but no remembered project
- **THEN** Rennet opens the real New Chat view for the first project returned by the authoritative project list and remembers it

### Requirement: Project switching remains inside New Chat

The resolved New Chat view SHALL keep its existing project switcher so changing projects does not require a separate front door. Selecting another project SHALL update the route and remembered project.

#### Scenario: User switches project
- **WHEN** the user chooses a different project in New Chat
- **THEN** New Chat renders that project's targets, updates the route, and remembers the selected project

### Requirement: Zero projects has one setup path

When the active source has no projects, bare New Chat SHALL show the first-run welcome only for a client whose welcome is incomplete. A client whose welcome is complete SHALL show a focused Add Project state that opens the existing Add Project browser.

#### Scenario: Fresh client has no projects
- **WHEN** bare New Chat opens with no projects and no welcome completion marker
- **THEN** the full first-run welcome opens

#### Scenario: Returning client has no projects
- **WHEN** bare New Chat opens with no projects after the welcome was completed
- **THEN** Rennet shows a focused Add Project action without replaying the welcome
